import { describe, expect, it, vi } from 'vitest';

import type { ConnectedAccountsService } from '@happier-dev/plugin-sdk/connected-accounts';
import type { HttpService } from '@happier-dev/plugin-sdk/http';

import pageOne from './fixtures/pullRequestsPageOne.json' with { type: 'json' };
import pageTwo from './fixtures/pullRequestsPageTwo.json' with { type: 'json' };
import pullRequestSelf from './fixtures/pullRequestSelf.json' with { type: 'json' };
import workspacesPage from './fixtures/userWorkspacesPage.json' with { type: 'json' };
import errorNotFound from './fixtures/errorNotFound.json' with { type: 'json' };
import {
  BITBUCKET_CLOUD_API_ORIGIN,
  createBitbucketTriageApiClient,
} from './apiClient.js';
import { createAuthorizedBitbucketClient } from './source/authorization.js';
import { resolveBitbucketPageGeometry } from './pagination.js';
import { createBitbucketRepositoryEnumerator } from './repositoryFrontier.js';
import {
  buildBitbucketAuthoredLaneUrl,
  buildBitbucketPullRequestUrl,
  buildBitbucketRepositoryReviewLaneUrl,
  buildBitbucketUserWorkspacesUrl,
  buildBitbucketWorkspaceRepositoriesUrl,
  getBitbucketPullRequest,
  listBitbucketWorkspaces,
  readBitbucketLaneAvailability,
  scanBitbucketPullRequests,
  withBitbucketPageLength,
} from './pullRequests.js';

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const ACCOUNT_UUID = '{9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19}';
const AUTHORIZATION = { Authorization: 'Basic <redacted-test-value>' } as const;
/**
 * Above the pull-request collection's 50-row page maximum, so one invocation genuinely walks more
 * than one page and the budget rule is exercised rather than trivially satisfied.
 */
const SCAN_LIMIT = 250;

type RecordedRequest = Readonly<{ url: string; headers: Readonly<Record<string, string>> }>;
type Reply = Readonly<{ status?: number; body?: unknown; headers?: Readonly<Record<string, string>> }>;

function encodeBody(body: unknown): Uint8Array {
  return new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
}

/** The empty workspace listing an authored-lane case answers its repository enumeration with. */
const EMPTY_REPOSITORY_LISTING: Reply = { body: { pagelen: 100, page: 1, values: [] } };

function isRepositoryListingUrl(url: string): boolean {
  return url.includes('/2.0/repositories/') && !url.includes('/pullrequests');
}

function createHttpStub(replies: readonly Reply[]): {
  http: HttpService;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const http = {
    async request(input: Parameters<HttpService['request']>[0]) {
      requests.push({ url: input.url, headers: { ...input.headers } });
      // The repository enumeration runs for real in these cases; only the lane pages are queued,
      // so the listing is answered out of band rather than consuming a queued reply.
      const reply = isRepositoryListingUrl(input.url)
        ? EMPTY_REPOSITORY_LISTING
        : replies[index++] ?? { status: 500 };
      return {
        status: reply.status ?? 200,
        finalUrl: input.url,
        headers: reply.headers ?? {},
        body: encodeBody(reply.body),
      };
    },
    openWebSocket() {
      throw new Error('not used');
    },
  } as unknown as HttpService;
  return { http, requests };
}

function createClient(replies: readonly Reply[], overrides?: Readonly<{ nowMs?: number }>) {
  const { http, requests } = createHttpStub(replies);
  const authorize = vi.fn(async () => AUTHORIZATION);
  const client = createBitbucketTriageApiClient({
    http,
    authorize,
    now: () => overrides?.nowMs ?? 1_000,
  });
  return { client, requests, authorize };
}

