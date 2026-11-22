import { readProcessRunState, type ProcessRunState } from '@/daemon/processRunState';
import { logger } from '@/ui/logger';

type RunnerIdentity = Readonly<{
  pid: number;
}>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function waitForTrackedRunnerProcessesExit(params: Readonly<{
  runners: readonly RunnerIdentity[];
  timeoutMs: number;
  pollIntervalMs: number;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
  onExitObserved?: (pid: number, exit: Readonly<{ reason: 'process-missing'; code: null; signal: null }>) => void | Promise<void>;
}>): Promise<boolean> {
  const readRunState = params.readRunState ?? readProcessRunState;
  const remaining = new Map(
    params.runners
      .filter((runner) => Number.isInteger(runner.pid) && runner.pid > 0)
      .map((runner) => [runner.pid, runner] as const),
  );
  if (remaining.size === 0) return true;

  const timeoutMs = Math.max(0, Math.trunc(params.timeoutMs));
  const pollIntervalMs = Math.max(0, Math.trunc(params.pollIntervalMs));
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + timeoutMs;
  const exitedPids: number[] = [];
  do {
    for (const pid of remaining.keys()) {
      const probeStartedAtMs = Date.now();
      const runState = await readRunState(pid);
      if (runState === 'dead' || runState === 'zombie') {
        logger.infoFile('[DAEMON STOP] Tracked runner physical exit observed', {
          pid, runState, elapsedMs: Date.now() - startedAtMs, probeElapsedMs: Date.now() - probeStartedAtMs,
        });
        exitedPids.push(pid);
        remaining.delete(pid);
      }
    }
    if (remaining.size === 0) break;
    if (Date.now() >= deadlineMs) break;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  } while (Date.now() <= deadlineMs);

  if (remaining.size > 0) {
    logger.infoFile('[DAEMON STOP] Physical runner exit wait expired', {
      remainingRunnerCount: remaining.size, elapsedMs: Date.now() - startedAtMs, timeoutMs,
    });
    return false;
  }
  // Settle custody after every runner has exited so cleanup cannot delay the decision to escalate another runner.
  if (params.onExitObserved) {
    for (const pid of exitedPids) {
      const lifecycleStartedAtMs = Date.now();
      await params.onExitObserved(pid, { reason: 'process-missing', code: null, signal: null });
      logger.infoFile('[DAEMON STOP] Tracked runner exit lifecycle completed', {
        pid, elapsedMs: Date.now() - lifecycleStartedAtMs,
      });
    }
  }
  return true;
}
