import { describe, expect, it } from 'vitest';

import {
  mapClaudeRateLimitEventToUsageDetails,
  mapClaudeRuntimeRateLimitsToUsageObservation,
} from './usage.js';
import { classifyClaudeConnectedServiceRuntimeAuthFailure } from './failure.js';

describe('mapClaudeRuntimeRateLimitsToUsageObservation', () => {
  it.each(['allowed', 'allowed_warning', 'rejected'])('reads every unified SDK window for %s events without mixing fraction and percent units', (status) => {
    const observation = mapClaudeRuntimeRateLimitsToUsageObservation({
      type: 'rate_limit_event', rate_limit_info: { status, rateLimitType: 'five_hour', unifiedWindows: {
        five_hour: { utilization: 1.0234, resetsAt: 1_790_378_400 },
        seven_day: { utilization: 0.2 },
        seven_day_fable: { utilization: 0.612 },
        seven_day_opus: { utilization: 0.4 },
        seven_day_sonnet: { utilization: 0.5 },
        invalid: { utilization: 'unknown' },
      } },
    });
    expect(observation).toMatchObject({ status: 'loaded_data', meters: [
      { meterId: 'five_hour', label: '5-hour', utilizationPct: 100, resetsAtMs: 1_790_378_400_000 },
      { meterId: 'seven_day', label: 'Weekly', utilizationPct: 20 },
      { meterId: 'seven_day_fable', label: 'Weekly (Fable)', utilizationPct: 61.2 },
      { meterId: 'seven_day_opus', label: 'Weekly (Opus)', utilizationPct: 40 },
      { meterId: 'seven_day_sonnet', label: 'Weekly (Sonnet)', utilizationPct: 50 },
    ] });
  });

  it('retains the older single-window SDK event without interpreting statusline percentages as fractions', () => {
    expect(mapClaudeRuntimeRateLimitsToUsageObservation({ type: 'rate_limit_event', rate_limit_info: {
      status: 'allowed', rateLimitType: 'five_hour', utilization: 0.82,
    } })).toMatchObject({ status: 'loaded_data', meters: [{ meterId: 'five_hour', utilizationPct: 82 }] });
    expect(mapClaudeRuntimeRateLimitsToUsageObservation({ rate_limits: { five_hour: { utilization: 0.82 } } }))
      .toMatchObject({ status: 'loaded_data', meters: [{ utilizationPct: 0.82 }] });
  });

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

  it('normalizes numeric statusline resets at the shared epoch boundary', () => {
    const cases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      ['100000000000', 100_000_000_000_000],
      ['1000000000000', 1_000_000_000_000],
    ] as const;

    for (const [resetsAt, expected] of cases) {
      expect(mapClaudeRuntimeRateLimitsToUsageObservation({
        rate_limits: {
          five_hour: { utilization: 81, resets_at: resetsAt },
        },
      })).toEqual({
        status: 'loaded_data',
        meters: [expect.objectContaining({
          meterId: 'five_hour',
          resetsAtMs: expected,
        })],
      });
    }
  });
});

describe('mapClaudeRateLimitEventToUsageDetails', () => {
  it.each([
    { apiErrorParams: { rate_limit_info: { resetsAt: 1_793_444_400, rateLimitType: 'seven_day', utilization: 0.95 } } },
    { quotaLimits: { resetsAt: 1_793_444_400, rateLimitType: 'seven_day', utilization: 0.95 } },
  ])('preserves structured usage rejection timing and allowance through classification: %j', (structured) => {
    const error = { type: 'assistant', isApiErrorMessage: true, apiError: 'usage_limit_reached',
      message: { content: [{ type: 'text', text: "You've hit your limit" }] }, ...structured };
    expect(mapClaudeRateLimitEventToUsageDetails(error)).toMatchObject({
      resetAtMs: 1_793_444_400_000, providerLimitId: 'seven_day', limitCategory: 'usage_limit',
    });
    expect(classifyClaudeConnectedServiceRuntimeAuthFailure({
      serviceId: 'claude-subscription', profileId: 'account-a', groupId: 'pool-a', error,
    })).toMatchObject({ kind: 'usage_limit', resetsAtMs: 1_793_444_400_000, providerLimitId: 'seven_day' });
  });
  it('does not fabricate allowance IDs from generic errors, but preserves an explicit allowance', () => {
    const event = { type: 'assistant', isApiErrorMessage: true, error: {
      error_status: 429, type: 'rate_limit_error', message: 'Usage limit reached',
    } };
    expect(mapClaudeRateLimitEventToUsageDetails(event)?.providerLimitId).toBeUndefined();
    expect(mapClaudeRateLimitEventToUsageDetails({ ...event, error: {
      ...event.error, providerLimitId: 'seven_day_opus',
    } })?.providerLimitId).toBe('seven_day_opus');
  });
  it.each([undefined, 0.95])('uses the matching rejected unified window even with conflicting top-level utilization %s', (utilization) => {
    const event = { type: 'rate_limit_event', rate_limit_info: {
      status: 'rejected', rateLimitType: 'five_hour', utilization, unifiedWindows: {
        five_hour: { utilization: 1, resetsAt: 1_790_378_400 },
        seven_day: { utilization: 0.2, resetsAt: 1_790_378_500 },
      },
    } };
    expect(mapClaudeRateLimitEventToUsageDetails(event)).toMatchObject({
      providerLimitId: 'five_hour', utilization: 100, resetAtMs: 1_790_378_400_000,
    });
    expect(mapClaudeRateLimitEventToUsageDetails({ ...event, rate_limit_info: {
      ...event.rate_limit_info, rateLimitType: 'unknown_window',
    } })).toMatchObject({ providerLimitId: 'unknown_window', utilization: utilization === undefined ? null : 95, resetAtMs: null });
  });

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
    });
  });
});
