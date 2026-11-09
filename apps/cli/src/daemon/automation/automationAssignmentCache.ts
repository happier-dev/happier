import type { AutomationWorkerAssignmentsResponse } from './automationTypes';

export function createAutomationAssignmentCache() {
  let assignments: AutomationWorkerAssignmentsResponse['assignments'] = [];

  return {
    replace(nextAssignments: AutomationWorkerAssignmentsResponse['assignments']): void {
      assignments = Array.isArray(nextAssignments) ? nextAssignments : [];
    },

    getAll(): AutomationWorkerAssignmentsResponse['assignments'] {
      return assignments;
    },

  };
}
