import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createSessionShareAccessLogRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'sessionShareAccessLogs',
        modelName: 'sessionShareAccessLog',
        primaryField: 'id',
        cutoffField: 'accessedAt',
    });
}
