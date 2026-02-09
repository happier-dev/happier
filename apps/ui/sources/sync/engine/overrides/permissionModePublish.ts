import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { computeNextPermissionIntentMetadata } from '@happier-dev/agents';

export function computeNextPermissionModeMetadata(params: {
    metadata: Metadata;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
}): Metadata {
    return computeNextPermissionIntentMetadata({
        metadata: params.metadata as any,
        permissionMode: params.permissionMode,
        permissionModeUpdatedAt: params.permissionModeUpdatedAt,
    }) as any;
}

export async function publishPermissionModeToMetadata(params: {
    sessionId: string;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, permissionMode, permissionModeUpdatedAt, updateSessionMetadataWithRetry } = params;

    await updateSessionMetadataWithRetry(sessionId, (metadata) =>
        computeNextPermissionModeMetadata({ metadata, permissionMode, permissionModeUpdatedAt })
    );
}
