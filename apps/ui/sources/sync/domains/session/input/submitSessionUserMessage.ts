import {
    readPendingLocalId,
    withSessionUserMessageDeliveryIntentMeta,
    type PendingRequestedActionV1,
} from '@happier-dev/protocol';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
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
import { recordSessionMessageDeliveryDecision } from './sessionMessageDeliveryTelemetry';

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
    const code = error && typeof error === 'object'
        ? (error as { code?: unknown }).code
        : undefined;
    return typeof code === 'string' && code.trim().length > 0
        ? code.trim()
        : undefined;
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

function hasProviderAcceptancePending(result: DirectMessageSubmitResult): boolean {
    return Boolean(
        result
            && typeof result === 'object'
            && result.providerAcceptancePending === true,
    );
}

function resolveSubmitDecision(opts: SubmitSessionUserMessageOptions): SessionMessageDeliveryDecision {
    return decideSessionMessageDelivery({
        configuredMode: opts.configuredMode,
        busySteerSendPolicy: opts.busySteerSendPolicy,
        explicitMode: opts.explicitMode,
        session: opts.session,
        nowMs: opts.nowMs,
        forceImmediate: opts.forceImmediate,
        text: opts.text,
        permissionModeApplyTiming: opts.permissionModeApplyTiming,
        nonSteerableSendPrompt: opts.nonSteerableSendPrompt,
        providerNonSteerablePayloadReason: opts.providerNonSteerablePayloadReason,
        applyConfigAndSteer: opts.applyConfigAndSteer,
        steerWithoutConfig: opts.steerWithoutConfig,
    });
}

function requestedPendingQueue(opts: SubmitSessionUserMessageOptions): boolean {
    const requestedMode = opts.explicitMode ?? opts.configuredMode;
    return requestedMode === 'server_pending' || requestedMode === 'interrupt';
}

