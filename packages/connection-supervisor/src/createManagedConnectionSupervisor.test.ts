import { describe, expect, it, vi } from 'vitest';

import {
  createManagedConnectionSupervisor,
  DEFAULT_MANAGED_CONNECTION_POLICY,
  type ManagedConnectionTransport,
  type ReadinessProbeResult,
} from './index';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTransportHarness(options?: Readonly<{ autoConnectOnCall?: boolean }>) {
  const onConnectedListeners = new Set<() => void>();
  const onDisconnectedListeners = new Set<(event: { intentional?: boolean; reason?: string | null; error?: unknown }) => void>();
  const onErrorListeners = new Set<(error: unknown) => void>();
  let connected = false;
  const autoConnectOnCall = options?.autoConnectOnCall ?? true;

  const transport: ManagedConnectionTransport = {
    connect: vi.fn(async () => {
      if (!autoConnectOnCall) {
        return;
      }
      connected = true;
      for (const listener of onConnectedListeners) listener();
    }),
    disconnect: vi.fn(async (params?: { intentional?: boolean }) => {
      connected = false;
      for (const listener of onDisconnectedListeners) {
        listener({ intentional: params?.intentional === true, reason: params?.intentional === true ? 'manual' : 'disconnect' });
      }
    }),
    destroy: vi.fn(async () => {
      connected = false;
    }),
    isConnected: () => connected,
    onConnected: (listener) => {
      onConnectedListeners.add(listener);
      return () => onConnectedListeners.delete(listener);
    },
    onDisconnected: (listener) => {
      onDisconnectedListeners.add(listener);
      return () => onDisconnectedListeners.delete(listener);
    },
    onError: (listener) => {
      onErrorListeners.add(listener);
      return () => onErrorListeners.delete(listener);
    },
  };

  return {
    transport,
    emitDisconnect(event: { intentional?: boolean; reason?: string | null; error?: unknown } = {}) {
      connected = false;
      for (const listener of onDisconnectedListeners) listener(event);
    },
    emitError(error: unknown) {
      for (const listener of onErrorListeners) listener(error);
    },
  };
}

