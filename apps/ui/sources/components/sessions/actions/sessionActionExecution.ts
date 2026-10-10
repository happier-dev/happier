import { showPutUnderSessionModal } from '@/components/sessions/work/PutUnderSessionModal';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { sessionDisplayActions, undoSessionBotChange } from '@/sync/ops/sessions/sessionDisplayActions';
import { readSessionBotV1, type SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { getStorage } from '@/sync/domains/state/storageStore';
import * as React from 'react';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { getSessionAvatarId, getSessionName } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveSessionToolCallsMenuState } from './sessionToolCallsMenuState';
import { sessionOrganizationActions } from '@/sync/ops/sessionOrganization/sessionOrganizationActions';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { router } from 'expo-router';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import {
    sessionSetManualReadStateWithServerScope,
} from '@/sync/ops';
import { sessionSetAttentionStandingWithServerScope } from '@/sync/ops/sessionOrganization';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    clearSessionVisibleWhenInactive,
    isSessionActiveArchiveResult,
    stopSessionAndMaybeArchive,
} from '@/components/sessions/sessionStopArchiveFlow';

import {
    SESSION_ACTION_MAKE_BOT_ID,
    SESSION_ACTION_MAKE_REGULAR_ID,
    SESSION_ACTION_RAIL_PIN_ID,
    SESSION_ACTION_RAIL_UNPIN_ID,
    SESSION_ACTION_WORK_OPEN_ID,
    SESSION_ACTION_TALK_ID,
    SESSION_ACTION_TOOL_CALLS_TOGGLE_ID,
    SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID,
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
    SessionActionExecutionOperations,
    SessionActionId,
    SessionActionOperationResult,
    SessionActionTarget,
} from './sessionActionTypes';

const executeVoiceAction = createFrontDoorActionExecute();

export async function executeSessionLifecycleAction(
    actionId: 'session.stop' | 'session.archive' | 'session.unarchive' | 'session.delete' | 'session.title.set',
    sessionId: string,
    options?: Readonly<{ serverId?: string | null }>,
    title?: string,
): Promise<SessionActionOperationResult> {
    const outcome = await executeVoiceAction(actionId, { sessionId, ...(title === undefined ? {} : { title }) }, {
        surface: 'ui', defaultSessionId: sessionId, ...(options?.serverId ? { serverId: options.serverId } : {}),
    });
    if (!outcome.ok) {
        const details = outcome.details;
        const message = details && typeof details === 'object' && 'error' in details && typeof details.error === 'string'
            ? details.error : outcome.error;
        return { success: false, message, code: outcome.errorCode,
            ...(details === undefined ? {} : { details }) };
    }
    const result = outcome.result;
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result);
    if (approval.success) return { success: false, code: approval.data.kind, message: approval.data.kind, details: approval.data };
    // The title Action acknowledges a metadata write; lifecycle transports retain
    // their success/recovery envelope for the incumbent stop/archive flow.
    if (actionId === 'session.title.set') return { success: true };
    if (!result || typeof result !== 'object' || !('success' in result) || typeof result.success !== 'boolean') {
        return { success: false, code: 'invalid_action_output', message: 'invalid_action_output' };
    }
    return {
        success: result.success,
        ...('message' in result && typeof result.message === 'string' ? { message: result.message } : {}),
        ...('code' in result && typeof result.code === 'string' ? { code: result.code } : {}),
        ...('recovery' in result && (result.recovery === 'wait_for_inactive' || result.recovery === 'retry_when_runtime_available')
            ? { recovery: result.recovery } : {}),
    };
}
/** The picture beside the notice's one line of text. */
const BOT_CHANGE_NOTICE_AVATAR_SIZE_PX = 18;

/**
 * The accepted Make this a bot / Make a regular session outcome (60s1, lab `b-promote T`): one notice on the
 * app's presentation-notice owner, whose Undo runs the current-value-guarded inverse. Only an accepted write
 * reaches here; a refused inverse reports through the same owner.
 */
