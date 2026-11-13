import { describe, expect, it } from 'vitest';

import { buildClaudeRuntimeIssue, mapClaudeProviderFailureToUsageDetails } from './runtimeIssues.js';

describe('mapClaudeProviderFailureToUsageDetails', () => {
  it('retains an existing Provider Action cause in a terminal Turn issue', () => {
    const actionCause = { phase: 'providers.launch', errorClass: 'TypeError', errorCode: null, httpStatus: 503 } as const;
    const evidence = Object.assign(new Error('Native failure'), { code: 'provider_endpoint_unavailable', failureCause: actionCause });
    expect(buildClaudeRuntimeIssue({ evidence, occurredAt: 100 })).toMatchObject({ failureCause: {
      code: 'provider_endpoint_unavailable', phase: 'turn', failureReason: 'unknown', httpStatus: 503, actionCause,
    } });
  });

  it.each(['result', 'errors'] as const)('retains failed SDK %s evidence and its own reset without allowance telemetry', (field) => {
    const text = 'Claude AI usage limit reached|1792656000';
    const evidence = { type: 'result', subtype: 'error_during_execution', is_error: true,
      [field]: field === 'errors' ? [text] : text };
    expect(buildClaudeRuntimeIssue({ evidence, occurredAt: 1792655000000 })).toMatchObject({
      source: 'usage_limit', usageLimit: { limitCategory: 'usage_limit', resetAtMs: 1792656000000 },
    });
    expect(mapClaudeProviderFailureToUsageDetails({ ...evidence, subtype: 'success', is_error: false })).toBeNull();
    expect(mapClaudeProviderFailureToUsageDetails({ type: 'result', subtype: 'error_during_execution', is_error: true,
      result: 'Usage limit reached' })).toMatchObject({ limitCategory: 'usage_limit', resetAtMs: null });
  });

  it('preserves StopFailure classification and provider retry timing through the canonical parser', () => {
    expect(mapClaudeProviderFailureToUsageDetails({ error_type: 'rate_limit' })).toMatchObject({ quotaScope: 'account' });
    expect(mapClaudeProviderFailureToUsageDetails({ status: 429, error: { retry_after: 2 } }))
      .toMatchObject({ retryAfterMs: 2000 });
    expect(mapClaudeProviderFailureToUsageDetails({ type: 'rate_limit_error' }))
      .toMatchObject({ quotaScope: 'account' });
  });
  it('uses native allowance evidence rather than the rate-limit error category', () => {
    const error = { status: 429, code: 'rate_limit_error', retryAfterMs: 1500 };
    expect(mapClaudeProviderFailureToUsageDetails(error)).toMatchObject({
      quotaScope: 'account', retryAfterMs: 1500,
    });
    expect(mapClaudeProviderFailureToUsageDetails(error)?.providerLimitId).toBeUndefined();
    expect(mapClaudeProviderFailureToUsageDetails({ ...error, providerLimitId: 'seven_day_opus' })?.providerLimitId)
      .toBe('seven_day_opus');
    expect(mapClaudeProviderFailureToUsageDetails({ status: 401, message: 'rate limit' })).toBeNull();
  });
  it('normalizes numeric provider reset epochs at the shared boundary', () => {
    const cases = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      ['100000000000', 100_000_000_000_000],
      ['1000000000000', 1_000_000_000_000],
    ] as const;

    for (const [value, expected] of cases) {
      expect(mapClaudeProviderFailureToUsageDetails({
        status: 429,
        reset_at: value,
      })).toMatchObject({
        resetAtMs: expected,
      });
    }
  });
});