describe('createManagedConnectionSupervisor', () => {
  it('connects immediately and publishes online state', async () => {
    const harness = createTransportHarness();
    const states: string[] = [];

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => harness.transport,
      probeReadiness: async (): Promise<ReadinessProbeResult> => ({ status: 'ready' }),
      onStateChange: (state) => {
        states.push(`${state.phase}:${state.reason ?? 'none'}`);
      },
      initialFastRetryDelayMs: 1,
      backoffMinMs: 5,
      backoffMaxMs: 20,
      jitterRatio: 0,
    });

    await supervisor.start();

    expect(states).toContain('connecting:initial_connect');
    expect(states).toContain('online:initial_connect');
  });

  it('does one fast retry before entering managed retry mode', async () => {
    vi.useFakeTimers();
    const firstTransport = createTransportHarness();
    const secondTransport = createTransportHarness();
    const thirdTransport = createTransportHarness();
    const transports = [firstTransport, secondTransport, thirdTransport];
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ status: 'ready' });
    const states: Array<{ phase: string; attempt: number }> = [];

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => {
        const next = transports.shift();
        if (!next) throw new Error('missing transport');
        return next.transport;
      },
      probeReadiness,
      onStateChange: (state) => {
        states.push({ phase: state.phase, attempt: state.attempt });
      },
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    firstTransport.emitDisconnect({ reason: 'transport closed' });
    await vi.advanceTimersByTimeAsync(1);
    secondTransport.emitDisconnect({ reason: 'transport closed' });
    await vi.advanceTimersByTimeAsync(10);

    expect(probeReadiness).toHaveBeenCalledTimes(2);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'offline', attempt: 1 }),
        expect.objectContaining({ phase: 'offline', attempt: 2 }),
        expect.objectContaining({ phase: 'online', attempt: 2 }),
      ]),
    );

    vi.useRealTimers();
  });

  it('transitions to auth_failed and stops retrying when readiness probe rejects auth', async () => {
    vi.useFakeTimers();
    const harness = createTransportHarness();
    const probeReadiness = vi.fn<() => Promise<ReadinessProbeResult>>().mockResolvedValue({ status: 'auth_failed', statusCode: 401 });
    const states: string[] = [];

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => harness.transport,
      probeReadiness,
      onStateChange: (state) => {
        states.push(state.phase);
      },
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    harness.emitDisconnect({ reason: 'transport closed' });
    await vi.advanceTimersByTimeAsync(25);

    expect(states).toContain('auth_failed');
    expect(probeReadiness).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('retries from auth_failed when start is called again', async () => {
    vi.useFakeTimers();
    const firstTransport = createTransportHarness();
    const secondTransport = createTransportHarness();
    const transports = [firstTransport, secondTransport];
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'auth_failed', statusCode: 401 })
      .mockResolvedValueOnce({ status: 'ready' });
    const states: Array<{ phase: string; attempt: number }> = [];

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => {
        const next = transports.shift();
        if (!next) throw new Error('missing transport');
        return next.transport;
      },
      probeReadiness,
      onStateChange: (state) => {
        states.push({ phase: state.phase, attempt: state.attempt });
      },
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    firstTransport.emitDisconnect({ reason: 'transport closed' });
    await vi.advanceTimersByTimeAsync(25);

    expect(states).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'auth_failed', attempt: 1 })]));

    await supervisor.start();

    expect(probeReadiness).toHaveBeenCalledTimes(1);
    expect(secondTransport.transport.connect).toHaveBeenCalledTimes(1);
    expect(states).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'online', attempt: 0 })]));

    vi.useRealTimers();
  });

  it('increases retry attempts when readiness probes keep reporting server_unreachable', async () => {
    vi.useFakeTimers();
    const firstTransport = createTransportHarness();
    const secondTransport = createTransportHarness();
    const transports = [firstTransport, secondTransport];
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'server_unreachable', errorMessage: 'offline-1' })
      .mockResolvedValueOnce({ status: 'server_unreachable', errorMessage: 'offline-2' })
      .mockResolvedValueOnce({ status: 'ready' });
    const states: Array<{ phase: string; attempt: number; nextRetryAt: number | null; lastErrorMessage: string | null }> = [];

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => {
        const next = transports.shift();
        if (!next) throw new Error('missing transport');
        return next.transport;
      },
      probeReadiness,
      onStateChange: (state) => {
        states.push({
          phase: state.phase,
          attempt: state.attempt,
          nextRetryAt: state.nextRetryAt,
          lastErrorMessage: state.lastErrorMessage,
        });
      },
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      jitterRatio: 0,
    });

    await supervisor.start();
    firstTransport.emitDisconnect({ reason: 'transport closed' });
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);

    expect(probeReadiness).toHaveBeenCalledTimes(3);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'offline', attempt: 2, lastErrorMessage: 'offline-1' }),
        expect.objectContaining({ phase: 'offline', attempt: 3, lastErrorMessage: 'offline-2' }),
        expect.objectContaining({ phase: 'online', attempt: 3 }),
      ]),
    );

    vi.useRealTimers();
  });

  it('retries when connect_error happens before a transport ever reaches connected state', async () => {
    vi.useFakeTimers();
    const firstTransport = createTransportHarness({ autoConnectOnCall: false });
    const secondTransport = createTransportHarness();
    const transports = [firstTransport, secondTransport];
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'ready' });
    const states: Array<{ phase: string; attempt: number; lastErrorMessage: string | null }> = [];

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => {
        const next = transports.shift();
        if (!next) throw new Error('missing transport');
        return next.transport;
      },
      probeReadiness,
      onStateChange: (state) => {
        states.push({
          phase: state.phase,
          attempt: state.attempt,
          lastErrorMessage: state.lastErrorMessage,
        });
      },
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    firstTransport.emitError(new Error('handshake failed'));
    await vi.advanceTimersByTimeAsync(1);

    expect(probeReadiness).toHaveBeenCalledTimes(1);
    expect(secondTransport.transport.connect).toHaveBeenCalledTimes(1);
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: 'offline', attempt: 1, lastErrorMessage: 'handshake failed' }),
        expect.objectContaining({ phase: 'online', attempt: 1 }),
      ]),
    );

    vi.useRealTimers();
  });

  it('cancels pending retries on intentional stop', async () => {
    vi.useFakeTimers();
    const harness = createTransportHarness();
    const probeDeferred = createDeferred<ReadinessProbeResult>();
    const probeReadiness = vi.fn(() => probeDeferred.promise);

    const supervisor = createManagedConnectionSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      createTransport: () => harness.transport,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    harness.emitDisconnect({ reason: 'transport closed' });
    await vi.advanceTimersByTimeAsync(1);
    await supervisor.stop();
    probeDeferred.resolve({ status: 'ready' });
    await vi.runOnlyPendingTimersAsync();

    expect(harness.transport.destroy).toHaveBeenCalled();

    vi.useRealTimers();
  });
});
