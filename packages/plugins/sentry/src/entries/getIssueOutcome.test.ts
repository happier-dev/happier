import { describe, expect, it } from 'vitest';

import issueDetail from '../fixtures/issueDetail.json' with { type: 'json' };
import issueDetailMergedSuccessor from '../fixtures/issueDetailMergedSuccessor.json' with { type: 'json' };

import { SENTRY_SCOPE_SEPARATOR } from '../sentryContracts.js';
import { resolveSentryGetOutcome } from './getIssueOutcome.js';

const CONFIGURED = Object.freeze({
  deploymentOrigin: 'https://us.sentry.io',
  organizationId: '7701',
});
const REQUEST_URL = 'https://us.sentry.io/api/0/organizations/7701/issues/5501001/';
const SCOPE = `https://us.sentry.io${SENTRY_SCOPE_SEPARATOR}7701`;
const NOW_MS = 1_786_000_000_000;

function resolve(
  response: Readonly<{ status: number; headers?: Record<string, string>; body: unknown }>,
  requestedEntryId = '5501001',
) {
  return resolveSentryGetOutcome({
    requestedEntryId,
    configured: CONFIGURED,
    requestUrl: REQUEST_URL,
    organizationSlug: 'example-org',
    nowMs: NOW_MS,
    outcome: {
      kind: 'response',
      response: {
        status: response.status,
        headers: response.headers ?? {},
        bodyText: JSON.stringify(response.body),
      },
    },
  });
}

describe('resolveSentryGetOutcome', () => {
  it('returns present when the 200 body carries the requested issue id', () => {
    const outcome = resolve(issueDetail);

    expect(outcome.kind).toBe('present');
    if (outcome.kind !== 'present') return;
    expect(outcome.snapshot.localRef.entryId).toBe('5501001');
    expect(outcome.snapshot.state).toEqual({ presentation: 'active', nativeLabel: 'Escalating' });
  });

  it('reports merged when the 200 body carries a different issue id', () => {
    // `[SOURCE]` `bases/group.py` calls `get_group_with_redirect(...)` and
    // discards the `redirected` flag, so a merged-away id returns HTTP 200 with
    // the successor's body and no header announcing the substitution. Comparing
    // the returned id is the only detection available to any client.
    const outcome = resolve(issueDetailMergedSuccessor);

    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    expect(outcome.localRef).toEqual({
      kindId: 'error-issue',
      collisionScope: SCOPE,
      entryId: '5501001',
    });
    expect(outcome.successor).toEqual({
      kindId: 'error-issue',
      collisionScope: SCOPE,
      entryId: '5509999',
    });
  });

  it('derives the successor scope from the invoked instance, never from the response project', () => {
    const outcome = resolve(issueDetailMergedSuccessor);

    expect(outcome.kind).toBe('merged');
    if (outcome.kind !== 'merged') return;
    // The successor body names project 9004 / other-project; neither may rekey it.
    expect(outcome.successor.collisionScope).toBe(SCOPE);
    expect(outcome.successor.collisionScope).not.toContain('9004');
    expect(outcome.successor.collisionScope).not.toContain('other-project');
  });

  it('returns unresolved sentry-not-found-unverified for a 404 and never absent', () => {
    const outcome = resolve({ status: 404, body: { detail: 'The requested resource does not exist' } });

    expect(outcome).toEqual({
      kind: 'unresolved',
      localRef: { kindId: 'error-issue', collisionScope: SCOPE, entryId: '5501001' },
      failure: { class: 'unknown', code: 'sentry-not-found-unverified' },
    });
    expect(JSON.stringify(outcome)).not.toContain('absent');
  });

  it('maps every other rejection to its typed unresolved outcome', () => {
    expect(resolve({ status: 401, body: {} })).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'authentication', code: 'sentry-token-invalid' },
    });
    expect(resolve({ status: 403, body: {} })).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'permission', code: 'sentry-insufficient-permission' },
    });
    expect(resolve({
      status: 429,
      headers: { 'x-sentry-rate-limit-reset': '1786000060' },
      body: {},
    })).toMatchObject({
      kind: 'unresolved',
      failure: {
        class: 'rateLimit',
        code: 'sentry-rate-limited',
        retryNotBeforeMs: 1_786_000_060_000,
      },
    });
    expect(resolve({ status: 503, body: {} })).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'transient', code: 'sentry-upstream-unavailable' },
    });
  });

  it('treats an unparseable or non-object 200 body as an unsupported contract', () => {
    const outcome = resolveSentryGetOutcome({
      requestedEntryId: '5501001',
      configured: CONFIGURED,
      requestUrl: REQUEST_URL,
      organizationSlug: 'example-org',
      nowMs: NOW_MS,
      outcome: {
        kind: 'response',
        response: { status: 200, headers: {}, bodyText: 'not json at all' },
      },
    });

    expect(outcome).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'sentry-response-unparseable' },
    });

    expect(resolve({ status: 200, body: [] })).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'sentry-response-unparseable' },
    });
  });

  it('treats a 200 body with no usable id as unparseable rather than merged', () => {
    expect(resolve({ status: 200, body: { ...issueDetail.body, id: null } })).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'unsupportedContract', code: 'sentry-response-unparseable' },
    });
  });

  it('passes a client-side failure through unchanged as unresolved', () => {
    const outcome = resolveSentryGetOutcome({
      requestedEntryId: '5501001',
      configured: CONFIGURED,
      requestUrl: REQUEST_URL,
      organizationSlug: 'example-org',
      nowMs: NOW_MS,
      outcome: {
        kind: 'failed',
        failure: { class: 'transient', code: 'sentry-cancelled' },
      },
    });

    expect(outcome).toMatchObject({
      kind: 'unresolved',
      failure: { class: 'transient', code: 'sentry-cancelled' },
    });
  });
});
