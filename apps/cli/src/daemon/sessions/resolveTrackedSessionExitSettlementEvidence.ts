import type { TrackedSession } from '../types';

/**
 * Restores a restart-interrupted turn only at the observed-exit boundary.
 * The returned copy is never installed into live tracked-session state.
 */
export function resolveTrackedSessionExitSettlementEvidence(
  tracked: TrackedSession,
): TrackedSession {
  if (tracked.activeTurnId || !tracked.reattachedInterruptedTurnId) {
    return tracked;
  }
  return {
    ...tracked,
    activeTurnId: tracked.reattachedInterruptedTurnId,
  };
}
