import { afterEach, describe, expect, it, vi } from 'vitest';
import { startAutomationLeaseHeartbeat } from './automationLeaseHeartbeat';

afterEach(() => vi.useRealTimers());

describe('Automation claim lease observation', () => {
  it('keeps a long lease cadence without overflowing the platform timer delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const maximumPlatformDelay = 2_147_483_647;
    const heartbeatMs = maximumPlatformDelay + 1_000;
    const timer = vi.spyOn(globalThis, 'setTimeout');
    const onHeartbeat = vi.fn(async () => Date.now() + 4 * heartbeatMs);
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs, leaseExpiresAtMs: 4 * heartbeatMs,
      onHeartbeat, onError: vi.fn() });
    try {
      expect(timer.mock.calls[0]?.[1]).toBeLessThanOrEqual(maximumPlatformDelay);
      await vi.advanceTimersByTimeAsync(maximumPlatformDelay);
      expect(onHeartbeat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onHeartbeat).toHaveBeenCalledOnce();
    } finally { heartbeat.stop(); timer.mockRestore(); }
  });

  it('lets a pending renewal use the confirmed lease instead of a shorter attempt budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deadlines: number[] = [];
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 10_000,
      onHeartbeat: async (_progress, deadline, signal) => {
        deadlines.push(deadline);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 6_000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return 20_000;
      }, onError });
    try {
      await vi.advanceTimersByTimeAsync(7_000);
      expect(deadlines).toEqual([10_000]);
      expect(onError).not.toHaveBeenCalled();
    } finally { heartbeat.stop(); }
  });

  it('honors a renewal cadence below the removed one-second floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 250, leaseExpiresAtMs: 1_000,
      onHeartbeat: async () => { starts.push(Date.now()); return Date.now() + 1_000; }, onError: vi.fn() });
    try {
      await vi.advanceTimersByTimeAsync(750);
      expect(starts).toEqual([250, 500, 750]);
    } finally { heartbeat.stop(); }
  });

  it('derives renewal windows from the confirmed lease left after slow claim delivery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 10_000, leaseExpiresAtMs: 6_000,
      onHeartbeat: async () => {
        starts.push(Date.now());
        if (starts.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 2_000));
          throw Object.assign(new Error('slow renewal'), { code: 'ECONNABORTED' });
        }
        return 30_000;
      }, onError });
    try {
      await vi.advanceTimersByTimeAsync(5_999);
      expect(starts).toHaveLength(2);
      expect(starts[0]).toBe(0);
      expect(starts[1]).toBeLessThan(6_000);
      expect(onError).not.toHaveBeenCalled();
    } finally { heartbeat.stop(); }
  });

  it('keeps a delayed renewal pending until the confirmed lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 10_000, leaseExpiresAtMs: 30_000,
      onHeartbeat: async (_progress, _deadline, signal) => {
        starts.push(Date.now());
        if (starts.length === 1) {
          await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
        }
        return 60_000;
      }, onError });
    try {
      vi.setSystemTime(18_000);
      await vi.advanceTimersByTimeAsync(11_999);
      expect(starts).toEqual([28_000]);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onError).toHaveBeenCalledOnce();
    } finally { heartbeat.stop(); }
  });

  it('retries serially before expiry when a renewal takes longer than one cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const deadlines: number[] = [];
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 10_000,
      onHeartbeat: async (_progress, deadlineAtMs) => {
        starts.push(Date.now());
        deadlines.push(deadlineAtMs);
        if (starts.length === 1) {
          await new Promise(resolve => setTimeout(resolve, 2_500));
          throw Object.assign(new Error('slow renewal'), { code: 'ECONNABORTED' });
        }
        return 20_000;
      }, onError });
    try {
      await vi.advanceTimersByTimeAsync(4_500);
      expect(starts).toEqual([1_000, 4_500]);
      expect(deadlines).toEqual([10_000, 10_000]);
      expect(onError).not.toHaveBeenCalled();
    } finally { heartbeat.stop(); }
  });

  it.each(['publisher_proof', 'http'] as const)('retains the pending %s phase only for expiry and late-response attribution', async stage => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let acknowledge!: (expiry: number) => void;
    const response = new Promise<number>(resolve => { acknowledge = resolve; });
    const onObservation = vi.fn();
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000,
      onHeartbeat: onProgress => {
        onProgress({ stage, renewalStartedAtMs: 1_000, stageStartedAtMs: stage === 'http' ? 1_250 : 1_000,
          ...(stage === 'http' ? { publisherProofDurationMs: 250 } : {}) });
        return response;
      }, onError, onObservation });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({ event: 'expired',
      observedAtMs: 3_000, renewalScheduledAtMs: 1_000, renewalStartedAtMs: 1_000,
      renewalTransport: expect.objectContaining({ stage, stageStartedAtMs: stage === 'http' ? 1_250 : 1_000 }) }));
    acknowledge(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onObservation).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'late_response',
      renewalTransport: expect.objectContaining({ stage }) }));
    expect(onError).toHaveBeenCalledOnce();
    heartbeat.stop();
  });

  it('identifies a starved cadence before any renewal starts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onHeartbeat = vi.fn(async () => 30_000);
    const onObservation = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000,
      onHeartbeat, onError: vi.fn(), onObservation });
    vi.setSystemTime(3_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onHeartbeat).not.toHaveBeenCalled();
    expect(onObservation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ event: 'expired',
      observedAtMs: 4_000, scheduledAtMs: 1_000, renewalStartedAtMs: null, renewalTransport: null }));
    heartbeat.stop();
  });

  it('keeps renewing and stopping when the observation callback throws', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onHeartbeat = vi.fn(async () => Date.now() + 3_000);
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000,
      onHeartbeat, onError, onObservation: () => { throw new Error('observer failed'); } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(5);
    expect(onError).not.toHaveBeenCalled();
    expect(() => heartbeat.stop()).not.toThrow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onHeartbeat).toHaveBeenCalledTimes(5);
  });

  it('identifies a delayed renewal and its late response without reviving the expired claim', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let acknowledge!: (expiry: number) => void;
    const response = new Promise<number>(resolve => { acknowledge = resolve; });
    const onObservation = vi.fn();
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000,
      onHeartbeat: () => response, onError, onObservation });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(onObservation.mock.calls.map(([event]) => event)).toEqual([
      expect.objectContaining({ event: 'renewal_started', observedAtMs: 1_000, scheduledAtMs: 1_000,
        leaseExpiresAtMs: 3_000, renewalStartedAtMs: 1_000 }),
      expect.objectContaining({ event: 'expired', observedAtMs: 3_000, renewalStartedAtMs: 1_000,
        renewalInFlight: true }),
    ]);
    acknowledge(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onObservation).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'late_response',
      observedAtMs: 3_000, renewalStartedAtMs: 1_000, leaseExpiresAtMs: 3_000 }));
    expect(onError).toHaveBeenCalledOnce();
    heartbeat.stop();
  });

  it('keeps a claim after a transient heartbeat failure and renews only from server expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onError = vi.fn();
    const onHeartbeat = vi.fn(async () => Date.now() + 5_000)
      .mockRejectedValueOnce(Object.assign(new Error('lost response'), { code: 'ECONNABORTED' }));
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 3_000, onHeartbeat, onError });
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onError).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(onHeartbeat).toHaveBeenCalledTimes(3);
      expect(onError).not.toHaveBeenCalled();
    } finally { heartbeat.stop(); }
  });

  it.each([401, 403, 404, 409])('ends claim observation on authoritative heartbeat refusal (%s)', async status => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refusal = { response: { status } };
    const onError = vi.fn();
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 30_000,
      onHeartbeat: async () => { throw refusal; }, onError });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onError).toHaveBeenCalledExactlyOnceWith(refusal);
    heartbeat.stop();
  });

  it.each(['transport_failure', 'pending_response'] as const)('ends observation at the last confirmed lease expiry (%s)', async scenario => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let acknowledge = (_expiry: number) => {};
    const response = new Promise<number>(resolve => { acknowledge = resolve; });
    const onError = vi.fn();
    const onHeartbeat = vi.fn(async () => {
      if (scenario === 'pending_response') return await response;
      throw Object.assign(new Error('lost response'), { code: 'ECONNABORTED' });
    });
    const heartbeat = startAutomationLeaseHeartbeat({ heartbeatMs: 1_000, leaseExpiresAtMs: 2_500, onHeartbeat, onError });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(onError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onError).toHaveBeenCalledOnce();
    acknowledge(30_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onError).toHaveBeenCalledOnce();
    if (scenario === 'pending_response') expect(onHeartbeat).toHaveBeenCalledOnce();
    heartbeat.stop();
  });
});
