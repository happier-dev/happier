import { buildExistingSessionPermissionModeActionInput } from '@happier-dev/protocol/sessions/authoring/existingSessionActionInputs';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { SESSION_PERMISSION_MODE_SET_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { requireActionSuccess, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

export async function applyPermissionModeSelection(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    mode: PermissionMode;
    applyTiming: 'immediate' | 'next_prompt';
    executeAction: (...args: Parameters<FrontDoorActionExecute>) => ReturnType<FrontDoorActionExecute>;
}>): Promise<void> {
    const result = await params.executeAction(SESSION_PERMISSION_MODE_SET_ACTION_ID_V1, buildExistingSessionPermissionModeActionInput({
        sessionId: params.sessionId,
        permissionMode: params.mode,
        applyTiming: params.applyTiming,
    }), { surface: 'ui', defaultSessionId: params.sessionId, ...(params.serverId ? { serverId: params.serverId } : {}) });
    requireActionSuccess(result);
}

/** Raw projection/publication effect; only the Action executor supplies these dependencies. */
export async function applyPermissionModeSelectionEffect(params: {
    sessionId: string;
    mode: PermissionMode;
    applyTiming: 'immediate';
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

    const updatedAt = params.getSessionPermissionModeUpdatedAt(params.sessionId);
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return;

    await params.publishSessionPermissionModeToMetadata({
        sessionId: params.sessionId,
        permissionMode: canonicalMode,
        permissionModeUpdatedAt: updatedAt,
    });
}
