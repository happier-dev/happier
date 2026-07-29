import { readProcessRunState, type ProcessRunState } from '@/daemon/processRunState';

type TrackedRunnerPid = Readonly<{ pid: number }>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export async function waitForTrackedRunnerProcessesExit(params: Readonly<{
  runners: readonly TrackedRunnerPid[];
  timeoutMs: number;
  pollIntervalMs: number;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
}>): Promise<boolean> {
  const readRunState = params.readRunState ?? readProcessRunState;
  const remaining = new Set(
    params.runners
      .map((runner) => runner.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
  if (remaining.size === 0) return true;

  const timeoutMs = Math.max(0, Math.trunc(params.timeoutMs));
  const pollIntervalMs = Math.max(0, Math.trunc(params.pollIntervalMs));
  const deadlineMs = Date.now() + timeoutMs;
  do {
    for (const pid of remaining) {
      const runState = await readRunState(pid);
      if (runState === 'dead' || runState === 'zombie') {
        remaining.delete(pid);
      }
    }
    if (remaining.size === 0) return true;
    if (Date.now() >= deadlineMs) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadlineMs - Date.now())));
  } while (Date.now() <= deadlineMs);

  return false;
}