describe('Bitbucket triage request construction', () => {
  it('percent-encodes braced identifiers into every route it builds', () => {
    expect(buildBitbucketAuthoredLaneUrl({
      workspaceUuid: WORKSPACE_UUID,
      accountUuid: ACCOUNT_UUID,
    })).toBe(
      `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/workspaces/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D`
      + '/pullrequests/%7B9f1c2a44-5d0e-4c8b-8b0a-1d7e6f3a2c19%7D?state=OPEN',
    );

    const review = new URL(buildBitbucketRepositoryReviewLaneUrl({
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
    }));
    expect(review.pathname).toBe(
      '/2.0/repositories/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D'
      + '/%7B1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9%7D/pullrequests',
    );
    // Both review lanes ride this one walk, and neither is expressible as a server-side filter:
    // Bitbucket answers every `participants.*` predicate with `400 … does not support filtering`,
    // and the `reviewers.uuid` filter that *is* accepted would drop an approval left by someone
    // who was never a requested reviewer — the exact population `reviewed` is defined by. So the
    // walk is unfiltered and the projection restores the two lists the collection omits by default.
    expect(review.searchParams.get('q')).toBeNull();
    expect(review.searchParams.get('state')).toBe('OPEN');
    expect(review.searchParams.get('fields')).toBe('+values.reviewers,+values.participants');
    expect(review.toString()).not.toContain(ACCOUNT_UUID);

    expect(buildBitbucketPullRequestUrl({
      workspaceUuid: WORKSPACE_UUID,
      repositoryUuid: REPOSITORY_UUID,
      entryId: '42',
    })).toBe(
      `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/repositories/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D`
      + '/%7B1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9%7D/pullrequests/42',
    );

    expect(buildBitbucketUserWorkspacesUrl())
      .toBe(`${BITBUCKET_CLOUD_API_ORIGIN}/2.0/user/workspaces`);

    expect(buildBitbucketWorkspaceRepositoriesUrl({ workspaceUuid: WORKSPACE_UUID }))
      .toBe(
        `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/repositories`
        + '/%7B4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44%7D',
      );
  });

  it('keeps page length owned by the invocation rather than by the route builders', () => {
    const laneUrl = buildBitbucketAuthoredLaneUrl({
      workspaceUuid: WORKSPACE_UUID,
      accountUuid: ACCOUNT_UUID,
    });

    expect(laneUrl).not.toContain('pagelen');
    expect(withBitbucketPageLength(laneUrl, 50)).toBe(`${laneUrl}&pagelen=50`);
    expect(withBitbucketPageLength(`${BITBUCKET_CLOUD_API_ORIGIN}/2.0/user/workspaces`, 100))
      .toBe(`${BITBUCKET_CLOUD_API_ORIGIN}/2.0/user/workspaces?pagelen=100`);
    expect(withBitbucketPageLength(`${laneUrl}&pagelen=10`, 50)).toBe(`${laneUrl}&pagelen=50`);
  });

  it('sends no change-watermark qualifier on any lane', () => {
    const urls = [
      buildBitbucketAuthoredLaneUrl({ workspaceUuid: WORKSPACE_UUID, accountUuid: ACCOUNT_UUID }),
      buildBitbucketRepositoryReviewLaneUrl({
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid: REPOSITORY_UUID,
      }),
    ];

    for (const url of urls) expect(url).not.toMatch(/updated_on|since|updatedSince/i);
  });

  it('declares the two lanes Bitbucket Cloud cannot serve instead of returning them empty', () => {
    expect(readBitbucketLaneAvailability('authored')).toEqual({ kind: 'available' });
    expect(readBitbucketLaneAvailability('review-requested')).toEqual({ kind: 'available' });
    // The pull-request collection carries `participants` — with `approved`, `state` and the
    // participant's own uuid — once the `fields` projection asks for it, so the evidence this lane
    // is defined by is obtainable and the lane is served rather than declared unserveable.
    expect(readBitbucketLaneAvailability('reviewed')).toEqual({ kind: 'available' });
    expect(readBitbucketLaneAvailability('assigned'))
      .toEqual({ kind: 'unavailable', reason: 'bitbucket-assignee-lane-unavailable' });
    expect(readBitbucketLaneAvailability('mentioned'))
      .toEqual({ kind: 'unavailable', reason: 'bitbucket-mentioned-lane-unavailable' });
  });
});