function publishSessionBotChangeNotice(params: Readonly<{
    target: SessionActionTarget;
    address: SessionAddress;
    accepted: SessionBotV1 | null;
    previous: SessionBotV1 | null;
}>) {
    const name = getSessionName(params.target.session, params.target.serverId);
    const key = `session-bot:${params.address.serverId}:${params.address.sessionId}`;
    publishPresentationNotice({
        key,
        severity: 'info',
        message: params.accepted ? t('bots.promoted', { name }) : t('bots.demoted', { name }),
        // Lab `b-promote T`: the session's own picture, then its name in the stronger weight.
        leading: React.createElement(Avatar, {
            id: getSessionAvatarId(params.target.session, params.target.serverId),
            size: BOT_CHANGE_NOTICE_AVATAR_SIZE_PX,
        }),
        emphasis: name,
        undo: {
            label: t('bots.undo'),
            run: () => {
                retirePresentationNotice(key);
                fireAndForget((async () => {
                    const undone = await undoSessionBotChange({ address: params.address, accepted: params.accepted, previous: params.previous });
                    if (!undone.ok) publishPresentationNotice({ key, severity: 'error', message: t('bots.refused') });
                })(), { tag: 'sessionActionExecution.undoSessionBotChange' });
            },
        },
    });
}

function resolveStopArchiveFlow(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.stopArchiveFlow ?? stopSessionAndMaybeArchive;
}

function resolveStopSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['stopSession']> {
    return context?.operations?.stopSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.stop', sessionId, options));
}

function resolveArchiveSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['archiveSession']> {
    return context?.operations?.archiveSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.archive', sessionId, options));
}

function resolveUnarchiveSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['unarchiveSession']> {
    return context?.operations?.unarchiveSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.unarchive', sessionId, options));
}

function resolveRenameSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['renameSession']> {
    return context?.operations?.renameSession ?? ((sessionId, title, options) => executeSessionLifecycleAction('session.title.set', sessionId, options, title));
}

function resolveSetSessionRole(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.setSessionRole ?? roleActions.setSessionRole;
}

function resolveDeleteSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['deleteSession']> {
    return context?.operations?.deleteSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.delete', sessionId, options));
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
    throw new HappyError(result.message || fallbackMessage, false, { code: result.code, details: result.details });
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
        case SESSION_ACTION_TALK_ID: {
            if (!targetAddress || params.target.session.access?.capabilities.readTranscript !== true) {
                throw new HappyError('session_not_selected', false, { code: 'session_not_selected' });
            }
            const result = await executeVoiceAction('ui.voice_global.start', {
                target: { kind: 'session', sessionAddress: targetAddress }, expectedAttempt: null,
            }, { surface: 'ui', serverId: targetAddress.serverId });
            if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
            const output = VoiceConversationActionOutputSchemas['ui.voice_global.start'].parse(result.result);
            if (output.status === 'unavailable') throw new HappyError(output.code, false, { code: output.code });
            return;
        }
        case SESSION_ACTION_WORK_OPEN_ID: {
            if (!targetAddress || params.target.session.access?.capabilities.readTranscript !== true) return;
            router.push(buildScopedSessionRouteHref({ ...targetAddress,
                query: serializeSessionPaneUrlState({ rightTabId: 'agents' }),
            }) as Parameters<typeof router.push>[0]);
            return;
        }
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
        case SESSION_ACTION_MAKE_BOT_ID:
        case SESSION_ACTION_MAKE_REGULAR_ID: {
            const accepted = params.actionId === SESSION_ACTION_MAKE_BOT_ID ? { kind: 'bot' as const } : null;
            const previous = readSessionBotV1(params.target.session.metadata?.bot);
            const result = await sessionDisplayActions.setBot(params.target.sessionId, accepted,
                { serverId: params.target.serverId });
            if (!result.ok) throw new HappyError(result.error, false);
            if (targetAddress) publishSessionBotChangeNotice({ target: params.target, address: targetAddress, accepted, previous });
            return;
        }
        case SESSION_ACTION_TOOL_CALLS_TOGGLE_ID:
        case SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID: {
            // A surface without its own reading flips what the transcript shows now (same precedence owner).
            const showToolCalls = params.actionId === SESSION_ACTION_TOOL_CALLS_USE_DEFAULT_ID
                ? null
                : params.input?.showToolCalls ?? !resolveSessionToolCallsMenuState({
                    target: params.target,
                    accountShowToolCalls: getStorage().getState().settings.transcriptShowToolCalls,
                }).showToolCalls;
            const result = await sessionDisplayActions.setToolCalls(params.target.sessionId, showToolCalls,
                { serverId: params.target.serverId });
            if (!result.ok) throw new HappyError(result.error, false);
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
        case SESSION_ACTION_RAIL_PIN_ID:
        case SESSION_ACTION_RAIL_UNPIN_ID: {
            const result = await sessionOrganizationActions.setPin(params.target.sessionId,
                params.actionId === SESSION_ACTION_RAIL_PIN_ID, { serverId: params.target.serverId, surface: 'rail' });
            if (!result.ok) throw new HappyError(result.error, false, { code: result.errorCode });
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
