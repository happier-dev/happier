import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createAutomationRunEventRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'automationRunEvents',
        modelName: 'automationRunEvent',
        primaryField: 'id',
        cutoffField: 'ts',
    });
}
