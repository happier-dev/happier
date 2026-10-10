import { DEFAULT_SESSION_INACTIVE_RESUME_POLICY } from '@happier-dev/protocol/account/settings/accountSettings';
import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { normalizeParticipantRecipientRoutingIdentityV1, withParticipantRecipientV1 } from '@happier-dev/protocol/messages/structured/participantMessageV1';
import { withSessionUserMessageDeliveryIntentMeta } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol/sessions/pending/pendingRequestedActionV1';

import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { classifyAgentSessionComposerNonSteerablePayload } from '@/agents/registry/registryUiBehavior';
import { HappyError } from '@/utils/errors/errors';
import {
    canDirectSubmitUserMessageNow,
    decideSessionMessageDelivery,
    isPendingQueueSubmitKnownUnsupported,
    type SessionMessageDeliveryDecision,
    type MessageSendMode,
} from '@/sync/domains/session/control/submitMode';

import type {
    DirectMessageSubmitResult,
    DirectMessageBypassReason,
    PendingMessageSubmitResult,
    SessionSubmitPort,
    SubmitPersistence,
    SubmitSessionUserMessageOptions,
    SubmitSessionUserMessageResult,
} from './types';
import { SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE } from './types';
import { SESSION_INPUT_ACCOUNT_SCOPE_RETIRED_ERROR_CODE } from './types';
import { recordSessionMessageDeliveryDecision } from './sessionMessageDeliveryTelemetry';
import {
    canSendUserMessageToSession,
    SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
} from './sessionMessageSendEligibility';

type ResolvedSubmitDecision = Readonly<{
    decision: SessionMessageDeliveryDecision;
    opts: SubmitSessionUserMessageOptions;
    supportRefreshAttempted: boolean;
    supportRefreshSucceeded: boolean;
    supportRefreshErrorMessage?: string;
}>;

function isSubmitAccountLifetimeCurrent(opts: SubmitSessionUserMessageOptions): boolean {
    return opts.accountLifetime?.isCurrent() !== false;
}

function accountScopeRetiredResult(
    type: 'rejected' | 'send_failed' = 'rejected',
    persistence: SubmitPersistence = 'none',
    localId?: string,
): SubmitSessionUserMessageResult {
    return {
        type,
        persistence,
        ...(localId ? { localId } : {}),
        wake: { attempted: false, state: 'not_needed' },
        errorCode: SESSION_INPUT_ACCOUNT_SCOPE_RETIRED_ERROR_CODE,
        errorMessage: 'Session Account authority is unavailable',
    };
}

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function getErrorCode(error: unknown): string | undefined {
    if (error instanceof HappyError && typeof error.code === 'string' && error.code.trim().length > 0) {
        return error.code;
    }
    if (!error || typeof error !== 'object' || Array.isArray(error)) {
        return undefined;
    }
    const record = error as Readonly<Record<string, unknown>>;
    const code = record.errorCode ?? record.code;
    return typeof code === 'string' && code.trim().length > 0 ? code : undefined;
}

function getSubmitSendFailure(error: unknown, fallback: string): Pick<SubmitSessionUserMessageResult, 'errorCode' | 'errorMessage'> {
    const errorCode = getErrorCode(error);
    return {
        ...(errorCode ? { errorCode } : {}),
        errorMessage: getErrorMessage(error, fallback),
    };
}

function readLocalId(result: PendingMessageSubmitResult | DirectMessageSubmitResult): string | undefined {
    return result && typeof result === 'object' && typeof result.localId === 'string'
        ? result.localId
        : undefined;
}

type DirectSubmitPersistence = Extract<SubmitPersistence, 'pending' | 'transcript_committed' | 'provider_direct'>;

function readDirectSubmitPersistence(result: DirectMessageSubmitResult): DirectSubmitPersistence | undefined {
    if (!result || typeof result !== 'object') {
        return undefined;
    }
    switch (result.persistence) {
        case 'pending':
        case 'transcript_committed':
        case 'provider_direct':
            return result.persistence;
        default:
            return undefined;
    }
}

function hasTranscriptCommitEvidence(result: DirectMessageSubmitResult): boolean {
    return Boolean(
        result
            && typeof result === 'object'
            && typeof result.seq === 'number'
            && Number.isFinite(result.seq),
    );
}

