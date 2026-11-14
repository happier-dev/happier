import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import issueDetail from '../fixtures/issueDetail.json' with { type: 'json' };
import issueDetailMergedSuccessor from '../fixtures/issueDetailMergedSuccessor.json' with { type: 'json' };
import issuesListMalformedRows from '../fixtures/issuesListMalformedRows.json' with { type: 'json' };
import { executeSentryScanPage } from '../scan/scanIssuesPage.js';
import type { SentryApiClientV1 } from '../api/sentryApiClient.js';
import { resolveSentryGetOutcome } from './getIssueOutcome.js';

const configured = { deploymentOrigin: 'https://us.sentry.io', organizationId: '7701' };
const requestUrl = 'https://us.sentry.io/api/0/organizations/7701/issues/5501001/';
const collisionScope = 'https://us.sentry.io\u001f7701';
const NativeURL = globalThis.URL;
let scopeParses = 0;

beforeEach(() => {
  scopeParses = 0;
  // Instrument the platform URL boundary without replacing any scope/domain logic.
  // Absolute API URLs are scope resolution; route construction uses a relative URL.
  vi.stubGlobal('URL', class extends NativeURL {
    constructor(...args: ConstructorParameters<typeof URL>) {
      super(...args);
      if (typeof args[0] === 'string' && args[0].startsWith('https://us.sentry.io/api/0/organizations/')) {
        scopeParses += 1;
      }
    }
  });
});
afterEach(() => vi.unstubAllGlobals());

function get(body: unknown, url = requestUrl) {
  return resolveSentryGetOutcome({
    requestedEntryId: '5501001', configured, requestUrl: url,
    organizationSlug: 'example-org', nowMs: 1_786_000_000_000,
    outcome: { kind: 'response', response: { status: 200, headers: {}, bodyText: JSON.stringify(body) } },
  });
}

describe('request-owned Sentry collision scope', () => {
  it.each([
    ['present', issueDetail.body],
    ['merged', issueDetailMergedSuccessor.body],
    ['unresolved', { ...issueDetail.body, id: null }],
  ])('resolves once for a %s get while preserving native identity', (kind, body) => {
    const result = get(body);
    expect(result.kind).toBe(kind);
    expect(result.localRef).toEqual({ kindId: 'error-issue', entryId: '5501001', collisionScope });
    if (result.kind === 'present') expect(result.snapshot.localRef).toEqual(result.localRef);
    if (result.kind === 'merged') expect(result.successor).toEqual({ kindId: 'error-issue', entryId: '5509999', collisionScope });
    if (result.kind === 'unresolved') expect(result.failure.code).toBe('sentry-response-unparseable');
    expect(scopeParses).toBe(1);
  });

  it.each([
    ['https://eu.sentry.io/api/0/organizations/7701/issues/5501001/', 'sentry-invoked-origin-mismatch'],
    ['https://us.sentry.io/api/0/organizations/7702/issues/5501001/', 'sentry-invoked-organization-mismatch'],
  ])('refuses wrong-scope get %s before projecting present or merged rows', (url, code) => {
    for (const body of [issueDetail.body, issueDetailMergedSuccessor.body]) {
      expect(get(body, url)).toMatchObject({ kind: 'unresolved', failure: { class: 'unsupportedContract', code } });
    }
  });

  it.each([false, true])('resolves once per scan page, including empty=%s', async (empty) => {
    const response = issuesListMalformedRows;
    const client = { request: vi.fn(async () => ({
      kind: 'response' as const,
      response: { status: response.status, headers: response.headers, bodyText: JSON.stringify(empty ? [] : response.body) },
    })), updateIssue: async () => { throw new Error('scan must not write'); } } satisfies SentryApiClientV1;
    const result = await executeSentryScanPage({
      client, configured, organizationSlug: 'example-org',
      page: { kind: 'initial', scanLimit: 64 }, nowMs: 1_786_000_000_000,
    });
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations).toHaveLength(empty ? 0 : 2);
    for (const snapshot of result.observations) expect(snapshot.localRef.collisionScope).toBe(collisionScope);
    if (!empty) expect(result.health).toMatchObject({ omittedItemCount: 3 });
    expect(scopeParses).toBe(1);
  });
});
