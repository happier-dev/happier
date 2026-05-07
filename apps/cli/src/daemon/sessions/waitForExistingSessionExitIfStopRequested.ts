import type { TrackedSession } from '../types';

type ExitObservation = Readonly<{
  reason: 'process-missing';
  code: null;
  signal: null;
}>;

function sleep(ms: number): Promise<void> {
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

function trackedSessionMatchesExistingSessionId(trackedSession: TrackedSession, sessionId: string): boolean {
  if (trackedSession.happySessionId === sessionId) return true;

  const existingSessionId =
    trackedSession.spawnOptions && typeof (trackedSession.spawnOptions as any).existingSessionId === 'string'
      ? String((trackedSession.spawnOptions as any).existingSessionId).trim()
      : '';
  return existingSessionId === sessionId;
}

function collectStopRequestedMatchingPids(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
}>): number[] {
  const pids: number[] = [];
  for (const [pid, trackedSession] of params.pidToTrackedSession.entries()) {
    if (!trackedSessionMatchesExistingSessionId(trackedSession, params.sessionId)) {
      continue;
    }
    if (typeof trackedSession.stopRequestedAtMs === 'number' && Number.isFinite(trackedSession.stopRequestedAtMs)) {
      pids.push(pid);
    }
  }
  return pids;
}

export async function waitForExistingSessionExitIfStopRequested(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  isSessionRunnerActive: (sessionId: string) => Promise<boolean>;
  timeoutMs: number;
  pollIntervalMs: number;
  onExitObserved?: (pid: number, exit: ExitObservation) => void;
}>): Promise<void> {
  const normalizedSessionId = String(params.sessionId ?? '').trim();
  if (!normalizedSessionId) return;

  const initialMatchingPids = collectStopRequestedMatchingPids({
    sessionId: normalizedSessionId,
    pidToTrackedSession: params.pidToTrackedSession,
  });
  if (initialMatchingPids.length === 0) return;

  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const active = await params.isSessionRunnerActive(normalizedSessionId);
    if (!active) {
      const matchingPids = collectStopRequestedMatchingPids({
        sessionId: normalizedSessionId,
        pidToTrackedSession: params.pidToTrackedSession,
      });
      for (const pid of matchingPids) {
        params.onExitObserved?.(pid, { reason: 'process-missing', code: null, signal: null });
      }
      return;
    }
    await sleep(params.pollIntervalMs);
  }
}
