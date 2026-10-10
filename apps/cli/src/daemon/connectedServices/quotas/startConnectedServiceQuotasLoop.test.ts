import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceQuotasLoop } from './startConnectedServiceQuotasLoop';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';

describe('startConnectedServiceQuotasLoop', () => {
  it('notifies subscribed demand readers only after a successful settled tick, and detaches on stop', async () => {
    let tick: () => void = () => {};
    let complete: () => void = () => {};
    let fail = false;
    const observations: string[] = [];
    // Account HTTP and clock are external boundaries; keep the real coordinator beneath them.
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'quota-loop-account', encryption: null }, quotaFetchers: [], discoveryEnabled: false,
      now: () => { if (fail) throw new Error('clock unavailable'); return 500; },
      randomBytes: length => new Uint8Array(length),
      api: {
        getAccountEncryptionMode: async () => {
          await new Promise<void>(resolve => { complete = resolve; });
          return 'plain';
        },
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null,
      },
    });
    const handle = startConnectedServiceQuotasLoop({
      enabled: true, tickMs: 10,
      coordinator,
      onTickError: () => {},
      setIntervalFn: fn => { tick = fn; return 123; },
      clearIntervalFn: () => {},
    });
    const unsubscribe = handle!.subscribeAfterTick(() => { observations.push('read-demand'); });
    tick();
    expect(observations).toEqual([]);
    complete();
    await vi.waitFor(() => expect(observations).toEqual(['read-demand']));
    fail = true;
    tick();
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(observations).toEqual(['read-demand']);
    unsubscribe();
    fail = false;
    tick();
    complete();
    await Promise.resolve();
    await Promise.resolve();
    expect(observations).toEqual(['read-demand']);
    handle!.subscribeAfterTick(() => { observations.push('after-stop'); });
    tick();
    const stopping = handle!.stop();
    complete();
    await stopping;
    expect(observations).not.toContain('after-stop');
  });

  it('schedules tickOnce when enabled', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

	    let captured: (() => void) = () => {};
	    let cleared = 0;
	    const setIntervalFn = ((fn: () => void) => {
	      captured = fn;
	      return 123;
	    });
    const clearIntervalFn = (() => {
      cleared += 1;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn,
    });

    expect(handle).not.toBeNull();
    const callback: () => void = captured ?? (() => {
      throw new Error('fixture: expected interval callback');
    });
    callback();
    await Promise.resolve();

    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
    handle?.stop();
    expect(cleared).toBe(1);
  });

  it('unrefs the interval handle when supported', () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };
    const unref = vi.fn();
    const setIntervalFn = vi.fn(() => ({ unref }));

    startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const handle = startConnectedServiceQuotasLoop({
      enabled: false,
      tickMs: 10,
      coordinator: { tickOnce: vi.fn() },
      onTickError: vi.fn(),
      setIntervalFn: () => 123,
      clearIntervalFn: () => {},
    });
    expect(handle).toBeNull();
  });

  it('pauses ticks until resume()', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

    let captured: (() => void) = () => {};
    const setIntervalFn = ((fn: () => void) => {
      captured = fn;
      return 123;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn,
      clearIntervalFn: vi.fn(),
    });

    handle?.pause();
    captured();
    await Promise.resolve();
    expect(coordinator.tickOnce).not.toHaveBeenCalled();

    handle?.resume();
    captured();
    await Promise.resolve();
    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
  });

  it('waits for an in-flight tick when stopped', async () => {
    let releaseTick!: () => void;
    let markTickStarted!: () => void;
    const tickStarted = new Promise<void>((resolve) => {
      markTickStarted = resolve;
    });
    const coordinator: { tickOnce: () => Promise<void> } = {
      tickOnce: vi.fn(async () => {
        markTickStarted();
        await new Promise<void>((release) => {
          releaseTick = release;
        });
      }),
    };

    let captured: (() => void) = () => {};
    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setIntervalFn: (fn: () => void) => {
        captured = fn;
        return 123;
      },
      clearIntervalFn: vi.fn(),
    });

    captured();

    await tickStarted;
    const stopPromise = handle?.stop();
    let stopped = false;
    void stopPromise?.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseTick();
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
