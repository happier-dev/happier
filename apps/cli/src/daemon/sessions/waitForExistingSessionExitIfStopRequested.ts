import type { TrackedSession } from '../types';
import type { ProcessRunState } from '../processRunState';
import { waitForTrackedRunnerProcessesExit } from './waitForTrackedRunnerProcessesExit';
import {
  trackSession,
  trackedSessionsForProcess,
  type ReadonlyTrackedSessionMap,
  type SessionTrackingKey,
  type TrackedSessionMap,
} from '@/daemon/sessions/sessionTrackingKey';

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
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
}>): TrackedSessionMap {
  const runners = new Map<SessionTrackingKey, TrackedSession>();
  for (const trackedSession of params.trackedSessionsByKey.values()) {
    if (!trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId)) {
      continue;
    }
    if (typeof trackedSession.stopRequestedAtMs === 'number' && Number.isFinite(trackedSession.stopRequestedAtMs)) {
      trackSession(runners, trackedSession);
    }
  }
  return runners;
}

export async function waitForExistingSessionExitIfStopRequested(params: Readonly<{
  sessionId: string;
  trackedSessionsByKey: ReadonlyTrackedSessionMap;
  readRunState?: (pid: number) => Promise<ProcessRunState>;
  timeoutMs: number;
  pollIntervalMs: number;
  onExitObserved?: (pid: number, exit: ExitObservation) => void | Promise<void>;
}>): Promise<void> {
  const normalizedSessionId = String(params.sessionId ?? '').trim();
  if (!normalizedSessionId) return;

  const initialMatchingRunners = collectStopRequestedMatchingRunners({
    sessionId: normalizedSessionId,
    trackedSessionsByKey: params.trackedSessionsByKey,
  });
  if (initialMatchingRunners.size === 0) return;
  const onExitObserved = params.onExitObserved;

  // Serviceability is not death proof: paused or identity-unknown runners must retain custody.
  await waitForTrackedRunnerProcessesExit({
    runners: Array.from(initialMatchingRunners.values(), (tracked) => ({
      pid: tracked.pid,
      childProcess: tracked.childProcess,
    })),
    timeoutMs: params.timeoutMs,
    pollIntervalMs: params.pollIntervalMs,
    readRunState: params.readRunState,
    onExitObserved: onExitObserved ? async (pid, exit) => {
      // A captured child's exit cannot retire a replacement at the same PID.
      if (!trackedSessionsForProcess(params.trackedSessionsByKey, pid)
        .some(tracked => initialMatchingRunners.get(tracked.trackingKey) === tracked)) return;
      await onExitObserved(pid, exit);
    } : undefined,
  });
}
