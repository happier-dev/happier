import { readPendingLocalId, withSessionUserMessageDeliveryIntentMeta } from '@happier-dev/protocol';

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
        await port.switchSessionControlToRemote(opts.sessionId);
    } catch {
        // Non-fatal: the message is already persisted in the pending queue.
    }
}

async function directSend(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
    bypassPendingQueueReason: DirectMessageBypassReason,
): Promise<SubmitSessionUserMessageResult> {
    let handoffLocalId: string | undefined;
    let sawLocalPendingProjection = false;
    let reportedOutboundHandoff = false;
    try {
        const sendOptions = {
            profileId: opts.profileId ?? undefined,
            localId: opts.localId ?? undefined,
            ...(opts.hostAdmissionOrigin ? { hostAdmissionOrigin: opts.hostAdmissionOrigin } : {}),
            bypassPendingQueueReason,
            onLocalPendingProjectionCreated: opts.onOutboundHandoff
                ? ({ localId }: { localId: string }) => {
                    sawLocalPendingProjection = true;
                    handoffLocalId = localId;
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
    decision: SessionMessageDeliveryDecision,
): Promise<SubmitSessionUserMessageResult> {
    const requestedAction = opts.requestedAction ?? decision.requestedAction ?? { v: 1, kind: 'enqueue' as const };
    const wakeOpts = getPendingQueueWakeResumeOptions({
        sessionId: opts.sessionId,
        session: opts.session,
        resumeCapabilityOptions: opts.resumeCapabilityOptions,
        resumeTargetOverride: opts.resumeTargetOverride,
        permissionOverride: opts.permissionOverride,
        canWakeMachineId: port.canWakeMachineId,
    });

    let enqueueResult: PendingMessageSubmitResult;
    let handoffLocalId: string | undefined;
    try {
        enqueueResult = await port.enqueuePendingMessage(
            opts.sessionId,
            opts.text,
            opts.displayText,
            withSessionUserMessageDeliveryIntentMeta(opts.metaOverrides, decision.intent),
            {
                localId: opts.localId,
                ...(opts.hostAdmissionOrigin ? { hostAdmissionOrigin: opts.hostAdmissionOrigin } : {}),
                requestedAction,
                onLocalPendingProjectionCreated: opts.onOutboundHandoff
                    ? ({ localId }) => {
                        handoffLocalId = localId;
                    }
                    : undefined,
            },
        );
    } catch (error) {
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorMessage: getErrorMessage(error, 'Failed to enqueue message'),
        };
    }

    const localId = readLocalId(enqueueResult) ?? handoffLocalId;
    opts.onOutboundHandoff?.({
        persistence: 'pending',
        ...(localId ? { localId } : {}),
    });
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
    if (enqueueResult && typeof enqueueResult === 'object' && enqueueResult.accepted === false) {
        return {
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }
    if (enqueueResult && typeof enqueueResult === 'object' && enqueueResult.terminal === true) {
        return {
            type: 'success',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }
    if (!wakeOpts) {
        return {
            type: 'wake_pending',
            persistence: 'pending',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    }

    const resumeOptions = {
        ...wakeOpts,
        ...(opts.serverId ? { serverId: opts.serverId } : {}),
    };

    try {
        const wakeResult = await port.ensureSessionRuntimeForPendingInput(resumeOptions);
        if (wakeResult.type === 'error') {
            await switchRemoteAfterPendingEnqueueIfNeeded(port, opts);
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
        const errorMessage = getErrorMessage(error, 'Failed to resume session');
        await switchRemoteAfterPendingEnqueueIfNeeded(port, opts);
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
    const resolved = await resolveSubmitDecisionWithSupportRefresh(port, opts);
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
            await port.updatePendingRequestedAction(effectiveOpts.sessionId, localId, requestedAction);
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
        const wakeOpts = getPendingQueueWakeResumeOptions({
            sessionId: effectiveOpts.sessionId,
            session: effectiveOpts.session,
            resumeCapabilityOptions: effectiveOpts.resumeCapabilityOptions,
            resumeTargetOverride: effectiveOpts.resumeTargetOverride,
            permissionOverride: effectiveOpts.permissionOverride,
            canWakeMachineId: port.canWakeMachineId,
        });
        if (!wakeOpts) {
            if (effectiveOpts.session.active === false) {
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
        } else {
            try {
                const wakeResult = await port.ensureSessionRuntimeForPendingInput({
                    ...wakeOpts,
                    executionAuthorization: {
                        provenance: 'user_request',
                        requestId: localId,
                    },
                    ...(effectiveOpts.serverId ? { serverId: effectiveOpts.serverId } : {}),
                });
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
