import type { ConnectedAccountServiceKey } from '@happier-dev/protocol';

type ConnectedServiceSwitchDeferralPolicy =
    | 'defer_until_turn_boundary'
    | 'defer_until_idle';

type ConnectedServiceSwitchSource = 'manual' | 'automatic';

type ConnectedServiceSwitchDeferralCompletionReason =
    | 'completed_at_boundary'
    | 'switch_cancelled'
    | 'session_terminated'
    | 'daemon_shutdown';

export type ConnectedServiceSwitchTarget = Readonly<{
    serviceId: ConnectedAccountServiceKey;
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
    runSwitch: (signal?: AbortSignal) => Promise<unknown>;
}>;

type ConnectedServiceSwitchDeferralQueueParams = Readonly<{
    disableDeferral: boolean;
    emitSessionEvent?: (sessionId: string, event: unknown) => void | Promise<void>;
}>;

type DeferredRequest = Readonly<{
    resolve: (result: unknown) => void;
    reject: (error: unknown) => void;
}>;

type PendingSwitch = {
    sessionId: string;
    policy: ConnectedServiceSwitchDeferralPolicy;
    source: ConnectedServiceSwitchSource;
    target: ConnectedServiceSwitchTarget;
    runSwitch: (signal?: AbortSignal) => Promise<unknown>;
    executionCancellation: AbortController;
    requests: DeferredRequest[];
    settled: boolean;
    // Claimed synchronously when execution begins (before the runSwitch await) so a second terminal
    // turn event arriving during that await cannot re-invoke runSwitch on the same pending.
    executing: boolean;
    // POST-EFFECT SETTLEMENT: set once runSwitch has RESOLVED, i.e. the switch already produced its
    // (possibly irreversible) effect — for a planned runner restart that is the emitted signal. From
    // that moment the request can only be applied or applied-with-incomplete-evidence, never
    // rollback-safe-failed, so `settlePending` refuses to reject it.
    effectApplied: boolean;
    selectedResult: unknown;
    admissionTail: Promise<void>;
};

type SessionTurnState = {
    inFlight: boolean;
    lastEvent: ConnectedServiceTurnLifecycleEvent | null;
    hasProviderActivityThisTurn: boolean;
};

export type ConnectedServiceSwitchTurnLifecycleState = Readonly<SessionTurnState>;

export class ConnectedServiceSwitchDeferralConflictError extends Error {
    public readonly code:
        | 'group_generation_conflict'
        | 'switch_cancelled'
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

export function isSameConnectedServiceSwitchTarget(first: ConnectedServiceSwitchTarget, second: ConnectedServiceSwitchTarget): boolean {
    const a = normalizeTarget(first);
    const b = normalizeTarget(second);
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
    promise: Promise<unknown>;
    request: DeferredRequest;
}> {
    let resolve: ((result: unknown) => void) | null = null;
    let reject: ((error: unknown) => void) | null = null;
    const promise = new Promise<unknown>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        request: {
            resolve: (result) => resolve?.(result),
            reject: (error) => reject?.(error),
        },
    };
}

export type ConnectedServiceSwitchDeferralQueue = Readonly<{
    requestSwitch: (input: ConnectedServiceSwitchRequest) => Promise<unknown>;
    recordTurnLifecycleEvent: (input: Readonly<{
        sessionId: string;
        event: ConnectedServiceTurnLifecycleEvent;
        activeTurnIdWitness?: string | null;
    }>) => void;
    isTurnInFlight: (sessionId: string) => boolean;
    getTurnLifecycleState: (sessionId: string) => ConnectedServiceSwitchTurnLifecycleState;
    cancelSession: (sessionId: string, reason: 'session_terminated' | 'session_restarting') => Promise<void>;
    cancelAll: (reason: 'daemon_shutdown') => Promise<void>;
}>;

