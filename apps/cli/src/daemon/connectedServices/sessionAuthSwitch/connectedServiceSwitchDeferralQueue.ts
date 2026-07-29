type ConnectedServiceSwitchDeferralPolicy =
    | 'defer_until_turn_boundary'
    | 'defer_until_idle';

type ConnectedServiceSwitchSource = 'manual' | 'automatic';

type ConnectedServiceSwitchDeferralCompletionReason =
    | 'completed_at_boundary'
    | 'aborted_after_timeout'
    | 'switch_cancelled'
    | 'session_terminated'
    | 'daemon_shutdown';

export type ConnectedServiceSwitchTarget = Readonly<{
    serviceId: string;
    profileId: string;
    groupId: string;
    generation: number;
}>;

export type ConnectedServiceTurnLifecycleEvent =
    | 'prompt_or_steer'
    | 'task_started'
    | 'assistant_message_end'
    | 'turn_cancelled';

type ConnectedServiceSwitchRequest = Readonly<{
    sessionId: string;
    policy: ConnectedServiceSwitchDeferralPolicy;
    source: ConnectedServiceSwitchSource;
    target: ConnectedServiceSwitchTarget;
    runSwitch: () => Promise<void>;
}>;

type ConnectedServiceSwitchDeferralQueueParams = Readonly<{
    timeoutMs: number;
    disableDeferral: boolean;
    emitSessionEvent?: (sessionId: string, event: unknown) => void;
    nowMs?: () => number;
}>;

type DeferredRequest = Readonly<{
    resolve: () => void;
    reject: (error: unknown) => void;
}>;

type PendingSwitch = {
    sessionId: string;
    policy: ConnectedServiceSwitchDeferralPolicy;
    source: ConnectedServiceSwitchSource;
    target: ConnectedServiceSwitchTarget;
    runSwitch: () => Promise<void>;
    requestedAtMs: number;
    timer: ReturnType<typeof setTimeout> | null;
    requests: DeferredRequest[];
    settled: boolean;
    // Claimed synchronously when execution begins (before the runSwitch await) so a second terminal
    // turn event arriving during that await cannot re-invoke runSwitch on the same pending.
    executing: boolean;
};

type SessionTurnState = {
    inFlight: boolean;
    lastEvent: ConnectedServiceTurnLifecycleEvent | null;
    hasProviderActivityThisTurn: boolean;
    // True when a deferred switch's forced-boundary timeout closed a LIVE turn (the switch genuinely
    // interrupted in-flight work). Consumed by the continuation replay plan, which resolves AFTER the
    // forced close (inFlight already false there). Cleared when the next turn starts.
    forcedSwitchInterruptedLiveTurn: boolean;
};

export type ConnectedServiceSwitchTurnLifecycleState = Readonly<SessionTurnState>;

export class ConnectedServiceSwitchDeferralConflictError extends Error {
    public readonly code:
        | 'group_generation_conflict'
        | 'switch_cancelled'
        | 'switch_execution_timeout'
        | 'session_terminated'
        | 'daemon_shutdown';

    public constructor(input: Readonly<{
        code: ConnectedServiceSwitchDeferralConflictError['code'];
        message: string;
    }>) {
        super(input.message);
        this.name = 'ConnectedServiceSwitchDeferralConflictError';
        this.code = input.code;
    }
}

function normalizeTarget(target: ConnectedServiceSwitchTarget): ConnectedServiceSwitchTarget {
    return {
        serviceId: String(target.serviceId ?? '').trim(),
        profileId: String(target.profileId ?? '').trim(),
        groupId: String(target.groupId ?? '').trim(),
        generation: Number.isFinite(target.generation) ? Math.max(0, Math.trunc(target.generation)) : 0,
    };
}

function isSameTarget(a: ConnectedServiceSwitchTarget, b: ConnectedServiceSwitchTarget): boolean {
    return a.serviceId === b.serviceId
        && a.profileId === b.profileId
        && a.groupId === b.groupId
        && a.generation === b.generation;
}

