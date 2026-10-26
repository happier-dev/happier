import { t } from '@/text';
import { Modal } from '@/modal';
import { storage } from '@/sync/domains/state/storage';
import { HappyError } from '@/utils/errors/errors';
import {
    sessionArchiveWithServerScope,
    sessionDeleteWithServerScope,
    sessionRename,
    sessionSetManualReadStateWithServerScope,
    sessionStopWithServerScope,
    sessionUnarchiveWithServerScope,
} from '@/sync/ops';
import { sessionSetAttentionStandingWithServerScope, setSessionPin } from '@/sync/ops/sessionOrganization';
import { resolveSessionOrganizationMutationScope } from '@/sync/domains/session/organization/mutationScope';
import {
    archiveSessionWithPendingState,
    isSessionActiveArchiveResult,
    isSessionArchivePending,
    stopSessionAndMaybeArchive,
} from '@/components/sessions/sessionStopArchiveFlow';

import {
    SESSION_ACTION_ARCHIVE_ID,
    SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID,
    SESSION_ACTION_DELETE_ID,
    SESSION_ACTION_EDIT_TAGS_ID,
    SESSION_ACTION_MARK_READ_ID,
    SESSION_ACTION_MARK_UNREAD_ID,
    SESSION_ACTION_MOVE_TO_FOLDER_ID,
    SESSION_ACTION_PIN_ID,
    SESSION_ACTION_RENAME_ID,
    SESSION_ACTION_RESUME_ID,
    SESSION_ACTION_SET_ATTENTION_STANDING_ID,
    SESSION_ACTION_STOP_ID,
    SESSION_ACTION_UNARCHIVE_ID,
    SESSION_ACTION_UNPIN_ID,
    resolveAttentionStandingFromSessionActionId,
} from './sessionActionIds';
import type {
    SessionActionExecutionContext,
    SessionActionExecutionInput,
    SessionActionId,
    SessionActionOperationResult,
    SessionActionTarget,
} from './sessionActionTypes';
import { resolveSessionArchiveActionPolicy } from './sessionActionMetadata';
import { resolveSessionArchiveServerId } from '@/sync/domains/session/listing/sessionArchiveState';
import { resolveSessionListCacheServerId } from '@/sync/domains/session/listing/sessionListPresentation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';
import { nowServerMs } from '@/sync/runtime/time';
import { createSessionActionTarget } from './sessionActionContext';

function canDeleteCurrentSession(target: SessionActionTarget): boolean {
    if (!target.canDelete) return false;
    const state = storage.getState();
    const serverId = resolveSessionArchiveServerId(target.serverId);
    const localSession = areServerProfileIdentifiersEquivalent(serverId, getActiveServerSnapshot().serverId)
        ? state.sessionListRenderables[target.sessionId] ?? state.sessions[target.sessionId]
        : undefined;
    const cacheServerId = resolveSessionListCacheServerId(state.sessionListViewDataByServerId, serverId);
    const cachedRow = cacheServerId
        ? state.sessionListViewDataByServerId[cacheServerId]?.find((row) => row.type === 'session' && row.session.id === target.sessionId)
        : undefined;
    const session = localSession ?? (cachedRow?.type === 'session' ? cachedRow.session : undefined);
    if (!session) return false;

    // The target captures the owning Account; another Home's active profile must not replace it.
    return createSessionActionTarget({
        session,
        serverId,
        currentUserId: target.isOwnedByCurrentUser ? target.session.owner : null,
        isConnected: getSessionStatus(session, nowServerMs()).isConnected,
    }).canDelete;
}

function resolveStopArchiveFlow(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.stopArchiveFlow ?? stopSessionAndMaybeArchive;
}

function resolveStopSession(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.stopSession ?? sessionStopWithServerScope;
}

function resolveArchiveSession(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.archiveSession ?? sessionArchiveWithServerScope;
}

function resolveUnarchiveSession(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.unarchiveSession ?? sessionUnarchiveWithServerScope;
}

function resolveRenameSession(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.renameSession ?? sessionRename;
}

function resolveDeleteSession(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.deleteSession ?? sessionDeleteWithServerScope;
}

function resolveResumeSession(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.resumeSession;
}

function resolveSetManualReadState(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setManualReadState ?? sessionSetManualReadStateWithServerScope;
}