export function createConnectedServiceSwitchDeferralQueue(
    params: ConnectedServiceSwitchDeferralQueueParams,
): ConnectedServiceSwitchDeferralQueue {
    const turnStateBySessionId = new Map<string, SessionTurnState>();
    const pendingBySessionId = new Map<string, PendingSwitch>();

    const emit = (sessionId: string, event: unknown): void | Promise<void> => (
        params.emitSessionEvent?.(sessionId, event)
    );

    const readTurnState = (sessionId: string): SessionTurnState => {
        const existing = turnStateBySessionId.get(sessionId);
        if (existing) return existing;
        const created: SessionTurnState = {
            inFlight: false,
            lastEvent: null,
            hasProviderActivityThisTurn: false,
        };
        turnStateBySessionId.set(sessionId, created);
        return created;
    };

    const settlePending = (pending: PendingSwitch, action: 'resolve' | 'reject', error?: unknown): void => {
        if (pending.settled) return;
        pending.settled = true;
        pending.executionCancellation.abort();
        if (pendingBySessionId.get(pending.sessionId) === pending) {
            pendingBySessionId.delete(pending.sessionId);
        }
        // Once the switch effect has landed, every later failure (completion-event admission,
        // session teardown, daemon shutdown) is missing EVIDENCE, not an
        // un-happened switch. Rejecting here would tell the caller the switch can be rolled back
        // over an effect it can no longer undo, so the post-effect witness wins at this one seam.
        const settledAction = pending.effectApplied ? 'resolve' : action;
        const requests = [...pending.requests];
        pending.requests.length = 0;
        for (const request of requests) {
            if (settledAction === 'resolve') {
                request.resolve(pending.selectedResult);
            } else {
                request.reject(error);
            }
        }
    };

    const admitPendingEvent = (pending: PendingSwitch, event: unknown): void => {
        const admission = emit(pending.sessionId, event);
        if (!admission) return;
        pending.admissionTail = pending.admissionTail.then(async () => await admission);
        void pending.admissionTail.catch((error) => {
            settlePending(pending, 'reject', error);
        });
    };

    const executePendingSwitch = async (
        pending: PendingSwitch,
        reason: ConnectedServiceSwitchDeferralCompletionReason,
    ): Promise<void> => {
        if (pending.settled || pending.executing) return;
        // Claim execution synchronously, before the first await, so concurrent terminal events (or a
        // cancellation racing a terminal event) cannot both pass the guard and double-invoke runSwitch.
        pending.executing = true;
        try {
            pending.selectedResult = await pending.runSwitch(pending.executionCancellation.signal);
            pending.effectApplied = true;
            if (pending.settled) return;
            admitPendingEvent(pending, {
                type: 'connected_service_account_switch_deferral_completed',
                policy: pending.policy,
                reason,
            });
            await pending.admissionTail;
            settlePending(pending, 'resolve');
        } catch (error) {
            if (pending.settled) return;
            settlePending(pending, 'reject', error);
        }
    };

    const rejectPending = async (
        pending: PendingSwitch,
        reason: Extract<ConnectedServiceSwitchDeferralCompletionReason, 'session_terminated' | 'daemon_shutdown'>,
    ): Promise<void> => {
        if (pending.settled) return;
        pending.executionCancellation.abort();
        admitPendingEvent(pending, {
            type: 'connected_service_account_switch_deferral_completed',
            policy: pending.policy,
            reason,
        });
        await pending.admissionTail;
        const error = new ConnectedServiceSwitchDeferralConflictError({
            code: reason,
            message: `Connected-service deferred switch cancelled: ${reason}`,
        });
        settlePending(pending, 'reject', error);
    };

    const rejectSupersededPending = async (pending: PendingSwitch): Promise<void> => {
        if (pending.settled) return;
        pending.executionCancellation.abort();
        admitPendingEvent(pending, {
            type: 'connected_service_account_switch_deferral_completed',
            policy: pending.policy,
            reason: 'switch_cancelled',
        });
        await pending.admissionTail;
        const error = new ConnectedServiceSwitchDeferralConflictError({
            code: 'switch_cancelled',
            message: 'Connected-service deferred switch was cancelled',
        });
        settlePending(pending, 'reject', error);
    };

    const shouldRunImmediately = (input: ConnectedServiceSwitchRequest): boolean => {
        if (params.disableDeferral) return true;
        const state = readTurnState(input.sessionId);
        if (input.policy === 'defer_until_idle') {
            return state.inFlight !== true;
        }
        return state.inFlight !== true;
    };

    const requestSwitch = async (input: ConnectedServiceSwitchRequest): Promise<unknown> => {
        const sessionId = String(input.sessionId ?? '').trim();
        if (!sessionId) return;
        const target = normalizeTarget(input.target);
        if (shouldRunImmediately(input)) {
            return await input.runSwitch();
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
                executionCancellation: new AbortController(),
                requests: [deferred.request],
                settled: false,
                executing: false,
                effectApplied: false,
                selectedResult: undefined,
                admissionTail: Promise.resolve(),
            };
            pendingBySessionId.set(sessionId, created);
            admitPendingEvent(created, {
                type: 'connected_service_account_switch_deferred',
                policy: input.policy,
                awaitingBoundary: input.policy === 'defer_until_turn_boundary',
            });
            return await deferred.promise;
        }

        if (isSameConnectedServiceSwitchTarget(pending.target, target)) {
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

        const replacement: PendingSwitch = {
            sessionId,
            policy: input.policy,
            source: input.source,
            target,
            runSwitch: input.runSwitch,
            executionCancellation: new AbortController(),
            requests: [deferred.request],
            settled: false,
            executing: false,
            effectApplied: false,
            selectedResult: undefined,
            admissionTail: Promise.resolve(),
        };
        pendingBySessionId.set(sessionId, replacement);
        admitPendingEvent(pending, {
            type: 'connected_service_account_switch_deferral_superseded',
            policy: input.policy,
        });
        void rejectSupersededPending(pending).catch((error) => {
            settlePending(pending, 'reject', error);
        });
        return await deferred.promise;
    };

    const recordTurnLifecycleEvent = (input: Readonly<{
        sessionId: string;
        event: ConnectedServiceTurnLifecycleEvent;
        activeTurnIdWitness?: string | null;
    }>): void => {
        const sessionId = String(input.sessionId ?? '').trim();
        if (!sessionId) return;
        const state = readTurnState(sessionId);
        state.lastEvent = input.event;
        if (input.event === 'prompt_or_steer' || input.event === 'task_started') {
            state.inFlight = input.event === 'prompt_or_steer'
                ? input.activeTurnIdWitness !== null
                : true;
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
        if (input.event === 'turn_cancelled' && !pending.executing) {
            void rejectSupersededPending(pending).catch((error) => settlePending(pending, 'reject', error));
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
            };
        }
        const state = readTurnState(normalizedSessionId);
        return {
            inFlight: state.inFlight,
            lastEvent: state.lastEvent,
            hasProviderActivityThisTurn: state.hasProviderActivityThisTurn,
        };
    };

    const cancelSession = async (
        sessionId: string,
        reason: 'session_terminated' | 'session_restarting',
    ): Promise<void> => {
        const normalizedSessionId = String(sessionId ?? '').trim();
        if (!normalizedSessionId) return;
        if (reason === 'session_restarting') {
            // Runner retirement closes its turn while the selected switch settles.
            const state = turnStateBySessionId.get(normalizedSessionId);
            if (state) {
                state.inFlight = false;
                state.hasProviderActivityThisTurn = false;
            }
        } else {
            turnStateBySessionId.delete(normalizedSessionId);
        }
        const pending = pendingBySessionId.get(normalizedSessionId);
        if (!pending) return;
        if (reason === 'session_restarting') {
            // Retirement may land inside the selected callback. Let that execution publish its
            // result before resolving joined callers; unexecuted requests remain passive.
            if (pending.executing) return;
            settlePending(pending, 'resolve');
            return;
        }
        await rejectPending(pending, reason);
    };

    const cancelAll = async (reason: 'daemon_shutdown'): Promise<void> => {
        const pendingEntries = [...pendingBySessionId.values()];
        turnStateBySessionId.clear();
        await Promise.all(pendingEntries.map(async (pending) => await rejectPending(pending, reason)));
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
