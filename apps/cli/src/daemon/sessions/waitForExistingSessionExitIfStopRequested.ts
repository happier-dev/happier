import type { TrackedSession } from '../types';
import type { ProcessRunState } from '../processRunState';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';

type ExitObservation = Readonly<{
  reason: 'process-missing';
  code: null;
  signal: null;
}>;

function trackedSessionMatchesExistingSessionId(trackedSession: TrackedSession, sessionId: string): boolean {
  if (trackedSession.happySessionId === sessionId) return true;

  const existingSessionId =
    trackedSession.spawnOptions && typeof trackedSession.spawnOptions.existingSessionId === 'string'
      ? trackedSession.spawnOptions.existingSessionId.trim()
      : '';
  return existingSessionId === sessionId;
}

function collectStopRequestedMatchingRunners(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
}>): Map<number, TrackedSession> {
  const runners = new Map<number, TrackedSession>();
  for (const [pid, trackedSession] of params.pidToTrackedSession.entries()) {
    if (!trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId)) {
      continue;
    }
    if (typeof trackedSession.stopRequestedAtMs === 'number' && Number.isFinite(trackedSession.stopRequestedAtMs)) {
      runners.set(pid, trackedSession);
    }
  }
  return runners;
}

export async function waitForExistingSessionExitIfStopRequested(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
  timeoutMs: number;
  pollIntervalMs: number;
  onExitObserved?: (pid: number, exit: ExitObservation) => void | Promise<void>;
}>): Promise<void> {
  const normalizedSessionId = String(params.sessionId ?? '').trim();
  if (!normalizedSessionId) return;

  const initialMatchingRunners = collectStopRequestedMatchingRunners({
    sessionId: normalizedSessionId,
    pidToTrackedSession: params.pidToTrackedSession,
  });
  if (initialMatchingRunners.size === 0) return;
  const onExitObserved = params.onExitObserved;

  // Serviceability is not death proof: paused or identity-unknown runners must retain custody.
  await waitForTrackedRunnerProcessesExit({
    runners: Array.from(initialMatchingRunners, ([pid, tracked]) => ({
      pid,
      childProcess: tracked.childProcess,
    })),
    timeoutMs: params.timeoutMs,
    pollIntervalMs: params.pollIntervalMs,
    readRunState: params.readRunState,
    onExitObserved: onExitObserved ? async (pid, exit) => {
      // A captured child's exit cannot retire a replacement at the same PID.
      if (params.pidToTrackedSession.get(pid) !== initialMatchingRunners.get(pid)) return;
      await onExitObserved(pid, exit);
    } : undefined,
  });
}
