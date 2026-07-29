import type { TrackedSession } from '../types';
import { updateSessionMarkerActiveTurn } from '../sessionRegistry';

type TurnLifecycleEvent = 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';

export type TrackedSessionTurnLifecycleResult = Readonly<{
  status:
    | 'recorded'
    | 'ignored_missing_exact_turn'
    | 'ignored_session_not_found'
    | 'ignored_session_ambiguous'
    | 'ignored_turn_mismatch'
    | 'ignored_marker_not_updated';
  activeTurnId: string | null;
}>;

export async function applyTrackedSessionTurnLifecycle(input: Readonly<{
  trackedSessions: Iterable<TrackedSession>;
  sessionId: string;
  event: TurnLifecycleEvent;
  turnId?: string;
  updateSessionMarkerActiveTurn?: typeof updateSessionMarkerActiveTurn;
}>): Promise<TrackedSessionTurnLifecycleResult> {
  const matches = Array.from(input.trackedSessions).filter(
    (tracked) => tracked.happySessionId === input.sessionId,
  );
  if (matches.length === 0) {
    return { status: 'ignored_session_not_found', activeTurnId: null };
  }
  if (matches.length !== 1) {
    return { status: 'ignored_session_ambiguous', activeTurnId: null };
  }

  const tracked = matches[0]!;
  const currentActiveTurnId = tracked.activeTurnId ?? null;
  const turnId = typeof input.turnId === 'string' ? input.turnId.trim() : '';
  if (!turnId) {
    return { status: 'ignored_missing_exact_turn', activeTurnId: currentActiveTurnId };
  }

  const isTerminal = input.event === 'assistant_message_end' || input.event === 'turn_cancelled';
  if (isTerminal && currentActiveTurnId !== turnId) {
    return { status: 'ignored_turn_mismatch', activeTurnId: currentActiveTurnId };
  }

  const nextActiveTurnId = isTerminal ? null : turnId;
  const markerUpdated = await (input.updateSessionMarkerActiveTurn ?? updateSessionMarkerActiveTurn)({
    pid: tracked.sessionRunnerPid ?? tracked.pid,
    sessionId: input.sessionId,
    activeTurnId: nextActiveTurnId,
  });
  if (!markerUpdated) {
    return { status: 'ignored_marker_not_updated', activeTurnId: currentActiveTurnId };
  }

  if (nextActiveTurnId) {
    tracked.activeTurnId = nextActiveTurnId;
  } else {
    delete tracked.activeTurnId;
  }
  return { status: 'recorded', activeTurnId: nextActiveTurnId };
}
