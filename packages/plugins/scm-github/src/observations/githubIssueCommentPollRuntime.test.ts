import { describe, expect, it } from 'vitest';

import type {
  ConversationObservationV1,
  ConversationPollResultV1,
} from '@happier-dev/channels-protocol/v1';
import { MAX_CONVERSATION_RETRY_AFTER_MS } from '@happier-dev/channels-protocol/v1';

import type { GithubApiClientV1 } from './githubApiClient.js';
import {
  GithubIssueCommentCheckpointError,
  pollGithubIssueCommentsForChannels,
} from './githubIssueCommentPollRuntime.js';

type ConversationPollBatchResultV1 = Extract<ConversationPollResultV1, { kind: 'batch' }>;

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
  return result.observations.flatMap((ingress) => (
    ingress.kind === 'fullText' ? [ingress.observation] : []
  ));
}

describe('GitHub issue-comment Channel polling', () => {
  it('establishes an eleven-page no-history tail without admitting history before polling only post-baseline comments', async () => {
    const commentPageRequests: string[] = [];
    const client: GithubApiClientV1 = {
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
        continuation: null,
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
      kind: 'fullText',
      observation: {
        endpoint: { kind: 'githubIssue', audience: 'shared' },
        message: {
          text: '@happier-bot arrived after the baseline read',
          addressingEvidence: 'none',
        },
      },
    }]);
  });

  it('uses a complete-head ETag only for a 304 poll and preserves the checkpoint without observations', async () => {
    const requests: Array<Readonly<{ url: string; headers: Readonly<Record<string, string>> | undefined }>> = [];
    const client: GithubApiClientV1 = {
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
      checkpointAfterBatch: { ...checkpoint, continuation: null },
      retryHint: { retryAfterMs: 30_000 },
    });
  });

  it('clamps an over-24-hour GitHub poll interval before returning the strict retry hint', async () => {
    const client: GithubApiClientV1 = {
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
        kind: 'routableNonAdmission',
        reason: 'unsupportedEdit',
        shell: {
          occurrenceId: 'github:repository:77:issue-comment:9',
          message: {
            id: '9',
            revision: '2026-08-10T12:00:01.000Z',
          },
        },
      }],
      checkpointAfterBatch: {
        updatedAtIso: '2026-08-10T12:00:01.000Z',
        commentIdAtUpdatedAt: '9',
      },
    });
    expect(result.observations[0]).not.toHaveProperty('shell.streamKey');
  });

  it('replays a capped page with bounded stable-occurrence duplicates and still reaches its final cursor', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
      async request({ url }) {
        requests.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          const page = Number(parsed.searchParams.get('page') ?? '1');
          const next = page < 11 ? pageUrl(page + 1) : null;
          const second = page === 1 ? '00' : String(page).padStart(2, '0');
          return jsonResponse([{
            id: page,
            body: `comment ${page}`,
            created_at: `2026-08-10T12:00:${second}Z`,
            updated_at: `2026-08-10T12:00:${second}Z`,
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }], {
            ...(page === 1 ? { etag: 'first-page-etag' } : {}),
            ...(next === null ? {} : { link: `<${next}>; rel="next"` }),
          });
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: 'prior-etag',
      },
      limit: 1,
    })));
    expect(first).toMatchObject({
      kind: 'batch',
      observations: [{
        kind: 'fullText',
        observation: expect.objectContaining({
          occurrenceId: 'github:repository:77:issue-comment:2',
          transport: { kind: 'poll' },
        }),
      }],
      checkpointAfterBatch: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        continuation: {
          transport: 'poll',
          connectionId: 'connection-1',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:02.000Z',
            commentIdAtUpdatedAt: '2',
          },
          replayCursor: {
            updatedAtIso: '2026-08-10T12:00:02.000Z',
            commentIdAtUpdatedAt: '2',
          },
          url: pageUrl(1),
        },
      },
    });
    expect(requests.filter((url) => new URL(url).pathname.endsWith('/issues/comments'))).toHaveLength(10);

    const replayBatches: ConversationPollBatchResultV1[] = [];
    let checkpoint: unknown = first.checkpointAfterBatch;
    for (let replay = 0; replay < 20; replay += 1) {
      const batch = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
        client,
        checkpoint,
        limit: 1,
      })));
      replayBatches.push(batch);
      checkpoint = batch.checkpointAfterBatch;
    }

    expect(replayBatches[0]).toMatchObject({
      observations: [],
      checkpointAfterBatch: {
        continuation: {
          url: pageUrl(2),
        },
      },
    });
    expect(replayBatches[0]?.checkpointAfterBatch).not.toHaveProperty('continuation.replayCursor');
    const observations = [first, ...replayBatches].flatMap(fullTextObservations);
    expect(observations.map((observation) => observation.message.id)).toEqual([
      '2', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11',
    ]);
    expect(observations[0]?.occurrenceId).toBe('github:repository:77:issue-comment:2');
    expect(observations[1]?.occurrenceId).toBe(observations[0]?.occurrenceId);
    expect(replayBatches.at(-1)).toMatchObject({
      checkpointAfterBatch: {
        updatedAtIso: '2026-08-10T12:00:11.000Z',
        commentIdAtUpdatedAt: '11',
        continuation: null,
      },
    });
    expect(requests.filter((url) => new URL(url).pathname.endsWith('/issues/comments'))).toHaveLength(75);
  });

  it('does not lend a capped page replay cursor to a later Link page with a lower-ID edit in the same timestamp window', async () => {
    let pageTwoReads = 0;
    const client: GithubApiClientV1 = {
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          const page = Number(parsed.searchParams.get('page') ?? '1');
          if (page === 1) {
            return jsonResponse([{
              id: 100,
              body: 'first new comment',
              created_at: '2026-08-10T12:00:00Z',
              updated_at: '2026-08-10T12:00:00Z',
              issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
              user: { id: 123, login: 'octocat', type: 'User' },
            }], { link: `<${pageUrl(2)}>; rel="next"` });
          }
          pageTwoReads += 1;
          if (pageTwoReads === 1) {
            return jsonResponse([{
              id: 101,
              body: 'unseen page-two comment',
              created_at: '2026-08-10T12:00:00Z',
              updated_at: '2026-08-10T12:00:00Z',
              issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
              user: { id: 123, login: 'octocat', type: 'User' },
            }]);
          }
          return jsonResponse([{
            id: 50,
            body: 'an older comment edited during the replay window',
            created_at: '2026-08-10T11:00:00Z',
            updated_at: '2026-08-10T12:00:00Z',
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }]);
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`An unsupported edit must not fetch issue metadata: ${url}`);
      },
    };
    const checkpoint = {
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: null,
    };

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint,
      limit: 1,
    })));
    expect(fullTextObservations(first).map((observation) => observation.message.id)).toEqual(['100']);
    expect(first.checkpointAfterBatch.continuation).toMatchObject({
      url: pageUrl(1),
      replayCursor: {
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '100',
      },
    });

    const replay = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: first.checkpointAfterBatch,
      limit: 1,
    })));
    expect(replay).toMatchObject({
      observations: [],
      checkpointAfterBatch: {
        continuation: {
          url: pageUrl(2),
        },
      },
    });
    expect(replay.checkpointAfterBatch).not.toHaveProperty('continuation.replayCursor');

    const laterPage = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: replay.checkpointAfterBatch,
      limit: 1,
    })));
    expect(laterPage).toMatchObject({
      observations: [{
        kind: 'routableNonAdmission',
        reason: 'unsupportedEdit',
        shell: {
          occurrenceId: 'github:repository:77:issue-comment:50',
        },
      }],
    });
  });

  it('continues from page 11 after classifying the bounded ten-page Link window', async () => {
    const commentPageRequests: Array<Readonly<{ url: string; headers: Readonly<Record<string, string>> | undefined }>> = [];
    const client: GithubApiClientV1 = {
      async request({ url, headers }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          commentPageRequests.push({ url, headers });
          const page = Number(parsed.searchParams.get('page') ?? '1');
          const next = page < 11 ? pageUrl(page + 1) : null;
          const second = page === 1 ? '00' : String(page).padStart(2, '0');
          return jsonResponse([{
            id: page,
            body: `comment ${page}`,
            created_at: `2026-08-10T12:00:${second}Z`,
            updated_at: `2026-08-10T12:00:${second}Z`,
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }], {
            ...(page === 1 ? { etag: 'first-page-etag' } : {}),
            ...(next === null ? {} : { link: `<${next}>; rel="next"` }),
          });
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };
    const initialCheckpoint = {
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: 'prior-etag',
    };

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: initialCheckpoint,
      limit: 10,
    })));
    expect(fullTextObservations(first).map((observation) => observation.message.id)).toEqual([
      '2', '3', '4', '5', '6', '7', '8', '9', '10',
    ]);
    expect(first.checkpointAfterBatch).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: null,
      continuation: expect.objectContaining({
        filterSince: '2026-08-10T11:59:59Z',
        windowHighWatermark: {
          updatedAtIso: '2026-08-10T12:00:10.000Z',
          commentIdAtUpdatedAt: '10',
        },
        url: pageUrl(11),
      }),
    });
    expect(commentPageRequests.map((request) => request.url)).toEqual([
      pageUrl(1), pageUrl(2), pageUrl(3), pageUrl(4), pageUrl(5),
      pageUrl(6), pageUrl(7), pageUrl(8), pageUrl(9), pageUrl(10),
    ]);

    const second = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: first.checkpointAfterBatch,
      limit: 10,
    })));
    expect(fullTextObservations(second).map((observation) => observation.message.id)).toEqual(['11']);
    expect(second.checkpointAfterBatch).toMatchObject({
      commentIdAtUpdatedAt: '11',
      etag: null,
      continuation: null,
    });
    expect(commentPageRequests.map((request) => request.url)).toEqual([
      pageUrl(1), pageUrl(2), pageUrl(3), pageUrl(4), pageUrl(5),
      pageUrl(6), pageUrl(7), pageUrl(8), pageUrl(9), pageUrl(10), pageUrl(11),
    ]);
    expect(commentPageRequests.at(-1)?.headers).toEqual({});
  });

  it('does not lose a lower comment ID at the same timestamp on a later Link page', async () => {
    const client: GithubApiClientV1 = {
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          const page = Number(parsed.searchParams.get('page') ?? '1');
          const commentId = page === 11 ? 50 : 99 + page;
          const next = page < 11 ? pageUrl(page + 1) : null;
          return jsonResponse([{
            id: commentId,
            body: `comment ${commentId}`,
            created_at: '2026-08-10T12:00:00Z',
            updated_at: '2026-08-10T12:00:00Z',
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }], next === null ? {} : { link: `<${next}>; rel="next"` });
        }
        if (parsed.pathname === '/repos/acme/widgets/issues/1') {
          return jsonResponse({ id: 5, number: 1, title: 'Issue title' });
        }
        throw new Error(`Unexpected GitHub request ${url}`);
      },
    };
    const checkpoint = {
      v: 1,
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      etag: null,
    };

    const first = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({ client, checkpoint, limit: 10 })));
    expect(fullTextObservations(first).map((observation) => observation.message.id)).toEqual([
      '100', '101', '102', '103', '104', '105', '106', '107', '108', '109',
    ]);
    expect(first.checkpointAfterBatch).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '1',
      continuation: expect.objectContaining({
        url: pageUrl(11),
        windowHighWatermark: {
          updatedAtIso: '2026-08-10T12:00:00.000Z',
          commentIdAtUpdatedAt: '109',
        },
      }),
    });

    const second = expectPollBatch(await pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: first.checkpointAfterBatch,
      limit: 10,
    })));

    expect(fullTextObservations(second).map((observation) => observation.message.id)).toEqual(['50']);
    expect(second.checkpointAfterBatch).toMatchObject({
      updatedAtIso: '2026-08-10T12:00:00.000Z',
      commentIdAtUpdatedAt: '109',
      continuation: null,
    });
  });

  it('returns a provider history-gap result for a same-page Link loop instead of persisting a continuation', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
      async request({ url }) {
        requests.push(url);
        return jsonResponse([{
          id: 1,
          body: 'already checkpointed',
          created_at: '2026-08-10T12:00:00Z',
          updated_at: '2026-08-10T12:00:00Z',
          issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
          user: { id: 123, login: 'octocat', type: 'User' },
        }], { link: `<${pageUrl(1)}>; rel="next"` });
      },
    };

    await expect(pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
    }))).resolves.toEqual({
      kind: 'historyGap',
      reason: 'providerHistoryUnavailable',
    });
    expect(requests).toEqual([pageUrl(1)]);
  });

  it('turns malformed persisted checkpoints into reset attention before any provider request or checkpoint mutation', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
      async request({ url }) {
        requests.push(url);
        return jsonResponse([]);
      },
    };
    const malformedCheckpoints = [
      {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        continuation: {
          transport: 'poll',
          connectionId: 'connection-1',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:00.000Z',
            commentIdAtUpdatedAt: '1',
          },
          url: 'not a URL',
        },
      },
      {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        continuation: {
          transport: 'poll',
          connectionId: 'connection-1',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:00.000Z',
            commentIdAtUpdatedAt: '1',
          },
          url: 'https://evil.example/repos/acme/widgets/issues/comments?sort=updated&direction=asc&since=2026-08-10T11%3A59%3A59Z&per_page=100&page=11',
        },
      },
      {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        continuation: {
          transport: 'poll',
          connectionId: 'connection-1',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:00.000Z',
            commentIdAtUpdatedAt: '1',
          },
          url: 'https://api.github.com/repos/acme/widgets/issues/comments?sort=updated&direction=asc&since=2026-08-10T11%3A59%3A59Z&per_page=100&page=11&access_token=not-a-secret',
        },
      },
      {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: 12,
        continuation: null,
      },
      {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        continuation: {
          transport: 'poll',
          connectionId: '',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:00.000Z',
            commentIdAtUpdatedAt: '1',
          },
          url: pageUrl(11),
        },
      },
    ];
    for (const checkpoint of malformedCheckpoints) {
      const before = structuredClone(checkpoint);
      await expect(pollGithubIssueCommentsForChannels(pollInput({ client, checkpoint, limit: 10 })))
        .rejects.toBeInstanceOf(GithubIssueCommentCheckpointError);
      expect(checkpoint).toEqual(before);
    }
    expect(requests).toEqual([]);
  });

  it('rejects a continuation whose since filter no longer belongs to its stable outer cursor', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
      async request({ url }) {
        requests.push(url);
        return jsonResponse([]);
      },
    };
    const continuationUrl = new URL(pageUrl(11));
    continuationUrl.searchParams.set('since', '2026-08-10T12:00:30Z');

    await expect(pollGithubIssueCommentsForChannels(pollInput({
      client,
      checkpoint: {
        v: 1,
        updatedAtIso: '2026-08-10T12:00:00.000Z',
        commentIdAtUpdatedAt: '1',
        etag: null,
        continuation: {
          transport: 'poll',
          connectionId: 'connection-1',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T12:00:30Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:30.000Z',
            commentIdAtUpdatedAt: '20',
          },
          url: continuationUrl.toString(),
        },
      },
      limit: 10,
    }))).rejects.toBeInstanceOf(GithubIssueCommentCheckpointError);
    expect(requests).toEqual([]);
  });

  it('clears a continuation whose core-owned connection scope changed before restarting at the cursor boundary', async () => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
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
        continuation: {
          transport: 'poll',
          connectionId: 'superseded-connection',
          providerConnectionKey: 'github:repository:77',
          filterSince: '2026-08-10T11:59:59Z',
          windowHighWatermark: {
            updatedAtIso: '2026-08-10T12:00:00.000Z',
            commentIdAtUpdatedAt: '1',
          },
          url: pageUrl(11),
        },
      },
      limit: 10,
    })));

    expect(requests).toEqual([pageUrl(1)]);
    expect(result.checkpointAfterBatch).toMatchObject({
      etag: 'fresh-head-etag',
      continuation: null,
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
  ])('follows a next page whose Link header uses %s', async (_label, writeLink) => {
    const requests: string[] = [];
    const client: GithubApiClientV1 = {
      async request({ url }) {
        const parsed = new URL(url);
        if (parsed.pathname === '/repos/acme/widgets/issues/comments') {
          requests.push(url);
          const page = Number(parsed.searchParams.get('page') ?? '1');
          return jsonResponse([{
            id: 100 + page,
            body: `comment on page ${page}`,
            created_at: `2026-08-10T12:00:0${page}Z`,
            updated_at: `2026-08-10T12:00:0${page}Z`,
            issue_url: 'https://api.github.com/repos/acme/widgets/issues/1',
            user: { id: 123, login: 'octocat', type: 'User' },
          }], page === 1 ? { link: writeLink(pageUrl(2)) } : {});
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
        commentIdAtUpdatedAt: '1',
        etag: null,
      },
      limit: 10,
    })));

    expect(requests).toEqual([pageUrl(1), pageUrl(2)]);
    expect(fullTextObservations(result).map((observation) => observation.message.id))
      .toEqual(['101', '102']);
  });
});
