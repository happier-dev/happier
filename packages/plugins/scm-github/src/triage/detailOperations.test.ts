import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES,
  isExternalActionResultWithinResponseEnvelopeLimitV1,
} from '@happier-dev/plugin-sdk/actions';
import { MAX_TRIAGE_TEXT_UTF8_BYTES_V1, type TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
  githubChangedFile,
  githubCheckRun,
  githubCheckRunsResponse,
  githubCombinedStatusResponse,
  githubCommitStatus,
  githubFollowUpLinkHeader,
  githubTimelineEvent,
} from './__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import {
  GithubCapabilitiesResultV1Schema,
  GithubChangedFilesResultV1Schema,
  GithubChecksResultV1Schema,
  GithubFeedbackResultV1Schema,
  GithubOverviewResultV1Schema,
  GithubTimelineResultV1Schema,
} from './detail/contracts.js';
import { encodeGithubDetailContinuation } from './detail/continuation.js';
import {
  readGithubCapabilities,
  readGithubOverview,
  listGithubChangedFiles,
  readGithubFeedback,
  listGithubTimeline,
  readGithubChecks,
  readGithubPullRequestStatus,
} from './detailOperations.js';
import {
  createStubGithubTransport,
  readRecordedJsonBody,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
const HEAD_SHA = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
const BASE_SHA = '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e';
const CONFIGURED_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'configured-account',
});

function configuredInstance(purpose = GITHUB_CONNECTED_ACCOUNT_PURPOSE): TriageConfiguredSourceInstanceV1 {
  const token = encodeGithubTriageConfiguration({
    v: 1,
    scope: { kind: 'repository', repositoryKey: REPOSITORY_KEY },
  });
  if (token === null) throw new Error('the fixture configuration must encode');
  const fixture = createTriageSourceV1Fixture();
  return Object.freeze({
    ...fixture.configuredInstance,
    instance: Object.freeze({
      source: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-forge' }),
      sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId,
    }),
    binding: Object.freeze({ purpose, account: CONFIGURED_ACCOUNT }),
    localInstanceKey: 'github.com',
    configuration: Object.freeze({ v: 1 as const, token }),
  });
}

const PULL_REQUEST_REF = Object.freeze({
  kindId: 'pull-request',
  collisionScope: 'github:4210',
  entryId: '1284',
});
const ISSUE_REF = Object.freeze({
  kindId: 'issue',
  collisionScope: 'github:4210',
  entryId: '1284',
});

it('propagates the caller-owned invocation lifetime through a never-settling detail read', async () => {
  const caller = new AbortController();
  const stub = createStubGithubTransport({
    signal: caller.signal,
    respond: (request) => new URL(request.url).pathname.endsWith('/timeline')
      ? new Promise<StubHttpResponse>(() => {})
      : undefined,
  });
  const pending = listGithubTimeline(planeInput(), stub.context);

  caller.abort(new DOMException('The host invocation reached its deadline.', 'TimeoutError'));

  await expect(pending).resolves.toEqual({
    kind: 'unavailable',
    failure: { class: 'transient', code: 'github_request_timed_out' },
  });
});

function planeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    limit: 50,
    ...overrides,
  };
}

function jsonResponse(body: unknown, headers: Readonly<Record<string, string>> = {}): StubHttpResponse {
  return { status: 200, headers: { 'content-type': 'application/json', ...headers }, body };
}

