import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createUserFeedItemRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'userFeedItems',
        modelName: 'userFeedItem',
        primaryField: 'id',
        cutoffField: 'createdAt',
    });
}
