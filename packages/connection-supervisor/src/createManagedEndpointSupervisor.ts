import { deriveManagedConnectionReason } from './managedConnectionEvents.js';
import { computeManagedConnectionBackoffMs } from './reconnectBackoff.js';
import type { ManagedConnectionState, ReadinessProbeResult } from './managedConnectionTypes.js';
import type {
  ManagedEndpointFailureReport,
  ManagedEndpointSupervisor,
  ManagedEndpointSupervisorConfig,
  ManagedEndpointSupervisorState,
} from './managedEndpointSupervisorTypes.js';

function readProbeErrorMessage(probe: ReadinessProbeResult | undefined, fallback: string | null): string | null {
  if (!probe || probe.status === 'ready') return fallback;
  return probe.errorMessage ?? fallback;
}

function initialState(): ManagedEndpointSupervisorState {
  return {
    phase: 'idle',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
    lastProbe: null,
  };
}

function toProbeResultFromError(error: unknown): ReadinessProbeResult {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return { status: 'server_unreachable', errorMessage };
}

export function createManagedEndpointSupervisor(config: ManagedEndpointSupervisorConfig): ManagedEndpointSupervisor {
  let state = initialState();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let isStarted = false;
  let isStopped = false;
  let generation = 0;
  let pendingInvalidate = false;
  let startInFlight: Promise<void> | null = null;
  const listeners = new Set<(state: ManagedEndpointSupervisorState) => void>();

  function publish(next: ManagedEndpointSupervisorState): void {
    state = next;
    config.onStateChange?.(state);
    for (const listener of listeners) {
      listener(state);
    }
  }

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleProbe(attempt: number, delayMs: number, probe?: ReadinessProbeResult): void {
    if (isStopped) return;
    clearRetryTimer();
    const now = Date.now();
    publish({
      phase: 'offline',
      reason: deriveManagedConnectionReason({ probe }),
      attempt,
      nextRetryAt: now + delayMs,
      lastConnectedAt: state.lastConnectedAt,
      lastDisconnectedAt: now,
      lastErrorMessage: readProbeErrorMessage(probe, state.lastErrorMessage),
      lastProbe: probe ?? state.lastProbe,
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void runProbe({ attempt, initial: false });
    }, Math.max(0, delayMs));
  }

  async function runProbe(params: Readonly<{ attempt: number; initial: boolean }>): Promise<void> {
    const localGeneration = ++generation;
    clearRetryTimer();
    if (isStopped) return;

    publish({
      ...state,
      phase: 'connecting',
      reason: params.initial ? 'initial_connect' : state.reason,
      attempt: params.attempt,
      nextRetryAt: null,
      lastErrorMessage: null,
    });

    const probe = await config.probeReadiness().catch(toProbeResultFromError);
    if (isStopped || localGeneration !== generation) return;

    if (probe.status === 'auth_failed') {
      publish({
        ...state,
        phase: 'auth_failed',
        reason: deriveManagedConnectionReason({ probe }),
        attempt: params.attempt,
        nextRetryAt: null,
        lastErrorMessage: readProbeErrorMessage(probe, state.lastErrorMessage),
        lastProbe: probe,
      });
      return;
    }

    if (probe.status !== 'ready') {
      const nextAttempt = params.attempt + 1;
      const delayMs =
        probe.status === 'retry_later' && typeof probe.retryAfterMs === 'number' && Number.isFinite(probe.retryAfterMs)
          ? Math.max(1, probe.retryAfterMs)
          : nextAttempt <= Math.max(0, config.maxFastRetries)
            ? Math.max(0, config.initialFastRetryDelayMs)
            : computeManagedConnectionBackoffMs({
                attempt: nextAttempt,
                minMs: config.backoffMinMs,
                maxMs: config.backoffMaxMs,
                jitterRatio: config.jitterRatio,
              });
      scheduleProbe(nextAttempt, delayMs, probe);
      return;
    }

    const now = Date.now();
    publish({
      phase: 'online',
      reason: params.initial ? 'initial_connect' : state.reason,
      attempt: params.attempt,
      nextRetryAt: null,
      lastConnectedAt: now,
      lastDisconnectedAt: state.lastDisconnectedAt,
      lastErrorMessage: null,
      lastProbe: probe,
    });

    if (pendingInvalidate) {
      pendingInvalidate = false;
      void runProbe({ attempt: state.attempt, initial: false });
    }
  }

  function invalidate(): void {
    if (isStopped) return;
    if (state.phase === 'connecting') {
      pendingInvalidate = true;
      return;
    }
    pendingInvalidate = false;
    void runProbe({ attempt: state.attempt, initial: false });
  }

  function reportFailure(report: ManagedEndpointFailureReport): void {
    if (isStopped) return;
    if (state.phase !== 'online' && state.phase !== 'connecting') return;
    // Cancel any in-flight probe result so a reported transport failure cannot be overwritten
    // by a stale `probeReadiness()` resolution.
    generation += 1;
    const nextAttempt = Math.max(1, state.attempt + 1);
    const delayMs =
      nextAttempt <= Math.max(0, config.maxFastRetries)
        ? Math.max(0, config.initialFastRetryDelayMs)
        : computeManagedConnectionBackoffMs({
            attempt: nextAttempt,
            minMs: config.backoffMinMs,
            maxMs: config.backoffMaxMs,
            jitterRatio: config.jitterRatio,
          });
    scheduleProbe(nextAttempt, delayMs, {
      status: 'server_unreachable',
      errorMessage: report.errorMessage,
    });
  }

  async function waitUntilOnline(params?: Readonly<{ timeoutMs?: number }>): Promise<void> {
    if (state.phase === 'online') return;
    if (state.phase === 'auth_failed') {
      throw new Error('Endpoint auth failed');
    }
    const timeoutMs = params?.timeoutMs;

    await new Promise<void>((resolve, reject) => {
      const timeout =
        typeof timeoutMs === 'number'
          ? setTimeout(() => {
              cleanup();
              reject(new Error('Timed out waiting for endpoint online'));
            }, Math.max(0, timeoutMs))
          : null;

      let unsubscribe = () => {};
      unsubscribe = subscribe((s) => {
        if (s.phase === 'online') {
          cleanup();
          resolve();
          return;
        }
        if (s.phase === 'auth_failed') {
          cleanup();
          reject(new Error('Endpoint auth failed'));
        }
      });

      function cleanup() {
        unsubscribe();
        if (timeout) clearTimeout(timeout);
      }
    });
  }

  function subscribe(listener: (state: ManagedEndpointSupervisorState) => void): () => void {
    listeners.add(listener);
    listener(state);
    return () => listeners.delete(listener);
  }

  return {
    async start(): Promise<void> {
      if (startInFlight && !isStopped) {
        await startInFlight;
        return;
      }

      const run = async (): Promise<void> => {
      if (isStarted && !isStopped) {
        if (state.phase === 'online' || state.phase === 'connecting') return;
        pendingInvalidate = false;
        await runProbe({ attempt: 0, initial: false });
        return;
      }
      isStarted = true;
      isStopped = false;
      pendingInvalidate = false;
      await runProbe({ attempt: 0, initial: true });
      };

      const promise = run();
      startInFlight = promise;
      try {
        await promise;
      } finally {
        if (startInFlight === promise) {
          startInFlight = null;
        }
      }
    },
    async stop(): Promise<void> {
      if (isStopped) return;
      isStopped = true;
      startInFlight = null;
      pendingInvalidate = false;
      clearRetryTimer();
      publish({
        ...state,
        phase: 'shutting_down',
        reason: 'intentional_shutdown',
        nextRetryAt: null,
      });
    },
    invalidate,
    reportFailure,
    waitUntilOnline,
    getState(): ManagedEndpointSupervisorState {
      return state;
    },
    subscribe,
  };
}
