import { MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_REPOSITORY_RESPONSE,
  GITHUB_SEARCH_ISSUE_ITEM,
  GITHUB_FIXTURE_OTHER_REPOSITORY,
  GITHUB_OTHER_REPOSITORY_RESPONSE,
  GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  GITHUB_SEARCH_UNDECODABLE_ITEM,
  githubSearchLinkHeader,
  githubSearchResponse,
} from '../__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  createTestGithubApiClient,
  fixedClock,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from '../testkit/githubTriage.test-support.js';
import type { GithubTriageScanObservationV1, GithubTriageScanResultV1 } from '../types.js';

import { buildGithubLaneQuery, GITHUB_SCAN_LANE_ORDER_V1 } from './query.js';
import { runGithubTriageScan } from './scan.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();

/** The widest page the published scan input admits, and therefore the real geometry. */
const CONTRACT_LIMIT = MAX_TRIAGE_SCAN_PAGE_ENTRIES_V1;

function laneQueryOf(request: RecordedGithubRequest): string | null {
  return new URL(request.url).searchParams.get('q');
}

function laneOf(request: RecordedGithubRequest): string | null {
  const query = laneQueryOf(request);
  if (query === null) return null;
  for (const laneId of GITHUB_SCAN_LANE_ORDER_V1) {
    if (query === buildGithubLaneQuery({ laneId, repositoryKey: REPOSITORY_KEY })) return laneId;
  }
  return null;
}

function emptyPage(): StubHttpResponse {
  return { status: 200, body: githubSearchResponse({ items: [] }) };
}

/** A distinct pull request per index, so cross-page cardinality is countable. */
function pullRequestItems(count: number, offset = 0): readonly Record<string, unknown>[] {
  return Array.from({ length: count }, (_unused, index) => ({
    ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
    number: 1000 + offset + index,
    id: 5_000_000 + offset + index,
  }));
}

