import { describe, expect, it } from 'vitest';

import type { UsageObservation } from './usageObservation';
import { createExactTurnUsageAccumulator } from './exactTurnUsage';

function observation(overrides: Partial<UsageObservation> = {}): UsageObservation {
  return {
    provider: 'claude',
    source: 'runtime',
    scope: 'turn_delta',
    key: null,
    modelId: null,
    tokens: null,
    cost: null,
    contextUsedTokens: null,
    contextWindowTokens: null,
    ...overrides,
  };
}

describe('exact-turn usage accumulation', () => {
  it('withdraws exact dimensions after an unmeasured turn observation', () => {
    const accumulator = createExactTurnUsageAccumulator();
    accumulator.observe(observation({ tokens: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
      cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' },
      availability: { inputTokens: true, outputTokens: true, reportedCostUsd: true } }));
    accumulator.observe(observation());
    expect(accumulator.current()).toBeUndefined();
  });
  it('sums only availability-proven turn deltas and ignores cumulative snapshots', () => {
    const accumulator = createExactTurnUsageAccumulator();
    accumulator.observe(observation({
      tokens: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
      cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' },
      availability: { inputTokens: true, outputTokens: true, reportedCostUsd: true },
    }));
    accumulator.observe(observation({
      tokens: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: { reportedUsd: 0.01, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported_api_equivalent' },
      availability: { inputTokens: true, outputTokens: true, reportedCostUsd: true },
    }));
    accumulator.observe(observation({
      scope: 'session_cumulative',
      tokens: { input: 900, output: 400, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1300 },
      availability: { inputTokens: true, outputTokens: true, reportedCostUsd: false },
    }));

    expect(accumulator.current()).toEqual({ inputTokens: 9, outputTokens: 4, costUsd: 0.03 });
  });

  it('keeps a dimension unavailable after non-exact or unsafe evidence', () => {
    const accumulator = createExactTurnUsageAccumulator();
    accumulator.observe(observation({
      tokens: { input: 7, output: 3, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
      cost: { reportedUsd: 0, estimatedUsd: 0.02, currency: 'USD', costSource: 'pricing_estimate' },
      availability: { inputTokens: false, outputTokens: true, reportedCostUsd: false },
    }));
    accumulator.observe(observation({
      tokens: { input: 2, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 3 },
      cost: { reportedUsd: 0.01, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' },
      availability: { inputTokens: true, outputTokens: true, reportedCostUsd: true },
    }));

    expect(accumulator.current()).toEqual({ outputTokens: 4 });
  });
});
