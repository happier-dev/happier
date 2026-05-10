import type { Metadata } from '@/sync/domains/state/storageTypes';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { publishUiSessionStateFieldToMetadata } from './publishField';

export async function publishPermissionModeToMetadata(params: {
    sessionId: string;
    permissionMode: PermissionMode;
    permissionModeUpdatedAt: number;
    updateSessionMetadataWithRetry: (sessionId: string, updater: (metadata: Metadata) => Metadata) => Promise<void>;
}): Promise<void> {
    const { sessionId, permissionMode, permissionModeUpdatedAt, updateSessionMetadataWithRetry } = params;

    await publishUiSessionStateFieldToMetadata({
        sessionId,
        fieldId: 'intent.permissionMode',
        value: { v: 1, permissionMode, updatedAt: permissionModeUpdatedAt },
        reason: 'ui-permission-mode',
        updateSessionMetadataWithRetry,
    });
}
