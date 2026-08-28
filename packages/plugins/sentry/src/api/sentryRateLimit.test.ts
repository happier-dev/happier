import { describe, expect, it } from 'vitest';

import issuesListRateLimited from '../fixtures/issuesListRateLimited.json' with { type: 'json' };
import issuesListNoLinkHeader from '../fixtures/issuesListNoLinkHeader.json' with { type: 'json' };

import { readSentryRateLimitSnapshot, resolveSentryRetryNotBeforeMs } from './sentryRateLimit.js';

describe('readSentryRateLimitSnapshot', () => {
  it('derives absolute retryNotBeforeMs from Reset and never looks for Retry-After', () => {
    const snapshot = readSentryRateLimitSnapshot(issuesListRateLimited.headers);

    expect(snapshot.resetAtMs).toBe(1_786_000_060_000);
    expect(snapshot.limit).toBe(40);
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.headersAbsent).toBe(false);

    const nowMs = 1_786_000_000_000;
    expect(resolveSentryRetryNotBeforeMs(snapshot, nowMs)).toBe(1_786_000_060_000);

    // `Retry-After` belongs to event ingestion, not the API: it must be ignored.
    const retryAfterOnly = readSentryRateLimitSnapshot({ 'retry-after': '120' });
    expect(retryAfterOnly.headersAbsent).toBe(true);
    expect(resolveSentryRetryNotBeforeMs(retryAfterOnly, nowMs)).toBeNull();
  });

  it('reports headersAbsent rather than zero when the limiter failed open', () => {
    const snapshot = readSentryRateLimitSnapshot(issuesListNoLinkHeader.headers);

    expect(snapshot.headersAbsent).toBe(true);
    expect(snapshot.limit).toBeNull();
    expect(snapshot.remaining).toBeNull();
    expect(snapshot.resetAtMs).toBeNull();
    expect(snapshot.concurrentLimit).toBeNull();
    expect(snapshot.concurrentRemaining).toBeNull();
  });

  it('keeps a real zero remaining distinguishable from an absent header', () => {
    const snapshot = readSentryRateLimitSnapshot({ 'X-Sentry-Rate-Limit-Remaining': '0' });

    expect(snapshot.headersAbsent).toBe(false);
    expect(snapshot.remaining).toBe(0);
    expect(snapshot.limit).toBeNull();
  });

  it('reads a present-but-empty limiter header as absent evidence, not as a reading', () => {
    // `X-Sentry-Rate-Limit-Remaining: ` states no budget. Counting it as present makes the
    // snapshot claim the limiter answered when it supplied nothing to read.
    const snapshot = readSentryRateLimitSnapshot({ 'X-Sentry-Rate-Limit-Remaining': '  ' });

    expect(snapshot.headersAbsent).toBe(true);
    expect(snapshot.remaining).toBeNull();
  });

  it('rejects a malformed, past or non-future Reset instead of synthesizing a deadline', () => {
    const nowMs = 1_786_000_000_000;

    expect(resolveSentryRetryNotBeforeMs(
      readSentryRateLimitSnapshot({ 'x-sentry-rate-limit-reset': 'soon' }),
      nowMs,
    )).toBeNull();
    expect(resolveSentryRetryNotBeforeMs(
      readSentryRateLimitSnapshot({ 'x-sentry-rate-limit-reset': '1785999999' }),
      nowMs,
    )).toBeNull();
    expect(resolveSentryRetryNotBeforeMs(
      readSentryRateLimitSnapshot({ 'x-sentry-rate-limit-reset': '-5' }),
      nowMs,
    )).toBeNull();
  });

  it('preserves a future safe-integer Reset exactly without inventing a local horizon', () => {
    const nowMs = 1_786_000_000_000;
    const snapshot = readSentryRateLimitSnapshot({ 'x-sentry-rate-limit-reset': '99999999999' });

    expect(resolveSentryRetryNotBeforeMs(snapshot, nowMs)).toBe(99_999_999_999_000);
  });
});