describe('GitHub capability plane', () => {
  it('projects repository facts from the admission read without a duplicate fetch', async () => {
    const repositoryBody = {
      id: 4210,
      archived: false,
      has_issues: true,
      allow_merge_commit: true,
      allow_squash_merge: false,
      allow_rebase_merge: true,
      permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    };
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname
        === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`
        ? jsonResponse(repositoryBody)
        : undefined,
    });
    const result = GithubCapabilitiesResultV1Schema.parse(await readGithubCapabilities({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
    }, stub.context));
    expect(result.kind).toBe('capabilities');
    if (result.kind !== 'capabilities') return;
    expect(result.mergeMethods.squash).toEqual({ kind: 'unavailable', code: 'repository_unsupported' });
    expect(result.operations.pullRequestSubmitReview).toEqual({ kind: 'available' });
    expect(result.operations.pullRequestReviewCommentCreate).toEqual({ kind: 'available' });
    expect(result.operations.pullRequestMerge).toEqual({ kind: 'available' });
    expect(stub.requests.filter((request) =>
      new URL(request.url).pathname === `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`))
      .toHaveLength(1);
  });
});

/* --------------------------------------------------------------------- overview */

describe('GitHub overview plane', () => {
  it('refreshes one exact pull request into its current Markdown and branch facts', async () => {
    const observedAtMs = Date.parse('2026-08-31T10:11:12Z');
    const now = vi.spyOn(Date, 'now').mockReturnValue(observedAtMs);
    const pullRequest = {
      ...GITHUB_PULL_REQUEST_RESPONSE,
      mergeable_state: 'behind',
      assignees: [{ login: 'hubot' }],
      requested_reviewers: [{ login: 'monalisa' }],
      requested_teams: [{ slug: 'client-platform' }],
      milestone: { title: 'August' },
    };
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? jsonResponse(pullRequest)
        : undefined,
    });

    try {
      const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
        v: 1,
        instance: configuredInstance(),
        localRef: PULL_REQUEST_REF,
        routingToken: REPOSITORY_KEY,
      }, stub.context));

      expect(result).toEqual({
        kind: 'overview',
        kindId: 'pull-request',
        observedAtMs,
        title: 'Stream terminal frames without a full re-render',
        state: 'open',
        draft: false,
        merged: false,
        author: 'octocat',
        createdAtMs: Date.parse('2026-08-01T09:14:22Z'),
        updatedAtMs: Date.parse('2026-08-12T18:03:40Z'),
        body: 'Reworks the frame pump.',
        webUrl: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pull/1284`,
        labels: ['performance'],
        assignees: ['hubot'],
        milestone: 'August',
        headBranch: 'frame-pump',
        baseBranch: 'main',
        requestedReviewers: [
          { kind: 'user', subject: 'monalisa' },
          { kind: 'team', subject: 'client-platform' },
        ],
        headRevision: HEAD_SHA,
        additions: 214,
        deletions: 88,
        changedFiles: 12,
        branchUpdateEligibility: 'behind',
      });
      expect(stub.requests.filter((request) => new URL(request.url).pathname.endsWith('/pulls/1284')))
        .toHaveLength(1);
    } finally {
      now.mockRestore();
    }
  });

  it('states an independent provider permission denial instead of rendering an empty overview', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? { status: 403, body: { message: 'Resource not accessible' } }
        : undefined,
    });

    expect(await readGithubOverview({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
    }, stub.context)).toEqual({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'github_forbidden' },
    });
  });

  it('refreshes an issue without manufacturing pull-request-only fields', async () => {
    const issue = {
      ...GITHUB_ISSUE_RESPONSE,
      number: 1284,
      repository_url: `https://api.github.com/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`,
      html_url: `https://github.com/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/issues/1284`,
      labels: [{ name: 'bug' }],
      assignees: [{ login: 'hubot' }],
      milestone: { title: 'August' },
    };
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/issues/1284')
        ? jsonResponse(issue)
        : undefined,
    });

    const result = GithubOverviewResultV1Schema.parse(await readGithubOverview({
      v: 1,
      instance: configuredInstance(),
      localRef: ISSUE_REF,
      routingToken: REPOSITORY_KEY,
    }, stub.context));

    expect(result).toMatchObject({
      kind: 'overview',
      kindId: 'issue',
      title: 'Reconnect loop after a laptop resume',
      state: 'open',
      author: 'monalisa',
      body: 'The client reconnects in a loop after resume.',
      labels: ['bug'],
      assignees: ['hubot'],
      milestone: 'August',
    });
    expect(result).not.toHaveProperty('headBranch');
    expect(result).not.toHaveProperty('headRevision');
    expect(result).not.toHaveProperty('branchUpdateEligibility');
  });
});

/* --------------------------------------------------------------------- timeline */