function resolveSetPinned(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setPinned ?? (async (sessionId: string, pinned: boolean, opts?: Readonly<{ serverId?: string | null }>) => {
        const resolved = await resolveSessionOrganizationMutationScope(opts?.serverId);
        if (!resolved.ok) throw new HappyError(t('errors.unknownError'), false);
        await setSessionPin({ ...resolved.scope, sessionId, pinned });
    });
}

function resolveSetAttentionStanding(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setAttentionStanding ?? sessionSetAttentionStandingWithServerScope;
}

function resolveSetTags(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setTags;
}

function resolveMoveToFolder(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.moveToFolder;
}

function throwIfFailed(result: SessionActionOperationResult | void, fallbackMessage: string): void {
    if (!result || result.success) return;
    throw new HappyError(result.message || fallbackMessage, false);
}

function throwUnsupportedSingleTargetAction(): never {
    throw new HappyError(t('errors.unknownError'), false);
}

async function runStopArchiveFlow(params: Readonly<{
    target: SessionActionTarget;
    context?: SessionActionExecutionContext;
    archiveAfterStop: 'always' | 'never';
}>): Promise<void | false> {
    const stopArchiveFlow = resolveStopArchiveFlow(params.context);
    const stopSession = resolveStopSession(params.context);
    const archiveSession = resolveArchiveSession(params.context);
    return await stopArchiveFlow({
        sessionId: params.target.sessionId,
        serverId: params.target.serverId,
        hideInactiveSessions: params.context?.hideInactiveSessions === true,
        isPinned: params.target.isPinned,
        archiveAfterStop: params.archiveAfterStop,
        stopSession: async () => await stopSession(params.target.sessionId, { serverId: params.target.serverId }),
        archiveSession: async (options) => await archiveSession(params.target.sessionId, { serverId: params.target.serverId, ...options }),
        stopErrorMessage: t('sessionInfo.failedToStopSession'),
        archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
    });
}

export async function confirmSessionStop(): Promise<boolean> {
    return await Modal.confirm(t('sessionInfo.stopSession'), t('sessionInfo.stopSessionConfirm'), {
        cancelText: t('common.cancel'),
        confirmText: t('sessionInfo.stopSession'),
        destructive: true,
    });
}

async function executeArchiveAction(target: SessionActionTarget, context?: SessionActionExecutionContext): Promise<void | false> {
    const archiveSession = resolveArchiveSession(context);
    // An archive of this session is already in flight; a second one would race its lifecycle.
    if (isSessionArchivePending(target.sessionId, target.serverId)) return false;

    if (target.isActive || target.hasStoppableTerminalHost) {
        if (!await confirmSessionStop()) return false;
        return await runStopArchiveFlow({ target, context, archiveAfterStop: 'always' });
    }

    const result = await archiveSessionWithPendingState(
        target.sessionId,
        async () => await archiveSession(target.sessionId, { serverId: target.serverId }),
        target.serverId,
    );
    if (result === false) return false;
    if (!result.success) {
        if (isSessionActiveArchiveResult(result)) {
            // The server may know the session is active before this client does.
            // Waiving reversible archive confirmation never waives stopping it.
            if (!await confirmSessionStop()) return false;
            return await runStopArchiveFlow({ target, context, archiveAfterStop: 'always' });
        }
        throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
    }
}

