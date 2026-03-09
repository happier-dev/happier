import { createDeleteManyRetentionRule } from './createDeleteManyRetentionRule';

export function createVoiceSessionLeaseRetentionRule() {
    return createDeleteManyRetentionRule({
        id: 'voiceSessionLeases',
        modelName: 'voiceSessionLease',
        primaryField: 'id',
        cutoffField: 'expiresAt',
    });
}
