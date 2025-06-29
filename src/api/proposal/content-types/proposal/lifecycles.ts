'use strict';

// Import node-fetch for making HTTP requests (used for Meilisearch and FastAPI)
import fetch from 'node-fetch';

// Define the URLs for your external APIs
const FASTAPI_SALESFORCE_API_URL = 'http://localhost:8001/api/salesforce/opportunity';
// Make sure this Meilisearch URL and API Key are correct for your setup
const MEILISEARCH_API_URL = 'http://localhost:7700/indexes/employees/search';
const MEILISEARCH_API_KEY = 'masterKey'; // Replace with your actual Meilisearch master key if different

/**
 * TypeScript Interfaces for API responses.
 *
 * Ensure these match your FastAPI and Meilisearch response structures.
 */

// For FastAPI (Dummy Salesforce API)
interface OpportunityData {
  opportunityNumber: string;
  proposalName: string;
  clientName: string;
  value: string;
  status: string; // FastAPI uses 'status', Strapi uses 'pstatus'
  description: string;
}

interface FastAPIResponse {
  success: boolean;
  data?: OpportunityData;
  message?: string;
}

// For Meilisearch Employee Search
interface MeilisearchEmployeeHit {
  id: string; // Assuming Meilisearch returns an ID
  name: string; // Corresponds to employee_name in Strapi
  email: string;
  role: string; // Corresponds to job_title in Strapi
  department: string;
  // Add other fields you expect from Meilisearch if applicable
}

interface MeilisearchResponse {
  hits: MeilisearchEmployeeHit[];
  // Other Meilisearch response properties like offset, limit, estimatedTotalHits etc.
}

/**
 * Helper function to convert a plain string to Strapi's Rich Text (Slate.js) format.
 * Each paragraph will be an element.
 */
function convertToRichText(plainText: string): any[] {
  if (!plainText) {
    return [{ type: 'paragraph', children: [{ type: 'text', text: '' }] }];
  }
  const paragraphs = plainText.split('\n').map(line => ({
    type: 'paragraph',
    children: [{ type: 'text', text: line }],
  }));
  return paragraphs;
}


/**
 * Main lifecycle hooks for the 'Proposal' content type.
 */
