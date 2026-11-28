type ConnectedServiceSwitchDeferralPolicy =
  | 'defer_until_turn_boundary'
  | 'defer_until_idle';

type ConnectedServiceSwitchSource = 'manual' | 'automatic';

/**
 * `forced` (default): if the turn boundary does not arrive within `timeoutMs`, the switch closes the
 * turn and runs anyway. `none`: the switch waits for the real boundary, however long the turn runs.
 */
export type ConnectedServiceSwitchBoundaryDeadline = 'forced' | 'none';

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
  boundaryDeadline?: ConnectedServiceSwitchBoundaryDeadline;
  target: ConnectedServiceSwitchTarget;
  runSwitch: () => Promise<unknown>;
}>;

type ConnectedServiceSwitchDeferralQueueParams = Readonly<{
  timeoutMs: number;
  disableDeferral: boolean;
  emitSessionEvent?: (sessionId: string, event: unknown) => void;
  nowMs?: () => number;
}>;

type DeferredRequest = Readonly<{
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
}>;

type PendingSwitch = {
  sessionId: string;
  policy: ConnectedServiceSwitchDeferralPolicy;
  source: ConnectedServiceSwitchSource;
  boundaryDeadline: ConnectedServiceSwitchBoundaryDeadline;
  target: ConnectedServiceSwitchTarget;
  runSwitch: () => Promise<unknown>;
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

export function isSameConnectedServiceSwitchTarget(a: ConnectedServiceSwitchTarget, b: ConnectedServiceSwitchTarget): boolean {
  a = normalizeTarget(a);
  b = normalizeTarget(b);
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
  recordTurnLifecycleEvent: (input: Readonly<{ sessionId: string; event: ConnectedServiceTurnLifecycleEvent }>) => void;
  isTurnInFlight: (sessionId: string) => boolean;
  getTurnLifecycleState: (sessionId: string) => Readonly<{
    inFlight: boolean;
    lastEvent: ConnectedServiceTurnLifecycleEvent | null;
    hasProviderActivityThisTurn: boolean;
    forcedSwitchInterruptedLiveTurn: boolean;
  }>;
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

  const settlePending = (pending: PendingSwitch, action: 'resolve' | 'reject', result?: unknown): void => {
    if (pending.settled) return;
    pending.settled = true;
    clearPendingTimer(pending);
    pendingBySessionId.delete(pending.sessionId);
    const requests = [...pending.requests];
    pending.requests.length = 0;
    for (const request of requests) {
      if (action === 'resolve') {
        request.resolve(result);
      } else {
        request.reject(result);
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
      const result = await pending.runSwitch();
      if (pending.settled) return;
      emit(pending.sessionId, {
        type: 'connected_service_account_switch_deferral_completed',
        policy: pending.policy,
        reason,
      });
      settlePending(pending, 'resolve', result);
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
    if (pending.boundaryDeadline === 'none') return;
    pending.timer = setTimeout(() => {
      // Lane F deferral-timeout escape hatch: the turn boundary never arrived within the timeout, so
      // the deferred switch is forced. Close the turn cleanly at a forced boundary FIRST so the
      // forced switch is a clean terminal transition rather than a silent mid-stream kill: downstream
      // continuation/recovery and the managed-server release in-flight-turn guard then observe a
      // quiesced turn instead of an indefinitely stuck in-flight flag (which would otherwise wedge
      // the forced switch or leak the prior-fingerprint server).
      const state = turnStateBySessionId.get(pending.sessionId);
      if (state?.inFlight === true) {
        state.inFlight = false;
        state.lastEvent = 'turn_cancelled';
        // The forced boundary interrupted a LIVE turn: record the fact for the continuation replay
        // plan, which runs after this close and can no longer observe inFlight (idle-session manual
        // switches must NOT send continuation prompts; genuinely interrupted ones must).
        state.forcedSwitchInterruptedLiveTurn = true;
      }
      void executePendingSwitch(pending, 'aborted_after_timeout');
    }, timeoutMs);
  };

  // A caller that relies on the forced boundary (a manual switch, failure recovery) keeps it even
  // when it coalesces into a pending switch that was waiting without a deadline.
  const adoptForcedDeadline = (pending: PendingSwitch, input: ConnectedServiceSwitchRequest): void => {
    if ((input.boundaryDeadline ?? 'forced') !== 'forced' || pending.boundaryDeadline === 'forced') return;
    if (pending.executing || pending.settled) return;
    pending.boundaryDeadline = 'forced';
    schedulePendingTimeout(pending);
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
        boundaryDeadline: input.boundaryDeadline ?? 'forced',
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
        // 0 = no forced deadline: the switch waits for the real boundary.
        timeoutMs: created.boundaryDeadline === 'none' ? 0 : timeoutMs,
      });
      return await deferred.promise;
    }

    if (isSameConnectedServiceSwitchTarget(pending.target, target)) {
      adoptForcedDeadline(pending, input);
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
      adoptForcedDeadline(pending, input);
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
      boundaryDeadline: input.boundaryDeadline ?? 'forced',
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
    // A cancelled turn still gives the deferred switch its safe boundary. Treat the switch as
    // completed at the boundary so the transcript does not claim it was cancelled right before the
    // real restart/switch attempt is emitted.
    void executePendingSwitch(pending, 'completed_at_boundary');
  };

  const isTurnInFlight = (sessionId: string): boolean => {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) return false;
    return turnStateBySessionId.get(normalizedSessionId)?.inFlight === true;
  };

  const getTurnLifecycleState = (sessionId: string): Readonly<{
    inFlight: boolean;
    lastEvent: ConnectedServiceTurnLifecycleEvent | null;
    hasProviderActivityThisTurn: boolean;
    forcedSwitchInterruptedLiveTurn: boolean;
  }> => {
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
      // A connected-service forced restart is APPLYING the deferred switch via respawn, not
      // terminating the session. Settle the pending so it never leaks, but emit NO
      // "terminated"/cancelled completion event — the session continues under the restart (otherwise
      // the UI shows a misleading "Account switch cancelled" right as the session restarts; see the
      // exit-143 crash RCA).
      // An executing switch already owns retirement. Let its callback return the selected
      // outcome to every coalesced caller instead of replacing that outcome with void on exit.
      if (pending.executing) return;
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
