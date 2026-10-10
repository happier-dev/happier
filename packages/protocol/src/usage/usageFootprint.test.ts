import { describe, expect, it } from 'vitest';

import { projectUsageFootprint } from './index.js';
import type { UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';

const response: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: {
    eventCount: 2,
    tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 80, cacheWrite: 4, total: 120 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
  },
  breakdowns: {
    model: [{
      key: 'claude-sonnet-4-5',
      eventCount: 2,
      tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 80, cacheWrite: 4, total: 120 },
      cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
    }],
  },
};

describe('usage footprint projection', () => {
  it('keeps attributed accounting as an uncovered proxy without manufacturing energy or carbon', () => {
    expect(projectUsageFootprint(response)).toEqual({
      status: 'insufficient_basis',
      reason: 'no_applicable_versioned_method',
      method: null,
      energyWh: null,
      emissionsGCo2e: null,
      coverage: { accountedTokens: response.totals.tokens, estimatedTokenCount: 0 },
    });
  });

  it('does not reinterpret empty accounting as measured zero energy or emissions', () => {
    const empty: UsageAnalyticsQueryResponse = {
      v: 1,
      totals: {
        eventCount: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' },
      },
    };
    expect(projectUsageFootprint(empty)).toMatchObject({
      status: 'insufficient_basis', energyWh: null, emissionsGCo2e: null, method: null,
      coverage: { accountedTokens: empty.totals.tokens, estimatedTokenCount: 0 },
    });
  });
});