function usesExistingDurablePendingMessage(
    opts: SubmitSessionUserMessageOptions,
): boolean {
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
    decision: SessionMessageDeliveryDecision,
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
    try {
        let didMarkOutboundHandoff = false;
        let handoffLocalId: string | undefined;
        let sawLocalPendingProjection = false;
        const markOutboundHandoff = (persistence: DirectSubmitPersistence, localId?: string) => {
            if (didMarkOutboundHandoff) {
                return;
            }
            didMarkOutboundHandoff = true;
            handoffLocalId = localId;
            opts.onOutboundHandoff?.({
                persistence,
                ...(localId ? { localId } : {}),
            });
        };
        const sendOptions = {
            profileId: opts.profileId ?? undefined,
            localId: opts.localId ?? undefined,
            bypassPendingQueueReason,
            onLocalPendingProjectionCreated: opts.onOutboundHandoff
                ? ({ localId }: { localId: string }) => {
                    sawLocalPendingProjection = true;
                    markOutboundHandoff('pending', localId);
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
        if (!didMarkOutboundHandoff) {
            markOutboundHandoff(persistence, localId);
        }
        return {
            type: 'success',
            persistence,
            ...(hasProviderAcceptancePending(sendResult) ? { providerAcceptancePending: true } : {}),
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    } catch (error) {
        const errorCode = getErrorCode(error);
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            ...(errorCode ? { errorCode } : {}),
            errorMessage: getErrorMessage(error, 'Failed to send message'),
        };
    }
}

async function enqueuePending(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
): Promise<SubmitSessionUserMessageResult> {
    // Freeze the row action before persistence starts. Neither an enqueue delay nor a later
    // readiness refresh may reinterpret the caller's chosen action/command.
    const requestedAction = selectSubmitRequestedAction(opts, decision);
    const wakeOpts = getPendingQueueWakeResumeOptions({
        sessionId: opts.sessionId,
        session: opts.session,
        resumeCapabilityOptions: opts.resumeCapabilityOptions,
        resumeTargetOverride: opts.resumeTargetOverride,
        permissionOverride: opts.permissionOverride,
        nowMs: opts.nowMs,
        canWakeMachineId: port.canWakeMachineId,
    });

    let enqueueResult: PendingMessageSubmitResult;
    try {
        let didMarkOutboundHandoff = false;
        let handoffLocalId: string | undefined;
        const markOutboundHandoff = (localId?: string) => {
            if (didMarkOutboundHandoff) {
                return;
            }
            didMarkOutboundHandoff = true;
            handoffLocalId = localId;
            opts.onOutboundHandoff?.({
                persistence: 'pending',
                ...(localId ? { localId } : {}),
            });
        };
        enqueueResult = await port.enqueuePendingMessage(
            opts.sessionId,
            opts.text,
            opts.displayText,
            withSessionUserMessageDeliveryIntentMeta(opts.metaOverrides ?? null, decision.intent),
            {
                localId: opts.localId,
                requestedAction,
                ...(opts.onOutboundHandoff
                    ? { onLocalPendingProjectionCreated: ({ localId }) => markOutboundHandoff(localId) }
                    : {}),
            },
        );
        const localId = readLocalId(enqueueResult) ?? handoffLocalId;
        if (!didMarkOutboundHandoff) {
            markOutboundHandoff(localId);
        }
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
    } catch (error) {
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorMessage: getErrorMessage(error, 'Failed to enqueue message'),
        };
    }
}

function selectSubmitRequestedAction(
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
): PendingRequestedActionV1 {
    return opts.requestedAction ?? decision.requestedAction;
}

export async function submitSessionUserMessage(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
): Promise<SubmitSessionUserMessageResult> {
    const resolved = await resolveSubmitDecisionWithSupportRefresh(port, opts);
    const decision = resolved.decision;
    const effectiveOpts = resolved.opts;
    const mode = decision.mode;
    const forceImmediatePendingAction = effectiveOpts.forceImmediate === true
        && (effectiveOpts.configuredMode === 'server_pending' || mode === 'server_pending');
    recordSessionMessageDeliveryDecision({
        sessionId: effectiveOpts.sessionId,
        session: effectiveOpts.session,
        selectedMode: forceImmediatePendingAction ? 'server_pending' : mode,
        decisionReason: forceImmediatePendingAction ? 'force_immediate_pending_action' : decision.reason,
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

    if (shouldRejectUnsupportedPendingQueue(effectiveOpts, decision, mode)) {
        return rejectUnsupportedPendingQueue();
    }

    if (shouldFailClosedForUnknownPendingSupport(effectiveOpts, decision)) {
        return rejectUnknownPendingQueueSupport(resolved.supportRefreshErrorMessage);
    }

    const existingDurablePendingInterrupt = usesExistingDurablePendingMessage(effectiveOpts)
        && decision.intent === 'interrupt';

    if (effectiveOpts.existingDurablePendingMessage === true && effectiveOpts.localId) {
        const requestedAction = selectSubmitRequestedAction(effectiveOpts, decision);
        try {
            if (!port.updatePendingRequestedAction) {
                throw new Error('Pending requested-action update is unavailable');
            }
            await port.updatePendingRequestedAction(
                effectiveOpts.sessionId,
                effectiveOpts.localId,
                requestedAction,
            );
        } catch (error) {
            const errorCode = getErrorCode(error);
            const errorMessage = getErrorMessage(error, 'Failed to update Pending requested action');
            return {
                type: 'wake_failed',
                persistence: 'pending',
                wake: { attempted: false, state: 'failed', errorMessage },
                ...(errorCode ? { errorCode } : {}),
                errorMessage,
                localId: effectiveOpts.localId,
            };
        }

        const wakeOpts = getPendingQueueWakeResumeOptions({
            sessionId: effectiveOpts.sessionId,
            session: effectiveOpts.session,
            resumeCapabilityOptions: effectiveOpts.resumeCapabilityOptions,
            resumeTargetOverride: effectiveOpts.resumeTargetOverride,
            permissionOverride: effectiveOpts.permissionOverride,
            nowMs: effectiveOpts.nowMs,
            canWakeMachineId: port.canWakeMachineId,
        });
        if (wakeOpts) {
            try {
                const wakeResult = await port.ensureSessionRuntimeForPendingInput({
                    ...wakeOpts,
                    ...(effectiveOpts.serverId ? { serverId: effectiveOpts.serverId } : {}),
                });
                if (wakeResult.type === 'error') {
                    return {
                        type: 'wake_pending',
                        persistence: 'pending',
                        wake: { attempted: true, state: 'failed', errorMessage: wakeResult.errorMessage },
                        errorCode: wakeResult.errorCode,
                        errorMessage: wakeResult.errorMessage,
                        localId: effectiveOpts.localId,
                    };
                }
            } catch (error) {
                const errorMessage = getErrorMessage(error, 'Failed to wake session');
                return {
                    type: 'wake_pending',
                    persistence: 'pending',
                    wake: { attempted: true, state: 'failed', errorMessage },
                    errorMessage,
                    localId: effectiveOpts.localId,
                };
            }
        }
        return {
            type: 'success',
            persistence: 'pending',
            wake: wakeOpts
                ? { attempted: true, state: 'started' }
                : { attempted: false, state: 'not_needed' },
            localId: effectiveOpts.localId,
        };
    }

    if (mode === 'server_pending' && !existingDurablePendingInterrupt) {
        return enqueuePending(port, effectiveOpts, decision);
    }

    if (effectiveOpts.forceImmediate === true && effectiveOpts.configuredMode === 'server_pending') {
        return enqueuePending(port, effectiveOpts, { ...decision, mode: 'server_pending' });
    }

    if (mode === 'interrupt') {
        return enqueuePending(port, effectiveOpts, { ...decision, mode: 'server_pending' });
    }

    if (mode === 'agent_queue' && decision.pendingSupportState === 'supported') {
        return enqueuePending(port, effectiveOpts, decision);
    }

    const directBypassReason = existingDurablePendingInterrupt
        ? 'interrupt'
        : decision.directBypassReason ?? getDirectMessageBypassReason(effectiveOpts, mode);
    return directSend(port, effectiveOpts, directBypassReason);
}
