import { describe, expect, it } from 'vitest';

async function loadNormalizationHelpers() {
  const loaded = await import('./index').catch(() => null);
  expect(loaded).not.toBeNull();
  return loaded!;
}

describe('quota normalization helpers', () => {
  it('parses retry and provider reset evidence from common headers and bodies', async () => {
    const helpers = await loadNormalizationHelpers();
    const nowMs = Date.parse('2026-05-17T12:00:00.000Z');

    expect(helpers.parseRetryAfterHeader('30', { nowMs })).toEqual({
      retryAfterMs: 30_000,
      resetAtMs: null,
    });
    expect(helpers.parseRetryAfterHeader('Sun, 17 May 2026 12:00:10 GMT', { nowMs })).toEqual({
      retryAfterMs: 10_000,
      resetAtMs: Date.parse('2026-05-17T12:00:10.000Z'),
    });
    expect(helpers.parseProviderResetAt({
      nowMs,
      headers: {
        'x-ratelimit-reset-after': '2m',
      },
    })).toEqual({
      retryAfterMs: 120_000,
      resetAtMs: nowMs + 120_000,
    });
    expect(helpers.parseProviderResetAt({
      nowMs,
      body: {
        quotaResetDelay: '1h30m',
      },
    })).toEqual({
      retryAfterMs: 5_400_000,
      resetAtMs: nowMs + 5_400_000,
    });
    expect(helpers.parseProviderResetAt({
      nowMs,
      body: {
        quotaResetTimeStamp: '2026-05-17T13:00:00.000Z',
      },
    })).toEqual({
      retryAfterMs: 3_600_000,
      resetAtMs: Date.parse('2026-05-17T13:00:00.000Z'),
    });
  });

  it('parses numeric reset-delay fields as seconds while preserving retry-after-ms milliseconds', async () => {
    const helpers = await loadNormalizationHelpers();
    const nowMs = Date.parse('2026-05-17T12:00:00.000Z');

    expect(helpers.parseProviderResetAt({
      nowMs,
      headers: { 'x-ratelimit-reset-after': '120' },
    })).toEqual({
      retryAfterMs: 120_000,
      resetAtMs: nowMs + 120_000,
    });
    expect(helpers.parseProviderResetAt({
      nowMs,
      body: { quotaResetDelay: 120 },
    })).toEqual({
      retryAfterMs: 120_000,
      resetAtMs: nowMs + 120_000,
    });
    expect(helpers.parseProviderResetAt({
      nowMs,
      body: { retryDelay: '120' },
    })).toEqual({
      retryAfterMs: 120_000,
      resetAtMs: nowMs + 120_000,
    });
    expect(helpers.parseProviderResetAt({
      nowMs,
      body: { 'retry-after-ms': '120' },
    })).toEqual({
      retryAfterMs: 120,
      resetAtMs: null,
    });
  });

  it('parses Claude TUI reset text with an IANA time zone', async () => {
    const helpers = await loadNormalizationHelpers();
    const nowMs = Date.parse('2026-05-17T12:00:00.000Z');

    expect(helpers.parseProviderResetAt({
      nowMs,
      body: {
        message: 'Claude AI usage limit reached. Your limit resets 8pm (Europe/Zurich).',
      },
    })).toEqual({
      retryAfterMs: 21_600_000,
      resetAtMs: Date.parse('2026-05-17T18:00:00.000Z'),
    });
  });

  it('keeps explicit null meter values unknown and unrankable', async () => {
    const helpers = await loadNormalizationHelpers();
    const nullMeter = helpers.normalizeQuotaMeter({
      meterId: 'nulls',
      label: 'Nulls',
      remainingPct: null,
      utilizationPct: null,
      used: null,
      limit: null,
      limitCategory: 'usage_limit',
    });

    expect(nullMeter).toMatchObject({
      remainingPct: null,
      utilizationPct: null,
      reliable: false,
    });
    expect(helpers.selectEffectiveQuotaMeter([nullMeter])).toBeNull();
  });

  it('classifies provider limit evidence without collapsing capacity or eligibility into quota', async () => {
    const helpers = await loadNormalizationHelpers();

    expect(helpers.classifyProviderLimitEvidence({ code: 'usage_limit_reached' })).toBe('usage_limit');
    expect(helpers.classifyProviderLimitEvidence('Grok Build usage balance exhausted')).toBe('usage_limit');
    expect(helpers.classifyProviderLimitEvidence({ status: 429, message: 'rate limit exceeded' })).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ error: { status: 429 } })).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ error: { code: -32603, data: { status: 429 } } })).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ code: 'rate_limit_error' })).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ message: 'RateLimitError' })).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ message: 'model capacity exhausted' })).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ code: 'server_is_overloaded' })).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ message: 'server_is_overloaded' })).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ message: "We're currently experiencing high demand. Please try again shortly." })).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ message: 'High demand report for this workspace' })).toBe('unknown');
    expect(helpers.classifyProviderLimitEvidence({ message: 'stream disconnected before completion: Internal Server Error' })).toBe('unknown');
    expect(helpers.classifyProviderLimitEvidence({ status: 401, message: 'invalid api key' })).toBe('auth_invalid');
    expect(helpers.classifyProviderLimitEvidence({ status: 402, message: 'upgrade your plan' })).toBe('plan_invalid');
    expect(helpers.classifyProviderLimitEvidence({ message: 'plan unavailable for this account' })).toBe('plan_invalid');
    expect(helpers.classifyProviderLimitEvidence({ status: 400, message: 'validation failed' })).toBe('validation_failed');
    expect(helpers.classifyProviderLimitEvidence({ message: 'account disabled' })).toBe('disabled');
    expect(helpers.classifyProviderLimitEvidence({ message: 'quota limit: 100000 remaining: 95000' })).toBe('unknown');
  });

  it('selects the most constrained reliable applicable quota or rate-limit meter', async () => {
    const helpers = await loadNormalizationHelpers();

    const selected = helpers.selectEffectiveQuotaMeter([
      helpers.normalizeQuotaMeter({
        meterId: 'capacity',
        label: 'Capacity',
        remainingPct: 0,
        limitCategory: 'capacity',
        reliable: true,
        applicable: true,
      }),
      helpers.normalizeQuotaMeter({
        meterId: 'daily',
        label: 'Daily',
        utilizationPct: 70,
        limitCategory: 'usage_limit',
        reliable: true,
        applicable: true,
      }),
      helpers.normalizeQuotaMeter({
        meterId: 'weekly',
        label: 'Weekly',
        utilizationPct: 90,
        limitCategory: 'usage_limit',
        reliable: true,
        applicable: true,
      }),
      helpers.normalizeQuotaMeter({
        meterId: 'unknown',
        label: 'Unknown',
        remainingPct: 5,
        limitCategory: 'rate_limit',
        reliable: false,
        applicable: true,
      }),
    ]);

    expect(selected).toMatchObject({
      meterId: 'weekly',
      remainingPct: 10,
      effectiveStrategy: 'most_constrained',
    });
  });
});