describe('GitHub timeline plane', () => {
  it('walks pages by minting its own position and never carrying a provider URL', async () => {
    const stub = createStubGithubTransport({
      respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
        if (!request.url.includes('/issues/1284/timeline')) return undefined;
        const page = new URL(request.url).searchParams.get('page');
        if (page === '1') {
          return jsonResponse(
            [githubTimelineEvent({ id: 1, event: 'labeled', createdAt: '2026-08-01T00:00:00Z', label: 'bug' })],
            { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) },
          );
        }
        return jsonResponse([
          githubTimelineEvent({ id: 2, event: 'closed', createdAt: '2026-08-02T00:00:00Z' }),
        ]);
      },
    });

    const first = await listGithubTimeline(planeInput(), stub.context);
    const parsedFirst = GithubTimelineResultV1Schema.parse(first);
    if (parsedFirst.kind !== 'timeline') throw new Error('the first page must settle as timeline');
    expect(parsedFirst.rows.map((row) => row.id)).toEqual(['github-timeline-event:1']);
    expect(parsedFirst.continuation).toBeDefined();
    // The token is this source's own bytes; a provider URL never reaches a panel.
    expect(parsedFirst.continuation).not.toContain('api.github.com');
    expect(parsedFirst.incomplete).toBeUndefined();

    const second = await listGithubTimeline(
      planeInput({ continuation: parsedFirst.continuation }),
      stub.context,
    );
    const parsedSecond = GithubTimelineResultV1Schema.parse(second);
    if (parsedSecond.kind !== 'timeline') throw new Error('the second page must settle as timeline');
    expect(parsedSecond.rows.map((row) => row.id)).toEqual(['github-timeline-event:2']);
    expect(parsedSecond.continuation).toBeUndefined();

    expect(stub.requests
      .filter((request) => request.url.includes('/timeline'))
      .map((request) => new URL(request.url).searchParams.get('page')))
      .toEqual(['1', '2']);
  });

  it('reads a provider-stated empty timeline as a settled page with no rows', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/timeline') ? jsonResponse([]) : undefined),
    });

    const result = GithubTimelineResultV1Schema.parse(
      await listGithubTimeline(planeInput(), stub.context),
    );
    // "Nothing here" and "we could not look" are different answers.
    expect(result.kind).toBe('timeline');
    if (result.kind !== 'timeline') return;
    expect(result.rows).toEqual([]);
    expect(result.continuation).toBeUndefined();
  });

  it('names itself when the first page is refused', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/timeline')
        ? {
          status: 403,
          headers: { 'x-accepted-github-permissions': 'issues=read' },
          body: { message: 'Resource not accessible' },
        }
        : undefined),
    });

    const result = GithubTimelineResultV1Schema.parse(
      await listGithubTimeline(planeInput(), stub.context),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'permission', code: 'insufficient_scope' },
    });
  });

  it('refuses a continuation minted under a different page geometry', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const continuation = encodeGithubDetailContinuation({ v: 1, page: 3, perPage: 100 });

    const result = GithubTimelineResultV1Schema.parse(await listGithubTimeline(
      planeInput({ limit: 50, continuation }),
      stub.context,
    ));
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_detail_continuation_unreadable' },
    });
    // Resuming at a page that names different rows would silently skip content,
    // so nothing is requested at all.
    expect(stub.requests).toEqual([]);
  });

  it('reports a next page it will not follow instead of looking finished', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/timeline')
        ? jsonResponse(
          [githubTimelineEvent({ id: 1, event: 'closed', createdAt: '2026-08-01T00:00:00Z' })],
          // A cross-origin next URL is not the same request with only `page`
          // advanced, so it is refused rather than followed.
          { link: '<https://evil.example.com/repos/o/r/issues/1284/timeline?page=2>; rel="next"' },
        )
        : undefined),
    });

    const result = GithubTimelineResultV1Schema.parse(
      await listGithubTimeline(planeInput(), stub.context),
    );
    if (result.kind !== 'timeline') throw new Error('rows already read must survive');
    expect(result.rows).toHaveLength(1);
    expect(result.continuation).toBeUndefined();
    expect(result.incomplete).toBe('pagination');
  });

  it('makes no outbound call when the observed route cannot be parsed', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const result = GithubTimelineResultV1Schema.parse(await listGithubTimeline(
      planeInput({ routingToken: 'not-a-repository-key' }),
      stub.context,
    ));
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unknown', code: 'github_locator_unusable' },
    });
    expect(stub.requests).toEqual([]);
    expect(stub.materializeCount()).toBe(0);
  });

  it('refuses a configured instance bound to another purpose', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const result = GithubTimelineResultV1Schema.parse(await listGithubTimeline(
      planeInput({ instance: configuredInstance('some.other.purpose') }),
      stub.context,
    ));
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_instance_binding_foreign' },
    });
    expect(stub.requests).toEqual([]);
  });

  it('refuses the mutable repository route when it now names another immutable repository', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 8815, full_name: 'octo-org/example-app' });
        }
        if (pathname.endsWith('/issues/1284/timeline')) return jsonResponse([]);
        return undefined;
      },
    });

    const result = await listGithubTimeline(planeInput(), stub.context);
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unknown', code: 'route-body-mismatch' },
    });
    expect(stub.requests.some((request) => request.url.includes('/issues/1284/timeline')))
      .toBe(false);
  });
});

/* ---------------------------------------------------------------- changed files */

