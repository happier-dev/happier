import { sessionFinishedRippleTrigger } from '@happier-dev/brand/planet-moments';

export type SessionTurnState = Readonly<{
  lastTurnCompletedAt: number | null;
  pendingApproval: boolean;
  failedAt?: number | null;
}>;


type SessionFinishedRippleInput = Readonly<{
    enabled: boolean;
    visible: boolean;
    states: ReadonlyMap<string, SessionTurnState | null>;
    reset?: boolean;
}>;

/** Learns first or hidden facts without replay; Home merges ripples, while faces answer each visible terminal fact. */
export function createSessionFinishedRippleObserver(
  onAnswer: () => void,
  /** Each visible finish by its Session, unmerged: a Bot moon sparks once for its own completion. */
  onFinished?: (keys: readonly string[]) => void,
  /** A new terminal failure, already classified by the Session runtime owner. */
  onFailed?: (keys: readonly string[]) => void,
) {
  let seen: Map<string, SessionTurnState> | null = null;
  let last: number | null = null;
  return ({ enabled, visible, states, reset }: SessionFinishedRippleInput): void => {
    if (!enabled) {
      seen = null;
      return;
    }
    const learning = seen === null || reset;
    const previous = seen ?? new Map<string, SessionTurnState>();
    if (reset) previous.clear();
    seen = previous;
    const nowMs = performance.now();
    let answer = false;
    const finished: string[] = [];
    const failed: string[] = [];
    for (const [key, state] of states) {
      const before = previous.get(key);
      if (state === null) { previous.delete(key); continue; }
      previous.set(key, state);
      if (!before || learning) continue;
      const completed = state.lastTurnCompletedAt !== null
        && (before.lastTurnCompletedAt === null || state.lastTurnCompletedAt > before.lastTurnCompletedAt);
      const decision = sessionFinishedRippleTrigger({
        nowMs,
        lastTriggeredAtMs: last,
        wasFinished: false,
        turnComplete: completed,
        pendingApproval: state.pendingApproval,
        homeVisible: visible,
      });
      last = decision.lastTriggeredAtMs;
      answer ||= decision.trigger;
      const failure = state.failedAt != null && (before.failedAt == null || state.failedAt > before.failedAt);
      if (failure && visible) failed.push(key);
      else if (completed && visible && !state.pendingApproval) finished.push(key);
    }
    if (answer) onAnswer();
    if (finished.length > 0) onFinished?.(finished);
    if (failed.length > 0) onFailed?.(failed);
  };
}