export async function executeSessionAction(params: Readonly<{
    actionId: SessionActionId;
    target: SessionActionTarget;
    input?: SessionActionExecutionInput;
    context?: SessionActionExecutionContext;
}>): Promise<void | false> {
    const target = { ...params.target, serverId: resolveSessionArchiveServerId(params.target.serverId) };
    params = { ...params, target };
    if (params.actionId === SESSION_ACTION_ARCHIVE_ID || params.actionId === SESSION_ACTION_UNARCHIVE_ID) {
        const policy = resolveSessionArchiveActionPolicy({
            actionId: params.actionId,
            settings: storage.getState().settings.actionsSettingsV1,
        });
        if (!policy.enabled) return false;
        const willStop = params.actionId === SESSION_ACTION_ARCHIVE_ID
            && (params.target.isActive || params.target.hasStoppableTerminalHost);
        if (policy.requiresConfirmation && !willStop) {
            const isArchive = params.actionId === SESSION_ACTION_ARCHIVE_ID;
            const confirmed = await Modal.confirm(
                isArchive ? t('sessionInfo.archiveSession') : t('sessionInfo.unarchiveSession'),
                isArchive ? t('sessionInfo.archiveSessionConfirm') : t('sessionInfo.unarchiveSessionConfirm'),
                {
                    cancelText: t('common.cancel'),
                    confirmText: isArchive ? t('sessionInfo.archiveSession') : t('sessionInfo.unarchiveSession'),
                    destructive: policy.destructive,
                },
            );
            if (!confirmed) return false;
        }
    }
    switch (params.actionId) {
        case SESSION_ACTION_MARK_READ_ID:
            throwIfFailed(
                await resolveSetManualReadState(params.context)(params.target.sessionId, 'read', { serverId: params.target.serverId }),
                t('sessionInfo.failedToMarkSessionRead'),
            );
            return;
        case SESSION_ACTION_MARK_UNREAD_ID:
            throwIfFailed(
                await resolveSetManualReadState(params.context)(params.target.sessionId, 'unread', { serverId: params.target.serverId }),
                t('sessionInfo.failedToMarkSessionUnread'),
            );
            return;
        case SESSION_ACTION_RENAME_ID: {
            const title = params.input?.title?.trim();
            if (!title) return;
            throwIfFailed(
                await resolveRenameSession(params.context)(params.target.sessionId, title, { serverId: params.target.serverId }),
                t('sessionInfo.failedToRenameSession'),
            );
            return;
        }
        case SESSION_ACTION_RESUME_ID: {
            const resumeSession = resolveResumeSession(params.context);
            if (!resumeSession) throwUnsupportedSingleTargetAction();
            await resumeSession(params.target.sessionId);
            return;
        }
        case SESSION_ACTION_STOP_ID:
            await runStopArchiveFlow({ target: params.target, context: params.context, archiveAfterStop: 'never' });
            return;
        case SESSION_ACTION_ARCHIVE_ID:
            return await executeArchiveAction(params.target, params.context);
        case SESSION_ACTION_UNARCHIVE_ID:
            throwIfFailed(
                await resolveUnarchiveSession(params.context)(params.target.sessionId, { serverId: params.target.serverId }),
                t('sessionInfo.failedToUnarchiveSession'),
            );
            return;
        case SESSION_ACTION_DELETE_ID:
            // Confirmation can outlive a restore/resume or terminal-host update on another device.
            if (!canDeleteCurrentSession(params.target)) {
                throw new HappyError(t('sessionInfo.failedToDeleteSession'), false);
            }
            throwIfFailed(
                await resolveDeleteSession(params.context)(params.target.sessionId, { serverId: params.target.serverId }),
                t('sessionInfo.failedToDeleteSession'),
            );
            return;
        case SESSION_ACTION_PIN_ID:
        case SESSION_ACTION_UNPIN_ID: {
            const setPinned = resolveSetPinned(params.context);
            throwIfFailed(
                await setPinned(params.target.sessionId, params.actionId === SESSION_ACTION_PIN_ID, { serverId: params.target.serverId }),
                t('errors.unknownError'),
            );
            return;
        }
        case SESSION_ACTION_SET_ATTENTION_STANDING_ID:
        case SESSION_ACTION_CLEAR_ATTENTION_STANDING_ID: {
            const setAttentionStanding = resolveSetAttentionStanding(params.context);
            const standing = resolveAttentionStandingFromSessionActionId(params.actionId) === true;
            throwIfFailed(
                await setAttentionStanding(params.target.sessionId, standing, { serverId: params.target.serverId }),
                t('errors.unknownError'),
            );
            return;
        }
        case SESSION_ACTION_EDIT_TAGS_ID: {
            const setTags = resolveSetTags(params.context);
            if (!setTags) throwUnsupportedSingleTargetAction();
            throwIfFailed(
                await setTags(params.target.sessionId, params.input?.tags ?? [], { serverId: params.target.serverId }),
                t('errors.unknownError'),
            );
            return;
        }
        case SESSION_ACTION_MOVE_TO_FOLDER_ID: {
            const moveToFolder = resolveMoveToFolder(params.context);
            if (!moveToFolder) throwUnsupportedSingleTargetAction();
            throwIfFailed(
                await moveToFolder(params.target, { folderId: params.input?.folderId }),
                t('errors.unknownError'),
            );
            return;
        }
    }
}
