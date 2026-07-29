import type { TrackedSession } from '../types';

export type TrackedSessionActiveTurn = Readonly<{
  sessionId: string;
  turnId: string;
  markerPid: number;
}>;

/** Exact active-turn authority. A null result must never be replaced by inference. */
export function resolveTrackedSessionActiveTurn(
  tracked: Pick<TrackedSession, 'pid' | 'sessionRunnerPid' | 'happySessionId' | 'activeTurnId'>,
): TrackedSessionActiveTurn | null {
  const sessionId = tracked.happySessionId?.trim() ?? '';
  const turnId = tracked.activeTurnId?.trim() ?? '';
  if (!sessionId || !turnId) return null;
  return {
    sessionId,
    turnId,
    markerPid: tracked.sessionRunnerPid ?? tracked.pid,
  };
}
