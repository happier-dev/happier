import { describe, expect, it } from 'vitest';
import { normalizePiPaidUsage } from './paidUsage.js';

const unknownTokens = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };

describe('normalizePiPaidUsage', () => {
  it('preserves only native measurements without inferring a total or reasoning count', () => {
    expect(normalizePiPaidUsage({ input: 12, output: 0, cacheRead: 3 })).toEqual({
      tokens: { ...unknownTokens, input: 12, output: 0, cacheRead: 3 }, cost: null,
    });
    expect(normalizePiPaidUsage({ totalTokens: 0, cost: { total: 0 } })).toEqual({
      tokens: { ...unknownTokens, total: 0 },
      cost: { reportedUsd: null, estimatedUsd: 0, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' },
    });
  });

  it('retains a measured cost independently of absent or invalid token counters', () => {
    expect(normalizePiPaidUsage({ input: -1, output: Number.NaN, totalTokens: null, cost: { total: 0.2 } })).toEqual({
      tokens: unknownTokens,
      cost: { reportedUsd: null, estimatedUsd: 0.2, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' },
    });
    expect(normalizePiPaidUsage({})).toBeNull();
  });
});