function resolveDirectSubmitPersistence(
    result: DirectMessageSubmitResult,
    sawLocalPendingProjection: boolean,
): DirectSubmitPersistence {
    return readDirectSubmitPersistence(result)
        ?? (hasTranscriptCommitEvidence(result)
            ? 'transcript_committed'
            : sawLocalPendingProjection
                ? 'pending'
                : 'transcript_committed');
}

function resolveSubmitDecision(opts: SubmitSessionUserMessageOptions): SessionMessageDeliveryDecision {
    return decideSessionMessageDelivery({
        configuredMode: opts.configuredMode,
        busySteerSendPolicy: opts.busySteerSendPolicy,
        sessionInactiveResumePolicy: opts.sessionInactiveResumePolicy,
        explicitMode: opts.explicitMode,
        session: opts.session,
        nowMs: opts.nowMs,
        forceImmediate: opts.forceImmediate,
        providerNonSteerableReason: classifyAgentSessionComposerNonSteerablePayload({
            session: opts.session,
            agentTargetKey: opts.agentTargetKey ?? null,
            metaOverrides: opts.metaOverrides,
            currentRunnerProcessIdentity: opts.currentRunnerProcessIdentity ?? null,
        }),
        // G4 payload honesty: give the delivery decision the payload facts and the explicit
        // per-message user choices from the busy-send affordance.
        text: opts.text,
        nonSteerableSendPrompt: opts.nonSteerableSendPrompt,
        permissionModeApplyTiming: opts.permissionModeApplyTiming,
        applyConfigAndSteer: opts.applyConfigAndSteer,
        steerWithoutConfig: opts.steerWithoutConfig,
    });
}

function requestedPendingQueue(opts: SubmitSessionUserMessageOptions): boolean {
    const requestedMode = opts.explicitMode ?? opts.configuredMode;
    return requestedMode === 'server_pending' || requestedMode === 'interrupt';
}

function usesExistingDurablePendingMessage(opts: SubmitSessionUserMessageOptions): boolean {
    return opts.existingDurablePendingMessage === true
        && readPendingLocalId(opts.localId) !== null;
}

function isUnknownPendingQueueSupport(decision: SessionMessageDeliveryDecision): boolean {
    return decision.pendingSupportState === 'unknown_session'
        || decision.pendingSupportState === 'unknown_pending_version';
}

function shouldFailClosedForUnknownPendingSupport(
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
): boolean {
    if (usesExistingDurablePendingMessage(opts)) {
        return false;
    }
    if (!isUnknownPendingQueueSupport(decision)) {
        return false;
    }

    if (
        decision.intent === 'explicit_immediate'
        && decision.mode === 'agent_queue'
        && canDirectSubmitUserMessageNow({ session: opts.session, nowMs: opts.nowMs })
    ) {
        return false;
    }

    return decision.mode === 'server_pending'
        || requestedPendingQueue(opts)
        || !canDirectSubmitUserMessageNow({ session: opts.session, nowMs: opts.nowMs });
}

function shouldRefreshUnknownPendingSupport(
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
): boolean {
    return shouldFailClosedForUnknownPendingSupport(opts, decision);
}

function shouldRejectUnsupportedPendingQueue(
    opts: SubmitSessionUserMessageOptions,
    mode: MessageSendMode,
): boolean {
    if (usesExistingDurablePendingMessage(opts)) {
        return false;
    }
    if (!requestedPendingQueue(opts) || !isPendingQueueSubmitKnownUnsupported(opts.session)) {
        return false;
    }

    if (
        opts.forceImmediate === true
        && mode === 'agent_queue'
        && canDirectSubmitUserMessageNow({ session: opts.session, nowMs: opts.nowMs })
    ) {
        return false;
    }

    return true;
}

function rejectUnsupportedPendingQueue(): SubmitSessionUserMessageResult {
    return {
        type: 'rejected',
        persistence: 'none',
        wake: { attempted: false, state: 'not_needed' },
        errorCode: 'PENDING_QUEUE_UNSUPPORTED',
        errorMessage: 'The pending queue is unavailable for this session. Update the agent runtime or send this message immediately.',
    };
}

function shouldRejectUnsupportedRemoteVoiceTarget(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
): boolean {
    return opts.hostAdmissionOrigin === 'voice'
        && !usesExistingDurablePendingMessage(opts)
        && isPendingQueueSubmitKnownUnsupported(opts.session)
        && port.isSessionTargetRemoteToActiveServer(opts.sessionId);
}

