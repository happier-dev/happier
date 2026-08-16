import { describe, expect, it, vi } from 'vitest';

import { createDaemonEventLoopStallMonitor } from './daemonEventLoopStallMonitor';

describe('createDaemonEventLoopStallMonitor', () => {
  it('emits one bounded structured warning after a serious timer delay', () => {
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
      sampleIntervalMs: 1_000,
      warningThresholdMs: 2_000,
      maxReportedOperations: 2,
      getActiveRpcOperations: () => [
        { method: 'workspace.favicon.resolve', activeForMs: 6_000 },
        { method: 'scm.status.snapshot', activeForMs: 8_000 },
        { method: 'capabilities.detect', activeForMs: 3_000 },
      ],
      warn,
    });

    monitor.start();
    expect(unref).toHaveBeenCalledTimes(1);
    nowMs = 13_750;
    samples[0]?.();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      '[DAEMON PERF] Event loop stall detected',
      {
        eventLoopDelayMs: 2_750,
        sampleIntervalMs: 1_000,
        activeRpcOperations: [
          { method: 'scm.status.snapshot', activeForMs: 8_000 },
          { method: 'workspace.favicon.resolve', activeForMs: 6_000 },
        ],
        omittedActiveRpcOperationCount: 1,
      },
    );

    nowMs = 14_750;
    samples[0]?.();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
