import { buildExistingSessionPermissionModeActionInput } from '@happier-dev/protocol/sessions/authoring/existingSessionActionInputs';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { parsePermissionIntentAlias } from '@happier-dev/agents';
import { requireActionSuccess, type FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { HappyError } from '@/utils/errors/errors';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { captureSessionDraftCurrentness, clearSessionDraftCurrentnessLocal, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

export async function applyPermissionModeSelection(params: Readonly<{
    sessionId: string;
    serverId: string | null;
    mode: PermissionMode;
    applyTiming: 'immediate' | 'next_prompt';
    draftScope?: ServerAccountScope | null;
    executeAction: (...args: Parameters<FrontDoorActionExecute>) => ReturnType<FrontDoorActionExecute>;
}>): Promise<void> {
    if (params.applyTiming === 'next_prompt') {
        if (!params.draftScope) throw new HappyError('Session draft scope is unavailable', false, { code: 'session_account_scope_retired' });
        writeExistingSessionDraft({ scope: params.draftScope, sessionId: params.sessionId,
            patch: { nextPromptPermissionMode: params.mode } });
        return;
    }
    const address = { kind: 'session' as const, sessionId: params.sessionId };
    const currentness = params.draftScope ? captureSessionDraftCurrentness({ scope: params.draftScope, address }) : null;
    const result = await params.executeAction('session.permission_mode.set', buildExistingSessionPermissionModeActionInput({
        sessionId: params.sessionId,
        permissionMode: params.mode,
        applyTiming: params.applyTiming,
    }), { surface: 'ui', defaultSessionId: params.sessionId, ...(params.serverId ? { serverId: params.serverId } : {}) });
    requireActionSuccess(result);
    if (params.draftScope && currentness) clearSessionDraftCurrentnessLocal({ scope: params.draftScope, address, currentness,
        fieldIds: ['extensions.happier.nextPromptPermissionModeV1'] });
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
