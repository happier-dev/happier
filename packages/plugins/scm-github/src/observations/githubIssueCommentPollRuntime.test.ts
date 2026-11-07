import { describe, expect, it } from 'vitest';

import type {
  ConversationObservationV1,
  ConversationPollResultV1,
  ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';

import type { GithubApiClientV1, GithubApiResponseV1 } from './githubApiClient.js';
import {
  GithubIssueCommentCheckpointError,
  pollGithubIssueCommentsForChannels,
} from './githubIssueCommentPollRuntime.js';

type ConversationPollBatchResultV1 = Extract<ConversationPollResultV1, { kind: 'batch' }>;

/**
 * The polled Channels comment reader never performs the narrow manual-redirect
 * read reserved for the issue-transfer contract, so every fixture client
 * refuses it loudly rather than omitting it and hiding a real call.
 */
function refuseManualRedirectRead(): Promise<GithubApiResponseV1> {
  throw new Error(
    'The GitHub issue-comment poll runtime must not use the manual-redirect read.',
  );
}

const CONFIG = {
  v: 1 as const,
  repository: {
    v: 1 as const,
    repositoryId: '77',
    owner: 'acme',
    name: 'widgets',
    nameWithOwner: 'acme/widgets',
  },
  integrationPrincipal: { id: '99', label: 'happier-bot' },
};

function jsonResponse(value: unknown, headers: Readonly<Record<string, string>> = {}) {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({
      'x-ratelimit-remaining': '5000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1_000) + 3_600),
      ...headers,
    }),
    body: new TextEncoder().encode(JSON.stringify(value)),
  });
}

function pageUrl(page: number): string {
  const url = new URL('https://api.github.com/repos/acme/widgets/issues/comments');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('since', '2026-08-10T11:59:59Z');
  url.searchParams.set('per_page', '100');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function headUrlSince(since: string): string {
  const url = new URL('https://api.github.com/repos/acme/widgets/issues/comments');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('since', since);
  url.searchParams.set('per_page', '100');
  return url.toString();
}

function baselinePageUrl(page: number): string {
  const url = new URL('https://api.github.com/repos/acme/widgets/issues/comments');
  url.searchParams.set('sort', 'updated');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('per_page', '100');
  if (page > 1) url.searchParams.set('page', String(page));
  return url.toString();
}

function pollInput(input: Readonly<{
  client: GithubApiClientV1;
  checkpoint: unknown;
  limit: number;
  nowMs?: number;
}>) {
  return {
    client: input.client,
    config: CONFIG,
    checkpoint: input.checkpoint,
    limit: input.limit,
    nowMs: input.nowMs ?? Date.parse('2026-08-10T12:01:00.000Z'),
    // The provider checkpoint is scoped to the core-owned Channel connection,
    // not merely a repository-shaped URL. The cursor owner will consume these
    // fields when it persists an opaque Link continuation.
    connectionId: 'connection-1',
    providerConnectionKey: 'github:repository:77',
  };
}

function expectPollBatch(result: ConversationPollResultV1): ConversationPollBatchResultV1 {
  expect(result.kind).toBe('batch');
  if (result.kind !== 'batch') throw new Error(`Expected a GitHub poll batch, received ${result.kind}`);
  return result;
}

function fullTextObservations(result: ConversationPollBatchResultV1): readonly ConversationObservationV1[] {
  return result.observations.flatMap(({ observation }) => (
    observation.kind === 'fullText' ? [observation.observation] : []
  ));
}

type MutableGithubComment = { id: number; createdAt: string; updatedAt: string };

/**
 * A provider-faithful repository-comments endpoint: `sort=updated&direction=asc`
 * over a MUTABLE store, paged by offset. Editing a comment moves it to the end
 * of the ordering exactly as GitHub does, so page membership shifts under the
 * poller's feet. `afterRequest` runs once the response bytes are already frozen,
 * which models a mutation landing between two page requests.
 */
function createMutableIssueCommentsApi(input: Readonly<{
  comments: readonly MutableGithubComment[];
  pageSize: number;
  afterRequest?: (requestIndex: number, store: MutableGithubComment[]) => void;
}>): Readonly<{ client: GithubApiClientV1; requests: string[] }> {
  const store = input.comments.map((comment) => ({ ...comment }));
  const requests: string[] = [];
  const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
    async request({ url }) {
      const parsed = new URL(url);
      if (parsed.pathname === '/repos/acme/widgets/issues/1') {
        return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
      }
      if (parsed.pathname !== '/repos/acme/widgets/issues/comments') {
        throw new Error(`Unexpected GitHub request ${url}`);
      }
      const requestIndex = requests.length;
      requests.push(url);
      const since = parsed.searchParams.get('since');
      const sinceMs = since === null ? Number.NEGATIVE_INFINITY : Date.parse(since);
      const page = Number(parsed.searchParams.get('page') ?? '1');
      const ordered = store
        .filter((comment) => Date.parse(comment.updatedAt) >= sinceMs)
        .sort((left, right) => (
          Date.parse(left.updatedAt) - Date.parse(right.updatedAt) || left.id - right.id
        ));
      const start = (page - 1) * input.pageSize;
      const slice = ordered.slice(start, start + input.pageSize);
      const nextUrl = new URL(parsed.toString());
      nextUrl.searchParams.set('page', String(page + 1));
      const response = jsonResponse(slice.map((comment) => ({
        id: comment.id,
        body: `comment ${comment.id}`,
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
        user: { id: 123, login: 'octocat', type: 'User' },
      })), ordered.length > start + input.pageSize
        ? { link: `<${nextUrl.toString()}>; rel="next"` }
        : {});
      input.afterRequest?.(requestIndex, store);
      return response;
    },
  };
  return Object.freeze({ client, requests });
}

