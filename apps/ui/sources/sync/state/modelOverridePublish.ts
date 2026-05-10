import type { Metadata } from '@/sync/domains/state/storageTypes';
import { publishUiSessionStateFieldToMetadata } from './publishField';

export async function publishModelOverrideToMetadata(params: {
    sessionId: string;
    modelId: string;
    updatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, modelId, updatedAt, updateSessionMetadataWithRetry } = params;
    await publishUiSessionStateFieldToMetadata({
        sessionId,
        fieldId: 'intent.model',
        value: { v: 1, modelId: modelId || null, updatedAt },
        reason: 'ui-model-override',
        updateSessionMetadataWithRetry,
    });
}
