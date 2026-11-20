import { describe, expect, it } from 'vitest';

import {
  createStubGithubTransport,
  createTestGithubApiClient,
  fixedClock,
  readRecordedJsonBody,
} from './testkit/githubTriage.test-support.js';
import { readGithubFeedbackConnection } from './feedback.js';

const ROUTE = Object.freeze({ owner: 'octo-org', name: 'example-app' });

function graphqlDataFor(document: string, withEditability = false) {
  if (document.includes('GithubFeedbackComments')) {
    return {
      repository: {
        databaseId: 4210,
        pullRequest: {
          comments: {
            nodes: [
              { id: 'IC_2', author: { login: 'later' }, body: 'later', createdAt: '2026-08-12T12:00:00Z', url: 'https://github.com/o/r/pull/1#issuecomment-2', ...(withEditability ? { viewerCanUpdate: true } : {}) },
              { id: 'IC_1', author: { login: 'earlier' }, body: 'earlier', createdAt: '2026-08-11T12:00:00Z', url: 'https://github.com/o/r/pull/1#issuecomment-1', ...(withEditability ? { viewerCanUpdate: false } : {}) },
            ],
            pageInfo: { hasPreviousPage: true, startCursor: 'comments-before' },
          },
        },
      },
    };
  }
  if (document.includes('GithubFeedbackThreads')) {
    return {
      repository: {
        databaseId: 4210,
        pullRequest: {
          reviewThreads: {
            nodes: [{
              id: 'PRRT_1',
              isResolved: false,
              path: 'src/pump.ts',
              line: 42,
              firstComment: {
                totalCount: 4,
                nodes: [{ id: 'PRRC_first', author: { login: 'first' }, body: 'first reply', createdAt: '2026-08-09T13:00:00Z', url: 'https://github.com/o/r/pull/1#discussion_first' }],
              },
              comments: {
                nodes: [
                  { id: 'PRRC_2', author: { login: 'later' }, body: 'later reply', createdAt: '2026-08-12T13:00:00Z', url: 'https://github.com/o/r/pull/1#discussion_r2', ...(withEditability ? { viewerCanUpdate: true } : {}) },
                  { id: 'PRRC_1', author: { login: 'earlier' }, body: 'earlier reply', createdAt: '2026-08-11T13:00:00Z', url: 'https://github.com/o/r/pull/1#discussion_r1' },
                ],
                pageInfo: { hasPreviousPage: true, startCursor: 'thread-1-before' },
              },
            }],
            pageInfo: { hasPreviousPage: true, startCursor: 'threads-before' },
          },
        },
      },
    };
  }
  if (document.includes('GithubFeedbackReviews')) {
    return {
      repository: {
        databaseId: 4210,
        pullRequest: {
          reviewDecision: 'CHANGES_REQUESTED',
          reviews: {
            nodes: [{ id: 'PRR_1', author: { login: 'reviewer' }, body: 'Please split this.', state: 'CHANGES_REQUESTED', commit: { oid: 'a'.repeat(40) }, submittedAt: '2026-08-12T14:00:00Z', url: 'https://github.com/o/r/pull/1#pullrequestreview-1', ...(withEditability ? { viewerCanUpdate: true } : {}) }],
            pageInfo: { hasPreviousPage: true, startCursor: 'reviews-before' },
          },
        },
      },
    };
  }
  if (document.includes('GithubFeedbackRequests')) {
    return {
      repository: {
        databaseId: 4210,
        pullRequest: {
          reviewRequests: {
            nodes: [
              { requestedReviewer: { __typename: 'User', login: 'octocat' } },
              { requestedReviewer: { __typename: 'Team', name: 'Client Platform', slug: 'client-platform' } },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'requests-after' },
          },
        },
      },
    };
  }
  if (document.includes('GithubFeedbackThreadReplies')) {
    return {
      node: {
        id: 'PRRT_1',
        pullRequest: {
          number: 1284,
          repository: { databaseId: 4210 },
        },
        comments: {
          nodes: [{ id: 'PRRC_0', author: { login: 'oldest' }, body: 'oldest reply', createdAt: '2026-08-10T13:00:00Z', url: 'https://github.com/o/r/pull/1#discussion_r0' }],
          pageInfo: { hasPreviousPage: false, startCursor: 'thread-1-start' },
        },
      },
    };
  }
  throw new Error(`unexpected document: ${document}`);
}

