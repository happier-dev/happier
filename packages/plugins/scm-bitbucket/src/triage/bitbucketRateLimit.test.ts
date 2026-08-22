import { describe, expect, it } from 'vitest';

import {
  readBitbucketRateLimitTelemetry,
  readBitbucketRetryNotBeforeMs,
} from './bitbucketRateLimit.js';
import { classifyBitbucketHttpFailure, classifyBitbucketTransportFailure } from './failures.js';

const NOW_MS = 1_000;

describe('Bitbucket rate-limit evidence', () => {
  it('reads the three documented scaled-limit headers case-insensitively and calls them telemetry only', () => {
    const telemetry = readBitbucketRateLimitTelemetry({
      'X-RateLimit-Limit': '5000',
      'x-ratelimit-resource': 'api',
      'X-RATELIMIT-NEARLIMIT': 'true',
    });

    expect(telemetry).toEqual({ limit: 5000, resource: 'api', nearLimit: true });
  });

  it('never invents a reset from telemetry, because Bitbucket publishes no remaining or reset header', () => {
    expect(readBitbucketRetryNotBeforeMs({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-nearlimit': 'true',
    }, NOW_MS)).toBeNull();

    const throttled = classifyBitbucketHttpFailure({
      status: 429,
      headers: { 'x-ratelimit-limit': '1000', 'x-ratelimit-resource': 'api' },
      body: { type: 'error', error: { message: 'Too many requests' } },
      nowMs: NOW_MS,
    });

    expect(throttled.class).toBe('rateLimit');
    expect(throttled.retryNotBeforeMs).toBeUndefined();
  });

  it('honours a syntactically valid Retry-After through the injected clock, in both documented spellings', () => {
    expect(readBitbucketRetryNotBeforeMs({ 'retry-after': '30' }, NOW_MS)).toBe(NOW_MS + 30_000);
    expect(readBitbucketRetryNotBeforeMs({ 'Retry-After': '0' }, NOW_MS)).toBe(NOW_MS);

    const httpDate = new Date(NOW_MS + 45_000).toUTCString();
    expect(readBitbucketRetryNotBeforeMs({ 'retry-after': httpDate }, NOW_MS))
      .toBe(Date.parse(httpDate));
  });

  it('reports a far-future Retry-After as Bitbucket stated it, and drops evidence that is not a deadline', () => {
    // Bounding a provider statement is the single consumer's pacing policy
    // (`plugins/triage` `refresh/refreshEligibility.ts`), not a per-source constant.
    expect(readBitbucketRetryNotBeforeMs({ 'retry-after': '999999' }, NOW_MS))
      .toBe(NOW_MS + (999_999 * 1_000));
    expect(readBitbucketRetryNotBeforeMs({ 'retry-after': 'soon' }, NOW_MS)).toBeNull();
    expect(readBitbucketRetryNotBeforeMs({ 'retry-after': '-5' }, NOW_MS)).toBeNull();
    expect(readBitbucketRetryNotBeforeMs({ 'retry-after': new Date(NOW_MS - 5_000).toUTCString() }, NOW_MS))
      .toBeNull();
  });

  it('carries an explicit Retry-After onto the throttled failure as an absolute deadline', () => {
    const failure = classifyBitbucketHttpFailure({
      status: 429,
      headers: { 'retry-after': '12' },
      body: null,
      nowMs: NOW_MS,
    });

    expect(failure).toMatchObject({ class: 'rateLimit', retryNotBeforeMs: NOW_MS + 12_000 });
  });
});

describe('Bitbucket failure classification', () => {
  it('separates an invalid credential from a missing permission instead of folding either into a throttle', () => {
    expect(classifyBitbucketHttpFailure({ status: 401, headers: {}, body: null, nowMs: NOW_MS }))
      .toMatchObject({ class: 'authentication', code: 'credential-invalid' });
    expect(classifyBitbucketHttpFailure({ status: 403, headers: {}, body: null, nowMs: NOW_MS }))
      .toMatchObject({ class: 'permission', code: 'insufficient-scope' });
    expect(classifyBitbucketHttpFailure({ status: 403, headers: {}, body: null, nowMs: NOW_MS }).class)
      .not.toBe('rateLimit');
  });

  it('classifies 404 without concluding absence and gives 555 its own non-standard code', () => {
    expect(classifyBitbucketHttpFailure({ status: 404, headers: {}, body: null, nowMs: NOW_MS }))
      .toMatchObject({ class: 'notFound', code: 'route-not-found' });
    expect(classifyBitbucketHttpFailure({ status: 555, headers: {}, body: null, nowMs: NOW_MS }))
      .toMatchObject({ class: 'unsupportedContract', code: 'provider-oversized-response' });
    expect(classifyBitbucketHttpFailure({ status: 503, headers: {}, body: null, nowMs: NOW_MS }))
      .toMatchObject({ class: 'transient', code: 'server-error' });
  });

  it('takes a bounded non-secret detail from the documented error envelope only', () => {
    const failure = classifyBitbucketHttpFailure({
      status: 404,
      headers: {},
      body: { type: 'error', error: { message: 'Repository not found', detail: 'private' } },
      nowMs: NOW_MS,
    });

    expect(failure.detail).toBe('Repository not found');

    const long = classifyBitbucketHttpFailure({
      status: 404,
      headers: {},
      body: { type: 'error', error: { message: 'é'.repeat(2_000) } },
      nowMs: NOW_MS,
    });

    expect(new TextEncoder().encode(long.detail ?? '').byteLength).toBeLessThanOrEqual(1_024);
  });

  it('reports cancellation as cancellation rather than as a provider fault', () => {
    const aborted = new DOMException('aborted', 'AbortError');

    expect(classifyBitbucketTransportFailure(aborted)).toMatchObject({ class: 'cancelled' });
    expect(classifyBitbucketTransportFailure(new Error('socket hang up')))
      .toMatchObject({ class: 'transient', code: 'transport-failure' });
  });
});