async function runScan(input: Readonly<{
  respond: (request: RecordedGithubRequest) => StubHttpResponse | Promise<StubHttpResponse> | undefined;
  limit?: number;
  signal?: AbortSignal;
  nowMs?: number;
}>) {
  const transport = createStubGithubTransport({
    respond: input.respond,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const client = await createTestGithubApiClient(transport);
  const result = await runGithubTriageScan(
    {
      page: { kind: 'initial', limit: input.limit ?? 100 },
      repositoryKey: REPOSITORY_KEY,
    },
    {
      client,
      now: fixedClock(input.nowMs ?? 1_000),
      signal: transport.context.signal,
    },
  );
  return { result, transport };
}

/**
 * Drives the walk the way the aggregate does: one page, then the source's own
 * continuation, until the source settles `complete`. Nothing is persisted between
 * calls and no page is buffered — each result is applied as it arrives.
 */
async function runWalk(input: Readonly<{
  respond: (request: RecordedGithubRequest) => StubHttpResponse | Promise<StubHttpResponse> | undefined;
  limit?: number;
  maxPages?: number;
}>) {
  const transport = createStubGithubTransport({ respond: input.respond });
  const client = await createTestGithubApiClient(transport);
  const limit = input.limit ?? CONTRACT_LIMIT;
  const observations: GithubTriageScanObservationV1[] = [];
  const pages: GithubTriageScanResultV1[] = [];
  let token: string | null = null;

  for (let page = 0; page < (input.maxPages ?? 12); page += 1) {
    const result: GithubTriageScanResultV1 = await runGithubTriageScan(
      {
        page: token === null
          ? { kind: 'initial', limit }
          : { kind: 'continuation', token, maxLimit: CONTRACT_LIMIT },
        repositoryKey: REPOSITORY_KEY,
      },
      { client, now: fixedClock(1_000), signal: transport.context.signal },
    );
    pages.push(result);
    if (result.kind === 'failed') return { pages, observations, transport, settled: result };
    observations.push(...result.observations);
    if (result.kind === 'complete') return { pages, observations, transport, settled: result };
    token = result.continuation;
  }
  throw new Error('the GitHub walk did not settle inside its page budget');
}

describe('GitHub triage scan', () => {
  it('sends one request per involvement lane with explicit base qualifiers and no since window', async () => {
    const { transport } = await runScan({ respond: () => emptyPage() });

    const queries = transport.requests.map(laneQueryOf);
    expect(queries).toHaveLength(5);
    expect(new Set(queries).size).toBe(5);
    for (const query of queries) {
      expect(query).toContain('is:open');
      expect(query).toContain('archived:false');
      expect(query).toContain(`repo:${REPOSITORY_KEY}`);
      expect(query).not.toContain('updated:');
      expect(query).not.toContain('since');
    }
    expect(queries).toContain('is:open archived:false repo:octo-org/example-app review-requested:@me');
    expect(queries).not.toContain('is:open archived:false repo:octo-org/example-app user-review-requested:@me');
  });

  it('reads only whole native pages and settles partial once another will not fit', async () => {
    // The budget rule is deliberately whole-page: with limit 100 the native page size is
    // also 100, so ONE lane page is read and the invocation settles rather than shrinking
    // per_page or fetching a page it would have to discard a suffix of.
    const { result, transport } = await runScan({
      limit: 100,
      respond: () => ({
        status: 200,
        body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }),
      }),
    });

    expect(transport.requests).toHaveLength(1);
    expect(laneOf(transport.requests[0]!)).toBe('review-requested');
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations).toHaveLength(1);
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'projection-budget' });
  });

  it('advances lanes in bounded round-robin order so authored work cannot starve the rest', async () => {
    const { transport } = await runScan({
      respond: (request) => ({
        status: 200,
        headers: {
          link: githubSearchLinkHeader({
            laneQuery: laneQueryOf(request) ?? '',
            perPage: 100,
            nextPage: 2,
          }),
        },
        body: githubSearchResponse({ items: [] }),
      }),
      limit: 100,
    });

    expect(transport.requests.slice(0, 5).map(laneOf)).toEqual([
      'review-requested',
      'assigned',
      'mentioned',
      'reviewed',
      'authored',
    ]);
  });

  it('returns a continuation while any GitHub lane is still open and completes only when all five ended', async () => {
    const { pages, settled } = await runWalk({
      respond: () => ({
        status: 200,
        body: githubSearchResponse({ items: pullRequestItems(CONTRACT_LIMIT) }),
      }),
    });

    // Four pages carry a continuation, and the walk ends on the arm that ended the
    // last lane. A `page` arm never claims the walk finished.
    expect(pages.map((page) => page.kind)).toEqual([
      'page', 'page', 'page', 'page', 'complete',
    ]);
    for (const page of pages.slice(0, 4)) {
      if (page.kind !== 'page') throw new Error('expected a page arm');
      expect(typeof page.continuation).toBe('string');
      expect(page.evidence).not.toEqual({ kind: 'walkFinished' });
    }
    expect(settled.kind).toBe('complete');
  });

  it('reaches the fifth GitHub lane within one refresh at limit 64', async () => {
    const { transport, observations } = await runWalk({
      respond: () => ({
        status: 200,
        body: githubSearchResponse({ items: pullRequestItems(CONTRACT_LIMIT) }),
      }),
    });

    // Without the continuation the first lane consumed the whole budget on every
    // refresh and the remaining four were never queried at all.
    expect(transport.requests.map(laneOf)).toEqual([
      'review-requested',
      'assigned',
      'mentioned',
      'reviewed',
      'authored',
    ]);
    expect(observations).toHaveLength(5 * CONTRACT_LIMIT);
  });

  it('charges the GitHub page budget in raw items so a page never exceeds the submitted limit', async () => {
    const { result, transport } = await runScan({
      limit: CONTRACT_LIMIT,
      respond: (request) => ({
        status: 200,
        body: githubSearchResponse({
          // A whole page of rows this source cannot map still consumed a whole page.
          items: laneOf(request) === 'review-requested'
            ? Array.from(
              { length: CONTRACT_LIMIT },
              () => GITHUB_SEARCH_UNDECODABLE_ITEM as Record<string, unknown>,
            )
            : pullRequestItems(CONTRACT_LIMIT),
        }),
      }),
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    const omitted = result.evidence.kind === 'partial'
      ? result.evidence.omittedItemCount ?? 0
      : 0;
    // Counting only the rows that MAPPED leaves the budget unspent, so the next lane
    // fetches a further whole native page and the settled result carries more raw rows
    // than the caller admitted — which the strict target rejects atomically, losing the
    // valid rows with it.
    expect(result.observations.length + omitted).toBeLessThanOrEqual(CONTRACT_LIMIT);
    expect(transport.requests).toHaveLength(1);
    expect(result.observations).toHaveLength(0);
    expect(omitted).toBe(CONTRACT_LIMIT);
  });

  it('refuses a GitHub continuation it did not mint, and revalidates every Link on decode', async () => {
    const transport = createStubGithubTransport({ respond: () => emptyPage() });
    const client = await createTestGithubApiClient(transport);
    const foreign = JSON.stringify({
      v: 1,
      scanLimit: CONTRACT_LIMIT,
      nativePageSize: CONTRACT_LIMIT,
      nextLaneIndex: 0,
      walkHealth: [],
      lanes: GITHUB_SCAN_LANE_ORDER_V1.map((laneId, index) => ({
        laneId,
        // A cross-origin next URL that was never mintable here: the decode revalidates
        // every Link before it is fetched, because the token is untrusted on the way in.
        nextUrl: index === 0 ? 'https://evil.example.com/search/issues?page=2' : null,
        pagesConsumed: index === 0 ? 1 : 0,
        ended: index !== 0,
      })),
    });

    const result = await runGithubTriageScan(
      {
        page: { kind: 'continuation', token: foreign, maxLimit: CONTRACT_LIMIT },
        repositoryKey: REPOSITORY_KEY,
      },
      { client, now: fixedClock(1_000), signal: transport.context.signal },
    );

    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'github_scan_continuation_unrecognized',
      },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a GitHub continuation carrying an unrecognized sticky health reason', async () => {
    const transport = createStubGithubTransport({ respond: () => emptyPage() });
    const client = await createTestGithubApiClient(transport);
    const token = JSON.stringify({
      v: 1,
      scanLimit: CONTRACT_LIMIT,
      nativePageSize: CONTRACT_LIMIT,
      nextLaneIndex: 0,
      // Silently dropping an unknown caveat erases health the walk established.
      walkHealth: ['result-ceiling', 'lane-quarantined'],
      lanes: GITHUB_SCAN_LANE_ORDER_V1.map((laneId) => ({
        laneId,
        nextUrl: null,
        pagesConsumed: 0,
        ended: false,
      })),
    });

    const result = await runGithubTriageScan(
      {
        page: { kind: 'continuation', token, maxLimit: CONTRACT_LIMIT },
        repositoryKey: REPOSITORY_KEY,
      },
      { client, now: fixedClock(1_000), signal: transport.context.signal },
    );

    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'github_scan_continuation_unrecognized',
      },
    });
    expect(transport.requests).toHaveLength(0);
  });

  it('still reports result-ceiling on the GitHub page that settles a multi-page walk', async () => {
    const { settled, pages } = await runWalk({
      respond: (request) => (laneOf(request) === 'review-requested'
        // Only the FIRST lane, on the first call, sees the ceiling. Every later call
        // walks clean lanes and would otherwise report a truncated inbox as a whole one.
        ? {
          status: 200,
          body: githubSearchResponse({
            items: pullRequestItems(CONTRACT_LIMIT),
            totalCount: 4_211,
          }),
        }
        : emptyPage()),
    });

    expect(pages[0]?.kind).toBe('page');
    expect(settled.kind).toBe('complete');
    if (settled.kind !== 'complete') return;
    expect(settled.evidence).toEqual({ kind: 'partial', reason: 'result-ceiling' });
  });

  it('never pre-deduplicates across involvement lanes', async () => {
    const { observations, settled } = await runWalk({
      respond: () => ({
        status: 200,
        body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }),
      }),
    });

    expect(settled.kind).toBe('complete');
    expect(observations).toHaveLength(5);
    const involvement = observations.flatMap((observation) =>
      observation.kind === 'present' ? [...observation.viewer.involvement] : []);
    expect(new Set(involvement)).toEqual(new Set([
      'reviewRequested',
      'assignee',
      'mentioned',
      'participating',
      'author',
    ]));
    for (const observation of observations) {
      expect(observation.kind === 'present' && observation.localRef.entryId).toBe('1284');
    }
  });

  it('maps every native lane onto the closed canonical vocabulary, never a raw lane id', async () => {
    const { result } = await runScan({
      respond: () => ({
        status: 200,
        body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }),
      }),
    });

    // The continuation is this source's own opaque bytes; the OBSERVATIONS and the
    // health evidence are the public surface, and no native lane word crosses them.
    const publicSurface = JSON.stringify({
      observations: result.kind === 'failed' ? [] : result.observations,
      evidence: result.kind === 'failed' ? null : result.evidence,
    });
    expect(publicSurface).not.toContain('review-requested');
    expect(publicSurface).not.toContain('reviewed-by');
    expect(publicSurface).not.toContain('@me');
  });

  it('derives the GitHub cursor only from a validated Link and refuses a cross-origin one', async () => {
    const seen: string[] = [];
    const { result } = await runScan({
      respond: (request) => {
        seen.push(request.url);
        const page = new URL(request.url).searchParams.get('page');
        if (page === '1') {
          return {
            status: 200,
            headers: { Link: '<https://evil.example.com/search/issues?page=2>; rel="next"' },
            body: githubSearchResponse({ items: [] }),
          };
        }
        return emptyPage();
      },
    });

    expect(seen.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'lane-unresolved' });
    expect(result.laneFailures).toHaveLength(5);
    expect(result.laneFailures[0]).toEqual({
      class: 'unsupportedContract',
      code: 'github_search_link_invalid',
    });
  });

  it('follows a validated Link unchanged rather than rebuilding the page query', async () => {
    const requestedPages: string[] = [];
    await runScan({
      respond: (request) => {
        const url = new URL(request.url);
        const page = url.searchParams.get('page') ?? '';
        requestedPages.push(page);
        if (page === '1') {
          return {
            status: 200,
            headers: {
              link: githubSearchLinkHeader({
                laneQuery: laneQueryOf(request) ?? '',
                perPage: 100,
                nextPage: 2,
              }),
            },
            body: githubSearchResponse({ items: [] }),
          };
        }
        return emptyPage();
      },
      limit: 100,
    });

    expect(requestedPages.filter((page) => page === '2')).toHaveLength(5);
    expect(requestedPages).not.toContain('3');
  });

  it('keeps five GitHub lane frontiers private and settles partial at the projection budget', async () => {
    const perPageSeen = new Set<string>();
    const { result, transport } = await runScan({
      limit: CONTRACT_LIMIT,
      respond: (request) => {
        const url = new URL(request.url);
        perPageSeen.add(url.searchParams.get('per_page') ?? '');
        return {
          status: 200,
          headers: {
            link: githubSearchLinkHeader({
              laneQuery: laneQueryOf(request) ?? '',
              perPage: CONTRACT_LIMIT,
              nextPage: Number(url.searchParams.get('page') ?? '1') + 1,
            }),
          },
          body: githubSearchResponse({
            items: pullRequestItems(CONTRACT_LIMIT),
            totalCount: 900,
          }),
        };
      },
    });

    expect(perPageSeen).toEqual(new Set([String(CONTRACT_LIMIT)]));
    expect(transport.requests).toHaveLength(1);
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations).toHaveLength(CONTRACT_LIMIT);
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'projection-budget' });
    // The lane frontier is inside the source's own token and nowhere else.
    expect(JSON.stringify(result.observations)).not.toContain('api.github.com/search');
  });

  it('advances the GitHub raw cursor before tolerant decoding', async () => {
    const { result } = await runScan({
      limit: CONTRACT_LIMIT,
      respond: () => ({
        status: 200,
        body: githubSearchResponse({
          items: [
            GITHUB_SEARCH_UNDECODABLE_ITEM,
            GITHUB_SEARCH_PULL_REQUEST_ITEM,
            GITHUB_SEARCH_ISSUE_ITEM,
          ],
        }),
      }),
    });

    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    // The tail survives the malformed head.
    expect(result.observations).toHaveLength(2);
    expect(result.evidence).toEqual({
      kind: 'partial',
      reason: 'undecodable-items',
      omittedItemCount: 1,
    });
  });

  it('reports a scan as partial when any lane exceeded the search result ceiling', async () => {
    const { result } = await runScan({
      respond: (request) => (laneOf(request) === 'mentioned'
        ? { status: 200, body: githubSearchResponse({ items: [], totalCount: 4_211 }) }
        : emptyPage()),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'result-ceiling' });
  });

  it('reports incomplete_results as partial rather than a finished walk', async () => {
    const { result } = await runScan({
      respond: (request) => (laneOf(request) === 'authored'
        ? { status: 200, body: githubSearchResponse({ items: [], incompleteResults: true }) }
        : emptyPage()),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'incomplete-results' });
  });

  it('never returns an absent observation from a scan, whatever its health evidence', async () => {
    const { observations, settled } = await runWalk({
      respond: () => ({
        status: 200,
        body: githubSearchResponse({
          items: [GITHUB_SEARCH_ISSUE_ITEM, GITHUB_SEARCH_PULL_REQUEST_ITEM],
        }),
      }),
    });

    expect(settled.kind).toBe('complete');
    if (settled.kind !== 'complete') return;
    expect(settled.evidence).toEqual({ kind: 'walkFinished' });
    expect(observations).toHaveLength(10);
    expect(observations.every((observation) => observation.kind === 'present')).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('absent');
  });

  it('serializes five GitHub lanes and fails immediately with the provider-directed retry fact', async () => {
    const { result, transport } = await runScan({
      nowMs: 1_000,
      respond: (request) => (laneOf(request) === 'review-requested'
        ? { status: 429, body: { message: 'API rate limit exceeded' } }
        : emptyPage()),
    });

    expect(transport.requests).toHaveLength(1);
    expect(result).toEqual({
      kind: 'failed',
      failure: { class: 'rateLimit', code: 'github_rate_limited', retryNotBeforeMs: 61_000 },
    });
  });

  it('honours an explicit reset over the documented fallback and never waits through it', async () => {
    const startedAtMs = Date.now();
    const { result } = await runScan({
      nowMs: 1_000,
      respond: () => ({
        status: 403,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '901' },
        body: { message: 'API rate limit exceeded' },
      }),
    });

    expect(Date.now() - startedAtMs).toBeLessThan(1_000);
    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'rateLimit',
        code: 'github_secondary_rate_limited',
        retryNotBeforeMs: 901_000,
      },
    });
  });

  it('keeps an ordinary permission 403 out of the rate-limit arm', async () => {
    const { result } = await runScan({
      respond: () => ({
        status: 403,
        headers: {
          'x-ratelimit-remaining': '4999',
          'x-accepted-github-permissions': 'issues=read',
        },
        body: { message: 'Resource not accessible by personal access token' },
      }),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.laneFailures[0]).toEqual({ class: 'permission', code: 'insufficient_scope' });
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'lane-unresolved' });
  });

  it('settles the invocation when GitHub reports the search budget exhausted', async () => {
    const { result, transport } = await runScan({
      nowMs: 1_000,
      respond: () => ({
        status: 200,
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '61' },
        body: githubSearchResponse({ items: [] }),
      }),
    });

    expect(transport.requests).toHaveLength(1);
    expect(result).toEqual({
      kind: 'failed',
      failure: {
        class: 'rateLimit',
        code: 'github_rate_limit_budget_exhausted',
        retryNotBeforeMs: 61_000,
      },
    });
  });

  it('aborts every in-flight lane request when the signal aborts', async () => {
    const controller = new AbortController();
    const transport = createStubGithubTransport({
      respond: () => {
        controller.abort();
        return { status: 200, body: githubSearchResponse({ items: [] }) };
      },
      signal: controller.signal,
    });
    const client = await createTestGithubApiClient(transport);

    await expect(runGithubTriageScan(
      { page: { kind: 'initial', limit: 100 }, repositoryKey: REPOSITORY_KEY },
      { client, now: fixedClock(1_000), signal: controller.signal },
    )).resolves.toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'github_request_cancelled' },
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('resolves the repository id once per repository when the search item omits it', async () => {
    const repositoryReads: string[] = [];
    const { result } = await runScan({
      respond: (request) => {
        if (request.url.includes('/repos/')) {
          repositoryReads.push(request.url);
          return { status: 200, body: GITHUB_REPOSITORY_RESPONSE };
        }
        return {
          status: 200,
          body: githubSearchResponse({ items: [GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY] }),
        };
      },
    });

    expect(repositoryReads).toHaveLength(1);
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    const first = result.observations[0];
    expect(first?.kind === 'present' && first.localRef.collisionScope)
      .toBe(`github:${GITHUB_FIXTURE_REPOSITORY_ID}`);
  });

  it('asks for every repository a page needs at once rather than one after another', async () => {
    // GitHub omits `repository` from a search item, so identity needs one read per
    // DISTINCT repository on the page. Taken one after another that is a chain of
    // round trips inside one lane's page — an involvement inbox spanning fifty
    // repositories spends fifty sequential round trips before the second lane is
    // ever asked, and the invocation settles on the budget with the later lanes
    // unread. The request COUNT is not the problem and does not change here; the
    // serialization is.
    let inFlight = 0;
    let concurrentRepositoryReads = 0;
    const release: Array<() => void> = [];
    const { result } = await runScan({
      limit: 100,
      respond: (request) => {
        if (!request.url.includes('/repos/')) {
          return {
            status: 200,
            body: githubSearchResponse({
              items: [
                { ...GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY, number: 4001, id: 6_000_001 },
                { ...GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY, number: 4002, id: 6_000_002 },
                {
                  ...GITHUB_SEARCH_ISSUE_ITEM,
                  repository: undefined,
                  number: 4003,
                  id: 6_000_003,
                },
              ],
            }),
          };
        }
        inFlight += 1;
        concurrentRepositoryReads = Math.max(concurrentRepositoryReads, inFlight);
        const body = request.url.endsWith(GITHUB_FIXTURE_OTHER_REPOSITORY)
          ? GITHUB_OTHER_REPOSITORY_RESPONSE
          : GITHUB_REPOSITORY_RESPONSE;
        // Held open across a macrotask, so everything issued in the same tick is
        // outstanding together and countable. A chain settles one at a time and
        // never counts more than one — which is the failure, not a hang.
        return new Promise<StubHttpResponse>((resolve) => {
          release.push(() => {
            inFlight -= 1;
            resolve({ status: 200, body });
          });
          setTimeout(() => {
            for (const settle of release.splice(0)) settle();
          }, 0);
        });
      },
    });

    // Two distinct repositories on the page, both outstanding at the same moment.
    expect(concurrentRepositoryReads).toBe(2);
    expect(result.kind).toBe('page');
    if (result.kind !== 'page') return;
    expect(result.observations).toHaveLength(3);
  });
});
