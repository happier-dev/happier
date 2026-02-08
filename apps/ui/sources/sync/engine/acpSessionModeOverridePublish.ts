import type { Metadata } from '@/sync/storageTypes';
import { computeNextMetadataStringOverrideV1 } from '@happier-dev/agents';

export function computeNextAcpSessionModeOverrideMetadata(params: {
    metadata: Metadata;
    modeId: string;
    updatedAt: number;
}): Metadata {
    return computeNextMetadataStringOverrideV1({
        metadata: params.metadata as any,
        overrideKey: 'acpSessionModeOverrideV1',
        valueKey: 'modeId',
        value: params.modeId,
        updatedAt: params.updatedAt,
    }) as any;
}

export async function publishAcpSessionModeOverrideToMetadata(params: {
    sessionId: string;
    modeId: string;
    updatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, modeId, updatedAt, updateSessionMetadataWithRetry } = params;

    await updateSessionMetadataWithRetry(sessionId, (metadata) =>
        computeNextAcpSessionModeOverrideMetadata({ metadata, modeId, updatedAt })
    );
}
