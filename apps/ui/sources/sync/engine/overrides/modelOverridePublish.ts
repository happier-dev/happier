import type { Metadata } from '@/sync/domains/state/storageTypes';
import { computeNextModelOverrideMetadataV1 } from '@happier-dev/agents';

export function computeNextModelOverrideMetadata(params: {
    metadata: Metadata;
    modelId: string;
    updatedAt: number;
    retireModelScopedConfigOverrides?: boolean;
}): Metadata {
    return computeNextModelOverrideMetadataV1({
        metadata: params.metadata as any,
        modelId: params.modelId,
        updatedAt: params.updatedAt,
        retireModelScopedConfigOverrides: params.retireModelScopedConfigOverrides === true,
    }) as Metadata;
}

export async function publishModelOverrideToMetadata(params: {
    sessionId: string;
    modelId: string;
    updatedAt: number;
    retireModelScopedConfigOverrides?: boolean;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, modelId, updatedAt, updateSessionMetadataWithRetry } = params;
    await updateSessionMetadataWithRetry(sessionId, (metadata) => computeNextModelOverrideMetadata({
        metadata,
        modelId,
        updatedAt,
        retireModelScopedConfigOverrides: params.retireModelScopedConfigOverrides === true,
    }));
}