describe('GitHub changed-files plane', () => {
  it('retains exact comparison patches and pins endpoints across source continuations', async () => {
    const patch = '@@ -1 +1 @@\n-old  \n+new Ω  ';
    const mergeBaseOid = 'c'.repeat(40);
    const stub = createStubGithubTransport({
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname.includes('/compare/')) {
          expect(url.pathname).toBe(`/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/compare/${BASE_SHA}...${HEAD_SHA}`);
          return jsonResponse({ base_commit: { sha: BASE_SHA }, merge_base_commit: { sha: mergeBaseOid } });
        }
        if (url.pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 101 });
        if (!url.pathname.endsWith('/files')) return undefined;
        const paths = url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, index) => `first-${index}.ts`) : ['second.ts'];
        return jsonResponse(paths.map((filename) => ({ ...githubChangedFile({ filename }), additions: 1, deletions: 1, changes: 2, patch })),
          url.searchParams.get('page') === '1' ? { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) } : {});
      },
    });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 100 }), stub.context));
    expect(first.kind).toBe('changedFiles');
    if (first.kind !== 'changedFiles') return;
    expect(first.rows[0]).toMatchObject({ evidence: { state: 'available', patch } });
    expect(first.rows).toHaveLength(100);
    expect(first.comparison).toMatchObject({ beforeOid: mergeBaseOid, baseOid: '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e', headOid: HEAD_SHA, freshness: 'current', inventory: 'incomplete', content: 'complete', totalFileCount: 101 });
    expect(first.comparison).toMatchObject({ locator: { providerId: 'github', repository: REPOSITORY_KEY, number: 1284 } });
    const second = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 100, continuation: first.continuation }), stub.context));
    expect(second.kind).toBe('changedFiles');
    if (second.kind !== 'changedFiles') return;
    expect(second.rows[0]?.path).toBe('second.ts');
    expect(second.comparison).toMatchObject({ beforeOid: mergeBaseOid, inventory: 'complete', content: 'complete', enumeratedFileCount: 101 });
    expect(second.comparison).toMatchObject({ locator: { providerId: 'github', repository: REPOSITORY_KEY, number: 1284 } });
    expect(second.continuation).toBeUndefined();
    expect(stub.materializations.every((read) => read.account.accountId === CONFIGURED_ACCOUNT.accountId)).toBe(true);
  });

  it('keeps usable evidence when the metadata reread fails and refuses exact completeness', async () => {
    let metadataReads = 0;
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) {
        return ++metadataReads === 1 ? jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 }) : { status: 429, headers: { 'retry-after': '60' }, body: { message: 'rate limited' } };
      }
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'retained.ts' })]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.rows[0]?.path).toBe('retained.ts');
    expect(result.comparison).toMatchObject({ freshness: 'unverified', inventory: 'incomplete', failure: { class: 'rateLimit' } });
  });

  it.each(['base', 'head'] as const)('marks page evidence stale if the %s endpoint changes during its read', async (endpoint) => {
    let reads = 0;
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE,
        changed_files: 1, [endpoint]: { sha: ++reads === 1 ? (endpoint === 'head' ? HEAD_SHA : '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e') : 'a'.repeat(40), repo: GITHUB_REPOSITORY_RESPONSE },
      });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'mixed.ts' })]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.comparison).toMatchObject({ headOid: HEAD_SHA, freshness: 'stale', inventory: 'incomplete', reasons: expect.arrayContaining(['source_changed']) });
    expect(result.continuation).toBeUndefined();
  });

  it('keeps evidence incomplete when a provider continuation points outside its source route', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2 });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'retained.ts' })], { link: '<https://other.example/steal?page=2>; rel="next"' }) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result).toMatchObject({ kind: 'changedFiles', incomplete: 'pagination', comparison: { inventory: 'incomplete', reasons: expect.arrayContaining(['pagination']) } });
    expect(stub.requests.some((request) => request.url.startsWith('https://other.example'))).toBe(false);
  });

  it('retains missing and truncated patch facts without normalizing exact paths or patch bytes', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 3 });
      return request.url.includes('/files') ? jsonResponse([
        githubChangedFile({ filename: 'bin.dat', withPatch: false }),
        { ...githubChangedFile({ filename: 'two  spaces.ts' }), additions: 2, deletions: 1, changes: 3, patch: '@@ -1 +1,2 @@\n-old\n+first' },
        { ...githubChangedFile({ filename: ' ' }), additions: 0, deletions: 0, changes: 0, patch: '' },
      ]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.rows[0]?.evidence).toEqual({ state: 'unavailable', reason: 'provider_patch_missing' });
    expect(result.rows[1]).toMatchObject({ path: 'two  spaces.ts', evidence: { state: 'truncated', patch: '@@ -1 +1,2 @@\n-old\n+first', reason: 'provider_patch_truncated' } });
    expect(result.rows[2]).toMatchObject({ path: ' ', evidence: { state: 'available', patch: '' } });
    expect(result.comparison).toMatchObject({ inventory: 'complete', content: 'incomplete' });
  });

  it('keeps file inventory and states the real Action envelope limit for an oversized patch', async () => {
    const patch = '@@ -0,0 +1 @@\n+' + 'x'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES);
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 });
      return request.url.includes('/files') ? jsonResponse([{ ...githubChangedFile({ filename: 'large.txt' }), additions: 1, deletions: 0, changes: 1, patch }]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(result.kind).toBe('changedFiles');
    if (result.kind !== 'changedFiles') return;
    expect(result.rows[0]).toMatchObject({ path: 'large.txt', evidence: { state: 'unavailable', reason: 'transport_limit' } });
    expect(result.comparison).toMatchObject({ inventory: 'complete', content: 'incomplete', reasons: expect.arrayContaining(['transport_limit']) });
  });

  it.each(['base', 'head'] as const)('refuses a mixed comparison when the %s tip moves before the next page', async (endpoint) => {
    let headOid = HEAD_SHA;
    let baseOid = BASE_SHA;
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2,
        base: { sha: baseOid, repo: GITHUB_REPOSITORY_RESPONSE }, head: { sha: headOid } });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'prefix.ts' })], { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) }) : undefined;
    } });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1 }), stub.context));
    if (first.kind !== 'changedFiles') throw new Error('Expected the source prefix');
    if (endpoint === 'head') headOid = 'b'.repeat(40);
    else baseOid = 'b'.repeat(40);
    const second = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1, continuation: first.continuation }), stub.context));
    expect(second).toMatchObject({ kind: 'changedFiles', rows: [], comparison: { headOid: HEAD_SHA, freshness: 'stale', inventory: 'incomplete' } });
    expect(stub.requests.filter((request) => request.url.includes('/files'))).toHaveLength(1);
  });

  it.each(['missing', 'wrong-base', 'forbidden'] as const)('refuses exact comparison evidence when the merge-base attestation is %s', async (mode) => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.includes('/compare/')) return mode === 'forbidden'
        ? { status: 403, body: { message: 'Resource not accessible by integration' } }
        : jsonResponse({ base_commit: { sha: mode === 'wrong-base' ? 'a'.repeat(40) : BASE_SHA },
          ...(mode === 'missing' ? {} : { merge_base_commit: { sha: 'c'.repeat(40) } }) });
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 1 });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'file.ts' })]) : undefined;
    } });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true }), stub.context));
    expect(result).toMatchObject({ kind: 'unavailable', failure: { class: mode === 'forbidden' ? 'permission' : 'unsupportedContract' } });
  });

  it('returns a typed failed-page comparison without erasing a previously delivered prefix', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2 });
      if (!url.pathname.endsWith('/files')) return undefined;
      return url.searchParams.get('page') === '1'
        ? jsonResponse([githubChangedFile({ filename: 'prefix.ts' })], { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) })
        : { status: 401, body: { message: 'Bad credentials' } };
    } });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1 }), stub.context));
    if (first.kind !== 'changedFiles') throw new Error('Expected the source prefix');
    const second = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1, continuation: first.continuation }), stub.context));
    expect(second).toMatchObject({ kind: 'changedFiles', rows: [], comparison: { enumeratedFileCount: 1, inventory: 'incomplete', failure: { class: 'authentication' } } });
    expect(first.rows[0]?.path).toBe('prefix.ts');
  });

  it('rejects display-only or foreign-account continuations in comparison mode', async () => {
    const stub = createStubGithubTransport({ respond: (request) => {
      if (new URL(request.url).pathname.endsWith('/pulls/1284')) return jsonResponse({ ...GITHUB_PULL_REQUEST_RESPONSE, changed_files: 2 });
      return request.url.includes('/files') ? jsonResponse([githubChangedFile({ filename: 'prefix.ts' })], { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 2 }) }) : undefined;
    } });
    const first = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(planeInput({ comparison: true, limit: 1 }), stub.context));
    if (first.kind !== 'changedFiles') throw new Error('Expected the source prefix');
    const original = configuredInstance();
    const foreign = { ...original, binding: { ...original.binding, account: { ...CONFIGURED_ACCOUNT, accountId: 'other-account' } } };
    for (const input of [
      planeInput({ comparison: true, limit: 1, continuation: encodeGithubDetailContinuation({ v: 1, page: 2, perPage: 1 }) }),
      planeInput({ comparison: true, limit: 1, continuation: first.continuation, instance: foreign }),
    ]) expect(await listGithubChangedFiles(input, stub.context)).toMatchObject({ kind: 'unavailable', failure: { code: 'github_detail_continuation_unreadable' } });
    expect(stub.requests.filter((request) => request.url.includes('/files'))).toHaveLength(1);
  });

  it('renders a complete walk as complete', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse([
          githubChangedFile({ filename: 'src/pump.ts' }),
          githubChangedFile({ filename: 'src/huge.bin', withPatch: false }),
        ])
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({ limit: 100 }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the page must settle as changedFiles');
    expect(result.rows.map((row) => row.path)).toEqual(['src/pump.ts', 'src/huge.bin']);
    expect(result.rows.map((row) => row.diffAvailable)).toEqual([true, false]);
    expect(result.incomplete).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });

  it('stops at the documented 3,000-file ceiling and says so', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse(
          [githubChangedFile({ filename: 'src/last.ts' })],
          // GitHub keeps advertising a next page it will never actually serve.
          { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: 31 }) },
        )
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({
        limit: 100,
        continuation: encodeGithubDetailContinuation({ v: 1, page: 30, perPage: 100 }),
      }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the ceiling page must keep its rows');
    expect(result.rows).toHaveLength(1);
    // Known-incomplete is a rendered state, never a silent cap.
    expect(result.incomplete).toBe('ceiling');
    expect(result.continuation).toBeUndefined();
  });

  it('reports the ceiling on a terminal 3,000th-file page that advertises no next link', async () => {
    // GitHub documents the 3,000-file maximum but promises no `Link` past it, so the
    // exhausted-pagination shape is exactly what a capped walk looks like. Deriving the
    // boundary from the next link alone renders a capped list as a complete one.
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse(Array.from(
          { length: 100 },
          (_unused, index) => githubChangedFile({ filename: `src/file-${index}.ts` }),
        ))
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({
        limit: 100,
        continuation: encodeGithubDetailContinuation({ v: 1, page: 30, perPage: 100 }),
      }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the ceiling page must keep its rows');
    expect(result.rows).toHaveLength(100);
    expect(result.incomplete).toBe('ceiling');
    expect(result.continuation).toBeUndefined();
  });

  it('renders a final page that stops one file below the ceiling as complete', async () => {
    // The neighbouring case: 2,999 files is a walk GitHub finished, not one it capped,
    // and claiming a ceiling there would invent an incompleteness the user cannot resolve.
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/pulls/1284/files')
        ? jsonResponse(Array.from(
          { length: 99 },
          (_unused, index) => githubChangedFile({ filename: `src/file-${index}.ts` }),
        ))
        : undefined),
    });

    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({
        limit: 100,
        continuation: encodeGithubDetailContinuation({ v: 1, page: 30, perPage: 100 }),
      }),
      stub.context,
    ));
    if (result.kind !== 'changedFiles') throw new Error('the short page must keep its rows');
    expect(result.rows).toHaveLength(99);
    expect(result.incomplete).toBeUndefined();
    expect(result.continuation).toBeUndefined();
  });

  it('refuses to answer for an issue rather than returning an empty file list', async () => {
    const stub = createStubGithubTransport({ respond: () => undefined });
    const result = GithubChangedFilesResultV1Schema.parse(await listGithubChangedFiles(
      planeInput({ localRef: ISSUE_REF, limit: 100 }),
      stub.context,
    ));
    // An empty list would claim "this pull request changes nothing".
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_detail_kind_unsupported' },
    });
    expect(stub.requests).toEqual([]);
  });
});

