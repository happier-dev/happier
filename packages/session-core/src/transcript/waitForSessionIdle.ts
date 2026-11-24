import { UpdateContainerSchema, type UpdateContainer } from '@happier-dev/protocol/updates';
import {
  detectSessionTurnActivityFromProjection, readSessionProjectedPendingInputCount,
  readSessionProjectedPendingRequestCount, readSessionProjectedTurnStatus, type SessionTurnActivity,
} from './sessionTurnActivity.js';
import { isSessionAgentThreadTextUserMessage, isSessionAgentMessage,
  applySessionTurnLifecycleEvent, detectSessionTurnLifecycleEvent, isBareSessionReadyEvent } from './sessionTurnLifecycle.js';

export type AgentStateSummary = Readonly<{
  controlledByUser?: boolean;
  pendingRequestsCount: number;
}>;

export function summarizeAgentState(value: unknown): AgentStateSummary {
  const obj = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const controlledByUser = typeof obj?.controlledByUser === 'boolean' ? obj.controlledByUser : undefined;
  const requests = obj?.requests;
  const pendingRequestsCount =
    requests && typeof requests === 'object' && !Array.isArray(requests) ? Object.keys(requests).length : 0;
  return { ...(controlledByUser !== undefined ? { controlledByUser } : {}), pendingRequestsCount };
}

export function isIdle(summary: AgentStateSummary | null): boolean {
  if (!summary) return true;
  if (summary.controlledByUser === true) return false;
  return summary.pendingRequestsCount === 0;
}

function summarizeProjectedPendingRequests(value: unknown): AgentStateSummary | null {
  const pendingRequestsCount = readSessionProjectedPendingRequestCount(value);
  if (pendingRequestsCount === null) {
    return null;
  }
  return { pendingRequestsCount };
}

/**
 * The Session projection only carries the pending-request count, so a projected observation may
 * replace that count and nothing else. Merging it onto the freshest AgentState observation keeps
 * `controlledByUser` intact; otherwise a Session held by a live local terminal would be summarized
 * as idle and could be stopped underneath its user.
 */
function mergeProjectedPendingRequestCount(
  projected: AgentStateSummary | null,
  observedAgentState: AgentStateSummary | null,
): AgentStateSummary | null {
  if (!projected) return null;
  const controlledByUser = projected.controlledByUser ?? observedAgentState?.controlledByUser;
  return {
    ...(controlledByUser !== undefined ? { controlledByUser } : {}),
    pendingRequestsCount: projected.pendingRequestsCount,
  };
}

export const DEFAULT_SESSION_WAIT_IDLE_CONFIRM_MS = 250;

export function resolveSessionIdleWaitDurationMs(timeoutSeconds: number | undefined): number {
  const seconds = typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? Math.min(3600, timeoutSeconds)
    : 300;
  return Math.max(1, Math.floor(seconds * 1000));
}

export type IdleSocketObserver = (handlers: Readonly<{
  onUpdate: (value: unknown) => Promise<void>;
  onConnected: () => void;
  onError: (error: unknown) => void;
}>) => Readonly<{ dispose: () => Promise<void> }>;

