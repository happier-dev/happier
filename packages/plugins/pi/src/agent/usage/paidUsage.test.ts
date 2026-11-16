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

  it('preserves native reasoning and separates provider-reported zero from an absent estimate', () => {
    const usage = { input: 3259, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3263,
      cost: { total: 0, totalFromProvider: false } };
    expect(normalizePiPaidUsage(usage)).toEqual({
      tokens: { input: 3259, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3263 }, cost: null,
    });
    expect(normalizePiPaidUsage({ ...usage, reasoning: 2, cost: { total: 0, totalFromProvider: true } }))
      .toMatchObject({ tokens: { reasoning: 2 }, cost: { reportedUsd: 0, estimatedUsd: null, costSource: 'provider_reported' } });
    expect(normalizePiPaidUsage({ ...usage, cost: { total: 0.2, totalFromProvider: true } }))
      .toMatchObject({ cost: { reportedUsd: 0.2, estimatedUsd: null, costSource: 'provider_reported' } });
    expect(normalizePiPaidUsage({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { total: 0, totalFromProvider: true } }, 'error'))
      .toMatchObject({ tokens: { total: 0 }, cost: { reportedUsd: 0, estimatedUsd: null } });
  });

  it('retains a measured cost independently of absent or invalid token counters', () => {
    expect(normalizePiPaidUsage({ input: -1, output: Number.NaN, totalTokens: null, cost: { total: 0.2 } })).toEqual({
      tokens: unknownTokens,
      cost: { reportedUsd: null, estimatedUsd: 0.2, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' },
    });
    expect(normalizePiPaidUsage({})).toBeNull();
  });
});
