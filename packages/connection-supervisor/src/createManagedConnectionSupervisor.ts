import { deriveManagedConnectionReason } from './managedConnectionEvents.js';
import { computeManagedConnectionBackoffMs } from './reconnectBackoff.js';
import type {
  ManagedConnectionState,
  ManagedConnectionSupervisor,
  ManagedConnectionSupervisorConfig,
  ManagedConnectionTransport,
  ReadinessProbeResult,
  TransportDisconnectEvent,
} from './managedConnectionTypes.js';

function readProbeErrorMessage(probe: ReadinessProbeResult | undefined, fallback: string | null): string | null {
  if (!probe || probe.status === 'ready') return fallback;
  return probe.errorMessage ?? fallback;
}

function initialState(): ManagedConnectionState {
  return {
    phase: 'idle',
    reason: null,
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
  };
}

export function createManagedConnectionSupervisor(
  config: ManagedConnectionSupervisorConfig,
): ManagedConnectionSupervisor {
  let state = initialState();
  let currentTransport: ManagedConnectionTransport | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let isStarted = false;
  let isStopped = false;
  let reconnectAttempt = 0;
  let generation = 0;
  let detachCurrentListeners: Array<() => void> = [];

  function publish(next: ManagedConnectionState): void {
    state = next;
    config.onStateChange?.(state);
  }

  function clearRetryTimer(): void {
    if (!retryTimer) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  async function cleanupTransport(params: { intentional?: boolean } = {}): Promise<void> {
    const transport = currentTransport;
    currentTransport = null;
    for (const detach of detachCurrentListeners.splice(0)) {
      detach();
    }
    if (!transport) return;
    try {
      await transport.disconnect({ intentional: params.intentional === true });
    } catch {}
    await transport.destroy().catch(() => {});
  }

  async function establishConnection(params: { initial?: boolean; attempt: number }): Promise<void> {
    const localGeneration = ++generation;
    clearRetryTimer();
    if (currentTransport) {
      await cleanupTransport();
    }
    if (isStopped) return;

    const transport = config.createTransport();
    currentTransport = transport;

    detachCurrentListeners = [
      transport.onConnected(() => {
        if (localGeneration !== generation || isStopped) return;
        const now = Date.now();
        reconnectAttempt = params.attempt;
        publish({
          phase: 'online',
          reason: params.initial ? 'initial_connect' : state.reason,
          attempt: params.attempt,
          nextRetryAt: null,
          lastConnectedAt: now,
          lastDisconnectedAt: state.lastDisconnectedAt,
          lastErrorMessage: null,
        });
        void config.onConnected?.({ state });
      }),
      transport.onDisconnected((event) => {
        if (localGeneration !== generation || isStopped) return;
        void handleDisconnect(event);
      }),
      transport.onError((error) => {
        if (localGeneration !== generation || isStopped) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (state.phase === 'connecting' && currentTransport === transport && transport.isConnected() !== true) {
          const nextAttempt = Math.max(1, state.attempt + 1);
          const delayMs =
            nextAttempt <= Math.max(1, config.maxFastRetries)
              ? Math.max(0, config.initialFastRetryDelayMs)
              : computeManagedConnectionBackoffMs({
                  attempt: nextAttempt,
                  minMs: config.backoffMinMs,
                  maxMs: config.backoffMaxMs,
                  jitterRatio: config.jitterRatio,
                });
          scheduleReconnect(nextAttempt, delayMs, {
            status: 'server_unreachable',
            errorMessage,
          });
          return;
        }
        publish({
          ...state,
          lastErrorMessage: errorMessage,
        });
      }),
    ];

    publish({
      ...state,
      phase: 'connecting',
      reason: params.initial ? 'initial_connect' : state.reason,
      attempt: params.attempt,
      nextRetryAt: null,
      lastErrorMessage: null,
    });

    await transport.connect();
  }

  async function runProbeAndReconnect(attempt: number): Promise<void> {
    if (isStopped) return;
    const probe = await config.probeReadiness().catch((error): ReadinessProbeResult => ({
      status: 'server_unreachable',
      errorMessage: error instanceof Error ? error.message : String(error),
    }));
    if (isStopped) return;

    if (probe.status === 'auth_failed') {
      publish({
        ...state,
        phase: 'auth_failed',
        reason: deriveManagedConnectionReason({ probe }),
        attempt,
        nextRetryAt: null,
        lastErrorMessage: readProbeErrorMessage(probe, state.lastErrorMessage),
      });
      await config.onAuthFailed?.({ state, probe });
      return;
    }

    if (probe.status !== 'ready') {
      const nextAttempt = attempt + 1;
      const delayMs =
        probe.status === 'retry_later' && typeof probe.retryAfterMs === 'number'
          ? probe.retryAfterMs
          : computeManagedConnectionBackoffMs({
              attempt: nextAttempt,
              minMs: config.backoffMinMs,
              maxMs: config.backoffMaxMs,
              jitterRatio: config.jitterRatio,
            });
      scheduleReconnect(nextAttempt, delayMs, probe);
      return;
    }

    await config.onBeforeReconnect?.({ attempt, state });
    await establishConnection({ attempt });
  }

  function scheduleReconnect(attempt: number, delayMs: number, probe?: ReadinessProbeResult): void {
    if (isStopped) return;
    clearRetryTimer();
    const now = Date.now();
    publish({
      phase: 'offline',
      reason: deriveManagedConnectionReason({ probe }),
      attempt,
      nextRetryAt: now + delayMs,
      lastConnectedAt: state.lastConnectedAt,
      lastDisconnectedAt: state.lastDisconnectedAt,
      lastErrorMessage: readProbeErrorMessage(probe, state.lastErrorMessage),
    });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void runProbeAndReconnect(attempt);
    }, Math.max(0, delayMs));
  }

  async function handleDisconnect(event: TransportDisconnectEvent): Promise<void> {
    const attempt = reconnectAttempt + 1;
    reconnectAttempt = attempt;
    const now = Date.now();
    publish({
      phase: 'offline',
      reason: deriveManagedConnectionReason({ disconnectEvent: event }),
      attempt,
      nextRetryAt: null,
      lastConnectedAt: state.lastConnectedAt,
      lastDisconnectedAt: now,
      lastErrorMessage: event.error instanceof Error ? event.error.message : event.error ? String(event.error) : null,
    });
    await config.onDisconnected?.({ state, event });
    if (event.intentional || isStopped) {
      return;
    }

    const isFastRetry = attempt <= Math.max(0, config.maxFastRetries);
    const delayMs = isFastRetry
      ? Math.max(0, config.initialFastRetryDelayMs)
      : computeManagedConnectionBackoffMs({
          attempt,
          minMs: config.backoffMinMs,
          maxMs: config.backoffMaxMs,
          jitterRatio: config.jitterRatio,
        });
    scheduleReconnect(attempt, delayMs);
  }

  return {
    async start(): Promise<void> {
      if (isStarted && !isStopped) {
        if (state.phase === 'online' || state.phase === 'connecting') {
          return;
        }
        reconnectAttempt = 0;
        await establishConnection({ initial: false, attempt: 0 });
        return;
      }
      isStarted = true;
      isStopped = false;
      reconnectAttempt = 0;
      await establishConnection({ initial: true, attempt: 0 });
    },
    async stop(): Promise<void> {
      if (isStopped) return;
      isStopped = true;
      clearRetryTimer();
      publish({
        ...state,
        phase: 'shutting_down',
        reason: 'intentional_shutdown',
        nextRetryAt: null,
      });
      await cleanupTransport({ intentional: true });
    },
    getState(): ManagedConnectionState {
      return state;
    },
  };
}
