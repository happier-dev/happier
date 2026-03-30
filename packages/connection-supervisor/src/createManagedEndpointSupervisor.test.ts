import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MANAGED_CONNECTION_POLICY,
  type ReadinessProbeResult,
  createManagedEndpointSupervisor,
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

describe('createManagedEndpointSupervisor', () => {
  it('dedupes concurrent start() calls while a probe is in flight', async () => {
    const probeDeferred = createDeferred<ReadinessProbeResult>();
    const probeReadiness = vi.fn(() => probeDeferred.promise);

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    const p1 = supervisor.start();
    const p2 = supervisor.start();

    expect(probeReadiness).toHaveBeenCalledTimes(1);

    probeDeferred.resolve({ status: 'ready' });
    await Promise.all([p1, p2]);
  });

  it('probes immediately and publishes online state when ready', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi.fn<() => Promise<ReadinessProbeResult>>().mockResolvedValue({ status: 'ready' });
    const phases: string[] = [];

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      jitterRatio: 0,
    });
    supervisor.subscribe((s) => phases.push(s.phase));

    await supervisor.start();

    expect(probeReadiness).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(expect.arrayContaining(['connecting', 'online']));

    vi.useRealTimers();
  });

  it('waitUntilOnline rejects immediately when already auth_failed', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi.fn<() => Promise<ReadinessProbeResult>>().mockResolvedValue({ status: 'auth_failed', statusCode: 401 });
    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    await expect(supervisor.waitUntilOnline()).rejects.toThrow('Endpoint auth failed');

    vi.useRealTimers();
  });

  it('updates lastDisconnectedAt on each offline transition', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ status: 'server_unreachable' })
      .mockResolvedValueOnce({ status: 'ready' })
      .mockResolvedValueOnce({ status: 'server_unreachable' });

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      maxFastRetries: 0,
      backoffMinMs: 10_000,
      backoffMaxMs: 10_000,
      jitterRatio: 0,
    });

    await supervisor.start();
    expect(supervisor.getState().phase).toBe('online');

    vi.setSystemTime(1000);
    supervisor.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.getState().phase).toBe('offline');
    expect(supervisor.getState().lastDisconnectedAt).toBe(1000);

    vi.setSystemTime(2000);
    supervisor.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.getState().phase).toBe('online');

    vi.setSystemTime(3000);
    supervisor.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisor.getState().phase).toBe('offline');
    expect(supervisor.getState().lastDisconnectedAt).toBe(3000);

    vi.useRealTimers();
  });

  it('schedules retries with backoff when server is unreachable', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'server_unreachable', errorMessage: 'offline' })
      .mockResolvedValueOnce({ status: 'ready' });
    const states: Array<{ phase: string; attempt: number; nextRetryAt: number | null; lastErrorMessage: string | null }> = [];

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      maxFastRetries: 0,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });
    supervisor.subscribe((s) =>
      states.push({ phase: s.phase, attempt: s.attempt, nextRetryAt: s.nextRetryAt, lastErrorMessage: s.lastErrorMessage }),
    );

    await supervisor.start();
    expect(states).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'offline', attempt: 1, lastErrorMessage: 'offline' })]));

    await vi.advanceTimersByTimeAsync(10);

    expect(probeReadiness).toHaveBeenCalledTimes(2);
    expect(states).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'online', attempt: 1 })]));

    vi.useRealTimers();
  });

  it('respects retryAfterMs for retry_later probes', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'retry_later', retryAfterMs: 50 })
      .mockResolvedValueOnce({ status: 'ready' });
    const nextRetryAts: Array<number | null> = [];

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 20,
      jitterRatio: 0,
    });
    supervisor.subscribe((s) => nextRetryAts.push(s.nextRetryAt));

    await supervisor.start();

    const scheduled = nextRetryAts.find((v) => typeof v === 'number');
    expect(typeof scheduled).toBe('number');

    await vi.advanceTimersByTimeAsync(49);
    expect(probeReadiness).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(probeReadiness).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('clamps retryAfterMs=0 to avoid a tight retry loop', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'retry_later', retryAfterMs: 0, errorMessage: 'busy' })
      .mockResolvedValueOnce({ status: 'ready' });

    const states: Array<{ phase: string; nextRetryAt: number | null }> = [];
    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });
    supervisor.subscribe((s) => {
      states.push({ phase: s.phase, nextRetryAt: s.nextRetryAt });
    });

    await supervisor.start();

    const offlineState = states.findLast((s) => s.phase === 'offline') ?? null;
    expect(offlineState?.nextRetryAt ?? 0).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(0);
    expect(probeReadiness).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(probeReadiness).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('ignores non-finite retryAfterMs values to avoid immediate retry loops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'retry_later', retryAfterMs: Number.NaN, errorMessage: 'busy' })
      .mockResolvedValueOnce({ status: 'ready' });

    const states: Array<{ phase: string; nextRetryAt: number | null }> = [];
    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 10,
      maxFastRetries: 10,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });
    supervisor.subscribe((s) => {
      states.push({ phase: s.phase, nextRetryAt: s.nextRetryAt });
    });

    await supervisor.start();

    const offlineState = states.findLast((s) => s.phase === 'offline') ?? null;
    expect(offlineState?.nextRetryAt).toBe(10);

    await vi.advanceTimersByTimeAsync(9);
    expect(probeReadiness).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(probeReadiness).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('transitions to auth_failed and stops retrying when auth fails', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi.fn<() => Promise<ReadinessProbeResult>>().mockResolvedValue({ status: 'auth_failed', statusCode: 401 });
    const phases: string[] = [];

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });
    supervisor.subscribe((s) => phases.push(s.phase));

    await supervisor.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(phases).toContain('auth_failed');
    expect(probeReadiness).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('cancels scheduled retries on stop', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi.fn<() => Promise<ReadinessProbeResult>>().mockResolvedValue({ status: 'server_unreachable' });
    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      maxFastRetries: 0,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    await supervisor.start();
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(probeReadiness).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('invalidate triggers an immediate probe while offline', async () => {
    vi.useFakeTimers();
    const probeReadiness = vi
      .fn<() => Promise<ReadinessProbeResult>>()
      .mockResolvedValueOnce({ status: 'server_unreachable' })
      .mockResolvedValueOnce({ status: 'ready' });

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 1,
      maxFastRetries: 0,
      backoffMinMs: 1_000,
      backoffMaxMs: 1_000,
      jitterRatio: 0,
    });

    await supervisor.start();
    expect(probeReadiness).toHaveBeenCalledTimes(1);

    supervisor.invalidate();
    await vi.advanceTimersByTimeAsync(0);

    expect(probeReadiness).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('reportFailure cancels an in-flight probe result', async () => {
    vi.useFakeTimers();
    let resolveProbe: ((value: ReadinessProbeResult) => void) | null = null;
    const probeReadiness = vi.fn<() => Promise<ReadinessProbeResult>>().mockImplementation(
      () =>
        new Promise<ReadinessProbeResult>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const supervisor = createManagedEndpointSupervisor({
      ...DEFAULT_MANAGED_CONNECTION_POLICY,
      probeReadiness,
      initialFastRetryDelayMs: 10,
      maxFastRetries: 0,
      backoffMinMs: 10,
      backoffMaxMs: 10,
      jitterRatio: 0,
    });

    const startPromise = supervisor.start();

    // The probe is in-flight; supervisor should be connecting.
    expect(supervisor.getState().phase).toBe('connecting');

    supervisor.reportFailure({ errorMessage: 'network failed' });
    expect(supervisor.getState().phase).toBe('offline');

    resolveProbe?.({ status: 'ready' });
    await startPromise;

    // Without a generation bump, the stale probe would publish online here.
    expect(supervisor.getState().phase).toBe('offline');

    vi.useRealTimers();
  });
});
