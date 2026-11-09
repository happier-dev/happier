import { describe, expect, it, vi } from 'vitest';

import { startConnectedServiceQuotasLoop } from './startConnectedServiceQuotasLoop';
import { ConnectedServiceQuotasCoordinator } from './ConnectedServiceQuotasCoordinator';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';

describe('startConnectedServiceQuotasLoop', () => {
  it('aborts awaited account HTTP before stop finishes and does not publish another tick', async () => {
    let release: () => void = () => {};
    let requestSignal: AbortSignal | undefined;
    let requestStarted = false;
    let stopped = false;
    const observations: string[] = [];
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'quota-cancellation-account', encryption: null },
      quotaFetchers: [], discoveryEnabled: false,
      now: () => 500, randomBytes: length => new Uint8Array(length),
      // Account HTTP is the boundary; the coordinator and loop remain real.
      api: {
        getAccountEncryptionMode: async options => {
          requestSignal = options?.signal;
          requestStarted = true;
          await new Promise<void>((resolve, reject) => {
            release = resolve;
            requestSignal?.addEventListener('abort', () => reject(requestSignal!.reason), { once: true });
          });
          return 'plain';
        },
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null,
      },
    });
    const handle = startConnectedServiceQuotasLoop({
      enabled: true, tickMs: 10_000, coordinator, onTickError: () => {},
      setTimeoutFn: () => 1, clearTimeoutFn: () => {},
    })!;
    handle.subscribeAfterTick(() => { observations.push('settled'); });
    handle.wake();
    expect(requestStarted).toBe(true);
    const stopping = handle.stop().then(() => { stopped = true; });
    try {
      await vi.waitFor(() => {
        expect(requestSignal?.aborted).toBe(true);
        expect(stopped).toBe(true);
      });
      expect(observations).toEqual([]);
    } finally {
      release();
      await stopping;
    }
  });

  it('reconciles a parked owner on runtime registration and releases its subscription on stop', async () => {
    vi.useFakeTimers();
    const registry = new ConnectedServiceRuntimeRegistry();
    let ticks = 0;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'quota-loop-registry-account', encryption: null },
      quotaFetchers: [], discoveryEnabled: false, runtimeRegistry: registry,
      now: () => { ticks += 1; return Date.now(); },
      randomBytes: length => new Uint8Array(length),
      api: { getAccountEncryptionMode: async () => 'plain',
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null },
    });
    const handle = startConnectedServiceQuotasLoop({ enabled: true, tickMs: 50, coordinator,
      subscribeWake: listener => registry.subscribeTargetRegistrations(listener), onTickError: () => {} });
    try {
      handle?.wake();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(ticks).toBe(1);
      registry.registerTarget({ pid: 123, agentId: null, materializationKey: 'runtime',
        connectedServicesBindingsRaw: { v: 1, bindingsByServiceId: {} } });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
      await handle?.stop();
      registry.updateTarget({ pid: 123, sessionId: 'later' });
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
    } finally { await handle?.stop(); vi.useRealTimers(); }
  });
  it('parks after initial reconciliation when no account has a probe or reset deadline', async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'quota-loop-account', encryption: null },
      quotaFetchers: [], discoveryEnabled: false,
      now: () => { ticks += 1; return Date.now(); },
      randomBytes: length => new Uint8Array(length),
      api: {
        getAccountEncryptionMode: async () => 'plain',
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null,
      },
    });
    const handle = startConnectedServiceQuotasLoop({
      enabled: true, tickMs: 50, coordinator, runImmediately: true, onTickError: () => {},
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(1);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(ticks).toBe(1);
      handle?.pause();
      handle?.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(ticks).toBe(2);
    } finally {
      await handle?.stop();
      vi.useRealTimers();
    }
  });

  it('wakes the existing loop after profile changes without overlapping ticks', async () => {
    let ticks = 0;
    let firstRead = true;
    let release: () => void = () => {};
    // The real coordinator owns discovery; only its clock and account HTTP are controlled.
    const coordinator = new ConnectedServiceQuotasCoordinator({
      credentials: { token: 'quota-loop-account', encryption: null },
      quotaFetchers: [], discoveryEnabled: false,
      now: () => { ticks += 1; return 500; },
      randomBytes: length => new Uint8Array(length),
      api: {
        getAccountEncryptionMode: async () => {
          if (firstRead) {
            firstRead = false;
            await new Promise<void>(resolve => { release = resolve; });
          }
          return 'plain';
        },
        getConnectedServiceQuotaSnapshotSealed: async () => null,
        getConnectedServiceCredentialSealed: async () => null,
      },
    });
    const handle = startConnectedServiceQuotasLoop({
      enabled: true, tickMs: 10000,
      coordinator,
      onTickError: () => {},
      setTimeoutFn: () => 1, clearTimeoutFn: () => {},
    });
    handle?.wake();
    expect(ticks).toBe(1);
    handle?.wake();
    handle?.wake();
    expect(ticks).toBe(1);
    release();
    await vi.waitFor(() => expect(ticks).toBe(2));
    handle?.pause();
    handle?.wake();
    expect(ticks).toBe(2);
    handle?.resume();
    await vi.waitFor(() => expect(ticks).toBe(3));
    await handle?.stop();
    handle?.wake();
    expect(ticks).toBe(3);
  });

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
      setTimeoutFn: fn => { tick = fn; return 123; },
      clearTimeoutFn: () => {},
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
	    const setTimeoutFn = ((fn: () => void) => {
	      captured = fn;
	      return 123;
	    });
    const clearTimeoutFn = (() => {
      cleared += 1;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setTimeoutFn,
      clearTimeoutFn,
    });

    expect(handle).not.toBeNull();
    const callback: () => void = captured ?? (() => {
      throw new Error('fixture: expected interval callback');
    });
    callback();
    await Promise.resolve();

    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
    await handle?.stop();
    callback();
    expect(coordinator.tickOnce).toHaveBeenCalledTimes(1);
  });

  it('unrefs the interval handle when supported', () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };
    const unref = vi.fn();
    const setTimeoutFn = vi.fn(() => ({ unref }));

    startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
    });

    expect(unref).toHaveBeenCalledTimes(1);
  });

  it('does nothing when disabled', () => {
    const handle = startConnectedServiceQuotasLoop({
      enabled: false,
      tickMs: 10,
      coordinator: { tickOnce: vi.fn() },
      onTickError: vi.fn(),
      setTimeoutFn: () => 123,
      clearTimeoutFn: () => {},
    });
    expect(handle).toBeNull();
  });

  it('pauses ticks until resume()', async () => {
    const coordinator: { tickOnce: () => Promise<void> } = { tickOnce: vi.fn(async () => {}) };

    let captured: (() => void) = () => {};
    const setTimeoutFn = ((fn: () => void) => {
      captured = fn;
      return 123;
    });

    const handle = startConnectedServiceQuotasLoop({
      enabled: true,
      tickMs: 10,
      coordinator,
      onTickError: vi.fn(),
      setTimeoutFn,
      clearTimeoutFn: vi.fn(),
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
      setTimeoutFn: (fn: () => void) => {
        captured = fn;
        return 123;
      },
      clearTimeoutFn: vi.fn(),
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