function rejectUnsupportedRemoteVoiceTarget(): SubmitSessionUserMessageResult {
    return {
        type: 'rejected',
        persistence: 'none',
        wake: { attempted: false, state: 'not_needed' },
        errorCode: SESSION_INPUT_TARGET_UPDATE_REQUIRED_ERROR_CODE,
        errorMessage: 'The selected remote session requires an updated agent runtime before Voice can send a message.',
    };
}

function rejectUnknownPendingQueueSupport(errorMessage?: string): SubmitSessionUserMessageResult {
    return {
        type: 'rejected',
        persistence: 'none',
        wake: { attempted: false, state: 'not_needed' },
        errorCode: 'PENDING_QUEUE_SUPPORT_UNKNOWN',
        errorMessage: errorMessage
            ? `The pending queue could not be confirmed for this session: ${errorMessage}`
            : 'The pending queue could not be confirmed for this session. Try again after the session refreshes or send this message immediately.',
    };
}

function rejectInactiveSessionNotResumable(): SubmitSessionUserMessageResult {
    return {
        type: 'rejected',
        persistence: 'none',
        wake: { attempted: false, state: 'not_needed' },
        errorCode: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
        errorMessage: 'This inactive session cannot be resumed, so the message was not queued.',
    };
}

function shouldRejectInactiveNonResumablePendingWake(
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
): boolean {
    if (decision.mode !== 'server_pending') return false;
    return !canSendUserMessageToSession(opts.session, {
        resumeCapabilityOptions: opts.resumeCapabilityOptions,
    });
}

async function resolveSubmitDecisionWithSupportRefresh(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
): Promise<ResolvedSubmitDecision> {
    const decision = resolveSubmitDecision(opts);
    if (!shouldRefreshUnknownPendingSupport(opts, decision) || !port.refreshSessionForSubmit) {
        return {
            decision,
            opts,
            supportRefreshAttempted: false,
            supportRefreshSucceeded: false,
        };
    }

    try {
        const refreshedSession = await port.refreshSessionForSubmit(opts.sessionId, {
            serverId: opts.serverId ?? null,
            ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime } : {}),
        });
        if (refreshedSession) {
            const refreshedOpts = {
                ...opts,
                session: refreshedSession,
            };
            return {
                decision: resolveSubmitDecision(refreshedOpts),
                opts: refreshedOpts,
                supportRefreshAttempted: true,
                supportRefreshSucceeded: true,
            };
        }

        return {
            decision,
            opts,
            supportRefreshAttempted: true,
            supportRefreshSucceeded: false,
        };
    } catch (error) {
        return {
            decision,
            opts,
            supportRefreshAttempted: true,
            supportRefreshSucceeded: false,
            supportRefreshErrorMessage: getErrorMessage(error, 'session refresh failed'),
        };
    }
}

function getDirectMessageBypassReason(
    opts: SubmitSessionUserMessageOptions,
    mode: MessageSendMode,
): DirectMessageBypassReason {
    if (mode === 'interrupt') {
        return 'interrupt';
    }
    if (opts.forceImmediate === true) {
        return 'force_immediate';
    }
    return 'selected_direct';
}

async function switchRemoteAfterPendingEnqueueIfNeeded(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
): Promise<void> {
    if (opts.requestRemoteControlAfterPendingEnqueue !== true || !port.switchSessionControlToRemote) {
        return;
    }

    try {
        await port.switchSessionControlToRemote(
            opts.sessionId,
            ...((opts.serverId || opts.accountLifetime) ? [{
                ...(opts.serverId ? { serverId: opts.serverId } : {}),
                ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime } : {}),
            }] as const : [] as const),
        );
    } catch {
        // Non-fatal: the message is already persisted in the pending queue.
    }
}

function requestedActionRequiresRuntimeActivation(action: PendingRequestedActionV1): boolean {
    return action.kind === 'send_now' || action.kind === 'steer_now';
}

function selectInactiveSessionResumePolicy(
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
    requestedAction: PendingRequestedActionV1,
): 'when_available' | 'online_only' | null {
    if (
        opts.requestedAction === undefined
        && decision.intent === 'default'
        && requestedAction.kind === 'enqueue'
        && (opts.session.active === false || opts.session.presence !== 'online')
    ) {
        const policy = opts.sessionInactiveResumePolicy ?? DEFAULT_SESSION_INACTIVE_RESUME_POLICY;
        return policy === 'when_available' || policy === 'online_only' ? policy : null;
    }
    return null;
}

