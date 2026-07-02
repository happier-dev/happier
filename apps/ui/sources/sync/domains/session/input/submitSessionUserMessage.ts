import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { classifyAgentSessionComposerNonSteerablePayload } from '@/agents/registry/registryUiBehavior';
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

function readLocalId(result: PendingMessageSubmitResult | DirectMessageSubmitResult): string | undefined {
    return result && typeof result === 'object' && typeof result.localId === 'string'
        ? result.localId
        : undefined;
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
            metaOverrides: opts.metaOverrides,
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
    return (opts.explicitMode ?? opts.configuredMode) === 'server_pending';
}

function isUnknownPendingQueueSupport(decision: SessionMessageDeliveryDecision): boolean {
    return decision.pendingSupportState === 'unknown_session'
        || decision.pendingSupportState === 'unknown_pending_version';
}

function shouldFailClosedForUnknownPendingSupport(
    opts: SubmitSessionUserMessageOptions,
    decision: SessionMessageDeliveryDecision,
): boolean {
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
        const markOutboundHandoff = (localId?: string) => {
            if (didMarkOutboundHandoff) {
                return;
            }
            didMarkOutboundHandoff = true;
            handoffLocalId = localId;
            opts.onOutboundHandoff?.({
                persistence: 'transcript_committed',
                ...(localId ? { localId } : {}),
            });
        };
        const sendOptions = {
            profileId: opts.profileId ?? undefined,
            localId: opts.localId ?? undefined,
            bypassPendingQueueReason,
            onLocalPendingProjectionCreated: opts.onOutboundHandoff
                ? ({ localId }: { localId: string }) => markOutboundHandoff(localId)
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
        if (!didMarkOutboundHandoff) {
            markOutboundHandoff(localId);
        }
        return {
            type: 'success',
            persistence: 'transcript_committed',
            wake: { attempted: false, state: 'not_needed' },
            localId,
        };
    } catch (error) {
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorMessage: getErrorMessage(error, 'Failed to send message'),
        };
    }
}

async function enqueuePending(
    port: SessionSubmitPort,
    opts: SubmitSessionUserMessageOptions,
): Promise<SubmitSessionUserMessageResult> {
    const wakeOpts = getPendingQueueWakeResumeOptions({
        sessionId: opts.sessionId,
        session: opts.session,
        resumeCapabilityOptions: opts.resumeCapabilityOptions,
        resumeTargetOverride: opts.resumeTargetOverride,
        permissionOverride: opts.permissionOverride,
        canWakeMachineId: port.canWakeMachineId,
    });

    let enqueueResult: PendingMessageSubmitResult;
    try {
        enqueueResult = await port.enqueuePendingMessage(
            opts.sessionId,
            opts.text,
            opts.displayText,
            opts.metaOverrides,
        );
    } catch (error) {
        return {
            type: 'send_failed',
            persistence: 'none',
            wake: { attempted: false, state: 'not_needed' },
            errorMessage: getErrorMessage(error, 'Failed to enqueue message'),
        };
    }

    const localId = readLocalId(enqueueResult);
    opts.onOutboundHandoff?.({
        persistence: 'pending',
        ...(localId ? { localId } : {}),
    });
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
        const wakeResult = await port.resumeSession(resumeOptions);
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

    if (shouldRejectUnsupportedPendingQueue(effectiveOpts, mode)) {
        return rejectUnsupportedPendingQueue();
    }

    if (shouldFailClosedForUnknownPendingSupport(effectiveOpts, decision)) {
        return rejectUnknownPendingQueueSupport(resolved.supportRefreshErrorMessage);
    }

    if (mode === 'server_pending') {
        return enqueuePending(port, effectiveOpts);
    }

    if (mode === 'interrupt') {
        try {
            await port.abortSession?.(effectiveOpts.sessionId);
        } catch {
            // Best effort only; sending the user message still proceeds.
        }
    }

    return directSend(
        port,
        effectiveOpts,
        decision.directBypassReason ?? getDirectMessageBypassReason(effectiveOpts, mode),
    );
}