function isOlderGeneration(input: Readonly<{
    pending: ConnectedServiceSwitchTarget;
    next: ConnectedServiceSwitchTarget;
}>): boolean {
    if (input.pending.serviceId !== input.next.serviceId) return false;
    if (input.pending.groupId !== input.next.groupId) return false;
    return input.next.generation < input.pending.generation;
}

function shouldReplacePending(input: Readonly<{
    pendingSource: ConnectedServiceSwitchSource;
    nextSource: ConnectedServiceSwitchSource;
}>): boolean {
    if (input.pendingSource === 'manual' && input.nextSource !== 'manual') {
        return false;
    }
    return true;
}

function createDeferredPromise(): Readonly<{
    promise: Promise<void>;
    request: DeferredRequest;
}> {
    let resolve: (() => void) | null = null;
    let reject: ((error: unknown) => void) | null = null;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        request: {
            resolve: () => resolve?.(),
            reject: (error) => reject?.(error),
        },
    };
}

export type ConnectedServiceSwitchDeferralQueue = Readonly<{
    requestSwitch: (input: ConnectedServiceSwitchRequest) => Promise<void>;
    recordTurnLifecycleEvent: (input: Readonly<{ sessionId: string; event: ConnectedServiceTurnLifecycleEvent }>) => void;
    isTurnInFlight: (sessionId: string) => boolean;
    getTurnLifecycleState: (sessionId: string) => ConnectedServiceSwitchTurnLifecycleState;
    cancelSession: (sessionId: string, reason: 'session_terminated' | 'session_restarting') => void;
    cancelAll: (reason: 'daemon_shutdown') => void;
}>;

