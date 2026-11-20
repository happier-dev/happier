import { useEffect, useState } from 'react';

import {
  isTriageRefreshPacingBlockActiveV1,
  type TriageRefreshPacingBlockV1,
} from '../../refresh/refreshEligibility.js';

/**
 * The display clock for the coordinator's refusal and an optional visible read age.
 *
 * A pacing block is an absolute moment: the coordinator publishes
 * `nextEligibleAtMs`, and every surface that offers **Refresh** decides from it
 * whether a press may read right now. Reading `Date.now()` at render answers
 * that question correctly and answers it exactly once — so a page whose reader
 * simply waits out the deadline it was shown keeps a dead control and a notice
 * that has stopped being true. Nothing else was going to wake it: the window
 * store drops an expired refusal only when something reads its snapshot, and an
 * idle page reads nothing.
 *
 * One timeout observes the next displayed boundary: the published refusal's
 * expiry or the next minute of a visible read age. Pass completedAtMs only
 * while showing that age; hiding it removes its wake. Retained surfaces suspend
 * both wakes using the host’s presentation activity. The timestamp comes from
 * the list store, never window assembly or mount time. This reads no provider,
 * starts no pass and makes no freshness decision: the deadline, reason and eligibility rule all
 * remain the coordinator's (`core/CORPUS.md` §4.2), and all this does is ask
 * the same owner again at the one moment its answer can have changed.
 *
 * It is deliberately not in the window store. A store-level wake would notify
 * every subscriber of a fact none of them may be showing, and the store's
 * own contract is that an elapsed refusal expires on READ — which is the right
 * rule for a projection and the wrong one for a control a person is looking at.
 */
export function useTriageRefreshEligibilityNowV1(
  block: TriageRefreshPacingBlockV1 | null | undefined,
  completedAtMs: number | undefined,
  active: boolean,
): number {
  // The wake count is not state anybody reads; it is what lets an expiry the
  // page did not otherwise notice become a render, and — when the deadline is
  // still ahead after one — what re-arms the next observation.
  const [observedExpiries, setObservedExpiries] = useState(0);
  const nowMs = Date.now();
  const refusalDeadlineMs = isTriageRefreshPacingBlockActiveV1(block, nowMs)
    ? block.nextEligibleAtMs
    : null;
  const nextAgeMinuteMs = completedAtMs === undefined ? null
    : completedAtMs + (Math.floor(Math.max(0, nowMs - completedAtMs) / 60_000) + 1) * 60_000;
  const deadlineMs = refusalDeadlineMs === null ? nextAgeMinuteMs
    : nextAgeMinuteMs === null ? refusalDeadlineMs : Math.min(refusalDeadlineMs, nextAgeMinuteMs);

  useEffect(() => {
    if (!active || deadlineMs === null) return;
    // At least one millisecond, so a deadline that is still ahead by less than
    // a tick cannot spin: the block is active only while `nextEligibleAtMs` is
    // strictly greater than now, so the next observation always makes progress.
    const wake = setTimeout(
      () => { setObservedExpiries((count) => count + 1); },
      Math.max(1, deadlineMs - Date.now()),
    );
    return () => { clearTimeout(wake); };
  }, [active, deadlineMs, observedExpiries]);

  return nowMs;
}
