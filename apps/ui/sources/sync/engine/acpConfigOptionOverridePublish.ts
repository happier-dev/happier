import type { Metadata } from '@/sync/storageTypes';
import { computeNextMetadataConfigOptionOverrideV1 } from '@happier-dev/agents';

export type AcpConfigOptionOverrideValueId = string;

export function computeNextAcpConfigOptionOverrideMetadata(params: {
    metadata: Metadata;
    configId: string;
    value: AcpConfigOptionOverrideValueId;
    updatedAt: number;
}): Metadata {
    return computeNextMetadataConfigOptionOverrideV1({
        metadata: params.metadata as any,
        configId: params.configId,
        value: params.value,
        updatedAt: params.updatedAt,
    }) as any;
}

export async function publishAcpConfigOptionOverrideToMetadata(params: {
    sessionId: string;
    configId: string;
    value: AcpConfigOptionOverrideValueId;
    updatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, configId, value, updatedAt, updateSessionMetadataWithRetry } = params;

    await updateSessionMetadataWithRetry(sessionId, (metadata) =>
        computeNextAcpConfigOptionOverrideMetadata({ metadata, configId, value, updatedAt })
    );
}
