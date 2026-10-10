import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { HappyError } from '@/utils/errors/errors';

export async function applyPermissionModeSelection(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    mode: PermissionMode;
    applyTiming: 'immediate' | 'next_prompt';
    executeAction: (...args: Parameters<FrontDoorActionExecute>) => ReturnType<FrontDoorActionExecute>;
}>): Promise<void> {
    const result = await params.executeAction('session.permission_mode.set', {
        sessionId: params.sessionId,
        permissionMode: params.mode,
        applyTiming: params.applyTiming,
    }, { surface: 'ui', defaultSessionId: params.sessionId, ...(params.serverId ? { serverId: params.serverId } : {}) });
    if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode, details: result.details });
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) throw new HappyError(approval.data.kind, false, { code: approval.data.kind, details: approval.data });
}

/** Raw projection/publication effect; only the Action executor supplies these dependencies. */
export async function applyPermissionModeSelectionEffect(params: {
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
