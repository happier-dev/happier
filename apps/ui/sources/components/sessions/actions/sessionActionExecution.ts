import { resolveSessionArchiveAddress, type SessionArchiveOperation } from '@/sync/domains/session/listing/sessionArchiveState';
import { roleActions } from '@/sync/ops/roles/roleActions';
import { readSessionAnswersWorkerQuestionsV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { showPutUnderSessionModal } from '@/components/sessions/work/PutUnderSessionModal';
import { showMakeCoordinatorDialog } from '@/components/sessions/coordinator/MakeCoordinatorDialog';
import { sessionCoordinatorActions } from '@/sync/ops/sessions/sessionCoordinatorActions';
import { sessionDisplayActions, undoSessionBotChange } from '@/sync/ops/sessions/sessionDisplayActions';
import { readSessionBotV1, type SessionBotV1 } from '@happier-dev/protocol/sessions/identity/sessionBotV1';
import { announceBotMarkerAccepted } from '@/components/sessions/bots/botMarkerFeedback';
import { publishPresentationNotice, retirePresentationNotice } from '@/components/sessions/presentation/presentationNotices';
import { getStorage } from '@/sync/domains/state/storageStore';

import * as React from 'react';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { getSessionAvatarId, getSessionName, getSessionStatus } from '@/utils/sessions/sessionUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { resolveSessionToolCallsMenuState } from './sessionToolCallsMenuState';
import { sessionOrganizationActions } from '@/sync/ops/sessionOrganization/sessionOrganizationActions';
import { t } from '@/text';
import { HappyError } from '@/utils/errors/errors';
import { router } from 'expo-router';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { serializeSessionPaneUrlState } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import { VoiceConversationActionOutputSchemas } from '@happier-dev/protocol/actions/voiceConversationActionFamily';
import { SessionArchiveActionResultV1Schema } from '@happier-dev/protocol/sessions/control/contract';
import type { SessionStopIntent } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { archiveSessionReports } from './confirmSessionArchive';
import {
    sessionSetManualReadStateWithServerScope,
} from '@/sync/ops';
import { sessionSetAttentionStandingWithServerScope } from '@/sync/ops/sessionOrganization';
import { normalizeSessionAddress, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import {
    archiveSessionWithPendingState,
    isSessionArchivePending,
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
    SESSION_ACTION_PUT_UNDER_ID,
    SESSION_ACTION_COORDINATOR_MAKE_ID,
    SESSION_ACTION_COORDINATOR_EDIT_ID,
    SESSION_ACTION_COORDINATOR_ANSWERS_ID,
    SESSION_ACTION_COORDINATOR_STOP_ID,
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
    options?: Readonly<{
        serverId?: string | null;
        stopIntent?: SessionStopIntent;
        alsoArchiveReports?: boolean;
        archiveOperation?: SessionArchiveOperation;
        confirmed?: true;
        signal?: AbortSignal;
        expectedAccountId?: string;
    }>,
    title?: string,
): Promise<SessionActionOperationResult> {
    const outcome = await (options?.confirmed ? executeVoiceAction.confirmed : executeVoiceAction)(actionId, { sessionId, ...(title === undefined ? {} : { title }),
        ...(actionId === 'session.stop' && options?.stopIntent ? { stopIntent: options.stopIntent } : {}),
        ...(actionId === 'session.archive' && options?.alsoArchiveReports !== undefined ? { alsoArchiveReports: options.alsoArchiveReports } : {}) }, createSessionLifecycleActionContext(sessionId, options));
    return readSessionLifecycleActionOutcome(actionId, outcome);
}

function createSessionLifecycleActionContext(sessionId: string, options: Parameters<typeof executeSessionLifecycleAction>[2]) {
    return {
        surface: 'ui' as const,
        defaultSessionId: sessionId,
        ...(options?.archiveOperation ? { archiveOperation: options.archiveOperation } : {}),
        ...(options?.serverId ? { serverId: options.serverId } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.expectedAccountId ? { expectedAccountId: options.expectedAccountId } : {}),
    };
}

function readSessionLifecycleActionOutcome(
    actionId: Parameters<typeof executeSessionLifecycleAction>[0],
    outcome: Awaited<ReturnType<typeof executeVoiceAction>>,
): SessionActionOperationResult {
    if (!outcome.ok) {
        const details = outcome.details;
        const message = outcome.errorCode === 'session_archive_timeout' ? undefined
            : details && typeof details === 'object' && 'error' in details && typeof details.error === 'string'
                ? details.error : outcome.error;
        return { success: false, message, code: outcome.errorCode,
            ...(details === undefined ? {} : { details }) };
    }
    const result = outcome.result;
    const lifecycle = classifyHomeActionOutcome(outcome);
    if (lifecycle.kind === 'approval_pending') return { success: false, code: 'approval_request_created', message: 'approval_request_created', details: result };
    // The title Action acknowledges a metadata write; lifecycle transports retain
    // their success/recovery envelope for the incumbent stop/archive flow.
    if (actionId === 'session.title.set') return { success: true };
    if (actionId === 'session.archive') {
        const archived = SessionArchiveActionResultV1Schema.safeParse(result);
        return archived.success ? archived.data : { success: false, code: 'invalid_action_output', message: 'invalid_action_output' };
    }
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

/**
 * Stop coordinating's receipt (lab P3 L): the rules it removed come back with Undo, each through the
 * version-bound Follow writer. A partial stop says so; nothing pretends the session still coordinates.
 */
function publishCoordinatorStopNotice(
    target: SessionActionTarget,
    address: SessionAddress,
    stopped: Awaited<ReturnType<typeof sessionCoordinatorActions.stop>>,
) {
    const name = getSessionName(target.session, target.serverId);
    const key = `session-coordinator-stop:${address.serverId}:${address.sessionId}`;
    publishPresentationNotice({
        key,
        severity: stopped.status === 'partial' ? 'error' : 'info',
        message: stopped.status === 'partial' ? t('sessionCoordinator.menu.stopPartial', { name }) : t('sessionCoordinator.menu.stopped', { name }),
        emphasis: name,
        ...(stopped.undo.removed.length > 0 ? { undo: {
            label: t('bots.undo'),
            run: () => {
                retirePresentationNotice(key);
                fireAndForget((async () => {
                    const restored = await sessionCoordinatorActions.undoStop(stopped.undo);
                    if (restored.status !== 'restored') publishPresentationNotice({ key, severity: 'error', message: t('sessionCoordinator.menu.undoStopFailed') });
                })(), { tag: 'sessionActionExecution.undoCoordinatorStop' });
            },
        } } : {}),
    });
}

function resolveStopArchiveFlow(context: SessionActionExecutionContext | undefined) {
    return context?.operations?.stopArchiveFlow ?? stopSessionAndMaybeArchive;
}

function resolveStopSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['stopSession']> {
    return context?.operations?.stopSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.stop', sessionId, options));
}

function resolveArchiveSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['archiveSession']> {
    const archive = context?.operations?.archiveSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.archive', sessionId, options));
    return async (sessionId, options) => {
        const result = await archive(sessionId, options);
        if (result.success) await archiveSessionReports({ ...result, serverId: options?.serverId });
        return result;
    };
}

function resolveUnarchiveSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['unarchiveSession']> {
    return context?.operations?.unarchiveSession ?? ((sessionId, options) => executeSessionLifecycleAction('session.unarchive', sessionId, options));
}

function resolveRenameSession(context: SessionActionExecutionContext | undefined): NonNullable<SessionActionExecutionOperations['renameSession']> {
    return context?.operations?.renameSession ?? ((sessionId, title, options) => executeSessionLifecycleAction('session.title.set', sessionId, options, title));
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

function throwIfFailed(result: SessionActionOperationResult | void, fallbackMessage: string): void {
    if (!result || result.success) return;
    const message = result.message && result.message !== result.code ? result.message : fallbackMessage;
    throw new HappyError(message, false, { code: result.code, details: result.details });
}

function throwUnsupportedSingleTargetAction(): never {
    throw new HappyError(t('errors.unknownError'), false);
}

async function runStopArchiveFlow(params: Readonly<{
    target: SessionActionTarget;
    address: SessionAddress;
    context?: SessionActionExecutionContext;
    archiveAfterStop: 'always' | 'never';
    alsoArchiveReports?: boolean;
}>): Promise<void | false> {
    const stopArchiveFlow = resolveStopArchiveFlow(params.context);
    const stopSession = resolveStopSession(params.context);
    const archiveSession = resolveArchiveSession(params.context);
    return await stopArchiveFlow({
        address: params.address,
        hideInactiveSessions: params.context?.hideInactiveSessions === true,
        isPinned: params.target.isPinned,
        archiveAfterStop: params.archiveAfterStop,
        stopSession: async () => {
            const result = await stopSession(params.address.sessionId, { serverId: params.address.serverId });
            if (result.success && params.archiveAfterStop === 'never') {
                publishPresentationNotice({ key: `session-stop:${params.address.serverId}:${params.address.sessionId}`,
                    severity: 'info', message: t('sessionInfo.sessionStopped') });
            }
            return result;
        },
        archiveSession: async (archiveOperation) => await archiveSession(params.address.sessionId, { serverId: params.address.serverId, archiveOperation,
            ...(params.alsoArchiveReports !== undefined ? { alsoArchiveReports: params.alsoArchiveReports } : {}) }),
        stopErrorMessage: t('sessionInfo.failedToStopSession'),
        archiveErrorMessage: t('sessionInfo.failedToArchiveSession'),
    });
}

async function executeArchiveAction(
    target: SessionActionTarget,
    targetAddress: SessionAddress,
    context?: SessionActionExecutionContext,
    alsoArchiveReports?: boolean,
): Promise<void | false> {
    const address = resolveSessionArchiveAddress(targetAddress);
    if (!address) throwUnsupportedSingleTargetAction();
    if (isSessionArchivePending(address)) return false;
    const archiveSession = resolveArchiveSession(context);
    if (target.isActive || target.hasRecoverableTerminalHost) {
        return await runStopArchiveFlow({ target, address, context, archiveAfterStop: 'always', alsoArchiveReports });
    }
    const result = await archiveSessionWithPendingState(address, (archiveOperation) => archiveSession(address.sessionId, {
        archiveOperation,
        serverId: address.serverId,
        ...(alsoArchiveReports !== undefined ? { alsoArchiveReports } : {}),
    }));
    if (result === false) return false;
    if (!result.success) {
        if (isSessionActiveArchiveResult(result)) {
            return await runStopArchiveFlow({ target, address, context, archiveAfterStop: 'always', alsoArchiveReports });
        }
        throwIfFailed(result, t('sessionInfo.failedToArchiveSession'));
    }
}

export async function executeSessionAction(params: Readonly<{
    actionId: SessionActionId;
    target: SessionActionTarget;
    input?: SessionActionExecutionInput;
    context?: SessionActionExecutionContext;
}>): Promise<void | false> {
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
        case SESSION_ACTION_MAKE_BOT_ID:
        case SESSION_ACTION_MAKE_REGULAR_ID: {
            const accepted = params.actionId === SESSION_ACTION_MAKE_BOT_ID ? { kind: 'bot' as const } : null;
            const previous = readSessionBotV1(params.target.session.metadata?.bot);
            const result = await sessionDisplayActions.setBot(params.target.sessionId, accepted,
                { serverId: params.target.serverId });
            if (!result.ok) throw new HappyError(result.error, false);
            if (targetAddress) {
                publishSessionBotChangeNotice({ target: params.target, address: targetAddress, accepted, previous });
                // Accepted only: the header mark acknowledges it and the rail's Bots entry nudges (lab `b-promote`).
                announceBotMarkerAccepted({ serverId: targetAddress.serverId, sessionId: targetAddress.sessionId, bot: accepted !== null });
            }
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
        case SESSION_ACTION_COORDINATOR_MAKE_ID:
            if (!targetAddress) throwUnsupportedSingleTargetAction();
            showMakeCoordinatorDialog(targetAddress);
            return;
        case SESSION_ACTION_COORDINATOR_EDIT_ID:
            if (!targetAddress) throwUnsupportedSingleTargetAction();
            // People, on what it follows (its Following section; coordination lab P1p).
            router.push(buildScopedSessionRouteHref({ ...targetAddress,
                query: { ...serializeSessionPaneUrlState({ rightTabId: 'collaboration' }), collaborationFocus: 'following' },
            }) as Parameters<typeof router.push>[0]);
            return;
        case SESSION_ACTION_COORDINATOR_ANSWERS_ID: {
            if (!targetAddress) throwUnsupportedSingleTargetAction();
            const setAnswers = params.context?.operations?.setSessionAnswersWorkerQuestions ?? roleActions.setSessionAnswersWorkerQuestions;
            const enabled = !readSessionAnswersWorkerQuestionsV1(params.target.session.metadata);
            const result = await setAnswers(targetAddress.sessionId, enabled, { serverId: targetAddress.serverId });
            if (!result.ok) throw new HappyError(t('errors.unknownError'), false);
            return;
        }
        case SESSION_ACTION_COORDINATOR_STOP_ID: {
            if (!targetAddress) throwUnsupportedSingleTargetAction();
            const stopped = await sessionCoordinatorActions.stop(targetAddress.sessionId, { serverId: targetAddress.serverId });
            if (stopped.status === 'unavailable') throw new HappyError(t('sessionCoordinator.menu.stopFailed'), false);
            publishCoordinatorStopNotice(params.target, targetAddress, stopped);
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
            return await executeArchiveAction(params.target, targetAddress, params.context, params.input?.alsoArchiveReports);
        case SESSION_ACTION_UNARCHIVE_ID:
            throwIfFailed(
                await resolveUnarchiveSession(params.context)(params.target.sessionId, { serverId: params.target.serverId }),
                t('sessionInfo.failedToUnarchiveSession'),
            );
            return;
        case SESSION_ACTION_DELETE_ID:
            if (!params.target.serverId || (!params.target.canDelete && !params.target.canStopAndDelete)) {
                throw new HappyError(t('sessionInfo.failedToDeleteSession'), false);
            }
            throwIfFailed(await resolveDeleteSession(params.context)(params.target.sessionId, {
                serverId: params.target.serverId,
                confirmed: params.context?.confirmed,
            }), t('sessionInfo.failedToDeleteSession'));
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
