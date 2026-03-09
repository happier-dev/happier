import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createTerminalAuthRequestRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'terminalAuthRequests',
        modelName: 'terminalAuthRequest',
        primaryField: 'id',
        cutoffField: 'updatedAt',
    });
}
