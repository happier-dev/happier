import { describe, expect, it } from 'vitest';

import issuesListRateLimited from '../fixtures/issuesListRateLimited.json' with { type: 'json' };

import { classifySentryFailure } from './sentryFailure.js';

const NOW_MS = 1_786_000_000_000;

describe('classifySentryFailure', () => {
  it('classifies 403 as permission and never as rateLimit', () => {
    const failure = classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: { status: 403, headers: {}, bodyText: '{"detail":"You do not have permission"}' },
    });

    expect(failure).toEqual({
      class: 'permission',
      code: 'sentry-insufficient-permission',
    });
  });

  it('classifies 401 as authentication', () => {
    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issue',
      nowMs: NOW_MS,
      response: { status: 401, headers: {}, bodyText: '' },
    })).toEqual({ class: 'authentication', code: 'sentry-token-invalid' });
  });

  it('carries the response-derived absolute deadline for a 429 with a usable Reset', () => {
    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: {
        status: 429,
        headers: issuesListRateLimited.headers,
        bodyText: JSON.stringify(issuesListRateLimited.body),
      },
    })).toEqual({
      class: 'rateLimit',
      code: 'sentry-rate-limited',
      retryNotBeforeMs: 1_786_000_060_000,
    });
  });

  it('uses the unhinted rate-limit code and omits a deadline when Reset is absent or stale', () => {
    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: { status: 429, headers: {}, bodyText: '' },
    })).toEqual({ class: 'rateLimit', code: 'sentry-rate-limited-unhinted' });

    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: { status: 429, headers: { 'x-sentry-rate-limit-reset': '1700000000' }, bodyText: '' },
    })).toEqual({ class: 'rateLimit', code: 'sentry-rate-limited-unhinted' });
  });

  it('maps only an InvalidSearchQuery 400 to the query-rejected contract failure', () => {
    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: {
        status: 400,
        headers: {},
        bodyText: '{"detail":"Invalid query. InvalidSearchQuery: Invalid format for date field"}',
      },
    })).toEqual({ class: 'unsupportedContract', code: 'sentry-query-rejected' });

    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: { status: 400, headers: {}, bodyText: '{"detail":"something else"}' },
    })).toEqual({ class: 'unknown', code: 'sentry-unexpected-status' });
  });

  it('keeps a 404 ambiguous rather than authoritative', () => {
    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issue',
      nowMs: NOW_MS,
      response: { status: 404, headers: {}, bodyText: '' },
    })).toEqual({ class: 'unknown', code: 'sentry-not-found-unverified' });
  });

  it('classifies 5xx, transport failure and cancellation as transient with distinct codes', () => {
    expect(classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: { status: 503, headers: {}, bodyText: '' },
    })).toEqual({ class: 'transient', code: 'sentry-upstream-unavailable' });

    expect(classifySentryFailure({ kind: 'transport', operation: 'issuesList' }))
      .toEqual({ class: 'transient', code: 'sentry-upstream-unavailable' });

    expect(classifySentryFailure({ kind: 'cancelled', operation: 'issuesList' }))
      .toEqual({ class: 'transient', code: 'sentry-cancelled' });
  });

  it('reports an unparseable body as unsupportedContract', () => {
    expect(classifySentryFailure({ kind: 'unparseable', operation: 'issue' }))
      .toEqual({ class: 'unsupportedContract', code: 'sentry-response-unparseable' });
  });

  it('reports an operation-qualified self-hosted unsupported code without probing versions', () => {
    expect(classifySentryFailure({ kind: 'selfHostedUnsupported', operation: 'tagValues' }))
      .toEqual({
        class: 'unsupportedContract',
        code: 'sentry-self-hosted-tag-values-unsupported',
      });
    expect(classifySentryFailure({ kind: 'selfHostedUnsupported', operation: 'organizations' }))
      .toEqual({
        class: 'unsupportedContract',
        code: 'sentry-self-hosted-organizations-unsupported',
      });
  });

  it('never echoes a provider status, body or header into the failure', () => {
    const failure = classifySentryFailure({
      kind: 'status',
      operation: 'issuesList',
      nowMs: NOW_MS,
      response: {
        status: 418,
        headers: { 'x-request-id': 'abcdef', 'set-cookie': 'session=secret' },
        bodyText: '{"detail":"secret upstream text"}',
      },
    });

    expect(failure).toEqual({ class: 'unknown', code: 'sentry-unexpected-status' });
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(JSON.stringify(failure)).not.toContain('418');
  });
});
