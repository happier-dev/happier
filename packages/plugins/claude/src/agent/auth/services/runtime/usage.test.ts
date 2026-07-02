import { describe, expect, it } from 'vitest';

import { mapClaudeRuntimeRateLimitsToUsageObservation } from './usage.js';

describe('mapClaudeRuntimeRateLimitsToUsageObservation', () => {
  it('distinguishes missing statusline rate limits from loaded-empty rate limits', () => {
    expect(mapClaudeRuntimeRateLimitsToUsageObservation({})).toEqual({ status: 'not_loaded' });
    expect(mapClaudeRuntimeRateLimitsToUsageObservation({ rate_limits: {} })).toEqual({
      status: 'loaded_empty',
      meters: [],
    });
  });

  it('normalizes Claude statusline runtime rate_limits as structured usage evidence', () => {
    const observation = mapClaudeRuntimeRateLimitsToUsageObservation({
      rate_limits: {
        five_hour: { utilization: 81, resets_at: '2026-02-16T00:00:00Z' },
        seven_day: { used_percent: 40, reset_at: 1_768_010_000 },
      },
    });

    expect(observation).toEqual({
      status: 'loaded_data',
      meters: [
        {
          meterId: 'five_hour',
          label: '5-hour',
          utilizationPct: 81,
          resetsAtMs: Date.parse('2026-02-16T00:00:00Z'),
          source: 'runtimeSignal',
        },
        {
          meterId: 'seven_day',
          label: 'Weekly',
          utilizationPct: 40,
          resetsAtMs: 1_768_010_000_000,
          source: 'runtimeSignal',
        },
      ],
    });
  });
});
