import type { AutomationWorkerAssignmentsResponse } from './automationTypes';

export type AutomationAssignmentCache = ReturnType<typeof createAutomationAssignmentCache>;

export function createAutomationAssignmentCache() {
  let assignments: AutomationWorkerAssignmentsResponse['assignments'] = [];
  let updatedAt = 0;

  return {
    replace(nextAssignments: AutomationWorkerAssignmentsResponse['assignments']): void {
      assignments = Array.isArray(nextAssignments) ? nextAssignments : [];
      updatedAt = Date.now();
    },

    getAll(): AutomationWorkerAssignmentsResponse['assignments'] {
      return assignments;
    },

    getByAutomationId(automationId: string) {
      return assignments.find((assignment) => assignment.automationId === automationId) ?? null;
    },

    getUpdatedAt(): number {
      return updatedAt;
    },
  };
}
