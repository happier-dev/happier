import type { TrackedSession } from '../types';

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

export async function waitForExistingSessionExitIfStopRequested(params: Readonly<{
  sessionId: string;
  pidToTrackedSession: ReadonlyMap<number, TrackedSession>;
  isSessionRunnerActive: (sessionId: string) => Promise<boolean>;
  timeoutMs: number;
  pollIntervalMs: number;
}>): Promise<void> {
  const normalizedSessionId = String(params.sessionId ?? '').trim();
  if (!normalizedSessionId) return;

  let sawStopMarker = false;
  for (const trackedSession of params.pidToTrackedSession.values()) {
    if (!trackedSessionMatchesExistingSessionId(trackedSession, normalizedSessionId)) {
      continue;
    }
    if (typeof trackedSession.stopRequestedAtMs === 'number' && Number.isFinite(trackedSession.stopRequestedAtMs)) {
      sawStopMarker = true;
      break;
    }
  }

  if (!sawStopMarker) return;

  const timeoutMs = Math.max(0, Math.floor(params.timeoutMs));
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const active = await params.isSessionRunnerActive(normalizedSessionId);
    if (!active) return;
    await sleep(params.pollIntervalMs);
  }
}
