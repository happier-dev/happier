import { describe, expect, it } from 'vitest';
import { normalizeOpenCodePaidUsage } from './paidUsage.js';

const unknownTokens = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };

describe('normalizeOpenCodePaidUsage', () => {
  it.each(['v1', 'v2'] as const)('preserves missing counters and native totals for dialect %s', dialect => {
    expect(normalizeOpenCodePaidUsage({ tokens: { input: 12, output: 0, cache: { read: 3 } } }, dialect)).toEqual({
      tokens: { ...unknownTokens, input: 12, output: 0, cacheRead: 3 },
      inputIncludesCache: false, outputIncludesReasoning: dialect === 'v1', cost: null,
    });
    expect(normalizeOpenCodePaidUsage({ tokens: { reasoning: 4, total: 0 }, cost: 0 }, dialect)).toEqual({
      tokens: { ...unknownTokens, reasoning: 4, total: 0 },
      inputIncludesCache: false, outputIncludesReasoning: dialect === 'v1',
      cost: { reportedUsd: null, estimatedUsd: 0, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' },
    });
  });

  it('retains a measured cost when native token measurements are unavailable', () => {
    expect(normalizeOpenCodePaidUsage({ cost: 0.2 }, 'v2')).toEqual({
      tokens: unknownTokens, inputIncludesCache: false, outputIncludesReasoning: false,
      cost: { reportedUsd: null, estimatedUsd: 0.2, currency: 'USD', billingContext: 'unknown', costSource: 'pricing_estimate' },
    });
    expect(normalizeOpenCodePaidUsage({ tokens: { input: -1, output: Number.NaN, total: null } }, 'v2')).toBeNull();
  });
});
