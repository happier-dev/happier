import type { AutomationDaemonAssignmentsResponse } from './automationTypes';

export type AutomationAssignmentCache = ReturnType<typeof createAutomationAssignmentCache>;

export function createAutomationAssignmentCache() {
  let assignments: AutomationDaemonAssignmentsResponse['assignments'] = [];
  let updatedAt = 0;

  return {
    replace(nextAssignments: AutomationDaemonAssignmentsResponse['assignments']): void {
      assignments = Array.isArray(nextAssignments) ? nextAssignments : [];
      updatedAt = Date.now();
    },

    getAll(): AutomationDaemonAssignmentsResponse['assignments'] {
      return assignments;
    },

    getByAutomationId(automationId: string) {
      return assignments.find((assignment) => assignment.automation.id === automationId) ?? null;
    },

    getUpdatedAt(): number {
      return updatedAt;
    },
  };
}
