import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createUsageEventRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'usageEvents',
        modelName: 'usageEvent',
        primaryField: 'id',
        cutoffField: 'observedAt',
    });
}
