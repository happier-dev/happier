import { describe, expect, it } from 'vitest';

import { parseRetryAfterNotBeforeMsV1 } from './retryAfter.js';

const NOW_MS = Date.UTC(2026, 7, 29, 12, 0, 0);

describe('parseRetryAfterNotBeforeMsV1', () => {
  it('accepts strict delta-seconds and HTTP-date evidence as absolute instants', () => {
    expect(parseRetryAfterNotBeforeMsV1('30', NOW_MS)).toBe(NOW_MS + 30_000);
    expect(parseRetryAfterNotBeforeMsV1('0', NOW_MS)).toBe(NOW_MS);
    expect(parseRetryAfterNotBeforeMsV1(new Date(NOW_MS + 45_000).toUTCString(), NOW_MS))
      .toBe(NOW_MS + 45_000);
    expect(parseRetryAfterNotBeforeMsV1(new Date(NOW_MS).toUTCString(), NOW_MS)).toBe(NOW_MS);
  });

  it('rejects absent, empty, fractional, negative, unsafe, malformed, and elapsed evidence', () => {
    expect(parseRetryAfterNotBeforeMsV1(null, NOW_MS)).toBeNull();
    expect(parseRetryAfterNotBeforeMsV1('  ', NOW_MS)).toBeNull();
    expect(parseRetryAfterNotBeforeMsV1('1.5', NOW_MS)).toBeNull();
    expect(parseRetryAfterNotBeforeMsV1('-5', NOW_MS)).toBeNull();
    expect(parseRetryAfterNotBeforeMsV1(String(Number.MAX_SAFE_INTEGER), NOW_MS)).toBeNull();
    expect(parseRetryAfterNotBeforeMsV1('soon', NOW_MS)).toBeNull();
    expect(parseRetryAfterNotBeforeMsV1(new Date(NOW_MS - 1_000).toUTCString(), NOW_MS)).toBeNull();
  });
});