export function createConnectedServiceSwitchDeferralQueue(
    params: ConnectedServiceSwitchDeferralQueueParams,
): ConnectedServiceSwitchDeferralQueue {
    const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.max(1_000, Math.trunc(params.timeoutMs)) : 60_000;
    const nowMs = params.nowMs ?? Date.now;
    const turnStateBySessionId = new Map<string, SessionTurnState>();
    const pendingBySessionId = new Map<string, PendingSwitch>();

    const emit = (sessionId: string, event: unknown): void => {
        params.emitSessionEvent?.(sessionId, event);
    };

    const readTurnState = (sessionId: string): SessionTurnState => {
        const existing = turnStateBySessionId.get(sessionId);
        if (existing) return existing;
        const created: SessionTurnState = {
            inFlight: false,
            lastEvent: null,
            hasProviderActivityThisTurn: false,
            forcedSwitchInterruptedLiveTurn: false,
        };
        turnStateBySessionId.set(sessionId, created);
        return created;
    };

    const clearPendingTimer = (pending: PendingSwitch): void => {
        if (!pending.timer) return;
        clearTimeout(pending.timer);
        pending.timer = null;
    };

    const settlePending = (pending: PendingSwitch, action: 'resolve' | 'reject', error?: unknown): void => {
        if (pending.settled) return;
        pending.settled = true;
        clearPendingTimer(pending);
        pendingBySessionId.delete(pending.sessionId);
        const requests = [...pending.requests];
        pending.requests.length = 0;
        for (const request of requests) {
            if (action === 'resolve') {
                request.resolve();
            } else {
                request.reject(error);
            }
        }
    };

    const executePendingSwitch = async (
        pending: PendingSwitch,
        reason: ConnectedServiceSwitchDeferralCompletionReason,
    ): Promise<void> => {
        if (pending.settled || pending.executing) return;
        // Claim execution synchronously, before the first await, so concurrent terminal events (or a
        // timeout racing a terminal event) cannot both pass the guard and double-invoke runSwitch.
        pending.executing = true;
        clearPendingTimer(pending);
        // CL-1: the deferral-window timer cleared above only bounds the WAIT for a boundary. Bound the
        // runSwitch execution itself too, so a hung switch (stuck materialization, wedged restart signal)
        // rejects the deferred callers instead of stranding them until session teardown. A late runSwitch
        // outcome after the deadline is ignored via the settled guard; the switch machinery downstream is
        // generation-guarded against a stale completion racing a newer request. The completion event
        // reuses the existing wire reason 'aborted_after_timeout' — no new wire enum member.
        const executionDeadline = setTimeout(() => {
            if (pending.settled) return;
            emit(pending.sessionId, {
                type: 'connected_service_account_switch_deferral_completed',
                policy: pending.policy,
                reason: 'aborted_after_timeout',
            });
            settlePending(pending, 'reject', new ConnectedServiceSwitchDeferralConflictError({
                code: 'switch_execution_timeout',
                message: `Connected-service deferred switch execution exceeded ${timeoutMs}ms`,
            }));
        }, timeoutMs);
        try {
            await pending.runSwitch();
            if (pending.settled) return;
            emit(pending.sessionId, {
                type: 'connected_service_account_switch_deferral_completed',
                policy: pending.policy,
                reason,
            });
            settlePending(pending, 'resolve');
        } catch (error) {
            if (pending.settled) return;
            settlePending(pending, 'reject', error);
        } finally {
            clearTimeout(executionDeadline);
        }
    };

    const rejectPending = (
        pending: PendingSwitch,
        reason: Extract<ConnectedServiceSwitchDeferralCompletionReason, 'session_terminated' | 'daemon_shutdown'>,
    ): void => {
        if (pending.settled) return;
        emit(pending.sessionId, {
            type: 'connected_service_account_switch_deferral_completed',
            policy: pending.policy,
            reason,
        });
        const error = new ConnectedServiceSwitchDeferralConflictError({
            code: reason,
            message: `Connected-service deferred switch cancelled: ${reason}`,
        });
        settlePending(pending, 'reject', error);
    };

    const rejectSupersededPending = (pending: PendingSwitch): void => {
        if (pending.settled) return;
        emit(pending.sessionId, {
            type: 'connected_service_account_switch_deferral_completed',
            policy: pending.policy,
            reason: 'switch_cancelled',
        });
        const error = new ConnectedServiceSwitchDeferralConflictError({
            code: 'switch_cancelled',
            message: 'Connected-service deferred switch was superseded by a newer request',
        });
        settlePending(pending, 'reject', error);
    };

    const schedulePendingTimeout = (pending: PendingSwitch): void => {
        clearPendingTimer(pending);
        pending.timer = setTimeout(() => {
            // The boundary never arrived in time. Force the turn to a closed boundary BEFORE running
            // the forced switch so `isTurnInFlight` stops reporting it as live — otherwise the
            // managed-server release guard would keep deferring this now-forced switch (which would
            // leave the prior-fingerprint server pinned). The forced close is observable as
            // turn_cancelled; the switch still emits its `aborted_after_timeout` completion event.
            const state = turnStateBySessionId.get(pending.sessionId);
            if (state?.inFlight === true) {
                state.inFlight = false;
                state.lastEvent = 'turn_cancelled';
                // The forced boundary interrupted a LIVE turn: record the fact for the continuation
                // replay plan, which runs after this close and can no longer observe inFlight
                // (idle-session manual switches must NOT send continuation prompts; genuinely
                // interrupted ones must).
                state.forcedSwitchInterruptedLiveTurn = true;
            }
            void executePendingSwitch(pending, 'aborted_after_timeout');
        }, timeoutMs);
    };

    const shouldRunImmediately = (input: ConnectedServiceSwitchRequest): boolean => {
        if (params.disableDeferral) return true;
        const state = readTurnState(input.sessionId);
        if (input.policy === 'defer_until_idle') {
            return state.inFlight !== true;
        }
        return state.inFlight !== true;
    };

    const requestSwitch = async (input: ConnectedServiceSwitchRequest): Promise<void> => {
        const sessionId = String(input.sessionId ?? '').trim();
        if (!sessionId) return;
        const target = normalizeTarget(input.target);
        if (shouldRunImmediately(input)) {
            await input.runSwitch();
            return;
        }

        const deferred = createDeferredPromise();
        const pending = pendingBySessionId.get(sessionId);
        if (!pending) {
            const created: PendingSwitch = {
                sessionId,
                policy: input.policy,
                source: input.source,
                target,
                runSwitch: input.runSwitch,
                requestedAtMs: nowMs(),
                timer: null,
                requests: [deferred.request],
                settled: false,
                executing: false,
            };
            pendingBySessionId.set(sessionId, created);
            schedulePendingTimeout(created);
            emit(sessionId, {
                type: 'connected_service_account_switch_deferred',
                policy: input.policy,
                awaitingBoundary: input.policy === 'defer_until_turn_boundary',
                timeoutMs,
            });
            return await deferred.promise;
        }

        if (isSameTarget(pending.target, target)) {
            pending.requests.push(deferred.request);
            return await deferred.promise;
        }

        if (isOlderGeneration({ pending: pending.target, next: target })) {
            throw new ConnectedServiceSwitchDeferralConflictError({
                code: 'group_generation_conflict',
                message: 'Connected-service switch generation is older than pending deferred switch',
            });
        }

        if (!shouldReplacePending({ pendingSource: pending.source, nextSource: input.source })) {
            pending.requests.push(deferred.request);
            return await deferred.promise;
        }

        emit(sessionId, {
            type: 'connected_service_account_switch_deferral_superseded',
            policy: input.policy,
            timeoutMs,
        });
        rejectSupersededPending(pending);

        const replacement: PendingSwitch = {
            sessionId,
            policy: input.policy,
            source: input.source,
            target,
            runSwitch: input.runSwitch,
            requestedAtMs: nowMs(),
            timer: null,
            requests: [deferred.request],
            settled: false,
            executing: false,
        };
        pendingBySessionId.set(sessionId, replacement);
        schedulePendingTimeout(replacement);
        return await deferred.promise;
    };

    const recordTurnLifecycleEvent = (input: Readonly<{
        sessionId: string;
        event: ConnectedServiceTurnLifecycleEvent;
    }>): void => {
        const sessionId = String(input.sessionId ?? '').trim();
        if (!sessionId) return;
        const state = readTurnState(sessionId);
        state.lastEvent = input.event;
        if (input.event === 'prompt_or_steer' || input.event === 'task_started') {
            state.inFlight = true;
            // A new turn supersedes any recorded forced-boundary interruption of a previous turn.
            state.forcedSwitchInterruptedLiveTurn = false;
            if (input.event === 'prompt_or_steer') {
                state.hasProviderActivityThisTurn = false;
            }
            if (input.event === 'task_started') {
                state.hasProviderActivityThisTurn = true;
            }
            return;
        }
        state.inFlight = false;
        const pending = pendingBySessionId.get(sessionId);
        if (!pending) return;
        if (input.event === 'assistant_message_end') {
            void executePendingSwitch(pending, 'completed_at_boundary');
            return;
        }
        void executePendingSwitch(pending, 'completed_at_boundary');
    };

    const isTurnInFlight = (sessionId: string): boolean => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) return false;
        return turnStateBySessionId.get(normalizedSessionId)?.inFlight === true;
    };

    const getTurnLifecycleState = (sessionId: string): ConnectedServiceSwitchTurnLifecycleState => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) {
            return {
                inFlight: false,
                lastEvent: null,
                hasProviderActivityThisTurn: false,
                forcedSwitchInterruptedLiveTurn: false,
            };
        }
        const state = readTurnState(normalizedSessionId);
        return {
            inFlight: state.inFlight,
            lastEvent: state.lastEvent,
            hasProviderActivityThisTurn: state.hasProviderActivityThisTurn,
            forcedSwitchInterruptedLiveTurn: state.forcedSwitchInterruptedLiveTurn,
        };
    };

    const cancelSession = (sessionId: string, reason: 'session_terminated' | 'session_restarting'): void => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) return;
        turnStateBySessionId.delete(normalizedSessionId);
        const pending = pendingBySessionId.get(normalizedSessionId);
        if (!pending) return;
        if (reason === 'session_restarting') {
            settlePending(pending, 'resolve');
            return;
        }
        rejectPending(pending, reason);
    };

    const cancelAll = (reason: 'daemon_shutdown'): void => {
        const pendingEntries = [...pendingBySessionId.values()];
        turnStateBySessionId.clear();
        for (const pending of pendingEntries) {
            rejectPending(pending, reason);
        }
    };

    return {
        requestSwitch,
        recordTurnLifecycleEvent,
        isTurnInFlight,
        getTurnLifecycleState,
        cancelSession,
        cancelAll,
    };
}