async function shouldWakePendingInputFromUi(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
    machineId: string,
): Promise<boolean> {
    if (!isSubmitAccountLifetimeCurrent(opts)) return false;
    if (!port.shouldDelegatePendingActivationToDaemon) return true;
    const delegated = await port.shouldDelegatePendingActivationToDaemon(opts.session, opts.serverId, machineId);
    if (!isSubmitAccountLifetimeCurrent(opts)) return false;
    return !delegated;
}

async function directSend(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
    bypassPendingQueueReason: DirectMessageBypassReason,
): Promise<SubmitSessionUserMessageResult> {
    if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult();
    let handoffLocalId: string | undefined;
    let sawLocalPendingProjection = false;
    let reportedOutboundHandoff = false;
    try {
        const sendOptions = {
            profileId: opts.profileId ?? undefined,
            localId: opts.localId ?? undefined,
            ...(opts.hostAdmissionOrigin ? { hostAdmissionOrigin: opts.hostAdmissionOrigin } : {}),
            ...(opts.allowedModels ? { allowedModels: opts.allowedModels } : {}),
            ...(opts.allowedPermissionModes ? { allowedPermissionModes: opts.allowedPermissionModes } : {}),
            bypassPendingQueueReason,
            ...(opts.serverId ? { serverId: opts.serverId } : {}),
            ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime, session: opts.session } : {}),
            onLocalPendingProjectionCreated: opts.onOutboundHandoff
                ? ({ localId }: { localId: string }) => {
                    sawLocalPendingProjection = true;
                    handoffLocalId = localId;
                    // An exact routed submit keeps Composer custody until the
                    // captured credential is still current after admission.
                    if (opts.accountLifetime) return;
                    reportedOutboundHandoff = true;
                    opts.onOutboundHandoff?.({
                        persistence: 'pending',
                        localId,
                    });
                }
                : undefined,
        };
        const sendResult = await port.sendMessage(
            opts.sessionId,
            opts.text,
            opts.displayText,
            opts.metaOverrides,
            sendOptions,
        );
        const localId = readLocalId(sendResult) ?? handoffLocalId ?? opts.localId ?? undefined;
        const persistence = resolveDirectSubmitPersistence(sendResult, sawLocalPendingProjection);
        if (!isSubmitAccountLifetimeCurrent(opts)) {
            // The transport result is the custody fact. Retirement after an ACK
            // must not reinterpret an accepted prompt as a failed send, while
            // the retired Composer owner remains fenced from clearing its draft.
            return {
                type: 'success',
                persistence,
                ...(sendResult?.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
                wake: { attempted: false, state: 'not_needed' },
                localId,
            };
        }
        if (!reportedOutboundHandoff) {
            opts.onOutboundHandoff?.({
                persistence,
                ...(localId ? { localId } : {}),
            });
        }
        return {
            type: 'success',
            persistence,
            ...(sendResult?.providerAcceptancePending === true ? { providerAcceptancePending: true } : {}),
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    } catch (error) {
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            ...(handoffLocalId ? { localId: handoffLocalId } : {}),
            ...getSubmitSendFailure(error, 'Failed to send message'),
        };
    }
}

