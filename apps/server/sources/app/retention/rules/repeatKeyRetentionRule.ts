import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createRepeatKeyRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'repeatKeys',
        modelName: 'repeatKey',
        primaryField: 'key',
        cutoffField: 'expiresAt',
    });
}
