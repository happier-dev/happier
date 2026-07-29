export type ForcedRefreshFreshnessDecision =
  | Readonly<{ kind: 'rotate'; reason: 'not_forced' | 'current_token_not_adoptable' | 'current_token_failed' }>
  | Readonly<{ kind: 'adopt_current' }>;

/**
 * Adopt-fresh-first (CLOSE-18) — canonical decision owner.
 *
 * On a forced reactive credential refresh (for example, a runtime-auth 401 retry), adopt the current store access
 * token instead of rotating (and burning) the single-use refresh token WHENEVER the current token
 * is still usable AND differs from the token that failed. The decision is keyed on the
 * failing-token comparison, NOT on the refresh-expiry window: when N runtimes hit a 401 with the
 * same stale token, only the first rotation happens and every other caller adopts the rotated
 * token — even if that token is near (but not past) expiry — collapsing N rotations to one and
 * preventing refresh-token burn.
 *
 * Provider-specific fingerprint comparison is supplied as a boolean so token formats remain
 * provider-owned while the adoption decision stays centralized here.
 */
export function resolveForcedRefreshFreshnessDecision(params: Readonly<{
  force: boolean;
  currentTokenAdoptable: boolean;
  currentDiffersFromFailingToken: boolean;
}>): ForcedRefreshFreshnessDecision {
  if (!params.force) return { kind: 'rotate', reason: 'not_forced' };
  if (!params.currentTokenAdoptable) return { kind: 'rotate', reason: 'current_token_not_adoptable' };
  return params.currentDiffersFromFailingToken
    ? { kind: 'adopt_current' }
    : { kind: 'rotate', reason: 'current_token_failed' };
}
