import { describe, expect, it, vi } from 'vitest';

import { createDaemonEventLoopStallMonitor } from './daemonEventLoopStallMonitor';

describe('createDaemonEventLoopStallMonitor', () => {
  it('emits a bounded safe warning when timer overshoot reaches the serious-stall threshold', () => {
    let nowMs = 10_000;
    const samples: Array<() => void> = [];
    const unref = vi.fn();
    const warn = vi.fn();
    const monitor = createDaemonEventLoopStallMonitor({
      nowMs: () => nowMs,
      setIntervalFn: (callback) => {
        samples.push(callback);
        return { unref };
      },
      clearIntervalFn: vi.fn(),
      getActiveRpcOperations: () => Array.from({ length: 9 }, (_, index) => ({
        method: `safe.method.${index}`,
        activeForMs: 9_000 - index,
      })),
      warn,
    });

    monitor.start();
    expect(unref).toHaveBeenCalledTimes(1);
    nowMs = 13_000;
    samples[0]?.();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[DAEMON PERF] Event loop stall detected',
      {
        eventLoopDelayMs: 2_000,
        sampleIntervalMs: 1_000,
        activeRpcOperations: Array.from({ length: 8 }, (_, index) => ({
          method: `safe.method.${index}`,
          activeForMs: 9_000 - index,
        })),
        omittedActiveRpcOperationCount: 1,
      },
    );

    nowMs = 14_000;
    samples[0]?.();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clears its single sampler and can be stopped more than once', () => {
    const handle = { unref: vi.fn() };
    const clearIntervalFn = vi.fn();
    const monitor = createDaemonEventLoopStallMonitor({
      getActiveRpcOperations: () => [],
      warn: vi.fn(),
      setIntervalFn: () => handle,
      clearIntervalFn,
    });

    monitor.start();
    monitor.start();
    monitor.stop();
    monitor.stop();

    expect(handle.unref).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledWith(handle);
  });
});
