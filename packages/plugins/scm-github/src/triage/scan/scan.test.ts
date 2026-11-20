import { MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_FIXTURE_REPOSITORY_ID,
  GITHUB_REPOSITORY_RESPONSE,
  GITHUB_SEARCH_ISSUE_ITEM,
  GITHUB_FIXTURE_OTHER_REPOSITORY_ID,
  GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY,
  GITHUB_SEARCH_PULL_REQUEST_ITEM,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_SEARCH_UNDECODABLE_ITEM,
  githubSearchLinkHeader,
  githubSearchResponse,
  githubCheckRunsResponse,
  githubCombinedStatusResponse,
} from '../__fixtures__/githubResponses.js';
import { runGithubTriageGet } from '../get.js';
import {
  createStubGithubTransport,
  githubChecksBatchResponse,
  githubChecksRollupCounts,
  createTestGithubApiClient,
  readRecordedJsonBody,
  fixedClock,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from '../testkit/githubTriage.test-support.js';
import type { GithubTriageScanObservationV1, GithubTriageScanResultV1 } from '../types.js';

import { buildGithubLaneQuery, GITHUB_SCAN_LANE_ORDER_V1 } from './query.js';
import { runGithubTriageScan } from './scan.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();

/** Representative caller-selected geometry; the protocol has no feature-local maximum. */
const CONTRACT_LIMIT = 64;

function laneQueryOf(request: RecordedGithubRequest): string | null {
  return new URL(request.url).searchParams.get('q');
}

function laneOf(request: RecordedGithubRequest): string | null {
  const query = laneQueryOf(request);
  if (query === null) return null;
  for (const laneId of GITHUB_SCAN_LANE_ORDER_V1) {
    if (query === buildGithubLaneQuery({ laneId, repositoryKeys: [REPOSITORY_KEY] })) return laneId;
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
  batch?: (request: RecordedGithubRequest) => StubHttpResponse | Promise<StubHttpResponse>;
}>) {
  const transport = createStubGithubTransport({
    respond: request => new URL(request.url).pathname === '/graphql'
      ? (input.batch ?? githubChecksBatchResponse)(request) : input.respond(request),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const client = await createTestGithubApiClient(transport);
  const result = await runGithubTriageScan(
    {
      page: { kind: 'initial', limit: input.limit ?? 100 },
      repositoryKeys: [REPOSITORY_KEY],
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
  const transport = createStubGithubTransport({ respond: request => new URL(request.url).pathname === '/graphql'
    ? githubChecksBatchResponse(request) : input.respond(request) });
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
          : { kind: 'continuation', token },
        repositoryKeys: [REPOSITORY_KEY],
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
  it('retains realistic native head pages inside the source continuation allocation', async () => {
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const url = new URL(request.url);
      expect(url.searchParams.get('per_page')).toBe('10');
      const page = Number(url.searchParams.get('page'));
      const next = new URL(url); next.searchParams.set('page', String(page + 1));
      const offset = laneOf(request) === 'review-requested' ? 0 : 100;
      return { status: 200, headers: { Link: `<${next}>; rel="next"` },
        body: githubSearchResponse({ items: Array.from({ length: 10 }, (_, index) => {
          const value = offset + (page - 1) * 10 + index + 1;
          return { ...GITHUB_SEARCH_ISSUE_ITEM, number: 10_000 - value,
            updated_at: new Date(value * 1000).toISOString() };
        }) }) };
    } });
    const deps = { client: await createTestGithubApiClient(transport), now: fixedClock(1_000), signal: transport.context.signal };
    const input = { repositoryKeys: [REPOSITORY_KEY], sort: { field: 'updated' as const, direction: 'asc' as const } };
    const first = await runGithubTriageScan({ ...input, page: { kind: 'initial', limit: 50 } }, deps);
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') throw new Error('expected retained native rows');
    expect(new TextEncoder().encode(first.continuation).byteLength).toBeLessThanOrEqual(MAX_TRIAGE_PAGING_TOKEN_UTF8_BYTES_V1);
    expect(first.observations).toHaveLength(10);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(5);
    const beforeReplay = transport.requests.length;
    const replay = await runGithubTriageScan({ ...input, sort: { field: 'updated', direction: 'desc' },
      page: { kind: 'continuation', token: first.continuation } }, deps);
    expect(replay).toMatchObject({ kind: 'failed', failure: { code: 'github_scan_continuation_unrecognized' } });
    expect(transport.requests).toHaveLength(beforeReplay);
    const second = await runGithubTriageScan({ ...input, page: { kind: 'continuation', token: first.continuation } }, deps);
    expect(second.kind).toBe('page');
    if (second.kind === 'failed') throw new Error(second.failure.code);
    expect(second.observations.map(row => row.kind === 'present' && row.snapshot.sourceUpdatedAtMs))
      .toEqual(Array.from({ length: 10 }, (_, index) => (index + 11) * 1000));
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(6);
  });

  it('refuses an unsupported field before fetching an unsorted source page', async () => {
    const transport = createStubGithubTransport({ respond: emptyPage });
    const result = await runGithubTriageScan({ repositoryKeys: [REPOSITORY_KEY],
      sort: { field: 'due', direction: 'asc' }, page: { kind: 'initial', limit: 2 } },
      { client: await createTestGithubApiClient(transport), now: fixedClock(1_000), signal: transport.context.signal });
    expect(result).toMatchObject({ kind: 'failed', failure: { class: 'unsupportedContract', code: 'unsupported-sort' } });
    expect(transport.requests).toHaveLength(0);
  });

  it.each([{ field: 'updated', direction: 'asc' }, { field: 'updated', direction: 'desc' },
    { field: 'created', direction: 'asc' }, { field: 'created', direction: 'desc' }] as const)('merges $field $direction lane heads before paginating and retains unshown rows', async ({ field, direction }) => {
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const url = new URL(request.url);
      expect(url.searchParams.get('per_page')).toBe('2');
      expect(url.searchParams.get('sort')).toBe(field);
      expect(url.searchParams.get('order')).toBe(direction);
      const lane = laneOf(request);
      const values = lane === 'review-requested' ? [1, 4, 5, 8] : lane === 'assigned' ? [2, 3, 6, 7] : [];
      const sorted = direction === 'asc' ? values : values.slice().reverse();
      const page = Number(url.searchParams.get('page'));
      const next = new URL(url); next.searchParams.set('page', String(page + 1));
      return { status: 200, ...(page === 1 && values.length > 0 ? { headers: { Link: `<${next}>; rel="next"` } } : {}),
        body: githubSearchResponse({ items: sorted.slice((page - 1) * 2, page * 2).map(value => ({
          ...GITHUB_SEARCH_ISSUE_ITEM, number: 100 - value,
          [field === 'updated' ? 'updated_at' : 'created_at']: new Date(value * 1_000).toISOString(),
        })) }) };
    } });
    const deps = { client: await createTestGithubApiClient(transport), now: fixedClock(1_000), signal: transport.context.signal };
    const input = { repositoryKeys: [REPOSITORY_KEY], sort: { field, direction } };
    const first = await runGithubTriageScan({ ...input, page: { kind: 'initial', limit: 10 } }, deps);
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') throw new Error('expected retained lane heads');
    expect(first.observations.map(row => row.kind === 'present' && row.localRef.entryId))
      .toEqual(direction === 'asc' ? ['99', '98', '97'] : ['92', '93', '94']);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(5);
    const second = await runGithubTriageScan({ ...input, page: { kind: 'continuation', token: first.continuation } }, deps);
    expect(second.kind).toBe('complete');
    if (second.kind === 'failed') throw new Error(second.failure.code);
    expect(second.observations.map(row => row.kind === 'present' && row.localRef.entryId))
      .toEqual(direction === 'asc' ? ['96', '95', '94', '93', '92'] : ['95', '96', '97', '98', '99']);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(7);
  });
  it('merges grouped repository queries without expanding successful native groups', async () => {
    const repositories = Array.from({ length: 7 }, (_, index) => `owner/repository-${index}`);
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const query = laneQueryOf(request) ?? '';
      const values = query.includes('review-requested:@me') ? [query.includes('repository-6') ? 1 : 4] : [];
      return { status: 200, body: githubSearchResponse({ items: values.map(value => ({
        ...GITHUB_SEARCH_ISSUE_ITEM, number: 100 - value, updated_at: new Date(value * 1000).toISOString(),
      })) }) };
    } });
    const result = await runGithubTriageScan({ repositoryKeys: repositories,
      sort: { field: 'updated', direction: 'asc' }, page: { kind: 'initial', limit: 10 } },
      { client: await createTestGithubApiClient(transport), now: fixedClock(1_000), signal: transport.context.signal });
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error(result.failure.code);
    expect(result.observations.map(row => row.kind === 'present' && row.localRef.entryId)).toEqual(['99', '96']);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(10);
  });

  it('partitions the fetched-row budget across repository streams after grouped query refusal', async () => {
    let fetchedRows = 0;
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const query = laneQueryOf(request) ?? '';
      if (query.includes(' OR ')) return { status: 422, body: { message: 'repository unavailable' } };
      const size = Number(new URL(request.url).searchParams.get('per_page'));
      const items = Array.from({ length: size }, (_, index) => ({ ...GITHUB_SEARCH_ISSUE_ITEM,
        number: index + 1, updated_at: new Date((index + 1) * 1000).toISOString(),
      }));
      fetchedRows += items.length;
      return { status: 200, body: githubSearchResponse({ items }) };
    } });
    const result = await runGithubTriageScan({ repositoryKeys: ['owner/a', 'owner/b'],
      sort: { field: 'updated', direction: 'asc' }, page: { kind: 'initial', limit: 10 } },
      { client: await createTestGithubApiClient(transport), now: fixedClock(1_000), signal: transport.context.signal });
    expect(result.kind).not.toBe('failed');
    expect(fetchedRows).toBe(10);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(15);
  });

  it('merges every repository head when GitHub decomposes a rejected grouped query', async () => {
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const query = laneQueryOf(request) ?? '';
      if (query.includes(' OR ')) return { status: 422, body: { message: 'repository unavailable' } };
      const values = query.includes('review-requested:@me') ? query.includes('repo:owner/a') ? [4, 9, 10, 11] : [1, 2, 3, 8] : [];
      const url = new URL(request.url); const page = Number(url.searchParams.get('page'));
      const next = new URL(url); next.searchParams.set('page', String(page + 1));
      return { status: 200, ...(page === 1 && values.length > 0 ? { headers: { Link: `<${next}>; rel="next"` } } : {}),
        body: githubSearchResponse({ items: values.slice((page - 1) * 2, page * 2).map(value => ({
          ...GITHUB_SEARCH_ISSUE_ITEM, number: 100 - value, updated_at: new Date(value * 1000).toISOString(),
        })) }) };
    } });
    const input = { repositoryKeys: ['owner/a', 'owner/b'], sort: { field: 'updated' as const, direction: 'asc' as const } };
    const deps = { client: await createTestGithubApiClient(transport), now: fixedClock(1_000), signal: transport.context.signal };
    const first = await runGithubTriageScan({ ...input, page: { kind: 'initial', limit: 20 } }, deps);
    expect(first.kind).toBe('page');
    if (first.kind !== 'page') throw new Error('expected decomposed continuation');
    expect(first.observations.map(row => row.kind === 'present' && row.localRef.entryId)).toEqual(['99', '98']);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(15);
    const second = await runGithubTriageScan({ ...input, page: { kind: 'continuation', token: first.continuation } }, deps);
    expect(second.kind).toBe('complete');
    if (second.kind === 'failed') throw new Error(second.failure.code);
    expect(second.observations.map(row => row.kind === 'present' && row.localRef.entryId)).toEqual(['97', '96', '92', '91', '90', '89']);
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/search/issues')).toHaveLength(17);
  });

  it('searches older text matches at GitHub within the configured repository and involvement lanes', async () => {
    const transport = createStubGithubTransport({ respond: request => {
      if (new URL(request.url).pathname === '/graphql') return githubChecksBatchResponse(request);
      const query = laneQueryOf(request) ?? '';
      return { status: 200, body: githubSearchResponse({ items: query.includes('"older"') && query.includes('"crash"')
        ? [{ ...GITHUB_SEARCH_ISSUE_ITEM, title: 'Older crash fix' }] : [] }) };
    } });
    const input = { page: { kind: 'initial' as const, limit: CONTRACT_LIMIT }, repositoryKeys: [REPOSITORY_KEY], query: 'older crash' };
    const result = await runGithubTriageScan(input, { client: await createTestGithubApiClient(transport),
      now: fixedClock(1_000), signal: transport.context.signal });
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error(result.failure.code);
    expect(result.observations.some(row => row.kind === 'present' && row.snapshot.title === 'Older crash fix')).toBe(true);
    const searches = transport.requests.filter(request => new URL(request.url).pathname === '/search/issues');
    expect(searches).toHaveLength(GITHUB_SCAN_LANE_ORDER_V1.length);
    expect(searches.every(request => (laneQueryOf(request) ?? '').includes(`repo:${REPOSITORY_KEY}`))).toBe(true);
  });

  it('reads at most one native search page per lane for a text query and retains honest partial coverage', async () => {
    const transport = createStubGithubTransport({ respond: request => {
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page'));
      const laneQuery = url.searchParams.get('q');
      if (laneQuery === null) throw new Error('Expected a GitHub search query');
      const headers: StubHttpResponse['headers'] = page === 1
        ? { link: githubSearchLinkHeader({ laneQuery, perPage: CONTRACT_LIMIT, nextPage: 2 }) } : {};
      return { status: 200, body: githubSearchResponse({ items: [], totalCount: CONTRACT_LIMIT * 2 }), headers };
    } });
    const input = { page: { kind: 'initial' as const, limit: CONTRACT_LIMIT }, repositoryKeys: [REPOSITORY_KEY], query: 'needle' };
    const result = await runGithubTriageScan(input, { client: await createTestGithubApiClient(transport),
      now: fixedClock(1_000), signal: transport.context.signal });
    expect(transport.requests).toHaveLength(GITHUB_SCAN_LANE_ORDER_V1.length);
    expect(result).toMatchObject({ kind: 'page', evidence: { kind: 'partial' } });
  });

  it('batches current heads, checks and missing repository identities for a consumed native page', async () => {
    const items = pullRequestItems(20).map(item => ({ ...item, repository: undefined }));
    const { result, transport } = await runScan({ respond: request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/search/issues') return { status: 200, body: githubSearchResponse({
        items: laneOf(request) === 'authored' ? items : [],
      }) };
      return undefined;
    }, batch: () => {
        const data: Record<string, unknown> = {};
        for (let index = 0; index < items.length; index += 1) data[`row${index}`] = {
          databaseId: Number(GITHUB_FIXTURE_REPOSITORY_ID), pullRequest: {
            reviewDecision: index === 19 ? 'CHANGES_REQUESTED' : 'APPROVED',
            headRefOid: 'a'.repeat(40), commits: { nodes: [{ commit: { oid: 'a'.repeat(40),
              statusCheckRollup: { contexts: githubChecksRollupCounts([{ __typename: 'StatusContext',
                state: index === 19 ? 'FAILURE' : 'SUCCESS' }]) },
            } }] },
          },
        };
        return { status: 200, body: { data } };
    } });
    expect(transport.requests.filter(request => new URL(request.url).pathname !== '/search/issues')).toHaveLength(1);
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error('expected scan rows');
    expect(result.observations).toHaveLength(20);
    expect(result.observations[19]).toMatchObject({ kind: 'present',
      localRef: { collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}` },
      snapshot: { rowFacts: expect.arrayContaining([{ id: 'github/review-decision', importance: 'primary',
        value: { kind: 'status', value: 'Changes requested', tone: 'danger' },
      }, { id: 'github/checks', importance: 'primary',
        value: { kind: 'status', value: '1 failing', tone: 'danger' },
      }]) },
    });
    expect(result.observations[0]).toMatchObject({ kind: 'present', snapshot: {
      rowFacts: expect.arrayContaining([{ id: 'github/review-decision', importance: 'primary',
        value: { kind: 'status', value: 'Approved', tone: 'success' } }]),
    } });
    expect(transport.materializeCount()).toBe(1);
  });

  it('retains rows but reports unavailable checks and partial scan evidence for a malformed batch answer', async () => {
    const { result } = await runScan({
      respond: request => ({ status: 200, body: githubSearchResponse({
        items: laneOf(request) === 'authored' ? [GITHUB_SEARCH_PULL_REQUEST_ITEM] : [],
      }) }),
      batch: () => ({ status: 200, body: { data: { row0: { databaseId: 4210, pullRequest: {
        headRefOid: 'a'.repeat(40), commits: { nodes: [] },
      } } } } }),
    });
    expect(result).toMatchObject({ kind: 'complete', evidence: { kind: 'partial', reason: 'github_checks_envelope_invalid' },
      observations: [{ kind: 'present', snapshot: { rowFacts: expect.arrayContaining([
        { id: 'github/checks', importance: 'primary', value: { kind: 'status', value: 'Checks unavailable', tone: 'warning' } },
      ]) } }],
    });
  });

  it('retains every searched row and reports partial evidence when the page batch of checks is rate limited', async () => {
    const { result, transport } = await runScan({
      respond: () => ({ status: 200, body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) }),
      batch: () => ({ status: 429, headers: { 'retry-after': '60' }, body: { message: 'API rate limit exceeded' } }),
    });
    // The batch follows the page's last search, so a parked account never refuses a search.
    expect(result).toMatchObject({ kind: 'complete', evidence: { kind: 'partial', reason: 'github_rate_limited' } });
    if (result.kind === 'failed') throw new Error('expected retained rows');
    expect(result.observations).toHaveLength(GITHUB_SCAN_LANE_ORDER_V1.length);
    for (const observation of result.observations) expect(observation).toMatchObject({ kind: 'present', snapshot: {
      rowFacts: expect.arrayContaining([
        { id: 'github/checks', importance: 'primary', value: { kind: 'status', value: 'Checks unavailable', tone: 'warning' } },
      ]) } });
    expect(transport.requests.map(request => new URL(request.url).pathname))
      .toEqual([...GITHUB_SCAN_LANE_ORDER_V1.map(() => '/search/issues'), '/graphql']);
  });

  it('does not start detached check reads for a row whose repository identity is unavailable', async () => {
    const { result, transport } = await runScan({ batch: () => ({ status: 200, body: { data: { row0: null } } }), respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') return { status: 200, body: githubSearchResponse({
        items: laneOf(request) === 'authored' ? [GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY] : [],
      }) };
      if (url.pathname === `/repos/${REPOSITORY_KEY}`) return { status: 403, body: { message: 'Forbidden' } };
      return undefined;
    } });
    expect(result).toMatchObject({ kind: 'complete', observations: [], evidence: { kind: 'partial', reason: 'undecodable-items' } });
    expect(transport.requests.some((request) => new URL(request.url).pathname.includes('/pulls/'))).toBe(false);
  });

  it('does not settle the last lane as complete when cancellation arrives during its batch read', async () => {
    const cancellation = new AbortController();
    const transport = createStubGithubTransport({ signal: cancellation.signal, respond: (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/search/issues') return { status: 200, body: githubSearchResponse({
        items: laneOf(request) === 'authored'
          ? [GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY] : [],
      }) };
      if (url.pathname === '/graphql') {
        cancellation.abort();
        return githubChecksBatchResponse(request);
      }
      return undefined;
    } });
    const client = await createTestGithubApiClient(transport);
    const result = await runGithubTriageScan({ page: { kind: 'initial', limit: CONTRACT_LIMIT }, repositoryKeys: [REPOSITORY_KEY] }, {
      client, now: fixedClock(1_000), signal: cancellation.signal,
    });
    expect(result).toMatchObject({ kind: 'failed', failure: { class: 'transient', code: 'github_request_cancelled' } });
  });

  it('preserves merged lifecycle from the search item pull_request envelope', async () => {
    // /search/issues shape from githubResponses.ts provenance: merged_at is nested.
    const { result } = await runScan({ respond: (request) => laneOf(request) === 'authored'
      ? { status: 200, body: githubSearchResponse({ items: [{
        ...GITHUB_SEARCH_PULL_REQUEST_ITEM,
        state: 'closed',
        pull_request: { url: 'https://api.github.com/repos/octo-org/example-app/pulls/1284', merged_at: '2026-08-13T10:00:00Z' },
      }] }) }
      : emptyPage() });
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error('scan failed');
    const observation = result.observations[0];
    if (observation?.kind !== 'present') throw new Error('expected a present observation');
    expect(observation.snapshot.state).toEqual({ presentation: 'resolved', nativeLabel: 'Merged' });
  });
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

  it('fills one Refresh across short initial lanes', async () => {
    const { result, transport } = await runScan({
      limit: 56,
      respond: (request) => {
        const lane = laneOf(request);
        if (lane === null) return undefined;
        const size = lane === 'review-requested' ? 2 : lane === 'authored' ? 54 : 0;
        return { status: 200, body: githubSearchResponse({ items: Array.from({ length: size }, (_, index) => ({
          ...GITHUB_SEARCH_ISSUE_ITEM, id: 5000 + index, number: (lane === 'authored' ? 100 : 1) + index,
        })) }) };
      },
    });
    expect(result).toMatchObject({ kind: 'complete', evidence: { kind: 'walkFinished' } });
    if (result.kind === 'failed') throw new Error('expected a filled scan');
    expect(result.observations).toHaveLength(56);
    expect(transport.requests.filter((request) => laneOf(request) !== null)
      .map((request) => Number(new URL(request.url).searchParams.get('per_page')))).toEqual([56, 54, 54, 54, 54]);
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

    expect(transport.requests.filter(request => laneOf(request) !== null).slice(0, 5).map(laneOf)).toEqual([
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
    expect(transport.requests.map(laneOf).filter((lane) => lane !== null)).toEqual([
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
      v: 2,
      scopeKey: JSON.stringify([[REPOSITORY_KEY]]),
      groupIndex: 0,
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
        repositoryIndex: null,
      })),
    });

    const result = await runGithubTriageScan(
      {
        page: { kind: 'continuation', token: foreign },
        repositoryKeys: [REPOSITORY_KEY],
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
      v: 2,
      scopeKey: JSON.stringify([[REPOSITORY_KEY]]),
      groupIndex: 0,
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
        repositoryIndex: null,
      })),
    });

    const result = await runGithubTriageScan(
      {
        page: { kind: 'continuation', token },
        repositoryKeys: [REPOSITORY_KEY],
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

  it('reports a present malformed Link as a lane failure instead of clean exhaustion', async () => {
    const { result } = await runScan({
      respond: () => ({
        status: 200,
        headers: { Link: 'not-a-link-value' },
        body: githubSearchResponse({ items: [] }),
      }),
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'lane-unresolved' });
    expect(result.laneFailures).toHaveLength(5);
    expect(result.laneFailures.every((failure) =>
      failure.class === 'unsupportedContract' && failure.code === 'github_search_link_invalid'))
      .toBe(true);
  });

  it.each([
    ['same', 2],
    ['regressive', 1],
  ])('settles a %s search next page as a lane failure instead of making progress', async (_label, nextPage) => {
    const requestedPages: string[] = [];
    const { result } = await runScan({
      respond: (request) => {
        const currentPage = Number(new URL(request.url).searchParams.get('page') ?? '1');
        requestedPages.push(String(currentPage));
        return {
          status: 200,
          headers: {
            link: githubSearchLinkHeader({
              laneQuery: laneQueryOf(request) ?? '',
              perPage: 100,
              nextPage: currentPage === 1 ? 2 : nextPage,
            }),
          },
          body: githubSearchResponse({ items: [] }),
        };
      },
      limit: 1_000,
    });

    expect(result.kind).toBe('complete');
    if (result.kind !== 'complete') return;
    expect(result.evidence).toEqual({ kind: 'partial', reason: 'lane-unresolved' });
    expect(result.laneFailures.some((failure) => failure.code === 'github_search_link_invalid'))
      .toBe(true);
    expect(requestedPages.length).toBeLessThanOrEqual(10);
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

  it('keeps an exact detail response separate from a pending scan continuation', async () => {
    const lane = GITHUB_SCAN_LANE_ORDER_V1[0];
    const laneQuery = buildGithubLaneQuery({ laneId: lane, repositoryKeys: [REPOSITORY_KEY] });
    const nextLink = githubSearchLinkHeader({ laneQuery, perPage: 1, nextPage: 2 });
    const nextUrl = nextLink.match(/<([^>]+)>/u)?.[1];
    if (nextUrl === undefined) throw new Error('Expected a scan continuation URL');
    let pageRequested!: () => void;
    let releasePage!: () => void;
    const pageStarted = new Promise<void>(resolve => { pageRequested = resolve; });
    const pageHeld = new Promise<void>(resolve => { releasePage = resolve; });
    const transport = createStubGithubTransport({ async respond(request) {
      const url = new URL(request.url);
      if (url.pathname === '/graphql') return githubChecksBatchResponse(request);
      if (url.pathname.endsWith('/pulls/1284')) {
        return { status: 200, body: { ...GITHUB_PULL_REQUEST_RESPONSE, title: 'Exact detail' } };
      }
      if (url.pathname !== '/search/issues') return undefined;
      if (request.url === nextUrl) {
        pageRequested();
        await pageHeld;
        return { status: 200, body: githubSearchResponse({ items: pullRequestItems(1) }) };
      }
      if (laneOf(request) !== lane) return emptyPage();
      return { status: 200, headers: { link: nextLink },
        body: githubSearchResponse({ items: [GITHUB_SEARCH_PULL_REQUEST_ITEM] }) };
    } });
    const deps = { client: await createTestGithubApiClient(transport), now: fixedClock(1_000),
      signal: transport.context.signal };
    const first = await runGithubTriageScan({ page: { kind: 'initial', limit: 1 }, repositoryKeys: [REPOSITORY_KEY] }, deps);
    if (first.kind !== 'page') throw new Error('Expected the first scan page to carry a continuation');
    const continuation = runGithubTriageScan({ page: { kind: 'continuation', token: first.continuation },
      repositoryKeys: [REPOSITORY_KEY] }, deps);
    try {
      await Promise.race([pageStarted, continuation.then(() => { throw new Error('The scan did not request page two'); })]);
      const localRef = { kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`,
        entryId: '1284' } as const;
      expect(first.observations.map(row => row.localRef)).toEqual([localRef]);
      const detail = await runGithubTriageGet({ localRef, routingToken: REPOSITORY_KEY }, deps);
      expect(detail.observation).toMatchObject({ kind: 'present', localRef, snapshot: { title: 'Exact detail' } });
    } finally {
      releasePage();
    }
    const second = await continuation;
    expect(second).toMatchObject({ observations: [{ kind: 'present', localRef: {
      kindId: 'pull-request', collisionScope: `github:${GITHUB_FIXTURE_REPOSITORY_ID}`, entryId: '1000',
    } }] });
    expect(transport.requests.filter(request => request.url === nextUrl)).toHaveLength(1);
    expect(transport.requests.filter(request => request.url.endsWith('/pulls/1284'))).toHaveLength(1);
  });

  it('keeps five GitHub lane frontiers private and settles partial at the projection budget', async () => {
    const perPageSeen = new Set<string>();
    const { result, transport } = await runScan({
      limit: CONTRACT_LIMIT,
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname !== '/search/issues') return undefined;
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
    expect(transport.requests.filter((request) => laneOf(request) !== null)).toHaveLength(1);
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

    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    // The tail survives the malformed head.
    expect(result.observations).toHaveLength(10);
    expect(result.evidence).toEqual({
      kind: 'partial',
      reason: 'undecodable-items',
      omittedItemCount: 5,
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
      respond: (request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith('/pulls/1284')) return { status: 200, body: GITHUB_PULL_REQUEST_RESPONSE };
        if (url.pathname.endsWith('/check-runs')) return { status: 200, body: githubCheckRunsResponse({ runs: [] }) };
        if (url.pathname.endsWith('/status')) return { status: 200, body: githubCombinedStatusResponse({ state: 'success', statuses: [] }) };
        return {
          status: 200,
          body: githubSearchResponse({
            items: [GITHUB_SEARCH_ISSUE_ITEM, GITHUB_SEARCH_PULL_REQUEST_ITEM],
          }),
        };
      },
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
    expect(result.laneFailures[0]).toEqual({ class: 'permission', code: 'insufficient_scope', detail: 'issues=read', requiredPermissions: 'issues=read' });
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
      { page: { kind: 'initial', limit: 100 }, repositoryKeys: [REPOSITORY_KEY] },
      { client, now: fixedClock(1_000), signal: controller.signal },
    )).resolves.toEqual({
      kind: 'failed',
      failure: { class: 'transient', code: 'github_request_cancelled' },
    });
    expect(transport.requests).toHaveLength(1);
  });

  it('acquires checks and repository identity for every lane of one page in a single batch', async () => {
    // Each lane returns a different pull request. A batch per lane puts one GraphQL
    // round trip between consecutive searches; the page needs exactly one.
    const lanes = ['review-requested', 'assigned', 'mentioned'];
    const { result, transport } = await runScan({
      limit: 56,
      respond: (request) => {
        const lane = laneOf(request);
        if (lane === null) return undefined;
        const index = lanes.indexOf(lane);
        return { status: 200, body: githubSearchResponse({ items: index < 0 ? [] : pullRequestItems(1, index) }) };
      },
    });
    const graphql = transport.requests.filter(request => new URL(request.url).pathname === '/graphql');
    expect(graphql).toHaveLength(1);
    expect(transport.requests.at(-1)).toBe(graphql[0]);
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') throw new Error('expected scan rows');
    expect(result.observations.map(observation => observation.kind === 'present' && observation.viewer.involvement))
      .toEqual([['reviewRequested'], ['assignee'], ['mentioned']]);
  });

  it('reads a list row checks rollup as GitHub state counts in one request, however many check pages it has', async () => {
    // 150 check runs on the head: GitHub pages contexts by 100, but its own state
    // counts cover the whole connection. The list row needs only those counts.
    const checkRuns = Array.from({ length: 150 }, (_unused, index) => ({
      __typename: 'CheckRun', id: `run-${index}`, databaseId: 9000 + index, name: `job ${index}`,
      status: 'COMPLETED', conclusion: index < 2 ? 'FAILURE' : 'SUCCESS', detailsUrl: null,
      startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', annotations: { totalCount: 0 },
      checkSuite: { createdAt: '2026-01-01T00:00:00Z', app: { slug: 'ci' }, commit: { oid: 'a'.repeat(40) },
        repository: { nameWithOwner: REPOSITORY_KEY }, workflowRun: null }, isRequired: false,
    }));
    const { result, transport } = await runScan({
      respond: request => ({ status: 200, body: githubSearchResponse({
        items: laneOf(request) === 'authored' ? [GITHUB_SEARCH_PULL_REQUEST_ITEM] : [],
      }) }),
      batch: (request) => {
        const { query, variables } = readRecordedJsonBody(request) as { query: string; variables: Record<string, unknown> };
        if (query.includes('checkRunCountsByState')) return githubChecksBatchResponse(request, { nodes: checkRuns });
        // A node page: GitHub's own 100-context page and cursor.
        const after = variables.cursor0 === 'page-2' ? 100 : 0;
        return { status: 200, body: { data: { row0: { databaseId: Number(GITHUB_FIXTURE_REPOSITORY_ID), pullRequest: {
          headRefOid: 'a'.repeat(40), commits: { nodes: [{ commit: { oid: 'a'.repeat(40), statusCheckRollup: { contexts: {
            nodes: checkRuns.slice(after, after + 100),
            pageInfo: { hasNextPage: after === 0, endCursor: after === 0 ? 'page-2' : null },
          } } } }] },
        } } } } };
      },
    });
    expect(transport.requests.filter(request => new URL(request.url).pathname === '/graphql')).toHaveLength(1);
    expect(result).toMatchObject({ kind: 'complete', observations: [{ kind: 'present', snapshot: {
      rowFacts: expect.arrayContaining([
        { id: 'github/checks', importance: 'primary', value: { kind: 'status', value: '2 failing', tone: 'danger' } },
      ]) } }] });
  });

  it('reuses batched repository identity and checks across involvement encounters', async () => {
    const { result, transport } = await runScan({
      respond: (request) => {
        if (new URL(request.url).pathname === `/repos/${REPOSITORY_KEY}`) {
          return { status: 200, body: GITHUB_REPOSITORY_RESPONSE };
        }
        return {
          status: 200,
          body: githubSearchResponse({ items: [GITHUB_SEARCH_ITEM_WITHOUT_REPOSITORY] }),
        };
      },
    });

    expect(transport.requests.filter(request => new URL(request.url).pathname === '/graphql')).toHaveLength(1);
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    const first = result.observations[0];
    expect(first?.kind === 'present' && first.localRef.collisionScope)
      .toBe(`github:${GITHUB_FIXTURE_REPOSITORY_ID}`);
  });

  it('includes issue repository identities alongside current PR facts in one batch', async () => {
    const { result, transport } = await runScan({
      limit: 100,
      respond: (request) => {
        if (new URL(request.url).pathname === '/search/issues') {
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
        return undefined;
      },
    });

    expect(transport.requests.filter(request => new URL(request.url).pathname !== '/search/issues')).toHaveLength(1);
    expect(result.kind).toBe('complete');
    if (result.kind === 'failed') return;
    expect(result.observations).toHaveLength(15);
    expect(result.observations[2]).toMatchObject({ kind: 'present', localRef: {
      kindId: 'issue', collisionScope: `github:${GITHUB_FIXTURE_OTHER_REPOSITORY_ID}`,
    } });
  });
});
