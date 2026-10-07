import { showPutUnderSessionModal } from '@/components/sessions/work/PutUnderSessionModal';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import {
    sessionArchiveWithServerScope,
    sessionDeleteWithServerScope,
    sessionRename,
    sessionSetManualReadStateWithServerScope,
    sessionStopWithServerScope,
    sessionUnarchiveWithServerScope,
} from '@/sync/ops';
import { sessionSetAttentionStandingWithServerScope } from '@/sync/ops/sessionOrganization';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    clearSessionVisibleWhenInactive,
    isSessionActiveArchiveResult,
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
    SESSION_ACTION_MAKE_ORCHESTRATOR_ID,
    ORCHESTRATOR_ROLE_ID,
    SESSION_ACTION_PUT_UNDER_ID,
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

function resolveSetSessionRole(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setSessionRole ?? roleActions.setSessionRole;
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

/**
 * Standing writes go through the same server-scoped organization op the settings and bulk paths
 * use; a surface may still substitute its own operation (tests, optimistic row handlers) the way
 * every other action here allows.
 */
function resolveSetAttentionStanding(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setAttentionStanding ?? sessionSetAttentionStandingWithServerScope;
}

function resolveSetPinned(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setPinned;
}

function resolveSetTags(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setTags;
}

function resolveMoveToFolder(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.moveToFolder;
}

function resolveClearSessionVisibleWhenInactive(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.clearSessionVisibleWhenInactive ?? clearSessionVisibleWhenInactive;
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
    address: SessionAddress;
    context?: SessionActionExecutionContext;
    archiveAfterStop: 'always' | 'never';
}>): Promise<void> {
    const stopArchiveFlow = resolveStopArchiveFlow(params.context);
    const stopSession = resolveStopSession(params.context);
    const archiveSession = resolveArchiveSession(params.context);
    await stopArchiveFlow({
        address: params.address,
        hideInactiveSessions: params.context?.hideInactiveSessions === true,
        isPinned: params.target.isPinned,
        archiveAfterStop: params.archiveAfterStop,
        stopSession: async () => await stopSession(params.address.sessionId, { serverId: params.address.serverId }),
        archiveSession: async () => await archiveSession(params.address.sessionId, { serverId: params.address.serverId }),
        stopErrorMessage: t('sessionInfo.failedToStopSession'),
        archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
    });
}

async function executeArchiveAction(
    target: SessionActionTarget,
    address: SessionAddress,
    context?: SessionActionExecutionContext,
): Promise<void> {
    const archiveSession = resolveArchiveSession(context);

    if (target.isActive || target.hasRecoverableTerminalHost) {
        await runStopArchiveFlow({ target, address, context, archiveAfterStop: 'always' });
        return;
    }

    const result = await archiveSession(address.sessionId, { serverId: address.serverId });
    if (!result.success) {
        if (isSessionActiveArchiveResult(result)) {
            await runStopArchiveFlow({ target, address, context, archiveAfterStop: 'always' });
            return;
        }
        throw new HappyError(result.message || t('sessionInfo.failedToArchiveSession'), false);
    }
    resolveClearSessionVisibleWhenInactive(context)(address);
}

export async function executeSessionAction(params: Readonly<{
    actionId: SessionActionId;
    target: SessionActionTarget;
    input?: SessionActionExecutionInput;
    context?: SessionActionExecutionContext;
}>): Promise<void> {
    const targetAddress = normalizeSessionAddress(params.target.serverId, params.target.sessionId);
    switch (params.actionId) {
        case 'ui.session.follow': {
            if (params.target.followEnabled !== true || !params.target.serverId?.trim()) return;
            const openEditor = params.context?.operations?.openFollowEditor;
            if (!openEditor) throwUnsupportedSingleTargetAction();
            openEditor({
                address: { serverId: params.target.serverId, sessionId: params.target.sessionId },
                archived: params.target.isArchived,
            });
            return;
        }
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
        case SESSION_ACTION_MAKE_ORCHESTRATOR_ID: {
            const result = await resolveSetSessionRole(params.context)(params.target.sessionId, ORCHESTRATOR_ROLE_ID, { serverId: params.target.serverId });
            if (!result.ok) throw new HappyError(t('sessionWork.actions.makeOrchestratorFailed'), false);
            return;
        }
        case SESSION_ACTION_PUT_UNDER_ID: {
            const openPicker = params.context?.operations?.openPutUnderPicker ?? showPutUnderSessionModal;
            openPicker({ sessionId: params.target.sessionId, serverId: params.target.serverId });
            return;
        }
        case SESSION_ACTION_RESUME_ID: {
            const resumeSession = resolveResumeSession(params.context);
            if (!resumeSession) throwUnsupportedSingleTargetAction();
            await resumeSession(params.target.sessionId);
            return;
        }
        case SESSION_ACTION_STOP_ID:
            if (!targetAddress) throwUnsupportedSingleTargetAction();
            await runStopArchiveFlow({
                target: params.target,
                address: targetAddress,
                context: params.context,
                archiveAfterStop: 'never',
            });
            return;
        case SESSION_ACTION_ARCHIVE_ID:
            if (!targetAddress) throwUnsupportedSingleTargetAction();
            await executeArchiveAction(params.target, targetAddress, params.context);
            return;
        case SESSION_ACTION_UNARCHIVE_ID:
            throwIfFailed(
                await resolveUnarchiveSession(params.context)(params.target.sessionId, { serverId: params.target.serverId }),
                t('sessionInfo.failedToUnarchiveSession'),
            );
            return;
        case SESSION_ACTION_DELETE_ID:
            throwIfFailed(
                await resolveDeleteSession(params.context)(params.target.sessionId, { serverId: params.target.serverId }),
                t('sessionInfo.failedToDeleteSession'),
            );
            return;
        case SESSION_ACTION_PIN_ID:
        case SESSION_ACTION_UNPIN_ID: {
            const setPinned = resolveSetPinned(params.context);
            if (!setPinned) throwUnsupportedSingleTargetAction();
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