function secondlyComments(input: Readonly<{ firstId: number; count: number; firstSecond: number }>) {
  return Array.from({ length: input.count }, (_unused, index) => {
    const at = `2026-08-10T12:00:${String(input.firstSecond + index).padStart(2, '0')}Z`;
    return { id: input.firstId + index, createdAt: at, updatedAt: at };
  });
}

describe('GitHub issue-comment Channel polling', () => {
  it.each([false, true])('uses the account overview for a headerless 304 and keeps the complete checkpoint (overview headers: %s)', async overviewHeaders => {
    const nowMs = Date.parse('2026-08-10T12:01:00Z');
    const checkpoint = { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: 'head' };
    const requests: string[] = [];
    const result = await pollGithubIssueCommentsForChannels(pollInput({ nowMs, checkpoint, limit: 10, client: {
      requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        requests.push(url);
        if (new URL(url).pathname === '/rate_limit') {
          const headers: Readonly<Record<string, string>> = overviewHeaders
            ? { 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': String(nowMs / 1_000 + 600) } : {};
          return {
            status: 200, headers,
            // Headers are authoritative; the other bucket must never supply cadence.
            body: new TextEncoder().encode(JSON.stringify({ resources: {
              core: { remaining: overviewHeaders ? 999 : 10, reset: nowMs / 1_000 + 600 }, graphql: { remaining: 1, reset: nowMs / 1_000 + 60 },
            } })),
          };
        }
        return { status: 304, headers: {}, body: new Uint8Array() };
      },
    } }));
    expect(result).toEqual({ kind: 'batch', observations: [], checkpointAfterBatch: checkpoint, retryHint: { retryAfterMs: 60_000 } });
    expect(requests).toHaveLength(2);
    expect(requests[1]).toBe('https://api.github.com/rate_limit');
  });

  it('refuses malformed account-budget facts instead of committing a successful unpaced poll', async () => {
    const checkpoint = { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: 'head' };
    const before = structuredClone(checkpoint);
    await expect(pollGithubIssueCommentsForChannels(pollInput({ checkpoint, limit: 10, client: {
      requestWithoutFollowingRedirects: refuseManualRedirectRead,
      request: async ({ url }) => new URL(url).pathname === '/rate_limit'
        ? { status: 200, headers: {}, body: new TextEncoder().encode('{"resources":{"core":{"remaining":"unknown","reset":0}}}') }
        : { status: 304, headers: {}, body: new Uint8Array() },
    } }))).rejects.toMatchObject({ code: 'github_api_response_invalid' });
    expect(checkpoint).toEqual(before);
  });

  it.each([null, {
    v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: null,
  }])('paces a no-poll-header response from its remaining provider budget, including baseline %j', async checkpoint => {
    const nowMs = Date.parse('2026-08-10T12:01:00.000Z');
    const client: GithubApiClientV1 = {
      requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request() {
        return jsonResponse([], {
          'x-ratelimit-remaining': '10',
          'x-ratelimit-reset': String(nowMs / 1_000 + 600),
        });
      },
    };
    const result = await pollGithubIssueCommentsForChannels(pollInput({ client, checkpoint, limit: 10, nowMs }));
    expect(result).toMatchObject({ retryHint: { retryAfterMs: 60_000 } });
  });

  it('waits only until the provider reset when the next poll needs more reads than remain', async () => {
    const nowMs = Date.parse('2026-08-10T12:01:00.000Z');
    const result = await pollGithubIssueCommentsForChannels(pollInput({
      checkpoint: { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: null },
      limit: 10, nowMs,
      client: {
        requestWithoutFollowingRedirects: refuseManualRedirectRead,
        async request({ url }) {
          return jsonResponse(new URL(url).pathname.endsWith('/issues/1') ? { id: 5, number: 1 } : [{
            id: 2, body: 'New comment', created_at: '2026-08-10T12:00:30Z', updated_at: '2026-08-10T12:00:30Z',
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1', user: { id: 3, login: 'actor', type: 'User' },
          }], { 'x-ratelimit-remaining': '1', 'x-ratelimit-reset': String(nowMs / 1_000 + 600) });
        },
      },
    }));
    expect(result).toMatchObject({ retryHint: { retryAfterMs: 600_000 } });
    expect(fullTextObservations(expectPollBatch(result))).toHaveLength(1);
  });

  it.each<{ status: number; remaining: string; hints: Readonly<Record<string, string>>; delay: number }>([
    { status: 200, remaining: '10', hints: { 'X-Poll-Interval': '30', 'Retry-After': '90' }, delay: 90_000 },
    { status: 304, remaining: '10', hints: {}, delay: 60_000 },
    { status: 304, remaining: '0', hints: {}, delay: 600_000 },
  ])('preserves explicit waits and rate-budget pacing for response $status / remaining $remaining', async ({ status, remaining, hints, delay }) => {
    const nowMs = Date.parse('2026-08-10T12:01:00.000Z');
    const checkpoint = status === 304 ? {
      v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: 'head',
    } : null;
    const result = await pollGithubIssueCommentsForChannels(pollInput({ client: {
      requestWithoutFollowingRedirects: refuseManualRedirectRead,
      request: async () => ({ status, body: status === 304 ? new Uint8Array() : new TextEncoder().encode('[]'),
        headers: { ...hints, 'x-ratelimit-remaining': remaining, 'x-ratelimit-reset': String(nowMs / 1_000 + 600) } }),
    }, checkpoint, limit: 10, nowMs }));
    expect(result).toMatchObject({ retryHint: { retryAfterMs: delay } });
    if (checkpoint !== null) expect(result).toMatchObject({ checkpointAfterBatch: checkpoint });
  });

  it('walks past ten provider pages to the comment cursor end in one admitted poll', async () => {
    const comments = secondlyComments({ firstId: 2, count: 24, firstSecond: 1 });
    const boundary = createMutableIssueCommentsApi({ comments, pageSize: 2 });
    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client: boundary.client,
      checkpoint: { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: null },
      limit: 100,
    })));

    expect(fullTextObservations(result)).toHaveLength(comments.length);
    expect(result.checkpointAfterBatch).toMatchObject({
      updatedAtIso: new Date(comments.at(-1)!.updatedAt).toISOString(),
      commentIdAtUpdatedAt: String(comments.at(-1)!.id),
    });
    expect(boundary.requests.length).toBeGreaterThan(10);
  });

  it('retains admitted linked-PR identities across equal successful polls and replaces only changed state', async () => {
    let state = 'open';
    let pullReads = 0;
    const client: GithubApiClientV1 = {
      requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        const path = new URL(url).pathname;
        if (path === '/repos/acme/widgets/issues/comments') return jsonResponse([]);
        if (path === '/repositories/77/pulls/1') {
          pullReads += 1;
          return jsonResponse({ number: 1, base: { repo: { id: 77 } }, state, merged: state === 'merged' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };
    const endpoint: ConversationResolvedEndpointV1 = {
      kind: 'githubPullRequest', audience: 'shared', id: 'github:repository:77:issue:5:number:1',
      pullRequest: { repository: 'acme/widgets', number: 1 },
      pullRequestState: { state: 'open', observedAt: 10 },
    };
    let previous = endpoint;
    let changedEndpoints = 0;
    for (const nowMs of [20, 30, 40]) {
      const result = await pollGithubIssueCommentsForChannels({ ...pollInput({ client, checkpoint: null, limit: 100, nowMs }),
        pullRequestEndpoints: [previous] });
      if (result.kind !== 'checkpointOnly') throw new Error('Expected no-history checkpoint.');
      const next = result.pullRequestEndpoints?.[0];
      if (next?.kind !== 'githubPullRequest') throw new Error('Expected the retained PR endpoint.');
      if (next !== previous) changedEndpoints += 1;
      previous = next;
    }
    expect(changedEndpoints).toBe(0);
    expect(previous).toBe(endpoint);
    expect(previous.pullRequestState).toBe(endpoint.pullRequestState);
    state = 'merged';
    const changed = await pollGithubIssueCommentsForChannels({ ...pollInput({ client, checkpoint: null, limit: 100, nowMs: 50 }),
      pullRequestEndpoints: [previous] });
    if (changed.kind !== 'checkpointOnly') throw new Error('Expected no-history checkpoint.');
    const terminal = changed.pullRequestEndpoints?.[0];
    if (terminal?.kind !== 'githubPullRequest') throw new Error('Expected the terminal endpoint.');
    expect(terminal).not.toBe(endpoint);
    expect(terminal.pullRequest).toBe(endpoint.pullRequest);
    expect(terminal.pullRequestState).toEqual({ state: 'merged', observedAt: 50 });
    state = 'open';
    const readsBeforeReopen = pullReads;
    const reopened = await pollGithubIssueCommentsForChannels({ ...pollInput({ client, checkpoint: null, limit: 100, nowMs: 60 }),
      // Several Session links can retain the same PR with different baselines.
      // A stale later row must not hide a transition from the newest baseline.
      pullRequestEndpoints: [terminal, endpoint] });
    if (reopened.kind !== 'checkpointOnly') throw new Error('Expected no-history checkpoint.');
    expect(reopened.pullRequestEndpoints?.[0]).toMatchObject({ pullRequestState: { state: 'open', observedAt: 60 } });
    expect(pullReads - readsBeforeReopen).toBe(1);
  });

  it('establishes an eleven-page no-history tail without admitting history before polling only post-baseline comments', async () => {
    const commentPageRequests: string[] = [];
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          commentPageRequests.push(url);
          if (parsed.searchParams.has('since')) {
            return jsonResponse([{
              id: 1101,
              body: 'post-baseline comment',
              created_at: '2026-08-10T12:00:12Z',
              updated_at: '2026-08-10T12:00:12Z',
              issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
              user: { id: 123, login: 'octocat', type: 'User' },
            }]);
          }
          const page = Number(parsed.searchParams.get('page') ?? '1');
          const firstId = ((page - 1) * 100) + 1;
          const comments = Array.from({ length: 100 }, (_, index) => {
            const id = firstId + index;
            const second = String(page).padStart(2, '0');
            return {
              id,
              body: `historical comment ${id}`,
              created_at: `2026-08-10T12:00:${second}Z`,
              updated_at: `2026-08-10T12:00:${second}Z`,
              issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
              user: { id: 123, login: 'octocat', type: 'User' },
            };
          });
          const next = page < 11 ? baselinePageUrl(page + 1) : null;
          return jsonResponse(comments, {
            ...(page === 1 ? { etag: 'baseline-head-etag' } : {}),
            ...(next === null
              ? {}
              : {
                link: page === 1
                  ? `<${next}>; rel="next", <${baselinePageUrl(11)}>; rel="last"`
                  : `<${next}>; rel="next"`,
              }),
          });
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };

    const baseline = await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: null,
      limit: 10,
    }));
    expect(baseline).toMatchObject({
      kind: 'checkpointOnly',
      checkpointAfterBatch: {
        updatedAtIso: '2026-08-10T12:00:11.000Z',
        commentIdAtUpdatedAt: '1100',
      },
    });
    if (baseline.kind !== 'checkpointOnly') {
      throw new Error(`Expected a GitHub checkpoint-only baseline, received ${baseline.kind}`);
    }
    expect(commentPageRequests).toEqual([baselinePageUrl(1), baselinePageUrl(11)]);

    const next = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: baseline.checkpointAfterBatch,
      limit: 10,
    })));
    expect(fullTextObservations(next).map((observation) => observation.message.id)).toEqual(['1101']);
    expect(commentPageRequests).toHaveLength(3);
    expect(new URL(commentPageRequests.at(-1)!).searchParams.get('since')).toBe('2026-08-10T12:00:10Z');
  });

  it('keeps a comment that arrives in the same GitHub timestamp second as an empty baseline eligible without trusting Markdown addressing', async () => {
    let commentPageReads = 0;
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          commentPageReads += 1;
          if (commentPageReads === 1) return jsonResponse([], { etag: 'empty-baseline-etag' });
          return jsonResponse([{
            id: 1,
            body: '@happier-bot arrived after the baseline read',
            created_at: '2026-08-10T12:00:00Z',
            updated_at: '2026-08-10T12:00:00Z',
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }], { etag: 'same-second-etag' });
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };

    const baseline = await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: null,
      limit: 10,
      nowMs: Date.parse('2026-08-10T12:00:00.500Z'),
    }));
    expect(baseline).toMatchObject({
      kind: 'checkpointOnly',
      checkpointAfterBatch: {
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '0',
      },
    });
    if (baseline.kind !== 'checkpointOnly') {
      throw new Error(`Expected a GitHub checkpoint-only baseline, received ${baseline.kind}`);
    }

    const next = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: baseline.checkpointAfterBatch,
      limit: 10,
    })));
    expect(fullTextObservations(next).map((observation) => observation.message.id)).toEqual(['1']);
    expect(next.observations).toMatchObject([{
      // GitHub's Channel poll is only a conversation ingress producer. Its
      // separate repository Event observer owns GitHub Automation events, so
      // this entry must not mint a second Event candidate.
      eventCandidate: null,
      observation: {
        kind: 'fullText',
        observation: {
          endpoint: { kind: 'githubIssue', audience: 'shared' },
          message: {
            text: '@happier-bot arrived after the baseline read',
            addressingEvidence: 'none',
          },
        },
      },
    }]);
  });

  it('uses a complete-head ETag only for a 304 poll and preserves the checkpoint without observations', async () => {
    const requests: Array<Readonly<{ url: string; headers: Readonly<Record<string, string>> | undefined }>> = [];
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url, headers }) {
        requests.push({ url, headers });
        return Object.freeze({
          status: 304,
          headers: Object.freeze({ 'x-poll-interval': '30' }),
          body: new Uint8Array(),
        });
      },
    };
    const checkpoint = {
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: 'complete-head-etag',
    };

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint,
      limit: 10,
      nowMs: Date.parse('2026-08-10T12:01:00.000Z'),
    })));

    expect(requests).toEqual([{
      url: pageUrl(1),
      headers: { 'If-None-Match': 'complete-head-etag' },
    }]);
    expect(result).toEqual({
      kind: 'batch',
      observations: [],
      checkpointAfterBatch: { ...checkpoint },
      retryHint: { retryAfterMs: 30_000 },
    });
  });

  it('preserves an over-24-hour GitHub poll interval in the strict retry hint', async () => {
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request() {
        return Object.freeze({
          status: 304,
          headers: Object.freeze({ 'x-poll-interval': '86401' }),
          body: new Uint8Array(),
        });
      },
    };
    const checkpoint = {
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: 'complete-head-etag',
    };

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint,
      limit: 10,
    })));

    expect(result).toMatchObject({
      retryHint: { retryAfterMs: 86_401_000 },
    });
  });

  it('returns an edited comment as bodyless routable non-admission while advancing its checkpoint', async () => {
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        if (new URL(url).pathname === '/repos/acme/widgets/issues/comments') {
          return jsonResponse([{
            id: 9,
            body: 'an edited comment must not be re-admitted',
            created_at: '2026-08-10T12:00:00Z',
            updated_at: '2026-08-10T12:00:01Z',
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }]);
        }
        if (new URL(url).pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
    })));

    expect(result).toMatchObject({
      kind: 'batch',
      observations: [{
        eventCandidate: null,
        observation: {
          kind: 'routableNonAdmission',
          reason: 'unsupportedEdit',
          shell: {
            occurrenceId: 'github:repository:77:issue-comment:9',
            message: {
              id: '9',
              revision: '2026-08-10T12:00:01.000Z',
            },
          },
        },
      }],
      checkpointAfterBatch: {
        updatedAtIso: '2026-08-10T12:00:01.000Z',
        commentIdAtUpdatedAt: '9',
      },
    });
    expect(result.observations[0]?.observation).not.toHaveProperty('shell.streamKey');
  });

  it('keeps the latest revision of a comment edited between overlapping window requests', async () => {
    const { client, requests } = createMutableIssueCommentsApi({
      pageSize: 4,
      comments: secondlyComments({ firstId: 9, count: 5, firstSecond: 1 }),
      afterRequest: (requestIndex, store) => {
        if (requestIndex !== 0) return;
        const edited = store.find((comment) => comment.id === 9);
        if (edited === undefined) throw new Error('The mutable fixture lost its edited comment');
        edited.updatedAt = '2026-08-10T12:00:06Z';
      },
    });

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
    })));

    expect(requests.length).toBeGreaterThan(1);
    const commentNine = result.observations.filter(({ observation }) => (
      (observation.kind === 'fullText' ? observation.observation : observation.shell).message.id === '9'
    ));
    expect(commentNine).toEqual([
      expect.objectContaining({
        eventCandidate: null,
        observation: expect.objectContaining({
          kind: 'routableNonAdmission',
          reason: 'unsupportedEdit',
          shell: expect.objectContaining({
            occurrenceId: 'github:repository:77:issue-comment:9',
            message: expect.objectContaining({ id: '9', revision: '2026-08-10T12:00:06.000Z' }),
          }),
        }),
      }),
    ]);
    expect(result.checkpointAfterBatch).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:06.000Z',
      commentIdAtUpdatedAt: '9',
    });
  });

  it('coalesces identical issue-comment revisions repeated by overlapping window requests', async () => {
    const { client, requests } = createMutableIssueCommentsApi({
      pageSize: 4,
      comments: secondlyComments({ firstId: 101, count: 6, firstSecond: 1 }),
    });

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
    })));

    // Restarting each request at the fully observed boundary deliberately
    // re-reads the preceding second, so the same revision arrives more than once.
    expect(requests.length).toBeGreaterThan(1);
    expect(fullTextObservations(result).map((observation) => observation.message.id))
      .toEqual(['101', '102', '103', '104', '105', '106']);
    expect(result.checkpointAfterBatch).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:06.000Z',
      commentIdAtUpdatedAt: '106',
    });
  });

  it('keeps the latest authenticated snapshot when same-second comment evidence changes during traversal', async () => {
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/1') return jsonResponse({ id: 5, number: 1 });
        if (parsed.pathname === '/repos/acme/widgets/issues/2') return jsonResponse({ id: 6, number: 2 });
        if (parsed.pathname !== '/repos/acme/widgets/issues/comments') throw new Error(`Unexpected GitHub request ${url}`);
        const since = parsed.searchParams.get('since');
        const comment = (id: number, second: string, issueNumber: number) => ({
          id,
          body: 'same revision',
          created_at: `2026-08-10T12:00:${second}Z`,
          updated_at: `2026-08-10T12:00:${second}Z`,
          issue_url: `https://api.github.com/repos/acme/widgets/issues/${issueNumber}`,
          user: { id: 123, login: 'octocat', type: 'User' },
        });
        if (since === '2026-08-10T11:59:59Z') {
          return jsonResponse([
            comment(9, '01', 1),
            comment(10, '02', 1),
            comment(11, '03', 1),
            comment(12, '04', 1),
          ], { link: `<${headUrlSince('2026-08-10T11:59:59Z')}&page=2>; rel="next"` });
        }
        return jsonResponse([
          comment(10, '02', 1),
          comment(11, '03', 1),
          comment(12, '04', 2),
          comment(13, '05', 1),
        ]);
      },
    };

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
    })));
    expect(fullTextObservations(result).map(row => row.message.id)).toEqual(['9', '10', '11', '12', '13']);
    expect(fullTextObservations(result).find(row => row.message.id === '12')?.endpoint.id)
      .toBe('github:repository:77:issue:6:number:2');
  });

  it('caps a batch at the Channels limit and resumes the remainder from the committed boundary', async () => {
    const { client } = createMutableIssueCommentsApi({
      pageSize: 4,
      comments: secondlyComments({ firstId: 101, count: 10, firstSecond: 1 }),
    });
    const checkpoint = {
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '100',
      etag: null,
    };

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint,
      limit: 5,
    })));
    expect(fullTextObservations(first).map((observation) => observation.message.id))
      .toEqual(['101', '102', '103', '104', '105']);
    expect(first.checkpointAfterBatch).toEqual({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:05.000Z',
      commentIdAtUpdatedAt: '105',
      etag: null,
    });

    const second = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: first.checkpointAfterBatch,
      limit: 5,
    })));
    expect(fullTextObservations(second).map((observation) => observation.message.id))
      .toEqual(['106', '107', '108', '109', '110']);
  });

  it('finishes every equal-time group before committing the complete provider window', async () => {
    // Two comments share every update second; no local request slice may leave
    // an unseen sibling behind the committed provider position.
    const paired = Array.from({ length: 30 }, (_unused, index) => {
      const at = `2026-08-10T12:00:${String(Math.floor(index / 2) + 1).padStart(2, '0')}Z`;
      return { id: 101 + index, createdAt: at, updatedAt: at };
    });
    const { client, requests } = createMutableIssueCommentsApi({ pageSize: 8, comments: paired });

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '100',
        etag: null,
      },
      limit: 100,
    })));
    const firstIds = fullTextObservations(first).map((observation) => observation.message.id);
    expect(requests.length).toBeGreaterThan(10);
    expect(first.checkpointAfterBatch).toEqual({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:15.000Z',
      commentIdAtUpdatedAt: '130',
      etag: null,
    });
    expect(firstIds).toEqual(paired.map(comment => String(comment.id)));

    const second = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: first.checkpointAfterBatch,
      limit: 100,
    })));
    expect(fullTextObservations(second)).toEqual([]);
    expect(second.checkpointAfterBatch).toEqual(first.checkpointAfterBatch);
  });

  it.each([6, 42])('traverses %s same-second comments through native pages without a history gap', async (count) => {
    const { client, requests } = createMutableIssueCommentsApi({
      pageSize: 4,
      comments: Array.from({ length: count }, (_unused, index) => ({
        id: 101 + index,
        createdAt: '2026-08-10T12:00:01Z',
        updatedAt: '2026-08-10T12:00:01Z',
      })),
    });

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '100',
        etag: null,
      },
      limit: 100,
    })));
    expect(fullTextObservations(first).map(row => row.message.id))
      .toEqual(Array.from({ length: count }, (_unused, index) => String(101 + index)));
    expect(requests).toHaveLength(Math.ceil(count / 4));
    const replay = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client, checkpoint: first.checkpointAfterBatch, limit: 100,
    })));
    expect(replay.observations).toEqual([]);
    expect(replay.checkpointAfterBatch).toEqual(first.checkpointAfterBatch);
  });

  it('reports a history gap when GitHub emits a present malformed Link header', async () => {
    const client: GithubApiClientV1 = {
      requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        if (new URL(url).pathname !== '/repos/acme/widgets/issues/comments') {
          throw new Error(`Malformed pagination must stop before issue materialization: ${url}`);
        }
        return jsonResponse([], { link: 'not-a-link-value' });
      },
    };

    await expect(pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '100',
        etag: null,
      },
      limit: 10,
    }))).resolves.toEqual({
      kind: 'historyGap',
      reason: 'providerHistoryUnavailable',
    });
  });

  it('turns malformed persisted checkpoints into reset attention before any provider request or checkpoint mutation', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        requests.push(url);
        return jsonResponse([]);
      },
    };
    const malformedCheckpoints = [
      { v: 2, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: null },
      { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', etag: null },
      { v: 1, updatedAtIso: 'not a timestamp', commentIdAtUpdatedAt: '1', etag: null },
      { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: 'ten', etag: null },
      { v: 1, updatedAtIso: '2026-08-10T12:00:00.000Z', commentIdAtUpdatedAt: '1', etag: 12 },
    ];
    for (const checkpoint of malformedCheckpoints) {
      const before = structuredClone(checkpoint);
      await expect(pollGithubIssueCommentsForChannels(pollInput({ client, checkpoint, limit: 10 })))
        .rejects.toBeInstanceOf(GithubIssueCommentCheckpointError);
      expect(checkpoint).toEqual(before);
    }
    expect(requests).toEqual([]);
  });

  it('ignores a predecessor checkpoint continuation payload and restarts at its stable ordering boundary', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        requests.push(url);
        return jsonResponse([], { etag: 'fresh-head-etag' });
      },
    };

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        // A predecessor build persisted an opaque provider page URL here. The
        // ordered boundary is the only checkpoint fact, so the URL is ignored
        // rather than followed or treated as corruption.
        continuation: {
          transport: 'poll',
          connectionId: 'superseded-connection',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          url: `${headUrlSince('2026-08-10T11:59:59Z')}&page=11`,
        },
      },
      limit: 10,
    })));

    expect(requests).toEqual([pageUrl(1)]);
    expect(result.checkpointAfterBatch).toEqual({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: 'fresh-head-etag',
    });
  });

  // RFC 8288 spells one `Link` relation several equivalent ways: the `rel` parameter
  // may be unquoted, may be preceded by other link parameters, and may be cased
  // differently. A private `split(',')` + anchored-regex parse silently reads NO next
  // page from those spellings and reports a finished collection the provider never
  // stated. This asserts the contract by comparison: an equivalently spelled header
  // must produce the same walk as the canonical one, whatever that walk is.
  it.each([
    ['canonical', (next: string) => `<${next}>; rel="next"`],
    ['unquoted rel', (next: string) => `<${next}>; rel=next`],
    ['a link parameter before rel', (next: string) => `<${next}>; type="application/json"; rel="next"`],
    ['a link parameter after rel', (next: string) => `<${next}>; rel="next"; type="application/json"`],
    ['an upper-cased rel', (next: string) => `<${next}>; rel="NEXT"`],
  ])('continues the window when the Link header spells its next relation with %s', async (_label, writeLink) => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          requests.push(url);
          const comment = (id: number, second: string) => ({
            id,
            body: `comment ${id}`,
            created_at: `2026-08-10T12:00:0${second}Z`,
            updated_at: `2026-08-10T12:00:0${second}Z`,
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          });
          if (parsed.searchParams.get('since') === '2026-08-10T11:59:59Z') {
            return jsonResponse(
              [comment(101, '1'), comment(102, '2')],
              { link: writeLink(`${headUrlSince('2026-08-10T11:59:59Z')}&page=2`) },
            );
          }
          return jsonResponse([comment(102, '2'), comment(103, '3')]);
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '100',
        etag: null,
      },
      limit: 10,
    })));

    expect(requests).toEqual([pageUrl(1), headUrlSince('2026-08-10T12:00:00Z')]);
    expect(fullTextObservations(result).map((observation) => observation.message.id))
      .toEqual(['101', '102', '103']);
  });

  it('still observes every comment when an already-read comment is edited between page requests', async () => {
    const { client } = createMutableIssueCommentsApi({
      pageSize: 4,
      comments: secondlyComments({ firstId: 101, count: 8, firstSecond: 10 }),
      afterRequest: (requestIndex, store) => {
        if (requestIndex !== 0) return;
        // GitHub orders this endpoint by the MUTABLE `updated_at`. Editing a
        // comment the poll already read removes it from the ordered prefix and
        // shifts every later comment one slot earlier, so the comment that was
        // first on the provider's next page moves onto the consumed page.
        const edited = store.find((comment) => comment.id === 101);
        if (edited === undefined) throw new Error('The mutable fixture lost its edited comment');
        edited.updatedAt = '2026-08-10T12:00:20Z';
      },
    });

    const result = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:09.000Z',
        commentIdAtUpdatedAt: '100',
        etag: null,
      },
      limit: 20,
    })));

    expect(fullTextObservations(result).map((observation) => observation.message.id)).toEqual([
      '102', '103', '104', '105', '106', '107', '108',
    ]);
    expect(result.observations.at(-1)).toMatchObject({
      eventCandidate: null,
      observation: {
        kind: 'routableNonAdmission',
        reason: 'unsupportedEdit',
        shell: { message: { id: '101' } },
      },
    });
    expect(result.checkpointAfterBatch).toEqual({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:20.000Z',
      commentIdAtUpdatedAt: '101',
      etag: null,
    });
  });
});
