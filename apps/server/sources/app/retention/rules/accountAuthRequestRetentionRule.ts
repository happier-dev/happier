import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createAccountAuthRequestRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'accountAuthRequests',
        modelName: 'accountAuthRequest',
        primaryField: 'id',
        cutoffField: 'updatedAt',
    });
}
