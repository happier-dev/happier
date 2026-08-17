import { describe, expect, it } from 'vitest';

import { mapCodexRateLimitResetCredits } from './rateLimitResetCredits.js';

describe('mapCodexRateLimitResetCredits', () => {
  it('uses the published numeric-epoch threshold for numeric credit timestamps', () => {
    expect(mapCodexRateLimitResetCredits({
      rawResetCredits: {
        credits: [{ id: 'credit-1', status: 'available', expires_at: 10_000_000_000 }],
      },
    })).toEqual({
      availableCount: 1,
      credits: [{
        id: 'credit-1',
        kind: 'usage_limit_reset',
        status: 'available',
        expiresAtMs: 10_000_000_000_000,
      }],
    });
  });
});