async function enqueuePending(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
    decision?: SessionMessageDeliveryDecision,
): Promise<SubmitSessionUserMessageResult> {
    if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult();
    const isExecutionRun = opts.recipient?.kind === 'execution_run';
    const requestedAction = opts.requestedAction ?? decision?.requestedAction ?? { v: 1, kind: 'enqueue' as const };
    const inactiveResumePolicy = !isExecutionRun && decision !== undefined
        ? selectInactiveSessionResumePolicy(opts, decision, requestedAction)
        : null;
    const wakeOpts = !isExecutionRun && (requestedActionRequiresRuntimeActivation(requestedAction) || inactiveResumePolicy !== null) ? getPendingQueueWakeResumeOptions({
        sessionId: opts.sessionId,
        session: opts.session,
        resumeCapabilityOptions: opts.resumeCapabilityOptions,
        resumeTargetOverride: opts.resumeTargetOverride,
        permissionOverride: opts.permissionOverride,
        canWakeMachineId: port.canWakeMachineId,
    }) : null;

    let enqueueResult: PendingMessageSubmitResult;
    let handoffLocalId: string | undefined;
    let wakeFromUiForWhenAvailable: boolean | null = null;
    try {
        wakeFromUiForWhenAvailable = inactiveResumePolicy === 'when_available' && wakeOpts
            ? await shouldWakePendingInputFromUi(port, opts, wakeOpts.machineId)
            : null;
        if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult();
        enqueueResult = await port.enqueuePendingMessage(
            opts.sessionId,
            opts.text,
            opts.displayText,
            decision ? withSessionUserMessageDeliveryIntentMeta(opts.metaOverrides, decision.intent) : opts.metaOverrides,
            {
                localId: opts.localId,
                ...(opts.serverId ? { serverId: opts.serverId } : {}),
                ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime } : {}),
                ...(opts.recipient ? { recipient: opts.recipient } : {}),
                ...(opts.hostAdmissionOrigin ? { hostAdmissionOrigin: opts.hostAdmissionOrigin } : {}),
                ...(opts.allowedModels ? { allowedModels: opts.allowedModels } : {}),
                ...(opts.allowedPermissionModes ? { allowedPermissionModes: opts.allowedPermissionModes } : {}),
                requestedAction,
                ...(wakeFromUiForWhenAvailable === false ? { resumeWhenAvailable: true as const } : {}),
                onLocalPendingProjectionCreated: opts.onOutboundHandoff
                    ? ({ localId }) => {
                        handoffLocalId = localId;
                    }
                    : undefined,
            },
        );
        if (!isSubmitAccountLifetimeCurrent(opts)) {
            return accountScopeRetiredResult('send_failed', enqueueResult?.cancelled ? 'none' : 'pending', readLocalId(enqueueResult) ?? handoffLocalId);
        }
    } catch (error) {
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            ...getSubmitSendFailure(error, 'Failed to enqueue message'),
        };
    }

    const localId = readLocalId(enqueueResult) ?? handoffLocalId;
    let handoffReported = false;
    const reportHandoffIfCurrent = (): boolean => {
        if (!isSubmitAccountLifetimeCurrent(opts)) return false;
        if (!handoffReported) {
            handoffReported = true;
            opts.onOutboundHandoff?.({
                persistence: 'pending',
                ...(localId ? { localId } : {}),
            });
        }
        return true;
    };
    if (enqueueResult && typeof enqueueResult === 'object' && enqueueResult.cancelled === true) {
        return {
            type: 'rejected',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorCode: 'PENDING_MESSAGE_CANCELLED',
            errorMessage: 'Pending message was cancelled before dispatch',
            localId,
        };
    }
    // Pending already owns this input. Runtime wake is a later lifecycle phase,
    // not a prerequisite for handing off the still-current Composer snapshot.
    if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
    if (enqueueResult && typeof enqueueResult === 'object' && enqueueResult.accepted === false) {
        if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
        return {
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }
    if (isExecutionRun || (enqueueResult && typeof enqueueResult === 'object' && enqueueResult.terminal === true)) {
        if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
        return {
            type: 'success',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }
    if (!wakeOpts) {
        if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
        return {
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }

    if (inactiveResumePolicy === 'online_only' && port.isMachineReachable?.(wakeOpts.machineId) !== true) {
        if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
        return {
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }

    const shouldWakeFromUi = wakeFromUiForWhenAvailable
        ?? (inactiveResumePolicy === 'online_only'
            ? true
            : await shouldWakePendingInputFromUi(port, opts, wakeOpts.machineId));
    if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
    if (!shouldWakeFromUi) {
        if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
        return {
            type: 'success',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }

    const resumeOptions = {
        ...wakeOpts,
        ...(opts.serverId ? { serverId: opts.serverId } : {}),
        ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime } : {}),
    };

    try {
        // The enqueue ACK does not carry native enrollment authority. Read the
        // current Session after acceptance, in the same captured Account/Home.
        const currentSession = port.refreshSessionForSubmit ? await port.refreshSessionForSubmit(opts.sessionId, {
            ...(opts.serverId ? { serverId: opts.serverId } : {}),
            ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime } : {}),
        }) : undefined;
        if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
        const wakeResult = await port.ensureSessionRuntimeForPendingInput({
            ...resumeOptions,
            ...(currentSession ? { pendingActivationAuthorization: currentSession.pendingActivationAuthorization } : {}),
        });
        if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
        if (wakeResult.type === 'pending') {
            await switchRemoteAfterPendingEnqueueIfNeeded(port, opts);
            if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
            return { type: 'wake_pending', persistence: 'pending', wake: { attempted: false, state: 'pending' }, localId };
        }
        if (wakeResult.type === 'error') {
            await switchRemoteAfterPendingEnqueueIfNeeded(port, opts);
            if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
            return {
                type: 'wake_failed',
                persistence: 'pending',
                wake: {
                    attempted: true,
                    state: 'failed',
                    errorMessage: wakeResult.errorMessage,
                },
                errorCode: wakeResult.errorCode,
                errorMessage: wakeResult.errorMessage,
                localId,
            };
        }
    } catch (error) {
        if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
        const errorMessage = getErrorMessage(error, 'Failed to resume session');
        await switchRemoteAfterPendingEnqueueIfNeeded(port, opts);
        if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
        return {
            type: 'wake_failed',
            persistence: 'pending',
            wake: {
                attempted: true,
                state: 'failed',
                errorMessage,
            },
            errorMessage,
            localId,
        };
    }

    await switchRemoteAfterPendingEnqueueIfNeeded(port, opts);
    if (!reportHandoffIfCurrent()) return accountScopeRetiredResult('send_failed', 'pending', localId);
    return {
        type: 'success',
        persistence: 'pending',
        wake: { attempted: true, state: 'started' },
        localId,
    };
}

