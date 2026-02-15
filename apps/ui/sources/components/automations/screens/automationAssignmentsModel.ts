import type { AutomationAssignment } from '@/sync/domains/automations/automationTypes';

export type AutomationAssignmentPatchInput = Readonly<{
    machineId: string;
    enabled?: boolean;
    priority?: number;
}>;

export function upsertAutomationAssignmentToggle(params: {
    assignments: ReadonlyArray<AutomationAssignment>;
    machineId: string;
    enabled: boolean;
}): AutomationAssignmentPatchInput[] {
    const machineId = params.machineId.trim();
    if (!machineId) {
        return params.assignments.map((assignment) => ({
            machineId: assignment.machineId,
            enabled: assignment.enabled,
            priority: assignment.priority,
        }));
    }

    let found = false;
    const next = params.assignments.map((assignment) => {
        if (assignment.machineId !== machineId) {
            return {
                machineId: assignment.machineId,
                enabled: assignment.enabled,
                priority: assignment.priority,
            };
        }

        found = true;
        return {
            machineId: assignment.machineId,
            enabled: params.enabled,
            priority: assignment.priority,
        };
    });

    if (!found) {
        next.push({
            machineId,
            enabled: params.enabled,
            priority: 0,
        });
    }

    return next;
}
