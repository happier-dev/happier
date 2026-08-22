import { describe, expect, it } from 'vitest';

import {
  parseClaudeProviderTimestampMs,
  parseClaudeUsageLimitReset,
} from './reset.js';

describe('parseClaudeUsageLimitReset', () => {
  it('rejects finite retry evidence whose millisecond conversion overflows or loses precision', () => {
    expect(parseClaudeUsageLimitReset({
      nowMs: 0,
      headers: { 'retry-after': Number.MAX_VALUE },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
    expect(parseClaudeUsageLimitReset({
      nowMs: 0,
      headers: { 'x-ratelimit-reset-after': `${Number.MAX_SAFE_INTEGER}d` },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
    expect(parseClaudeProviderTimestampMs(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(parseClaudeUsageLimitReset({
      nowMs: 0,
      headers: { 'retry-after-ms': Number.MAX_VALUE },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
    expect(parseClaudeUsageLimitReset({
      nowMs: 0,
      headers: { 'x-ratelimit-reset-after': `${Number.MAX_SAFE_INTEGER}ms 1ms` },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
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
      expect(parseClaudeProviderTimestampMs(value)).toBe(expected);
    }
  });

  it('rejects a delay when its reset timestamp cannot be represented safely', () => {
    expect(parseClaudeUsageLimitReset({
      nowMs: Number.MAX_SAFE_INTEGER - 500,
      headers: { 'x-ratelimit-reset-after': '1' },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
  });

  it('keeps valid large, date, and negative retry evidence distinct', () => {
    const nowMs = Date.parse('2026-05-17T12:00:00.000Z');

    expect(parseClaudeUsageLimitReset({
      nowMs: 0,
      headers: { 'retry-after': Math.floor(Number.MAX_SAFE_INTEGER / 1_000) },
    })).toEqual({
      retryAfterMs: 9_007_199_254_740_000,
      resetAtMs: null,
    });
    expect(parseClaudeUsageLimitReset({
      nowMs,
      headers: { 'retry-after': 'Sun, 17 May 2026 12:00:10 GMT' },
    })).toEqual({
      retryAfterMs: 10_000,
      resetAtMs: Date.parse('2026-05-17T12:00:10.000Z'),
    });
    expect(parseClaudeUsageLimitReset({
      nowMs,
      headers: { 'retry-after': '-1' },
    })).toEqual({
      retryAfterMs: null,
      resetAtMs: null,
    });
  });
});
