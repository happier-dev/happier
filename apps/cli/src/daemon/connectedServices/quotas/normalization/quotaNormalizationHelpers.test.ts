import { readFile } from 'node:fs/promises';

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

  it('normalizes absolute provider reset epochs at the shared seconds/ms boundary', async () => {
    const helpers = await loadNormalizationHelpers();
    const cases: ReadonlyArray<readonly [unknown, number | null]> = [
      [1_700_000_000, 1_700_000_000_000],
      [1_700_000_000_000, 1_700_000_000_000],
      [1_000_000_000_000, 1_000_000_000_000],
      ['1700000000', 1_700_000_000_000],
      ['1700000000000', 1_700_000_000_000],
      [Number.NaN, null],
      [Number.POSITIVE_INFINITY, null],
      [-1, null],
      ['not-a-timestamp', null],
    ];

    for (const [value, expected] of cases) {
      const timing = helpers.parseProviderResetAt({
        nowMs: 0,
        headers: { 'x-ratelimit-reset': value },
      });
      if (expected === null) {
        expect(timing).toEqual({ retryAfterMs: null, resetAtMs: null });
      } else {
        expect(timing).toEqual({ retryAfterMs: expected, resetAtMs: expected });
      }
    }
  });

  it('rejects retry delays whose finite conversion cannot be represented safely', async () => {
    const helpers = await loadNormalizationHelpers();

    expect(helpers.parseRetryAfterHeader(Number.MAX_VALUE, { nowMs: 0 })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
    expect(helpers.parseCompactDurationMs(`${Number.MAX_SAFE_INTEGER}d`)).toBeNull();
    expect(helpers.parseCompactDurationMs(`${Number.MAX_SAFE_INTEGER}ms 1ms`)).toBeNull();
    expect(helpers.parseProviderTimestampMs(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(helpers.parseProviderResetAt({
      nowMs: 0,
      headers: { 'retry-after-ms': Number.MAX_VALUE },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
  });

  it('rejects a reset delay when adding it to now exceeds safe millisecond precision', async () => {
    const helpers = await loadNormalizationHelpers();

    expect(helpers.parseProviderResetAt({
      nowMs: Number.MAX_SAFE_INTEGER - 500,
      headers: { 'x-ratelimit-reset-after': '1' },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
  });

  it('keeps valid large, date, and negative retry-after evidence distinct', async () => {
    const helpers = await loadNormalizationHelpers();
    const nowMs = Date.parse('2026-05-17T12:00:00.000Z');

    expect(helpers.parseRetryAfterHeader(Math.floor(Number.MAX_SAFE_INTEGER / 1_000), { nowMs: 0 })).toEqual({
      retryAfterMs: 9_007_199_254_740_000,
      resetAtMs: null,
    });
    expect(helpers.parseRetryAfterHeader('Sun, 17 May 2026 12:00:10 GMT', { nowMs })).toEqual({
      retryAfterMs: 10_000,
      resetAtMs: Date.parse('2026-05-17T12:00:10.000Z'),
    });
    expect(helpers.parseRetryAfterHeader('-1', { nowMs })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
  });

  it('keeps provider-specific reset parsers out of generic daemon normalization', async () => {
    const source = await readFile(new URL('./parseProviderResetAt.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/Claude|Anthropic|anthropic-ratelimit|timingFromClaudeTuiResetText/iu);
  });

  it('does not parse provider-specific TUI reset text without provider-owned evidence', async () => {
    const helpers = await loadNormalizationHelpers();
    const nowMs = Date.parse('2026-05-17T12:00:00.000Z');

    expect(helpers.parseProviderResetAt({
      nowMs,
      body: {
        message: 'Claude AI usage limit reached. Your limit resets 8pm (Europe/Zurich).',
      },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
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

    expect(helpers.classifyProviderLimitEvidence({ code: 'usage_limit_reached' }).category).toBe('usage_limit');
    expect(helpers.classifyProviderLimitEvidence({ status: 429, message: 'rate limit exceeded' }).category).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ error: { status: 429 } }).category).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ error: { code: -32603, data: { status: 429 } } }).category).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ code: 'rate_limit_error' }).category).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ message: 'RateLimitError' }).category).toBe('rate_limit');
    expect(helpers.classifyProviderLimitEvidence({ message: 'model capacity exhausted' }).category).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ code: 'server_is_overloaded' }).category).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ message: 'server_is_overloaded' }).category).toBe('capacity');
    expect(helpers.classifyProviderLimitEvidence({ status: 401, message: 'invalid api key' }).category).toBe('auth_invalid');
    expect(helpers.classifyProviderLimitEvidence({ status: 402, message: 'upgrade your plan' }).category).toBe('plan_invalid');
    expect(helpers.classifyProviderLimitEvidence({ message: 'plan unavailable for this account' }).category).toBe('plan_invalid');
    expect(helpers.classifyProviderLimitEvidence({ status: 400, message: 'validation failed' }).category).toBe('validation_failed');
    expect(helpers.classifyProviderLimitEvidence({ message: 'account disabled' }).category).toBe('disabled');
    expect(helpers.classifyProviderLimitEvidence({ message: 'quota limit: 100000 remaining: 95000' }).category).toBe('unknown');
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
