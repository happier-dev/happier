import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createAuthPairingSessionRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'authPairingSessions',
        modelName: 'authPairingSession',
        primaryField: 'id',
        cutoffField: 'expiresAt',
    });
}
