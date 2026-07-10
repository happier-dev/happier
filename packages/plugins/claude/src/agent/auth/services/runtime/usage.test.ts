import { describe, expect, it } from 'vitest';

import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeRuntimeRateLimitsToUsageObservation,
} from './usage.js';

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

describe('mapClaudeRateLimitEventToUsageDetails', () => {
  it('maps synthetic Claude assistant API-error rate-limit records that report 429 via error_status', () => {
    expect(mapClaudeRateLimitEventToUsageDetails({
      type: 'assistant',
      uuid: 'api-error-assistant-1',
      isApiErrorMessage: true,
      error: {
        type: 'api_error',
        message: 'Connection error.',
        error_status: 429,
        reset_at: '2026-05-17T12:00:00.000Z',
      },
    })).toMatchObject({
      v: 1,
      resetAtMs: Date.parse('2026-05-17T12:00:00.000Z'),
      retryAfterMs: null,
      quotaScope: 'account',
      recoverability: 'wait',
      providerLimitId: 'rate_limit',
    });
  });
});
