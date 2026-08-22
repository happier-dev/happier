import { describe, expect, it } from 'vitest';

import { mapCodexRateLimitResetCredits } from './rateLimitResetCredits.js';

describe('mapCodexRateLimitResetCredits', () => {
  it('normalizes numeric credit timestamps through the shared epoch boundary', () => {
    const cases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      ['100000000000', 100_000_000_000_000],
      ['1000000000000', 1_000_000_000_000],
    ] as const;

    for (const [expiresAt, expected] of cases) {
      expect(mapCodexRateLimitResetCredits({
        rawResetCredits: {
          credits: [{ id: 'credit-1', status: 'available', expires_at: expiresAt }],
        },
      })).toEqual({
        availableCount: 1,
        credits: [{
          id: 'credit-1',
          kind: 'usage_limit_reset',
          status: 'available',
          expiresAtMs: expected,
        }],
      });
    }
  });
});