export async function waitForIdleObservation(params: Readonly<{
  sessionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  initialTurnActivity: SessionTurnActivity;
  initialTurnActivityRequiresTranscriptIdleEvidence?: boolean;
  recheckTurnActivity?: () => Promise<SessionTurnActivity>;
  initialAgentStateSummary?: AgentStateSummary | null;
  preferProjectionUpdates?: boolean;
  readyCompletesPendingUserTurns?: boolean;
  initialAgentState: unknown;
  confirmMs?: number;
  observe: IdleSocketObserver;
  readSnapshot: () => Promise<{ projection: unknown; agentState: unknown } | null>;
  openAgentState: (value: string, version: number) => unknown | Promise<unknown>;
  openMessage: (content: unknown) => unknown | Promise<unknown>;
}>): Promise<{ idle: true; observedAt: number }> {
  const initialObservedAgentState = params.initialAgentState == null ? null : summarizeAgentState(params.initialAgentState);
  const initial =
    params.initialAgentStateSummary !== undefined
      ? mergeProjectedPendingRequestCount(params.initialAgentStateSummary, initialObservedAgentState)
      : initialObservedAgentState;
  let latestSummary = initial;
  let pendingUserTurns = params.initialTurnActivity.pendingUserTurns;
  let activeTaskInFlight = params.initialTurnActivity.activeTaskInFlight;
  let requiresTranscriptIdleEvidence = params.initialTurnActivityRequiresTranscriptIdleEvidence === true;
  let preferProjectionUpdates = params.preferProjectionUpdates === true;
  const readyCompletesPendingUserTurns = params.readyCompletesPendingUserTurns !== false;
  let observedTurnProgress = activeTaskInFlight;
  // Pending retirement can precede observation of the successor turn. Retain the known
  // input count until that successor is observed, including with older producers
  // that lack exact publication correlation.
  let pendingInputTurnsAwaitingMaterialization =
    preferProjectionUpdates && pendingUserTurns > 0 ? pendingUserTurns : 0;
  const hasTurnInFlight = () => activeTaskInFlight || pendingUserTurns > 0 || pendingInputTurnsAwaitingMaterialization > 0;
  const initiallyIdle = isIdle(initial) && !hasTurnInFlight();
  if (initiallyIdle && params.recheckTurnActivity) requiresTranscriptIdleEvidence = true;
  const idleConfirmMs = initiallyIdle ? params.confirmMs ?? DEFAULT_SESSION_WAIT_IDLE_CONFIRM_MS : 0;

  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const deadlineMs = Date.now() + timeoutMs;

  const result = await new Promise<{ idle: true; observedAt: number }>((resolve, reject) => {
    let settled = false;
    let waitingForIdleAfterFreshBusy = !initiallyIdle;
    let hasFreshAgentStateObservation = false;
    let observationRevision = 0;
    let idleConfirmTimer: ReturnType<typeof setTimeout> | null = null;
    let observation: ReturnType<IdleSocketObserver> | null = null;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener('abort', abort);
      if (idleConfirmTimer) {
        clearTimeout(idleConfirmTimer);
        idleConfirmTimer = null;
      }
      void observation?.dispose().catch(() => undefined);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout'));
    }, timeoutMs);

    const abort = () => {
      cleanup();
      reject(params.signal?.reason ?? new Error('cancelled'));
    };
    params.signal?.addEventListener('abort', abort, { once: true });
    if (params.signal?.aborted) {
      abort();
      return;
    }

    const applyRecheckedTurnActivity = (latestTurnActivity: SessionTurnActivity): boolean => {
      if (latestTurnActivity.pendingInputCount !== undefined) {
        pendingInputTurnsAwaitingMaterialization = latestTurnActivity.pendingInputCount;
      }
      if (!latestTurnActivity.turnInFlight && pendingInputTurnsAwaitingMaterialization > 0) {
        requiresTranscriptIdleEvidence = true;
        waitingForIdleAfterFreshBusy = true;
        return false;
      }
      pendingUserTurns = latestTurnActivity.pendingUserTurns;
      activeTaskInFlight = latestTurnActivity.activeTaskInFlight;
      if (activeTaskInFlight) pendingInputTurnsAwaitingMaterialization = latestTurnActivity.pendingUserTurns;
      if (latestTurnActivity.turnInFlight) {
        requiresTranscriptIdleEvidence = !preferProjectionUpdates || requiresTranscriptIdleEvidence;
        waitingForIdleAfterFreshBusy = true;
        return false;
      }
      requiresTranscriptIdleEvidence = false;
      return true;
    };

    const completeIdle = () => {
      if (settled) return;
      clearTimeout(timer);
      cleanup();
      resolve({ idle: true, observedAt: Math.min(Date.now(), deadlineMs) });
    };

    const recheckRequiredTranscriptIdleEvidence = async (): Promise<boolean> => {
      if (!requiresTranscriptIdleEvidence) return true;
      if (!params.recheckTurnActivity) return false;
      const revision = ++observationRevision;
      const latestTurnActivity = await params.recheckTurnActivity();
      if (settled || revision !== observationRevision) return false;
      return applyRecheckedTurnActivity(latestTurnActivity);
    };

    const resolveIdle = () => {
      void (async () => {
        try {
          if (!(await recheckRequiredTranscriptIdleEvidence())) {
            return;
          }
          if (settled || hasTurnInFlight() || (!isIdle(latestSummary) && hasFreshAgentStateObservation)) return;
          completeIdle();
        } catch {
          // Wait for the next transcript/projection event or reconnect.
        }
      })();
    };

    const onConnect = () => {
      const revision = ++observationRevision;
      void (async () => {
        try {
          const latestTurnActivity = await params.recheckTurnActivity?.();
          if (settled || revision !== observationRevision) return;
          if (latestTurnActivity && !applyRecheckedTurnActivity(latestTurnActivity)) return;
          const refreshed = await params.readSnapshot();
          if (settled || revision !== observationRevision || !refreshed) return;
          const refreshedProjectionActivity = preferProjectionUpdates
            ? detectSessionTurnActivityFromProjection(refreshed.projection) : null;
          if (refreshedProjectionActivity) {
            pendingUserTurns = refreshedProjectionActivity.pendingUserTurns;
            activeTaskInFlight = refreshedProjectionActivity.activeTaskInFlight;
          }
          const refreshedObservedAgentState = refreshed.agentState == null ? null : summarizeAgentState(refreshed.agentState);
          latestSummary = mergeProjectedPendingRequestCount(
            preferProjectionUpdates ? summarizeProjectedPendingRequests(refreshed.projection) : null,
            refreshedObservedAgentState ?? latestSummary,
          ) ?? refreshedObservedAgentState;
          if (hasTurnInFlight() || !isIdle(latestSummary)) {
            waitingForIdleAfterFreshBusy = true;
            return;
          }
          resolveIdle();
        } catch {
          // The managed transport owns reconnection; missing evidence is not idle.
        }
      })();
    };


    const observePendingInputCount = (body: unknown) => {
      const count = readSessionProjectedPendingInputCount(body);
      if (count === null || count === 0) return;
      pendingUserTurns = Math.max(pendingUserTurns, count);
      if (preferProjectionUpdates) {
        pendingInputTurnsAwaitingMaterialization = Math.max(pendingInputTurnsAwaitingMaterialization, count);
      } else {
        requiresTranscriptIdleEvidence = true;
      }
      waitingForIdleAfterFreshBusy = true;
      if (idleConfirmTimer) {
        clearTimeout(idleConfirmTimer);
        idleConfirmTimer = null;
      }
    };

    const onUpdate = async (raw: unknown) => {
      if (settled) return;
      const parsed = UpdateContainerSchema.safeParse(raw);
      if (!parsed.success) return;
      const update: UpdateContainer = parsed.data;
      const observedBody = update.body;
      const sessionId = 'sid' in observedBody ? observedBody.sid ?? ('sessionId' in observedBody ? observedBody.sessionId : undefined)
        : 'id' in observedBody ? observedBody.id : undefined;
      if (sessionId === params.sessionId) observationRevision += 1;

      if (update.body?.t === 'pending-changed') {
        if (!preferProjectionUpdates && !readyCompletesPendingUserTurns) return;
        const body = update.body;
        const sessionId = body.sid ?? body.sessionId;
        if (sessionId !== params.sessionId) return;
        observePendingInputCount(body);
        // A blocked-custody push needs the exact crossover even while the total stays positive.
        const hasBlockedInput = (body.pendingBlockedCount ?? 0) > 0;
        if (hasBlockedInput) requiresTranscriptIdleEvidence = true;
        if ((hasBlockedInput || readSessionProjectedPendingInputCount(body) === 0)
          && waitingForIdleAfterFreshBusy) resolveIdle();
        return;
      }

      if (update.body?.t === 'update-session') {
        const body = update.body;
        if (String(body.id ?? '') !== params.sessionId) return;

        if (preferProjectionUpdates || readyCompletesPendingUserTurns) observePendingInputCount(body);
        const observedTurnStatus = readSessionProjectedTurnStatus(body.latestTurnStatus);
        const projectedActivity = observedTurnStatus ? detectSessionTurnActivityFromProjection(body) : null;
        const shouldReadProjection = preferProjectionUpdates || !readyCompletesPendingUserTurns || projectedActivity !== null;
        let state: unknown;
        const agentState = body.agentState;
        if (typeof agentState?.value === 'string' && agentState.value.trim()) {
          const opened = params.openAgentState(agentState.value, agentState.version);
          state = opened instanceof Promise ? await opened : opened;
          if (settled) return;
        }
        const observedSummary = state == null ? null : summarizeAgentState(state);
        const projectedSummary = shouldReadProjection
          ? mergeProjectedPendingRequestCount(summarizeProjectedPendingRequests(body), observedSummary ?? latestSummary)
          : null;
        const projectedTurnStatus = shouldReadProjection ? observedTurnStatus : null;
        const canUseTerminalProjection =
          preferProjectionUpdates
          || readyCompletesPendingUserTurns
          || observedTurnProgress
          || activeTaskInFlight
          || projectedTurnStatus === 'in_progress';
        if (!canUseTerminalProjection && projectedTurnStatus && params.recheckTurnActivity) {
          // Completion can precede this subscriber's first native output.
          // The caller's current-input reader distinguishes it from an older
          // turn; missing busy delivery is not evidence that work remains.
          if (projectedSummary) {
            latestSummary = projectedSummary;
            hasFreshAgentStateObservation = true;
          }
          requiresTranscriptIdleEvidence = true;
          resolveIdle();
          return;
        }
        if (projectedActivity && projectedSummary) {
          if (readyCompletesPendingUserTurns) preferProjectionUpdates = true;
          if (projectedActivity.activeTaskInFlight) pendingInputTurnsAwaitingMaterialization = projectedActivity.pendingUserTurns;
          const nextPendingUserTurns = projectedActivity.pendingUserTurns;
          const nextActiveTaskInFlight = projectedActivity.activeTaskInFlight;
          const nextTurnInFlight = nextActiveTaskInFlight || nextPendingUserTurns > 0;
          if (nextTurnInFlight || !isIdle(projectedSummary)) {
            pendingUserTurns = nextPendingUserTurns;
            activeTaskInFlight = nextActiveTaskInFlight;
            latestSummary = projectedSummary;
            hasFreshAgentStateObservation = true;
            observedTurnProgress = true;
            waitingForIdleAfterFreshBusy = true;
            if (idleConfirmTimer) {
              clearTimeout(idleConfirmTimer);
              idleConfirmTimer = null;
            }
            return;
          }
          if (!canUseTerminalProjection) {
            return;
          }
          // The complete projection already proves no queued input or active
          // turn remains. Missing transcript delivery cannot overrule its owner.
          pendingInputTurnsAwaitingMaterialization = 0;
          pendingUserTurns = nextPendingUserTurns;
          activeTaskInFlight = nextActiveTaskInFlight;
          latestSummary = projectedSummary;
          hasFreshAgentStateObservation = true;
          if (!waitingForIdleAfterFreshBusy) {
            return;
          }

          resolveIdle();
          return;
        }
        if (projectedTurnStatus || projectedSummary) {
          let nextPendingUserTurns = pendingUserTurns;
          let nextActiveTaskInFlight = activeTaskInFlight;
          if (projectedTurnStatus) {
            nextActiveTaskInFlight = projectedTurnStatus === 'in_progress';
          }
          const nextSummary = projectedSummary ?? latestSummary;
          const nextTurnInFlight = nextActiveTaskInFlight || nextPendingUserTurns > 0;

          if (nextTurnInFlight || !isIdle(nextSummary)) {
            pendingUserTurns = nextPendingUserTurns;
            activeTaskInFlight = nextActiveTaskInFlight;
            if (projectedSummary) {
              latestSummary = projectedSummary;
              hasFreshAgentStateObservation = true;
            }
            observedTurnProgress = true;
            waitingForIdleAfterFreshBusy = true;
            if (idleConfirmTimer) {
              clearTimeout(idleConfirmTimer);
              idleConfirmTimer = null;
            }
            return;
          }
          if (pendingInputTurnsAwaitingMaterialization > 0) {
            return;
          }
          if (!canUseTerminalProjection) {
            return;
          }
          pendingUserTurns = nextPendingUserTurns;
          activeTaskInFlight = nextActiveTaskInFlight;
          if (projectedSummary) {
            latestSummary = projectedSummary;
            hasFreshAgentStateObservation = true;
          }
          if (!waitingForIdleAfterFreshBusy || latestSummary === null) {
            return;
          }

          resolveIdle();
          return;
        }

        const summary = observedSummary;
        if (!summary) return;
        hasFreshAgentStateObservation = true;
        latestSummary = summary;
        if (!isIdle(summary)) {
          waitingForIdleAfterFreshBusy = true;
          if (idleConfirmTimer) {
            clearTimeout(idleConfirmTimer);
            idleConfirmTimer = null;
          }
          return;
        }
        if (!waitingForIdleAfterFreshBusy || hasTurnInFlight()) {
          return;
        }

        resolveIdle();
        return;
      }

      const messageBody = update.body;
      if (messageBody.t !== 'new-message') return;
      if (String(messageBody.sid ?? '') !== params.sessionId) return;
      if (messageBody.delivery !== 'full') {
        clearTimeout(timer);
        cleanup();
        reject(new Error('Session idle observation requires full message delivery'));
        return;
      }
      if (
        preferProjectionUpdates
        && !requiresTranscriptIdleEvidence
        && pendingInputTurnsAwaitingMaterialization === 0
      ) return;
      const opened = params.openMessage(messageBody.message?.content);
      const decrypted = opened instanceof Promise ? await opened : opened;
      if (settled) return;
      if (!decrypted) return;

      if (isSessionAgentThreadTextUserMessage(decrypted)) {
        pendingInputTurnsAwaitingMaterialization = Math.max(0, pendingInputTurnsAwaitingMaterialization - 1);
        pendingUserTurns += 1;
        requiresTranscriptIdleEvidence = true;
        waitingForIdleAfterFreshBusy = true;
        if (idleConfirmTimer) {
          clearTimeout(idleConfirmTimer);
          idleConfirmTimer = null;
        }
        return;
      }

      const lifecycleEvent = detectSessionTurnLifecycleEvent(decrypted);
      if (!lifecycleEvent) {
        if (isSessionAgentMessage(decrypted) && hasTurnInFlight()) {
          observedTurnProgress = true;
        }
        return;
      }
      if (
        lifecycleEvent === 'ready'
        && !readyCompletesPendingUserTurns
        && !activeTaskInFlight
        && !observedTurnProgress
        && isBareSessionReadyEvent(decrypted)
      ) {
        return;
      }
      if (lifecycleEvent === 'ready' && !isBareSessionReadyEvent(decrypted) && pendingUserTurns > 0) {
        observedTurnProgress = true;
      }
      if (lifecycleEvent === 'task_started') {
        observedTurnProgress = true;
      }

      // A terminal native event can be the first observed fact for this input
      // (for example an OpenCode quota refusal without task_started). Reduce
      // the unobserved inputs through the same lifecycle owner as visible ones.
      pendingInputTurnsAwaitingMaterialization = applySessionTurnLifecycleEvent({
        pendingUserTurns: pendingInputTurnsAwaitingMaterialization,
        activeTaskInFlight,
        event: lifecycleEvent,
      }).pendingUserTurns;

      ({
        pendingUserTurns,
        activeTaskInFlight,
      } = applySessionTurnLifecycleEvent({
        pendingUserTurns,
        activeTaskInFlight,
        event: lifecycleEvent,
      }));
      if (lifecycleEvent === 'ready') {
        latestSummary = { ...(latestSummary ?? {}), pendingRequestsCount: 0 };
      }

      const staleAgentStateSnapshot = !hasFreshAgentStateObservation;

      if (hasTurnInFlight() || (!isIdle(latestSummary) && !staleAgentStateSnapshot)) {
        waitingForIdleAfterFreshBusy = true;
        if (idleConfirmTimer) {
          clearTimeout(idleConfirmTimer);
          idleConfirmTimer = null;
        }
        return;
      }
      if (!waitingForIdleAfterFreshBusy) {
        return;
      }

      resolveIdle();
    };

    observation = params.observe({
      onUpdate, onConnected: onConnect,
      onError: (error) => { clearTimeout(timer); cleanup(); reject(error); },
    });

    if (initiallyIdle) {
      idleConfirmTimer = setTimeout(() => {
        idleConfirmTimer = null;
        const revision = ++observationRevision;
        void (async () => {
          if (params.recheckTurnActivity) {
            try {
              const latestTurnActivity = await params.recheckTurnActivity();
              if (settled || revision !== observationRevision) return;
              requiresTranscriptIdleEvidence = false;
              if (!applyRecheckedTurnActivity(latestTurnActivity)) {
                waitingForIdleAfterFreshBusy = true;
                return;
              }
              requiresTranscriptIdleEvidence = false;
            } catch {
              // Transcript confirmation is required before reporting idle. Keep the socket wait
              // alive until fresh positive evidence arrives or the deadline rejects.
              return;
            }
          }

          resolveIdle();
        })();
      }, Math.min(idleConfirmMs, timeoutMs));
    }
  });

  return result;
}