/* --------------------------------------------------------------------- feedback */

describe('GitHub feedback plane', () => {
  it('routes the newest pull-request conversation through the one GraphQL feedback fetcher', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Record<string, unknown>;
        };
        expect(body.query).toContain('GithubFeedbackComments');
        expect(body.variables).toMatchObject({
          owner: 'octo-org',
          name: 'example-app',
          number: 1284,
          commentCount: 24,
          commentCursor: null,
        });
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              pullRequest: {
                comments: {
                  nodes: [
                    { id: 'IC_2', author: { login: 'later' }, body: 'later', createdAt: '2026-08-12T12:00:00Z', url: 'https://github.com/o/r/pull/1#issuecomment-2' },
                    { id: 'IC_1', author: { login: 'earlier' }, body: 'earlier', createdAt: '2026-08-11T12:00:00Z', url: 'https://github.com/o/r/pull/1#issuecomment-1' },
                  ],
                  pageInfo: { hasPreviousPage: true, startCursor: 'comments-before' },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));

    expect(result).toMatchObject({
      kind: 'comments',
      previousCursor: 'comments-before',
      rows: [{ id: 'IC_1' }, { id: 'IC_2' }],
    });
  });

  it('states when a provider cursor cannot cross the canonical Action envelope', async () => {
    const providerCursor = 'c'.repeat(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES + 1);
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              pullRequest: {
                comments: {
                  nodes: [{ id: 'IC_1', body: 'kept', createdAt: '2026-08-11T12:00:00Z' }],
                  pageInfo: { hasPreviousPage: true, startCursor: providerCursor },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));
    expect(result).toMatchObject({
      kind: 'comments',
      rows: [{ id: 'IC_1', body: 'kept' }],
      omittedRowCount: 0,
      projectionTruncated: false,
      incomplete: 'continuationUnavailable',
    });
    expect(result).not.toHaveProperty('previousCursor');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
  });

  it('reports provider document rows omitted by the canonical Action envelope', async () => {
    const body = 'x'.repeat(
      Math.floor(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2) + 2_048,
    );
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              pullRequest: {
                comments: {
                  nodes: [
                    { id: 'IC_1', body, createdAt: '2026-08-11T12:00:00Z' },
                    { id: 'IC_2', body, createdAt: '2026-08-12T12:00:00Z' },
                  ],
                  pageInfo: { hasPreviousPage: false, startCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));
    expect(result).toMatchObject({
      kind: 'comments',
      omittedRowCount: 1,
      projectionTruncated: true,
    });
    if (result.kind !== 'comments') throw new Error('the feedback read must settle as comments');
    expect(result.rows).toHaveLength(1);
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
  });

  it('routes an issue Comments window through that same GraphQL feedback fetcher', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === '/repos/octo-org/example-app') {
          return jsonResponse({ id: 4210, full_name: 'octo-org/example-app' });
        }
        if (pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Record<string, unknown>;
        };
        expect(body.query).toContain('issue(number: $number)');
        expect(body.query).not.toContain('pullRequest(number: $number)');
        expect(body.variables).toMatchObject({
          owner: 'octo-org',
          name: 'example-app',
          number: 1284,
          commentCount: 40,
          commentCursor: null,
        });
        return jsonResponse({
          data: {
            repository: {
              databaseId: 4210,
              issue: {
                comments: {
                  nodes: [{
                    id: 'IC_3',
                    author: { login: 'latest' },
                    body: 'latest issue reply',
                    createdAt: '2026-08-13T12:00:00Z',
                    url: 'https://github.com/o/r/issues/1284#issuecomment-3',
                  }],
                  pageInfo: { hasPreviousPage: true, startCursor: 'issue-comments-before' },
                },
              },
            },
          },
        });
      },
    });

    const result = GithubFeedbackResultV1Schema.parse(await readGithubFeedback({
      v: 1,
      instance: configuredInstance(),
      localRef: ISSUE_REF,
      routingToken: REPOSITORY_KEY,
      connection: 'comments',
    }, stub.context));

    expect(result).toMatchObject({
      kind: 'comments',
      previousCursor: 'issue-comments-before',
      rows: [{ id: 'IC_3', body: 'latest issue reply' }],
    });
  });
});

