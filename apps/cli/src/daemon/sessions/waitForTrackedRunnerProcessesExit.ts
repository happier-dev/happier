import { readProcessRunState, type ProcessRunState } from '@/daemon/processRunState';
import { logger } from '@/ui/logger';
import type { TrackedSession } from '../types';
import { waitForChangeOrDeadline } from '../lifecycle/waitForChangeOrDeadline';

type TrackedRunnerPid = Readonly<Pick<TrackedSession, 'pid' | 'childProcess'>>;

async function waitForChildExit(child: NonNullable<TrackedSession['childProcess']>, remainingMs: number): Promise<boolean> {
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  if (hasExited()) return true;
  await waitForChangeOrDeadline({
    remainingMs,
    waitForChange: signal => new Promise<void>(resolve => {
      const finish = () => {
        child.removeListener('exit', finish);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      child.once('exit', finish);
      signal.addEventListener('abort', finish, { once: true });
      // Subscribe before rechecking the producer's terminal fact.
      if (hasExited()) finish();
    }),
  });
  return hasExited();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

type PhysicalExitWaitParams = Readonly<{
  runners: readonly TrackedRunnerPid[];
  timeoutMs: number;
  pollIntervalMs: number;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
  onExitObserved?: (pid: number, exit: Readonly<{ reason: 'process-missing'; code: null; signal: null }>) => void | Promise<void>;
}>;

export async function waitForTrackedRunnerProcessesExit(params: PhysicalExitWaitParams): Promise<boolean> {
  const readRunState = params.readRunState ?? readProcessRunState;
  const runnersByPid = new Map(params.runners.map(runner => [runner.pid, runner]));
  const remaining = new Set(
    params.runners
      .map((runner) => runner.pid)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  );
  if (remaining.size === 0) return true;

  const timeoutMs = Math.max(0, Math.trunc(params.timeoutMs));
  const pollIntervalMs = Math.max(0, Math.trunc(params.pollIntervalMs));
  const startedAtMs = Date.now();
  const deadlineMs = startedAtMs + timeoutMs;
  const exitedPids: number[] = [];
  do {
    for (const pid of remaining) {
      const probeStartedAtMs = Date.now();
      const child = runnersByPid.get(pid)?.childProcess;
      // A daemon-owned child's terminal fact is pushed by the process adapter.
      // Adopted runners have no child handle and still need OS death proof.
      let runState: ProcessRunState;
      if (child?.pid === pid) {
        runState = await waitForChildExit(child, Math.max(0, deadlineMs - Date.now())) ? 'dead' : 'servable';
      } else {
        runState = await readRunState(pid);
      }
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
  // The grace period decides when a live runner needs escalation. Observe all
  // runners before joining retirement, so one cleanup cannot delay that decision
  // for another. Proven-dead cleanup settles through its canonical owner, without
  // inheriting the shorter physical-exit cutoff.
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


export async function observePlannedRunnerRetirement(
  params: Omit<PhysicalExitWaitParams, 'runners'> & Readonly<{ tracked: TrackedSession }>,
): Promise<boolean | undefined> {
  const { tracked, ...waitOptions } = params;
  if (tracked.childProcess) return;
  // Adopted restart observation can span the full completion window. Avoid repeated process
  // listings more than twice a second while retaining an explicitly slower configured cadence.
  return await waitForTrackedRunnerProcessesExit({
    ...waitOptions,
    runners: [{ pid: tracked.pid }],
    pollIntervalMs: Math.max(params.pollIntervalMs, 500),
  });
}