function unknownTranscriptTurnActivity(): SessionTurnActivity {
  return {
    pendingUserTurns: 1,
    activeTaskInFlight: false,
    turnInFlight: true,
  };
}

export type WaitForSessionIdleResult =
| Readonly<{ ok: true; sessionId: string; idle: true; observedAt: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'unsupported' | 'encryption_material_unavailable' | 'timeout' | 'cancelled'; candidates?: string[] }>;

type IdleTarget = Readonly<{
  ok: true;
  sessionId: string;
  projection: unknown;
  readInitialTurnActivity?: () => Promise<SessionTurnActivity>;
  readTurnActivity: () => Promise<SessionTurnActivity>;
  waitForObservation: (options: Omit<Parameters<typeof waitForIdleObservation>[0], 'observe' | 'readSnapshot' | 'openAgentState' | 'openMessage' | 'confirmMs' | 'initialAgentState'>) =>
    ReturnType<typeof waitForIdleObservation>;
}> | Extract<WaitForSessionIdleResult, { ok: false }>;

export async function waitForSessionIdle(params: Readonly<{
  timeoutMs: number;
  signal?: AbortSignal;
  readTarget: (lifetime: { signal: AbortSignal; remainingTimeoutMs: () => number }) => Promise<IdleTarget>;
}>): Promise<WaitForSessionIdleResult> {
  const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
  const deadlineMs = Date.now() + timeoutMs;
  const remainingTimeoutMs = () => Math.max(1, deadlineMs - Date.now());
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('timeout')), timeoutMs);
  const signal = params.signal ? AbortSignal.any([params.signal, deadline.signal]) : deadline.signal;

  try {
    const sessionTarget = await params.readTarget({ signal, remainingTimeoutMs });
    if (!sessionTarget.ok) {
      return {
        ok: false,
        code: sessionTarget.code,
        ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
      };
    }

    const initialProjectedActivity = detectSessionTurnActivityFromProjection(sessionTarget.projection);
    let initialTranscriptActivity: SessionTurnActivity | null = null;
    let initialTranscriptActivityUnavailable = false;
    if (!initialProjectedActivity) {
      try {
        initialTranscriptActivity = await (sessionTarget.readInitialTurnActivity ?? sessionTarget.readTurnActivity)();
      } catch {
        initialTranscriptActivityUnavailable = true;
      }
    }
    const initialTurnActivity =
      initialProjectedActivity?.turnInFlight
        ? initialProjectedActivity
        : initialTranscriptActivity?.turnInFlight
          ? initialTranscriptActivity
          : initialTranscriptActivityUnavailable
            ? unknownTranscriptTurnActivity()
            : initialProjectedActivity ?? initialTranscriptActivity ?? {
              pendingUserTurns: 0,
              activeTaskInFlight: false,
              turnInFlight: false,
            };
    const initialTurnActivityRequiresTranscriptIdleEvidence =
      initialTranscriptActivityUnavailable
      || initialTranscriptActivity?.turnInFlight === true;
    const initialProjectedPendingRequestCount = readSessionProjectedPendingRequestCount(sessionTarget.projection);

    try {
      const result = await sessionTarget.waitForObservation({
        sessionId: sessionTarget.sessionId,
        timeoutMs: remainingTimeoutMs(),
        signal,
        initialTurnActivity,
        initialTurnActivityRequiresTranscriptIdleEvidence,
        recheckTurnActivity: sessionTarget.readTurnActivity,
        ...(initialProjectedPendingRequestCount !== null
          ? { initialAgentStateSummary: { pendingRequestsCount: initialProjectedPendingRequestCount } }
          : {}),
        preferProjectionUpdates: initialProjectedActivity !== null,
      });
      return {
        ok: true,
        sessionId: sessionTarget.sessionId,
        ...result,
      };
    } catch {
      return {
        ok: false,
        code: params.signal?.aborted ? 'cancelled' : 'timeout',
      };
    }
  } catch (error) {
    if (signal.aborted) return { ok: false, code: params.signal?.aborted ? 'cancelled' : 'timeout' };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
