import { describe, expect, it } from 'vitest';

import { resolveForcedRefreshFreshnessDecision } from './adoptFreshFirst.js';

describe('resolveForcedRefreshFreshnessDecision (adopt-fresh-first)', () => {
  it('rotates when not forced', () => {
    expect(resolveForcedRefreshFreshnessDecision({
      force: false,
      currentTokenAdoptable: true,
      currentDiffersFromFailingToken: true,
    })).toEqual({ kind: 'rotate', reason: 'not_forced' });
  });

  it('rotates when the current token is not adoptable (e.g. expired)', () => {
    expect(resolveForcedRefreshFreshnessDecision({
      force: true,
      currentTokenAdoptable: false,
      currentDiffersFromFailingToken: true,
    })).toEqual({ kind: 'rotate', reason: 'current_token_not_adoptable' });
  });

  it('adopts the current token when forced, adoptable, and it differs from the failing token', () => {
    expect(resolveForcedRefreshFreshnessDecision({
      force: true,
      currentTokenAdoptable: true,
      currentDiffersFromFailingToken: true,
    })).toEqual({ kind: 'adopt_current' });
  });

  it('rotates when the current token is the one that failed (no fresher token to adopt)', () => {
    expect(resolveForcedRefreshFreshnessDecision({
      force: true,
      currentTokenAdoptable: true,
      currentDiffersFromFailingToken: false,
    })).toEqual({ kind: 'rotate', reason: 'current_token_failed' });
  });
});
