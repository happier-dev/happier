import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createPublicShareAccessLogRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'publicShareAccessLogs',
        modelName: 'publicShareAccessLog',
        primaryField: 'id',
        cutoffField: 'accessedAt',
    });
}
