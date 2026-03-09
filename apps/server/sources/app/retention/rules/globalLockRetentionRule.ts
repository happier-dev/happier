import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createGlobalLockRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'globalLocks',
        modelName: 'globalLock',
        primaryField: 'key',
        cutoffField: 'expiresAt',
    });
}