describe('Bitbucket triage API client', () => {
  it('materializes exactly the listed account once per invocation, for the exact API origin', async () => {
    const { http, requests } = createHttpStub([{ body: pageOne }, { body: pageTwo }]);
    const materializeListedAccount = vi.fn(async () => (
      { kind: 'httpHeaders' as const, headers: AUTHORIZATION }
    ));
    // Structural stub for the generic Connected Accounts boundary. There is exactly one
    // authorization path in this package and it is the exact-listed-account one: the selected
    // binding is a user preference, not this invocation's authority, so `materialize` is not a
    // second way in.
    const connectedAccounts = { materializeListedAccount, watch: vi.fn() };
    const account = { service: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-account' }, accountId: 'account-1' };
    const authorized = await createAuthorizedBitbucketClient(
      {
        connectedAccounts: connectedAccounts as unknown as ConnectedAccountsService,
        http,
        now: () => 1_000,
      },
      { purpose: 'bitbucket-triage', account: account as never },
    );

    expect(authorized.ok).toBe(true);
    if (!authorized.ok) return;
    await authorized.client.requestJson({ url: `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/a` });
    await authorized.client.requestJson({ url: `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/b` });

    expect(materializeListedAccount).toHaveBeenCalledTimes(1);
    expect(materializeListedAccount).toHaveBeenCalledWith(
      {
        purpose: 'bitbucket-triage',
        account,
        materialization: {
          kind: 'httpHeaders',
          origin: BITBUCKET_CLOUD_API_ORIGIN,
          headerNames: ['authorization'],
        },
      },
      expect.anything(),
    );
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.headers.Authorization).toBe(AUTHORIZATION.Authorization);
  });

  it('refuses to send a request to any origin other than the Bitbucket API origin', async () => {
    const { client, requests } = createClient([{ body: pageOne }]);

    const result = await client.requestJson({ url: 'https://api.bitbucket.org.example.com/2.0/a' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('untrusted-request-origin');
    expect(requests).toHaveLength(0);
  });

  it('classifies a non-JSON success body as an unsupported contract rather than crashing', async () => {
    const { http } = createHttpStub([]);
    const brokenHttp = {
      async request() {
        return {
          status: 200,
          finalUrl: `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/a`,
          headers: {},
          body: new TextEncoder().encode('<html>not json</html>'),
        };
      },
      openWebSocket: (http as unknown as HttpService).openWebSocket,
    } as unknown as HttpService;
    const client = createBitbucketTriageApiClient({
      http: brokenHttp,
      authorize: async () => AUTHORIZATION,
      now: () => 1_000,
    });

    const result = await client.requestJson({ url: `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/a` });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ class: 'unsupportedContract', code: 'malformed-json' });
  });
});