/* ----------------------------------------------------------------------- checks */

function checksTransport(input: Readonly<{
  checkRuns?: StubHttpResponse;
  status?: StubHttpResponse;
  pullRequest?: StubHttpResponse;
}>) {
  return createStubGithubTransport({
    respond: (request): StubHttpResponse | undefined => {
      if (request.url.endsWith('/pulls/1284')) {
        return input.pullRequest ?? jsonResponse(GITHUB_PULL_REQUEST_RESPONSE);
      }
      if (request.url.includes('/check-runs')) {
        return input.checkRuns ?? jsonResponse(githubCheckRunsResponse({ runs: [] }));
      }
      if (request.url.includes(`/commits/${HEAD_SHA}/status`)) {
        return input.status
          ?? jsonResponse(githubCombinedStatusResponse({ state: 'success', statuses: [] }));
      }
      return undefined;
    },
  });
}

function checksInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    ...overrides,
  };
}

describe('GitHub checks plane', () => {
  it('reads both collections at the pull request current head revision', async () => {
    const stub = checksTransport({
      checkRuns: jsonResponse(githubCheckRunsResponse({
        runs: [
          githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure' }),
          githubCheckRun({ id: 9002, name: 'build', status: 'in_progress' }),
        ],
      })),
      status: jsonResponse(githubCombinedStatusResponse({
        state: 'success',
        statuses: [githubCommitStatus({ id: 7701, context: 'legacy/ci', state: 'success' })],
      })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    if (result.kind !== 'checks') throw new Error('the checks read must settle as checks');
    // Reading against a remembered revision would answer for a commit the pull
    // request has already moved past.
    expect(result.headRevision).toBe(HEAD_SHA);
    expect(stub.requests.filter((request) => request.url.includes(HEAD_SHA))).toHaveLength(2);
    // Matrix legs share a name and a details URL; the native id keeps them apart.
    expect(result.rows.map((row) => row.key)).toEqual([
      'github-check-run:9001',
      'github-check-run:9002',
      'github-commit-status:7701',
    ]);
    expect(result.state).toBe('resolved');
    expect(result.failingCount).toBe(1);
    expect(result.runningCount).toBe(1);
    expect(result.passingCount).toBe(1);
  });

  it('fits unbounded provider diagnostics through the canonical Action result envelope', async () => {
    const diagnostic = 'x'.repeat(
      Math.floor(EXTERNAL_ACTION_RESPONSE_MAX_SERIALIZED_BYTES / 2) + 2_048,
    );
    const runs = [9001, 9002].map((id) => githubCheckRun({
      id,
      name: `job-${id}`,
      status: 'completed',
      conclusion: 'failure',
      output: { text: diagnostic },
    }));
    const stub = checksTransport({
      checkRuns: jsonResponse(githubCheckRunsResponse({ runs })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    if (result.kind !== 'checks') throw new Error('the checks read must settle as checks');
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.omittedRowCount).toBe(1);
    expect(result.projectionTruncated).toBe(true);
  });

  it('keeps the rows that answered when one of the two reads fails', async () => {
    const stub = checksTransport({
      checkRuns: { status: 500, headers: {}, body: { message: 'server error' } },
      status: jsonResponse(githubCombinedStatusResponse({
        state: 'success',
        statuses: [githubCommitStatus({ id: 7701, context: 'legacy/ci', state: 'success' })],
      })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    if (result.kind !== 'checks') throw new Error('a partial checks read still settles');
    expect(result.rows.map((row) => row.key)).toEqual(['github-commit-status:7701']);
    expect(result.state).toBe('unknown');
    expect(result.checkRunsFailure).toEqual({ class: 'transient', code: 'github_server_error' });
    expect(result.commitStatusFailure).toBeUndefined();
    // A rendered `0 failing` on a suite nobody could read is a fabricated fact.
    expect(result.failingCount).toBeUndefined();
    expect(result.passingCount).toBeUndefined();
  });

  it('distinguishes a suite with nothing configured from one it could not read', async () => {
    const none = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), checksTransport({}).context),
    );
    if (none.kind !== 'checks') throw new Error('an empty suite still settles');
    expect(none.state).toBe('none');
    expect(none.rows).toEqual([]);
    expect(none.failingCount).toBeUndefined();

    const unreadable = GithubChecksResultV1Schema.parse(await readGithubChecks(
      checksInput(),
      checksTransport({
        checkRuns: { status: 500, headers: {}, body: { message: 'server error' } },
        status: { status: 500, headers: {}, body: { message: 'server error' } },
      }).context,
    ));
    if (unreadable.kind !== 'checks') throw new Error('an unreadable suite still settles');
    expect(unreadable.state).toBe('unknown');
  });

  it('states that it has no commit to ask about rather than reporting no checks', async () => {
    const stub = checksTransport({
      pullRequest: jsonResponse(Object.freeze({
        ...GITHUB_PULL_REQUEST_RESPONSE,
        head: Object.freeze({ label: 'octo-org:frame-pump', ref: 'frame-pump' }),
      })),
    });

    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_head_revision_unreadable' },
    });
    // The two check reads are never issued against a revision this source
    // could not establish.
    expect(stub.requests.filter((request) => request.url.includes('/pulls/1284'))).toHaveLength(1);
  });

  it('refuses a pull-request body that answers for another entry', async () => {
    const stub = checksTransport({
      pullRequest: jsonResponse(Object.freeze({ ...GITHUB_PULL_REQUEST_RESPONSE, number: 99 })),
    });
    const result = GithubChecksResultV1Schema.parse(
      await readGithubChecks(checksInput(), stub.context),
    );
    expect(result).toEqual({
      kind: 'unavailable',
      failure: { class: 'unsupportedContract', code: 'github_detail_response_invalid' },
    });
  });
});

describe('GitHub pull-request status operation', () => {
  function statusInput(localRef: Readonly<{ kindId: string; collisionScope: string; entryId: string }> = PULL_REQUEST_REF) {
    return {
      v: 1, instance: configuredInstance(), localRef,
      lastKnownLocator: { v: 1, routingToken: REPOSITORY_KEY, displayPath: '#1284' },
    };
  }

  function statusTransport(checkRuns?: StubHttpResponse) {
    return createStubGithubTransport({ respond: (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/pulls/1284')) return jsonResponse({
        ...GITHUB_PULL_REQUEST_RESPONSE, mergeable: true, mergeable_state: 'blocked',
        additions: 18, deletions: 3,
      });
      if (path.includes('/check-runs')) return checkRuns ?? jsonResponse(githubCheckRunsResponse({ runs: [
        githubCheckRun({ id: 9001, name: 'build', status: 'completed', conclusion: 'failure' }),
        githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
      ] }));
      if (path.endsWith('/status')) return jsonResponse(githubCombinedStatusResponse({
        state: 'success', statuses: [githubCommitStatus({ id: 7701, context: 'legacy/ci', state: 'success' })],
      }));
      if (path !== '/graphql') return undefined;
      const body = readRecordedJsonBody(request) as { query: string };
      return jsonResponse({ data: { repository: { databaseId: 4210, pullRequest: body.query.includes('GithubFeedbackReviews')
        ? { reviewDecision: 'CHANGES_REQUESTED', reviews: {
          nodes: [
            { id: 'PRR_1', state: 'APPROVED', body: '', author: { login: 'alice' }, submittedAt: '2026-08-11T12:00:00Z' },
            { id: 'PRR_2', state: 'CHANGES_REQUESTED', body: '', author: { login: 'alice' }, submittedAt: '2026-08-12T12:00:00Z' },
            { id: 'PRR_3', state: 'COMMENTED', body: '', author: { login: 'alice' }, submittedAt: null },
          ], pageInfo: { hasPreviousPage: true, startCursor: 'older-reviews' },
        } }
        : { reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'bob' } }],
          pageInfo: { hasNextPage: false, endCursor: null } } },
      } } });
    } });
  }

  it('reads detail status at the current head and fills the canonical review/check facts', async () => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: 'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1 + 1), status: 'completed', conclusion: 'failure' }),
      githubCheckRun({ id: 9002, name: 'test', status: 'in_progress' }),
    ] })));
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({
      kind: 'status',
      projectionTruncated: true,
      checks: { state: 'complete', passed: 1, failed: 1, pending: 1, total: 3, incomplete: false,
        rows: [{ id: 'github-check-run:9001', name: 'x'.repeat(MAX_TRIAGE_TEXT_UTF8_BYTES_V1), state: 'failed' }, { id: 'github-check-run:9002', state: 'pending' },
          { id: 'github-commit-status:7701', state: 'passed' }] },
      review: { decision: 'changesRequested', reviewers: [{ name: 'alice', verb: 'changesRequested' },
        { name: 'bob', verb: 'pending' }], incomplete: true },
      merge: { state: 'blocked', blocker: 'blocked' },
      branch: { head: 'frame-pump', base: 'main', additions: 18, deletions: 3 },
      facts: [
        { id: 'github/review-decision', value: { kind: 'status', value: 'Changes requested', tone: 'danger' } },
        { id: 'github/checks', value: { kind: 'status', value: '1 failing', tone: 'danger' } },
      ],
    });
    expect(isExternalActionResultWithinResponseEnvelopeLimitV1(result)).toBe(true);
    expect(stub.requests.filter((request) => new URL(request.url).pathname.endsWith('/pulls/1284'))).toHaveLength(1);
    expect(stub.requests.filter((request) => request.url.includes(HEAD_SHA))).toHaveLength(2);
  });

  it('preserves successful rows while keeping an unreadable check breakdown unknown', async () => {
    const stub = statusTransport({ status: 500, headers: {}, body: { message: 'failed' } });
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', checks: {
      state: 'unknown', passed: null, failed: null, pending: null, total: null, incomplete: true,
      rows: [{ id: 'github-commit-status:7701', state: 'passed' }],
    } });
    if (result.kind !== 'status') throw new Error('partial status must keep the observed detail');
    expect(result.facts.some((fact) => fact.id === 'github/checks')).toBe(false);
  });

  it('reports omitted normalized-empty names without discarding the known provider counts', async () => {
    const stub = statusTransport(jsonResponse(githubCheckRunsResponse({ runs: [
      githubCheckRun({ id: 9001, name: '\u0000', status: 'completed', conclusion: 'failure' }),
    ] })));
    const result = await readGithubPullRequestStatus(statusInput(), stub.context);
    expect(result).toMatchObject({ kind: 'status', projectionTruncated: true, checks: {
      state: 'complete', passed: 1, failed: 1, pending: 0, total: 2, incomplete: true,
      rows: [{ id: 'github-commit-status:7701', state: 'passed' }],
    } });
  });

  it('refuses an issue before making provider requests', async () => {
    const stub = statusTransport();
    expect(await readGithubPullRequestStatus(statusInput(ISSUE_REF), stub.context)).toEqual({
      kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'github_detail_kind_unsupported' },
    });
    expect(stub.requests).toEqual([]);
  });

  it('propagates cancellation while a provider detail connection is pending', async () => {
    const caller = new AbortController();
    const stub = createStubGithubTransport({
      signal: caller.signal,
      respond: (request) => new URL(request.url).pathname.endsWith('/pulls/1284')
        ? new Promise<StubHttpResponse>(() => {}) : undefined,
    });
    const pending = readGithubPullRequestStatus(statusInput(), stub.context);
    caller.abort(new DOMException('The host invocation reached its deadline.', 'TimeoutError'));
    await expect(pending).resolves.toEqual({
      kind: 'unavailable', failure: { class: 'transient', code: 'github_request_timed_out' },
    });
  });
});