describe('the GitHub feedback fetcher', () => {
  it('keeps the commit-bound anchor when paging older thread replies', async () => {
    const stub = createStubGithubTransport({ respond: request => {
      const body = readRecordedJsonBody(request) as { query: string };
      expect(body.query).toContain('diffSide');
      return { status: 200, body: { data: { node: { id: 'thread', diffSide: 'RIGHT',
        pullRequest: { number: 1284, repository: { databaseId: 4210 } },
        comments: { nodes: [{ id: 'reply', body: '```suggestion\nnew\n```', path: 'file.ts',
          originalLine: 1, originalCommit: { oid: 'a'.repeat(40) }, outdated: false,
          diffHunk: '@@ -1 +1 @@\n-old\n+original' }], pageInfo: { hasPreviousPage: false } },
      } } } };
    } });
    const client = await createTestGithubApiClient(stub);
    const result = await readGithubFeedbackConnection({ route: ROUTE, repositoryId: '4210', number: '1284',
      kindId: 'pull-request', cursor: null, connection: 'threadReplies', threadId: 'thread' },
    { client, now: fixedClock(1000), signal: stub.context.signal });
    if (result.kind !== 'threadReplies') throw new Error(result.kind);
    expect(result.rows[0]).toMatchObject({ suggestions: [{ commitOid: 'a'.repeat(40),
      startLine: 1, endLine: 1, originalLines: ['original'], replacement: 'new' }] });
    expect(stub.requests).toHaveLength(1);
  });
  it.each([false, true])('projects a complete commit-bound suggestion (outdated=%s) without another read', async outdated => {
    const stub = createStubGithubTransport({ respond: request => {
      const body = readRecordedJsonBody(request) as { query: string };
      expect(body.query).toContain('diffHunk');
      return { status: 200, body: { data: { repository: { databaseId: 4210, pullRequest: {
        reviewThreads: { nodes: [{ id: 'thread', isResolved: false, diffSide: 'RIGHT', path: 'src/file.ts', line: 12,
          firstComment: { totalCount: 1, nodes: [{ id: 'comment', body: 'Try this:\n```suggestion\nnew value\n```',
            path: 'src/file.ts', line: 12, originalLine: 3, originalStartLine: 2, outdated,
            commit: { oid: 'b'.repeat(40) }, originalCommit: { oid: 'a'.repeat(40) },
            diffHunk: '@@ -1,3 +1,3 @@\n context\n-old\n+old value\n tail' }] },
          comments: { nodes: [], pageInfo: { hasPreviousPage: false } } }],
          pageInfo: { hasPreviousPage: false } },
      } } } } };
    } });
    const client = await createTestGithubApiClient(stub);
    const result = await readGithubFeedbackConnection({ route: ROUTE, repositoryId: '4210', number: '1284',
      kindId: 'pull-request', cursor: null, connection: 'threads' },
    { client, now: fixedClock(1000), signal: stub.context.signal });
    if (result.kind !== 'threads') throw new Error(result.kind);
    expect(result.rows[0]?.firstReply).toMatchObject({ suggestions: [{ path: 'src/file.ts',
      commitOid: 'a'.repeat(40), startLine: 2, endLine: 3, originalLines: ['old value', 'tail'],
      replacement: 'new value', outdated }] });
    expect(stub.requests).toHaveLength(1);
  });
  it.each(['comments', 'threads', 'reviews', 'requests', 'threadReplies'] as const)(
    'refuses a reused repository in the %s response without a repository preflight', async connection => {
      const stub = createStubGithubTransport({ respond: request => {
        const { query } = readRecordedJsonBody(request) as { query: string };
        const data = graphqlDataFor(query);
        if ('repository' in data && data.repository !== undefined) data.repository.databaseId = 999;
        if ('node' in data && data.node !== undefined) data.node.pullRequest.repository.databaseId = 999;
        return { status: 200, body: { data } };
      } });
      const client = await createTestGithubApiClient(stub);
      const common = { route: ROUTE, repositoryId: '4210', number: '1284', kindId: 'pull-request' as const, cursor: null };
      const input = connection === 'threadReplies' ? { ...common, connection, threadId: 'PRRT_1' } : { ...common, connection };
      expect(await readGithubFeedbackConnection(input, { client, now: fixedClock(1000), signal: stub.context.signal }))
        .toMatchObject({ kind: 'unavailable', failure: { code: 'route-body-mismatch' } });
      expect(stub.requests).toHaveLength(1);
    },
  );

  it('marks only the comments, replies and reviews GitHub says this viewer may update as editable', async () => {
    const queries: string[] = [];
    const stub = createStubGithubTransport({ respond: (request) => {
      const { query } = readRecordedJsonBody(request) as { query: string };
      queries.push(query);
      return { status: 200, body: { data: graphqlDataFor(query, true) } };
    } });
    const client = await createTestGithubApiClient(stub);
    const read = async (connection: 'comments' | 'threads' | 'reviews') => await readGithubFeedbackConnection(
      { route: ROUTE, repositoryId: '4210', number: '1284', kindId: 'pull-request', cursor: null, connection },
      { client, now: fixedClock(1000), signal: stub.context.signal },
    );

    const comments = await read('comments');
    if (comments.kind !== 'comments') throw new Error(comments.kind);
    expect(comments.rows.map((row) => [row.id, row.editable === true])).toEqual([['IC_1', false], ['IC_2', true]]);
    const reviews = await read('reviews');
    if (reviews.kind !== 'reviews') throw new Error(reviews.kind);
    expect(reviews.rows[0]?.editable).toBe(true);
    const threads = await read('threads');
    if (threads.kind !== 'threads') throw new Error(threads.kind);
    expect(threads.rows[0]?.replies.find((reply) => reply.id === 'PRRC_2')?.editable).toBe(true);
    expect(threads.rows[0]?.replies.find((reply) => reply.id === 'PRRC_1')?.editable).toBeUndefined();
    expect(queries.every((query) => query.includes('viewerCanUpdate'))).toBe(true);
  });

  it('keeps issue comment history at its issue-local 40-row window', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        if (new URL(request.url).pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Readonly<Record<string, unknown>>;
        };
        expect(body.query).toContain('issue(number: $number)');
        expect(body.query).not.toContain('pullRequest(number: $number)');
        expect(body.variables).toMatchObject({
          commentCount: 40,
          commentCursor: 'issue-comments-cursor',
        });
        return {
          status: 200,
          body: {
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
          },
        };
      },
    });
    const client = await createTestGithubApiClient(stub);
    const result = await readGithubFeedbackConnection({
      route: ROUTE,
      repositoryId: '4210',
      number: '1284',
      connection: 'comments',
      cursor: 'issue-comments-cursor',
      kindId: 'issue',
    }, { client, now: () => 1_000, signal: new AbortController().signal });

    expect(result).toMatchObject({
      kind: 'comments',
      previousCursor: 'issue-comments-before',
      rows: [{ id: 'IC_3', body: 'latest issue reply' }],
    });
  });

  it('pages every pull-request root connection and a nested thread on only its own cursor', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        if (new URL(request.url).pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Readonly<Record<string, unknown>>;
        };
        return { status: 200, body: { data: graphqlDataFor(body.query) } };
      },
    });
    const client = await createTestGithubApiClient(stub);
    const dependencies = { client, now: fixedClock(1_000), signal: stub.context.signal };

    const comments = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'comments', cursor: 'comments-cursor', kindId: 'pull-request',
    }, dependencies);
    const threads = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'threads', cursor: 'threads-cursor', kindId: 'pull-request',
    }, dependencies);
    const reviews = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'reviews', cursor: 'reviews-cursor', kindId: 'pull-request',
    }, dependencies);
    const requests = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'requests', cursor: 'requests-cursor', kindId: 'pull-request',
    }, dependencies);
    const replies = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'threadReplies', cursor: 'replies-cursor', threadId: 'PRRT_1', kindId: 'pull-request',
    }, dependencies);

    expect(comments).toMatchObject({
      kind: 'comments',
      previousCursor: 'comments-before',
      rows: [{ id: 'IC_1' }, { id: 'IC_2' }],
    });
    expect(threads).toMatchObject({
      kind: 'threads',
      previousCursor: 'threads-before',
      rows: [{
        id: 'PRRT_1',
        isResolved: false,
        path: 'src/pump.ts',
        line: 42,
        firstReply: { id: 'PRRC_first', body: 'first reply' },
        replyCount: 4,
        previousRepliesCursor: 'thread-1-before',
        replies: [{ id: 'PRRC_1' }, { id: 'PRRC_2' }],
      }],
    });
    expect(reviews).toMatchObject({
      kind: 'reviews',
      reviewDecision: 'changes-requested',
      previousCursor: 'reviews-before',
      rows: [{ id: 'PRR_1', body: 'Please split this.', commitRevision: 'a'.repeat(40) }],
    });
    expect(requests).toEqual({
      kind: 'requests',
      nextCursor: 'requests-after',
      rows: [
        { kind: 'user', subject: 'octocat' },
        { kind: 'team', subject: 'Client Platform' },
      ],
    });
    expect(replies).toMatchObject({
      kind: 'threadReplies', threadId: 'PRRT_1', rows: [{ id: 'PRRC_0' }],
    });

    const variables = stub.requests.map((request) => (
      readRecordedJsonBody(request) as { variables: Record<string, unknown> }
    ).variables);
    const documents = stub.requests.map((request) => (
      readRecordedJsonBody(request) as { query: string }
    ).query);
    expect(documents[2]).toContain('commit { oid }');
    expect(variables).toEqual([
      expect.objectContaining({ commentCursor: 'comments-cursor', commentCount: 24 }),
      expect.objectContaining({ threadCursor: 'threads-cursor', threadCount: 12, replyCount: 3 }),
      expect.objectContaining({ reviewCursor: 'reviews-cursor', reviewCount: 8 }),
      expect.objectContaining({ requestCursor: 'requests-cursor', requestCount: 16 }),
      expect.objectContaining({ threadId: 'PRRT_1', replyCursor: 'replies-cursor', replyCount: 3 }),
    ]);
    expect(documents[4]).toContain('node(id: $threadId)');
    expect(documents[4]).not.toContain('reviewThreads(first:');
  });
});