export async function submitSessionUserMessage(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
): Promise<SubmitSessionUserMessageResult> {
    if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult();
    if (opts.recipient) {
        try {
            const recipient = normalizeParticipantRecipientRoutingIdentityV1(opts.recipient);
            opts = { ...opts, recipient };
            if (recipient.kind === 'execution_run') {
                // The caller selects intent from the exact Run projection; parent
                // activity, direct-send compatibility and wake policy are unrelated.
                if (usesExistingDurablePendingMessage(opts)) {
                    const localId = opts.localId!;
                    if (!port.updatePendingRequestedAction) throw new Error('Pending action mutation is unavailable');
                    await port.updatePendingRequestedAction(
                        opts.sessionId,
                        localId,
                        opts.requestedAction ?? { v: 1, kind: 'enqueue' },
                        ...((opts.serverId || opts.accountLifetime) ? [{
                            ...(opts.serverId ? { serverId: opts.serverId } : {}),
                            ...(opts.accountLifetime ? { accountLifetime: opts.accountLifetime } : {}),
                        }] as const : [] as const),
                    );
                    if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult('send_failed', 'pending', opts.localId ?? undefined);
                    return { type: 'success', persistence: 'pending', wake: { attempted: false, state: 'not_needed' }, localId };
                }
                return await enqueuePending(port, opts);
            }
            opts = { ...opts, metaOverrides: withParticipantRecipientV1(opts.metaOverrides ?? {}, recipient) };
        } catch (error) {
            return {
                type: 'send_failed',
                persistence: usesExistingDurablePendingMessage(opts) ? 'pending' : 'none',
                wake: { attempted: false, state: 'not_needed' },
                ...getSubmitSendFailure(error, 'Failed to submit participant input'),
            };
        }
    }
    const resolved = await resolveSubmitDecisionWithSupportRefresh(port, opts);
    if (!isSubmitAccountLifetimeCurrent(opts)) return accountScopeRetiredResult();
    const decision = resolved.decision;
    const effectiveOpts = resolved.opts;
    const mode = decision.mode;
    recordSessionMessageDeliveryDecision({
        sessionId: effectiveOpts.sessionId,
        session: effectiveOpts.session,
        selectedMode: mode,
        decisionReason: decision.reason,
        configuredMode: effectiveOpts.configuredMode,
        busySteerSendPolicy: effectiveOpts.busySteerSendPolicy,
        explicitMode: effectiveOpts.explicitMode,
        forceImmediate: effectiveOpts.forceImmediate,
        callerSurface: effectiveOpts.callerSurface,
        localId: effectiveOpts.localId,
        nowMs: effectiveOpts.nowMs,
        supportRefreshAttempted: resolved.supportRefreshAttempted,
        supportRefreshSucceeded: resolved.supportRefreshSucceeded,
    });

    if (shouldRejectUnsupportedRemoteVoiceTarget(port, effectiveOpts)) {
        return rejectUnsupportedRemoteVoiceTarget();
    }

    if (shouldRejectUnsupportedPendingQueue(effectiveOpts, mode)) {
        return rejectUnsupportedPendingQueue();
    }

    if (shouldFailClosedForUnknownPendingSupport(effectiveOpts, decision)) {
        return rejectUnknownPendingQueueSupport(resolved.supportRefreshErrorMessage);
    }

    if (!usesExistingDurablePendingMessage(effectiveOpts) && shouldRejectInactiveNonResumablePendingWake(effectiveOpts, decision)) {
        return rejectInactiveSessionNotResumable();
    }

    if (usesExistingDurablePendingMessage(effectiveOpts)) {
        const localId = effectiveOpts.localId!;
        const requestedAction = effectiveOpts.requestedAction ?? decision.requestedAction ?? { v: 1, kind: 'enqueue' as const };
        try {
            if (!port.updatePendingRequestedAction) {
                throw new Error('Pending action mutation is unavailable');
            }
            await port.updatePendingRequestedAction(
                effectiveOpts.sessionId,
                localId,
                requestedAction,
                ...((effectiveOpts.serverId || effectiveOpts.accountLifetime) ? [{
                    ...(effectiveOpts.serverId ? { serverId: effectiveOpts.serverId } : {}),
                    ...(effectiveOpts.accountLifetime ? { accountLifetime: effectiveOpts.accountLifetime } : {}),
                }] as const : [] as const),
            );
            if (!isSubmitAccountLifetimeCurrent(effectiveOpts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
        } catch (error) {
            const failure = getSubmitSendFailure(error, 'Failed to update pending action');
            return {
                type: 'wake_failed',
                persistence: 'pending',
                wake: { attempted: true, state: 'failed', errorMessage: failure.errorMessage },
                ...failure,
                localId,
            };
        }
        const wakeOpts = requestedActionRequiresRuntimeActivation(requestedAction) ? getPendingQueueWakeResumeOptions({
            sessionId: effectiveOpts.sessionId,
            session: effectiveOpts.session,
            resumeCapabilityOptions: effectiveOpts.resumeCapabilityOptions,
            resumeTargetOverride: effectiveOpts.resumeTargetOverride,
            permissionOverride: effectiveOpts.permissionOverride,
            canWakeMachineId: port.canWakeMachineId,
        }) : null;
        if (!wakeOpts) {
            if (requestedActionRequiresRuntimeActivation(requestedAction) && effectiveOpts.session.active === false) {
                const errorMessage = 'This inactive session cannot be resumed; the pending message remains queued.';
                return {
                    type: 'wake_failed',
                    persistence: 'pending',
                    wake: { attempted: false, state: 'failed', errorMessage },
                    errorCode: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
                    errorMessage,
                    localId,
                };
            }
        } else if (await shouldWakePendingInputFromUi(port, effectiveOpts, wakeOpts.machineId)) {
            if (!isSubmitAccountLifetimeCurrent(effectiveOpts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
            try {
                const wakeResult = await port.ensureSessionRuntimeForPendingInput({
                    ...wakeOpts,
                    executionAuthorization: {
                        provenance: 'user_request',
                        requestId: localId,
                    },
                    ...(effectiveOpts.serverId ? { serverId: effectiveOpts.serverId } : {}),
                    ...(effectiveOpts.accountLifetime ? { accountLifetime: effectiveOpts.accountLifetime } : {}),
                });
                if (!isSubmitAccountLifetimeCurrent(effectiveOpts)) return accountScopeRetiredResult('send_failed', 'pending', localId);
                if (wakeResult.type === 'pending') return {
                    type: 'wake_pending', persistence: 'pending', wake: { attempted: false, state: 'pending' }, localId,
                };
                if (wakeResult.type === 'error') {
                    return {
                        type: 'wake_pending',
                        persistence: 'pending',
                        wake: { attempted: true, state: 'failed', errorMessage: wakeResult.errorMessage },
                        errorCode: wakeResult.errorCode,
                        errorMessage: wakeResult.errorMessage,
                        localId,
                    };
                }
            } catch (error) {
                const errorMessage = getErrorMessage(error, 'Failed to resume session');
                return {
                    type: 'wake_pending',
                    persistence: 'pending',
                    wake: { attempted: true, state: 'failed', errorMessage },
                    errorMessage,
                    localId,
                };
            }
        }
        return {
            type: 'success',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }

    if (mode === 'server_pending' || mode === 'interrupt') {
        return enqueuePending(port, effectiveOpts, decision);
    }

    return directSend(
        port,
        effectiveOpts,
        decision.directBypassReason ?? getDirectMessageBypassReason(effectiveOpts, mode),
    );
}