describe('Bitbucket bounded pull-request scan', () => {
  const AUTHORED_SEED_URL = `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/authored`;

  /** Page geometry is fixed once per walk, so every case resolves it the way a scan page does. */
  function geometryFor(scanLimit: number) {
    const resolved = resolveBitbucketPageGeometry(scanLimit);
    if (!resolved.ok) throw new Error('test geometry must resolve');
    return resolved.geometry;
  }

  /**
   * One authored-lane walk over an empty workspace. Everything below the HTTP boundary — request
   * construction, rotation, budget accounting, decoding, and the sticky health set — runs for real,
   * including the repository enumeration.
   */
  function walkAuthored(
    client: Parameters<typeof scanBitbucketPullRequests>[0]['client'],
    scanLimit: number,
    overrides: Partial<Parameters<typeof scanBitbucketPullRequests>[0]> = {},
  ) {
    return scanBitbucketPullRequests({
      client,
      geometry: geometryFor(scanLimit),
      authoredSeedUrl: AUTHORED_SEED_URL,
      authored: { nextUrl: null, ended: false },
      currentRepository: null,
      nextLaneIndex: 0,
      buildRepositoryLaneUrl: (repositoryUuid) => buildBitbucketRepositoryReviewLaneUrl({
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid,
      }),
      repositories: createBitbucketRepositoryEnumerator({
        client,
        workspaceUuid: WORKSPACE_UUID,
        resumeUrl: null,
        enteredRepositoryUuid: null,
        initial: true,
        ...(overrides.signal === undefined ? {} : { signal: overrides.signal }),
      }),
      ...overrides,
    });
  }

  it('follows the opaque next link verbatim and never rebuilds a page query', async () => {
    const { client, requests } = createClient([{ body: pageOne }, { body: pageTwo }]);

    const outcome = await walkAuthored(client, SCAN_LIMIT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(requests.map((request) => request.url).filter((url) => !isRepositoryListingUrl(url)))
      .toEqual([`${AUTHORED_SEED_URL}?pagelen=50`, pageOne.next]);
    expect(outcome.observations.map((observation) => observation.entry.entryId)).toEqual(['42', '41', '17']);
    for (const observation of outcome.observations) expect(observation.routeInvolvement).toBe('author');
  });

  it('reports the identity-invalid row as bounded omission evidence and keeps its page siblings', async () => {
    const { client } = createClient([{ body: pageOne }, { body: pageTwo }]);

    const outcome = await walkAuthored(client, SCAN_LIMIT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The reason is a name the frontier can carry to a later page; the count describes only the
    // rows this page returned.
    expect(outcome.walkHealth).toEqual(['undecodable-items']);
    expect(outcome.omittedItemCount).toBe(1);
    expect(outcome.observations).toHaveLength(3);
  });

  it('settles on the projection budget instead of shrinking pagelen or discarding a page suffix', async () => {
    const { client, requests } = createClient([{ body: pageOne }, { body: pageTwo }]);

    const outcome = await walkAuthored(client, 10);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${AUTHORED_SEED_URL}?pagelen=10`);
    expect(outcome.observations).toHaveLength(2);
    // The lane is still open, so the page-shape fact is this call's own and the walk continues.
    expect(outcome.projectionBudget).toBe(true);
    expect(outcome.walkOpen).toBe(true);
    expect(outcome.frontier.authored).toEqual({ nextUrl: pageOne.next, ended: false });
  });

  it('never emits an absent observation and never reports walkFinished for an unavailable lane', async () => {
    const { client } = createClient([{ body: { ...pageOne, next: undefined } }]);

    const outcome = await walkAuthored(client, SCAN_LIMIT, {
      unavailableLanes: [{ laneId: 'assigned', reason: 'bitbucket-assignee-lane-unavailable' }],
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.walkHealth).toContain('lane-unavailable');
    expect(outcome.observations.every((observation) => observation.entry.kindId === 'pull-request')).toBe(true);
  });

  it('reports an empty walk health only when every seeded lane ran out of pages', async () => {
    const { client } = createClient([{ body: { values: [pageOne.values[0]] } }]);

    const outcome = await walkAuthored(client, SCAN_LIMIT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Nothing was skipped, no lane failed, and the enumeration ended: only such a walk may settle
    // as finished.
    expect(outcome.walkHealth).toEqual([]);
    expect(outcome.projectionBudget).toBe(false);
    expect(outcome.walkOpen).toBe(false);
  });

  it('settles a throttled scan as a failure carrying the provider deadline and issues no further request', async () => {
    const { client, requests } = createClient([
      { status: 429, headers: { 'retry-after': '30' }, body: errorNotFound },
      { body: pageTwo },
    ]);

    const outcome = await walkAuthored(client, SCAN_LIMIT);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toMatchObject({ class: 'rateLimit', retryNotBeforeMs: 31_000 });
    expect(requests).toHaveLength(1);
  });

  it('refuses a cross-origin next link without fetching it', async () => {
    const { client, requests } = createClient([
      { body: { ...pageOne, next: 'https://evil.example.com/2.0/pullrequests?page=2' } },
      { body: pageTwo },
    ]);

    const outcome = await walkAuthored(client, SCAN_LIMIT);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(requests.filter((request) => !isRepositoryListingUrl(request.url))).toHaveLength(1);
    expect(outcome.walkHealth).toContain('lane-unresolved');
    expect(outcome.observations).toHaveLength(2);
  });

  it('walks the workspace-wide authored lane and one repository lane in round-robin order', async () => {
    const repositoryRow = {
      type: 'repository',
      uuid: REPOSITORY_UUID,
      name: 'repo',
      full_name: 'example-workspace/repo',
    };
    const requests: string[] = [];
    const http = {
      async request(input: Parameters<HttpService['request']>[0]) {
        requests.push(input.url);
        const body = isRepositoryListingUrl(input.url)
          ? { pagelen: 100, page: 1, values: [repositoryRow] }
          : { pagelen: 100, page: 1, values: [] };
        return { status: 200, finalUrl: input.url, headers: {}, body: encodeBody(body) };
      },
      openWebSocket() {
        throw new Error('not used');
      },
    } as unknown as HttpService;
    const client = createBitbucketTriageApiClient({
      http,
      authorize: vi.fn(async () => AUTHORIZATION),
      now: () => 1_000,
    });

    const outcome = await scanBitbucketPullRequests({
      client,
      geometry: geometryFor(SCAN_LIMIT),
      authoredSeedUrl: AUTHORED_SEED_URL,
      authored: { nextUrl: null, ended: false },
      currentRepository: null,
      nextLaneIndex: 0,
      buildRepositoryLaneUrl: (repositoryUuid) => buildBitbucketRepositoryReviewLaneUrl({
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid,
      }),
      repositories: createBitbucketRepositoryEnumerator({
        client,
        workspaceUuid: WORKSPACE_UUID,
        resumeUrl: null,
        enteredRepositoryUuid: null,
        initial: true,
      }),
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The repository is entered only after the workspace-wide lane ends, and it stays in the
    // frontier by stable uuid so a later page finds its successor in provider list order.
    expect(outcome.frontier.currentRepository)
      .toEqual({ repositoryUuid: REPOSITORY_UUID, lane: { nextUrl: null, ended: true } });
    expect(requests.filter((url) => url.includes('values.participants'))).toHaveLength(1);
  });

  /**
   * One walk whose workspace holds exactly one repository, so the repository review lane is
   * entered and answered with `rows`.
   */
  function walkOneRepository(rows: readonly unknown[]) {
    const repositoryRow = {
      type: 'repository',
      uuid: REPOSITORY_UUID,
      name: 'repo',
      full_name: 'example-workspace/repo',
    };
    const http = {
      async request(input: Parameters<HttpService['request']>[0]) {
        const body = isRepositoryListingUrl(input.url)
          ? { pagelen: 100, page: 1, values: [repositoryRow] }
          : { pagelen: 50, page: 1, values: input.url.includes('/pullrequests') && input.url.includes('fields') ? rows : [] };
        return { status: 200, finalUrl: input.url, headers: {}, body: encodeBody(body) };
      },
      openWebSocket() {
        throw new Error('not used');
      },
    } as unknown as HttpService;
    const client = createBitbucketTriageApiClient({
      http,
      authorize: vi.fn(async () => AUTHORIZATION),
      now: () => 1_000,
    });
    return scanBitbucketPullRequests({
      client,
      geometry: geometryFor(SCAN_LIMIT),
      authoredSeedUrl: AUTHORED_SEED_URL,
      authored: { nextUrl: null, ended: false },
      currentRepository: null,
      nextLaneIndex: 0,
      buildRepositoryLaneUrl: (repositoryUuid) => buildBitbucketRepositoryReviewLaneUrl({
        workspaceUuid: WORKSPACE_UUID,
        repositoryUuid,
      }),
      repositories: createBitbucketRepositoryEnumerator({
        client,
        workspaceUuid: WORKSPACE_UUID,
        resumeUrl: null,
        enteredRepositoryUuid: null,
        initial: true,
      }),
    });
  }

  const reviewRow = (participants: unknown) => ({
    id: 101,
    title: 'Review me',
    state: 'OPEN',
    destination: { repository: { uuid: REPOSITORY_UUID, full_name: 'example-workspace/repo' } },
    reviewers: [],
    ...(participants === undefined ? {} : { participants }),
  });

  it('reports a review page that came back without its participants projection instead of reading it as no approvals', async () => {
    // The whole `reviewed` lane rests on the projection taking effect. If it silently stopped
    // taking effect, every row would decode cleanly and every review lane would look empty —
    // indistinguishable from "nothing is waiting on you". That is the one failure this walk must
    // not report as a clean result.
    const unprojected = await walkOneRepository([reviewRow(undefined)]);

    expect(unprojected.ok).toBe(true);
    if (!unprojected.ok) return;
    expect(unprojected.walkHealth).toContain('review-evidence-unprojected');
  });

  it('reports no projection health when the review page carries its participants list', async () => {
    const projected = await walkOneRepository([reviewRow([])]);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    // A genuinely empty participants list is evidence, not absence of evidence: the projection
    // worked and this pull request has no participants yet.
    expect(projected.walkHealth).not.toContain('review-evidence-unprojected');
    expect(projected.observations.map((observation) => observation.routeInvolvement)).toEqual([null]);
  });

  it('stops on cancellation and starts a later attempt from the lane seed rather than resuming', async () => {
    const controller = new AbortController();
    const { client, requests } = createClient([{ body: pageOne }, { body: pageTwo }]);
    controller.abort();

    const outcome = await walkAuthored(client, SCAN_LIMIT, { signal: controller.signal });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.class).toBe('cancelled');
    expect(requests).toHaveLength(0);
  });
});

describe('Bitbucket authoritative get', () => {
  const target = {
    workspaceUuid: WORKSPACE_UUID,
    repositoryUuid: REPOSITORY_UUID,
    entryId: '42',
  } as const;

  it('accepts a 200 whose repository UUID and id match the requested reference', async () => {
    const { client, requests } = createClient([{ body: pullRequestSelf }]);

    const outcome = await getBitbucketPullRequest({ client, ...target });

    expect(outcome.kind).toBe('present');
    if (outcome.kind !== 'present') return;
    expect(outcome.entry.entryId).toBe('42');
    expect(outcome.entry.reviewers).toHaveLength(2);
    expect(requests).toHaveLength(1);
  });

  it('resolves a 404 as unresolved, because Bitbucket Cloud cannot prove absence under this credential', async () => {
    const { client } = createClient([{ status: 404, body: errorNotFound }]);

    const outcome = await getBitbucketPullRequest({ client, ...target });

    expect(outcome.kind).toBe('unresolved');
    if (outcome.kind !== 'unresolved') return;
    expect(outcome.failure).toMatchObject({ class: 'notFound' });
    expect(JSON.stringify(outcome)).not.toContain('absent');
  });

  it('rejects a 200 whose body belongs to a different repository or id', async () => {
    const wrongRepository = await getBitbucketPullRequest({
      client: createClient([{ body: pullRequestSelf }]).client,
      ...target,
      repositoryUuid: '{2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901}',
    });
    expect(wrongRepository).toMatchObject({
      kind: 'unresolved',
      failure: { code: 'route-body-mismatch' },
    });

    const wrongId = await getBitbucketPullRequest({
      client: createClient([{ body: pullRequestSelf }]).client,
      ...target,
      entryId: '43',
    });
    expect(wrongId).toMatchObject({ kind: 'unresolved', failure: { code: 'route-body-mismatch' } });
  });
});

describe('Bitbucket workspace enumeration', () => {
  it('walks the workspace-permission collection and reports a complete traversal', async () => {
    const { client, requests } = createClient([{ body: workspacesPage }]);

    const outcome = await listBitbucketWorkspaces({ client });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.workspaces.map((workspace) => workspace.slug))
      .toEqual(['example-workspace', 'example-partner']);
    expect(outcome.complete).toBe(true);
    expect(requests[0]?.url).toContain('/2.0/user/workspaces?pagelen=');
  });

  it('marks the traversal incomplete when a workspace page fails, without dropping what it saw', async () => {
    const { client } = createClient([
      { body: { ...workspacesPage, next: `${BITBUCKET_CLOUD_API_ORIGIN}/2.0/user/workspaces?page=2` } },
      { status: 503, body: errorNotFound },
    ]);

    const outcome = await listBitbucketWorkspaces({ client });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.complete).toBe(false);
    expect(outcome.workspaces).toHaveLength(2);
    expect(outcome.failure).toMatchObject({ class: 'transient' });
  });
});
