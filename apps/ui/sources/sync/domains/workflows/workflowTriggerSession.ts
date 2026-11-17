import type { WorkflowTriggerSetV1 } from '@happier-dev/protocol/workflows/triggers/workflowTriggerActionsV1';

/** A Habit belongs here when it starts here or its accepted graph writes here. */
export function isWorkflowTriggerSetAttachedToSession(set: WorkflowTriggerSetV1, sessionId: string): boolean {
    return set.scopeSessionId === sessionId || workflowTriggerSetWritesToSession(set, sessionId);
}

export function workflowTriggerSetWritesToSession(set: WorkflowTriggerSetV1, sessionId: string): boolean {
    return set.destinations?.targetSessionIds.includes(sessionId) === true;
}

/** The lifetime page owns its rows; Account rows add accepted destinations in this Session. */
export function projectSessionWorkflowTriggerSets(sessionId: string, lifetimeSets: readonly WorkflowTriggerSetV1[],
    accountSets: readonly WorkflowTriggerSetV1[]): readonly WorkflowTriggerSetV1[] {
    const selected = new Map(lifetimeSets.map(set => [set.automationId, set]));
    for (const set of accountSets) {
        if (!selected.has(set.automationId) && isWorkflowTriggerSetAttachedToSession(set, sessionId)) selected.set(set.automationId, set);
    }
    return [...selected.values()];
}