module.exports = {
  // Hook that runs BEFORE a new 'Proposal' entry is created
  async beforeCreate(event) {
    const { data } = event.params;

    // --- 1. Fetch and populate Proposal details from FastAPI (Salesforce Dummy) ---
    if (data.opportunityNumber) {
      try {
        const response = await fetch(`${FASTAPI_SALESFORCE_API_URL}/${data.opportunityNumber}`);
        const result = await response.json() as FastAPIResponse;

        if (response.ok && result.success && result.data) {
          data.proposalName = result.data.proposalName;
          data.clientName = result.data.clientName;
          data.value = result.data.value;
          data.pstatus = result.data.status;
          data.description = convertToRichText(result.data.description);
          console.log(`[Strapi Lifecycle] Successfully fetched and populated Proposal data for Opportunity: ${data.opportunityNumber}`);
        } else {
          const errorMessage = result.message || 'Failed to fetch opportunity data from Salesforce dummy API.';
          console.error(`[Strapi Lifecycle Error] Opportunity not found or API error: ${errorMessage}`);
          throw new Error(`Opportunity not found or API error: ${errorMessage}. Cannot create proposal.`);
        }
      } catch (error: any) {
        console.error(`[Strapi Lifecycle Error] Error calling Salesforce dummy API: ${error.message}`);
        throw new Error(`Error fetching Salesforce data: ${error.message}. Cannot create proposal.`);
      }
    } else {
      console.log("[Strapi Lifecycle] No opportunityNumber provided. Proceeding without Salesforce fetch.");
    }

    // --- 2. Process ProposedBy and link to Employee (using Meilisearch) ---
    if (data.proposedBy) {
      console.log(`[Strapi Lifecycle] Processing proposedBy: ${data.proposedBy}`);
      try {
        // Query Meilisearch for employee details
        const res = await fetch(MEILISEARCH_API_URL, {
          method: 'POST',
          headers: {
            'X-Meili-API-Key': MEILISEARCH_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ q: data.proposedBy, limit: 1 }), // Search by the proposedBy string
        });

        const result = await res.json() as MeilisearchResponse;
        const employeeFromMeilisearch = (result.hits && result.hits[0]) || null;
        console.log('Meilisearch response:', result);

        if (employeeFromMeilisearch) {
          // Check if employee exists in Strapi by email (assuming email is unique)
          const existingEmployees = await (strapi as any).entityService.findMany('api::employee.employee', {
            filters: { email: employeeFromMeilisearch.email },
            limit: 1,
          });

          let employeeEntry;

          if (existingEmployees.length > 0) {
            employeeEntry = existingEmployees[0];
            console.log(`[Strapi Lifecycle] Existing Employee found in Strapi: ${employeeEntry.id}`);
          } else {
            // Create new Employee entry in Strapi
            employeeEntry = await (strapi as any).entityService.create('api::employee.employee', {
              data: {
                employee_name: employeeFromMeilisearch.name,
                email: employeeFromMeilisearch.email,
                job_title: employeeFromMeilisearch.role,
                department: employeeFromMeilisearch.department,
                // Add any other fields you want to copy from Meilisearch to Strapi Employee
              },
            });
            console.log(`[Strapi Lifecycle] New Employee created in Strapi: ${employeeEntry.id}`);
          }

          // Link Proposal to Employee by setting the 'chooseEmployee' relation
          // In Strapi, for many-to-one, you set the ID of the related entry.
          data.chooseEmployee = employeeEntry.id;
          console.log(`[Strapi Lifecycle] Proposal linked to Employee ID: ${employeeEntry.id}`);

        } else {
          console.warn(`[Strapi Lifecycle Warning] No employee found in Meilisearch for ProposedBy: "${data.proposedBy}". 'chooseEmployee' relation will not be set.`);
          // You might choose to throw an error here if finding an employee is mandatory
          // throw new Error(`ProposedBy employee "${data.proposedBy}" not found. Cannot create proposal.`);
        }
      } catch (error: any) {
        console.error(`[Strapi Lifecycle Error] Error processing ProposedBy with Meilisearch/Employee Service: ${error.message}`);
        throw new Error(`Error processing employee data: ${error.message}. Cannot create proposal.`);
      }
    } else {
      console.log("[Strapi Lifecycle] No ProposedBy field provided. Skipping employee lookup.");
    }
  },

  // Hook that runs BEFORE an existing 'Proposal' entry is updated
  async beforeUpdate(event) {
    const { data, where } = event.params; // data contains only updated fields. `where` contains the ID.

    // --- Re-fetch and populate Proposal details from FastAPI (Salesforce Dummy) ---
    // If opportunityNumber is being updated, or if it was initially missing and now provided
    let opportunityNumberToFetch = data.opportunityNumber;
    if (!opportunityNumberToFetch) {
        const existingEntry: any = await (strapi as any).entityService.findOne('api::proposal.proposal', where.id);
        if (existingEntry) {
            opportunityNumberToFetch = existingEntry.opportunityNumber;
        }
    }

    if (opportunityNumberToFetch) {
        try {
            const response = await fetch(`${FASTAPI_SALESFORCE_API_URL}/${opportunityNumberToFetch}`);
            const result = await response.json() as FastAPIResponse;

            if (response.ok && result.success && result.data) {
                // Update only if data is successfully fetched
                data.proposalName = result.data.proposalName;
                data.clientName = result.data.clientName;
                data.value = result.data.value;
                data.pstatus = result.data.status;
                data.description = convertToRichText(result.data.description);
                console.log(`[Strapi Lifecycle] Successfully re-fetched and updated Proposal data for Opportunity: ${opportunityNumberToFetch}`);
            } else {
                const errorMessage = result.message || 'Failed to re-fetch opportunity data from Salesforce dummy API for update.';
                console.warn(`[Strapi Lifecycle Warning] Could not re-fetch Salesforce data for Opportunity ${opportunityNumberToFetch}: ${errorMessage}`);
            }
        } catch (error: any) {
            console.error(`[Strapi Lifecycle Error] Error calling Salesforce dummy API during update: ${error.message}`);
        }
    } else {
        console.log("[Strapi Lifecycle] No opportunityNumber available for re-fetch during update. Proceeding with existing data.");
    }

    // --- Process ProposedBy and link to Employee (using Meilisearch) on Update ---
    // This logic runs if `proposedBy` field is present in the `data` being updated,
    // or if you always want to re-evaluate it based on the existing `proposedBy` value.
    let proposedByToFetch = data.proposedBy;
    if (!proposedByToFetch) {
        const existingEntry: any = await (strapi as any).entityService.findOne('api::proposal.proposal', where.id, { populate: ['chooseEmployee'] });
        if (existingEntry) {
             proposedByToFetch = existingEntry.proposedBy;
        }
    }

    if (proposedByToFetch) {
        console.log(`[Strapi Lifecycle] Re-processing proposedBy on update: ${proposedByToFetch}`);
        try {
            const res = await fetch(MEILISEARCH_API_URL, {
                method: 'POST',
                headers: {
                    'X-Meili-API-Key': MEILISEARCH_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ q: proposedByToFetch, limit: 1 }),
            });

            const result = await res.json() as MeilisearchResponse;
            const employeeFromMeilisearch = (result.hits && result.hits[0]) || null;

            if (employeeFromMeilisearch) {
                const existingEmployees = await (strapi as any).entityService.findMany('api::employee.employee', {
                    filters: { email: employeeFromMeilisearch.email },
                    limit: 1,
                });

                let employeeEntry;
                if (existingEmployees.length > 0) {
                    employeeEntry = existingEmployees[0];
                    console.log(`[Strapi Lifecycle] Existing Employee found for update: ${employeeEntry.id}`);
                } else {
                    employeeEntry = await (strapi as any).entityService.create('api::employee.employee', {
                        data: {
                            employee_name: employeeFromMeilisearch.name,
                            email: employeeFromMeilisearch.email,
                            job_title: employeeFromMeilisearch.role,
                            department: employeeFromMeilisearch.department,
                        },
                    });
                    console.log(`[Strapi Lifecycle] New Employee created during update: ${employeeEntry.id}`);
                }
                data.chooseEmployee = employeeEntry.id;
                console.log(`[Strapi Lifecycle] Proposal updated to link to Employee ID: ${employeeEntry.id}`);
            } else {
                console.warn(`[Strapi Lifecycle Warning] No employee found in Meilisearch for ProposedBy: "${proposedByToFetch}" during update. 'chooseEmployee' relation might not be updated.`);
                // Decide if you want to nullify the relation if no employee is found for an update.
                // data.chooseEmployee = null;
            }
        } catch (error: any) {
            console.error(`[Strapi Lifecycle Error] Error processing ProposedBy with Meilisearch/Employee Service during update: ${error.message}`);
            // Do not throw an error here unless absolutely critical, as it might prevent unrelated updates.
        }
    } else {
        console.log("[Strapi Lifecycle] No ProposedBy field to process on update.");
    }
  },
};