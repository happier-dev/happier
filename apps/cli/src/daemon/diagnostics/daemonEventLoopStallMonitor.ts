import type { RpcHandlerActiveExecution } from '@/api/rpc/types';

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_WARNING_THRESHOLD_MS = 2_000;
const DEFAULT_MAX_REPORTED_OPERATIONS = 8;

type TimerHandle = Readonly<{ unref?: () => void }>;

export function createDaemonEventLoopStallMonitor(input: Readonly<{
  getActiveRpcOperations: () => readonly RpcHandlerActiveExecution[];
  warn: (message: string, data: Readonly<Record<string, unknown>>) => void;
  nowMs?: () => number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => TimerHandle;
  clearIntervalFn?: (handle: TimerHandle) => void;
  sampleIntervalMs?: number;
  warningThresholdMs?: number;
  maxReportedOperations?: number;
}>): Readonly<{
  start: () => void;
  stop: () => void;
}> {
  const nowMs = input.nowMs ?? (() => performance.now());
  const setIntervalFn = input.setIntervalFn ?? ((callback, intervalMs) => setInterval(callback, intervalMs));
  const clearIntervalFn = input.clearIntervalFn ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const sampleIntervalMs = input.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  const warningThresholdMs = input.warningThresholdMs ?? DEFAULT_WARNING_THRESHOLD_MS;
  const maxReportedOperations = input.maxReportedOperations ?? DEFAULT_MAX_REPORTED_OPERATIONS;
  let timer: TimerHandle | null = null;
  let expectedSampleAtMs = 0;

  const sample = (): void => {
    const observedAtMs = nowMs();
    const eventLoopDelayMs = Math.max(0, Math.round(observedAtMs - expectedSampleAtMs));
    expectedSampleAtMs = observedAtMs + sampleIntervalMs;
    if (eventLoopDelayMs < warningThresholdMs) return;

    const activeRpcOperations = input.getActiveRpcOperations()
      .map((operation) => ({
        method: operation.method,
        activeForMs: Math.max(0, Math.round(operation.activeForMs)),
      }))
      .sort((left, right) => right.activeForMs - left.activeForMs);
    const reportedOperations = activeRpcOperations.slice(0, maxReportedOperations);

    input.warn('[DAEMON PERF] Event loop stall detected', {
      eventLoopDelayMs,
      sampleIntervalMs,
      activeRpcOperations: reportedOperations,
      omittedActiveRpcOperationCount: Math.max(0, activeRpcOperations.length - reportedOperations.length),
    });
  };

  return {
    start: () => {
      if (timer) return;
      expectedSampleAtMs = nowMs() + sampleIntervalMs;
      timer = setIntervalFn(sample, sampleIntervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (!timer) return;
      clearIntervalFn(timer);
      timer = null;
    },
  };
}
