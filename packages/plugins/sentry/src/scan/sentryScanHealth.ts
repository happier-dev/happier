/**
 * The scan health vocabulary (`SENTRY.md` §3.4).
 *
 * `walkFinished` means exactly one thing: pagination ran out. It is **not** an
 * absence signal and contributes to none, for three independent reasons — the
 * walk is ordered by a mutating `last_seen`, the scope is the token's accessible
 * projects rather than the organization's, and the window is bounded at 90 days
 * by construction.
 */

import { SENTRY_FAILURE_CODES } from '../sentryContracts.js';

export type SentryScanHealthV1 =
  | Readonly<{ kind: 'walkFinished' }>
  | Readonly<{ kind: 'partial'; reason: string; omittedItemCount?: number }>
  | Readonly<{ kind: 'moving' }>;

export const SENTRY_WALK_FINISHED: SentryScanHealthV1 = Object.freeze({ kind: 'walkFinished' });

export function sentryPartialHealth(
  reason: string,
  omittedItemCount?: number,
): SentryScanHealthV1 {
  return omittedItemCount === undefined
    ? Object.freeze({ kind: 'partial' as const, reason })
    : Object.freeze({ kind: 'partial' as const, reason, omittedItemCount });
}

/**
 * The health facts of ONE page that stay true of the whole walk.
 *
 * A walk's pages are separate invocations of this source, and each one used to
 * report only what it saw. Page one omitting three undecodable rows and page two
 * running clean out of pagination therefore settled the walk as `walkFinished`,
 * and the caveat the user needed — some of your issues are not in this list —
 * was erased by the page that happened to be last.
 *
 * Names only, never counts: `omittedItemCount` belongs to the call that omitted
 * the rows, and a walk-level total would double-count against the aggregate's
 * `observations + omittedItemCount <= limit` check for this page.
 */
export const SENTRY_SCAN_STICKY_REASONS_V1 = Object.freeze([
  SENTRY_FAILURE_CODES.malformedIssueRow,
] as const);

export type SentryScanStickyReasonV1 = (typeof SENTRY_SCAN_STICKY_REASONS_V1)[number];

export function readSentryScanStickyReason(value: unknown): SentryScanStickyReasonV1 | null {
  return SENTRY_SCAN_STICKY_REASONS_V1.find((reason) => reason === value) ?? null;
}

/**
 * The walk-level caveat a settling page must still report.
 *
 * `null` when the walk carries none, which is the only case a finished walk may
 * claim `walkFinished`.
 */
export function sentryStickyHealth(
  sticky: ReadonlySet<SentryScanStickyReasonV1>,
): SentryScanHealthV1 | null {
  for (const reason of SENTRY_SCAN_STICKY_REASONS_V1) {
    if (sticky.has(reason)) return sentryPartialHealth(reason);
  }
  return null;
}
