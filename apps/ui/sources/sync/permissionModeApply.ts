import type { PermissionMode } from '@/sync/permissionTypes';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export async function applyPermissionModeSelection(params: {
    sessionId: string;
    mode: PermissionMode;
    applyTiming: 'immediate' | 'next_prompt';
    updateSessionPermissionMode: (sessionId: string, mode: PermissionMode) => void;
    getSessionPermissionModeUpdatedAt: (sessionId: string) => number | null | undefined;
    publishSessionPermissionModeToMetadata: (params: {
        sessionId: string;
        permissionMode: PermissionMode;
        permissionModeUpdatedAt: number;
    }) => Promise<void>;
}): Promise<void> {
    const canonicalMode = (parsePermissionIntentAlias(params.mode) ?? 'default') as PermissionMode;
    params.updateSessionPermissionMode(params.sessionId, canonicalMode);
    if (params.applyTiming !== 'immediate') return;

    const updatedAt = params.getSessionPermissionModeUpdatedAt(params.sessionId);
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return;

    await params.publishSessionPermissionModeToMetadata({
        sessionId: params.sessionId,
        permissionMode: canonicalMode,
        permissionModeUpdatedAt: updatedAt,
    });
}
