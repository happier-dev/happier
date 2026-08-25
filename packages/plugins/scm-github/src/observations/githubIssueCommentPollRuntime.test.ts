import { describe, expect, it } from 'vitest';

import type {
  ConversationObservationV1,
  ConversationPollResultV1,
} from '@happier-dev/channels-protocol/v1';
import { MAX_CONVERSATION_RETRY_AFTER_MS } from '@happier-dev/channels-protocol/v1';

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
    headers: Object.freeze(headers),
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
        continuation: null,
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

  it('clamps an over-24-hour GitHub poll interval before returning the strict retry hint', async () => {
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
      retryHint: { retryAfterMs: MAX_CONVERSATION_RETRY_AFTER_MS },
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

  it('reports a history gap for contradictory same-revision issue-comment identity across window requests', async () => {
    const client: GithubApiClientV1 = {
    requestWithoutFollowingRedirects: refuseManualRedirectRead,
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname !== '/repos/acme/widgets/issues/comments') {
          throw new Error(`A contradictory revision must stop before issue materialization: ${url}`);
        }
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

    await expect(pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '8',
        etag: null,
      },
      limit: 10,
    }))).resolves.toEqual({
      kind: 'historyGap',
      reason: 'providerHistoryUnavailable',
    });
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

  it('never commits inside an update second the bounded window left open, and resumes it whole', async () => {
    // Two comments share every update second, so the window boundary lands
    // inside a group whose lower comment ID could still be unseen.
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
    expect(requests).toHaveLength(10);
    expect(first.checkpointAfterBatch).toEqual({
      v: 1,
      updatedAtIso: '2026-08-10T12:00:12.000Z',
      commentIdAtUpdatedAt: '124',
      etag: null,
    });
    expect(firstIds.at(-1)).toBe('124');

    const second = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: first.checkpointAfterBatch,
      limit: 100,
    })));
    const secondIds = fullTextObservations(second).map((observation) => observation.message.id);

    // 125 and 126 share one update second at the first window's boundary.
    expect(secondIds).toEqual(['125', '126', '127', '128', '129', '130']);
    expect([...firstIds, ...secondIds]).toEqual(paired.map((comment) => String(comment.id)));
  });

  it('reports explicit incompleteness when one update second exceeds a provider page', async () => {
    const { client, requests } = createMutableIssueCommentsApi({
      pageSize: 4,
      comments: Array.from({ length: 6 }, (_unused, index) => ({
        id: 101 + index,
        createdAt: '2026-08-10T12:00:01Z',
        updatedAt: '2026-08-10T12:00:01Z',
      })),
    });

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
    expect(requests).toHaveLength(1);
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
