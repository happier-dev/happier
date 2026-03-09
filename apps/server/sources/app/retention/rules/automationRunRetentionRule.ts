import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

const TERMINAL_AUTOMATION_RUN_STATES = ['succeeded', 'failed', 'cancelled', 'expired'] as const;

export function createAutomationRunRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'automationRuns',
        modelName: 'automationRun',
        primaryField: 'id',
        cutoffField: 'finishedAt',
        extraWhere: () => ({
            state: { in: TERMINAL_AUTOMATION_RUN_STATES },
        }),
    });
}
