import { describe, expect, it } from 'vitest';

import { classifyAzureDevOpsResponse } from './failures.js';
import {
  MAX_AZURE_RETRY_HORIZON_MS,
  readAzureDevOpsRateLimitEvidence,
  resolveAzureDevOpsRetryNotBeforeMs,
} from './rateLimit.js';
import rateLimitedBody from './fixtures/error.rateLimited.json';

const NOW_MS = 1_000_000;

describe('readAzureDevOpsRateLimitEvidence', () => {
  it('reads Azure header evidence case-insensitively and keeps it provider-native', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({
      'Retry-After': '30',
      'X-RateLimit-Reset': '1700000000',
      'x-ratelimit-remaining': '0',
      'X-RATELIMIT-LIMIT': '200',
      'X-RateLimit-Delay': '4.5',
      'X-RateLimit-Resource': 'Git',
    });
    expect(evidence).toEqual({
      retryAfterSeconds: 30,
      retryAfterAtEpochMs: null,
      resetEpochSeconds: 1_700_000_000,
      remaining: 0,
      limit: 200,
      delaySeconds: 4.5,
      resource: 'Git',
    });
  });

  it('reports no evidence when Azure sent no rate-limit headers', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({ 'content-type': 'application/json' });
    expect(evidence.retryAfterSeconds).toBeNull();
    expect(evidence.resetEpochSeconds).toBeNull();
    expect(evidence.remaining).toBeNull();
  });

  it('ignores a non-numeric Retry-After rather than coercing it to zero', () => {
    expect(readAzureDevOpsRateLimitEvidence({ 'retry-after': 'soon' }).retryAfterSeconds).toBeNull();
  });
});

describe('resolveAzureDevOpsRetryNotBeforeMs', () => {
  it('converts an explicit relative Retry-After through the injected clock', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({ 'retry-after': '30' });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBe(NOW_MS + 30_000);
  });

  it('prefers an explicit Retry-After over a further-out reset', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({
      'retry-after': '5',
      'x-ratelimit-reset': String((NOW_MS + 300_000) / 1000),
    });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBe(NOW_MS + 5_000);
  });

  it('uses a valid future reset as an absolute deadline when Retry-After is absent', () => {
    const resetEpochSeconds = (NOW_MS + 120_000) / 1000;
    const evidence = readAzureDevOpsRateLimitEvidence({ 'x-ratelimit-reset': String(resetEpochSeconds) });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBe(NOW_MS + 120_000);
  });

  it('honors an HTTP-date Retry-After rather than discarding it', () => {
    const target = new Date(NOW_MS + 60_000).toUTCString();
    const evidence = readAzureDevOpsRateLimitEvidence({ 'retry-after': target });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBe(Date.parse(target));
  });

  it('ignores a reset already in the past instead of emitting a stale deadline', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({ 'x-ratelimit-reset': String((NOW_MS - 60_000) / 1000) });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBeNull();
  });

  it('invents no deadline when the provider supplied none', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({});
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBeNull();
  });

  it('treats remaining and limit as diagnostics that never become a deadline', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({
      'x-ratelimit-remaining': '0',
      'x-ratelimit-limit': '200',
      'x-ratelimit-delay': '12',
    });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS)).toBeNull();
  });

  it('clamps an implausibly distant reset to the source-owned horizon', () => {
    const evidence = readAzureDevOpsRateLimitEvidence({
      'x-ratelimit-reset': String((NOW_MS + 30 * 24 * 60 * 60 * 1000) / 1000),
    });
    expect(resolveAzureDevOpsRetryNotBeforeMs(evidence, NOW_MS))
      .toBe(NOW_MS + MAX_AZURE_RETRY_HORIZON_MS);
  });
});

describe('classifyAzureDevOpsResponse rate limiting', () => {
  it('classifies a 429 as rateLimit carrying the provider-directed absolute retry fact', () => {
    const failure = classifyAzureDevOpsResponse({
      status: 429,
      headers: { 'Retry-After': '17', 'X-RateLimit-Resource': 'Git' },
      bodyText: JSON.stringify(rateLimitedBody),
      nowMs: NOW_MS,
    });
    expect(failure?.class).toBe('rateLimit');
    expect(failure?.retryNotBeforeMs).toBe(NOW_MS + 17_000);
    expect(failure?.typeKey).toBe('RateLimitExceededException');
    expect(failure?.rateLimit?.resource).toBe('Git');
  });

  it('leaves a headerless 429 without an invented deadline', () => {
    const failure = classifyAzureDevOpsResponse({
      status: 429,
      headers: {},
      bodyText: '',
      nowMs: NOW_MS,
    });
    expect(failure?.class).toBe('rateLimit');
    expect(failure?.retryNotBeforeMs).toBeNull();
  });

  it('keeps an ordinary permission 403 out of the rate-limited class', () => {
    const failure = classifyAzureDevOpsResponse({
      status: 403,
      headers: {},
      bodyText: JSON.stringify({ message: 'TF401027: You need the Contribute permission.' }),
      nowMs: NOW_MS,
    });
    expect(failure?.class).toBe('forbidden');
    expect(failure?.retryNotBeforeMs).toBeNull();
  });
});
