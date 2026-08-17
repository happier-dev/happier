/**
 * The scan health vocabulary (`SENTRY.md` §3.4).
 *
 * `walkFinished` means exactly one thing: pagination ran out. It is **not** an
 * absence signal and contributes to none, for three independent reasons — the
 * walk is ordered by a mutating `last_seen`, the scope is the token's accessible
 * projects rather than the organization's, and the window is bounded at 90 days
 * by construction.
 */

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
