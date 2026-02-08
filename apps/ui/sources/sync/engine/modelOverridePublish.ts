import type { Metadata } from '@/sync/storageTypes';
import { computeNextMetadataStringOverrideV1 } from '@happier-dev/agents';

export function computeNextModelOverrideMetadata(params: {
    metadata: Metadata;
    modelId: string;
    updatedAt: number;
}): Metadata {
    return computeNextMetadataStringOverrideV1({
        metadata: params.metadata as any,
        overrideKey: 'modelOverrideV1',
        valueKey: 'modelId',
        value: params.modelId,
        updatedAt: params.updatedAt,
    }) as any;
}

export async function publishModelOverrideToMetadata(params: {
    sessionId: string;
    modelId: string;
    updatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, modelId, updatedAt, updateSessionMetadataWithRetry } = params;
    await updateSessionMetadataWithRetry(sessionId, (metadata) => computeNextModelOverrideMetadata({ metadata, modelId, updatedAt }));
}
