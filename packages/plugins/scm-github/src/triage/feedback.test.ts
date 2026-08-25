import { describe, expect, it } from 'vitest';

import {
  createStubGithubTransport,
  createTestGithubApiClient,
  fixedClock,
  readRecordedJsonBody,
} from './testkit/githubTriage.test-support.js';
import { readGithubFeedbackConnection } from './feedback.js';

const ROUTE = Object.freeze({ owner: 'octo-org', name: 'example-app' });

function graphqlDataFor(document: string) {
  if (document.includes('GithubFeedbackComments')) {
    return {
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
              comments: {
                nodes: [
                  { id: 'PRRC_2', author: { login: 'later' }, body: 'later reply', createdAt: '2026-08-12T13:00:00Z', url: 'https://github.com/o/r/pull/1#discussion_r2' },
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
            nodes: [{ id: 'PRR_1', author: { login: 'reviewer' }, body: 'Please split this.', state: 'CHANGES_REQUESTED', submittedAt: '2026-08-12T14:00:00Z', url: 'https://github.com/o/r/pull/1#pullrequestreview-1' }],
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
  it('pages every root connection and a nested thread on only its own cursor', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        if (new URL(request.url).pathname !== '/graphql') return undefined;
        const body = readRecordedJsonBody(request) as {
          query: string;
          variables: Readonly<Record<string, unknown>>;
        };
        if (body.variables.commentCursor === 'issue-comments-cursor') {
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
        }
        return { status: 200, body: { data: graphqlDataFor(body.query) } };
      },
    });
    const client = await createTestGithubApiClient(stub);
    const dependencies = { client, now: fixedClock(1_000), signal: stub.context.signal };

    const comments = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'comments', cursor: 'comments-cursor', kindId: 'pull-request',
    }, dependencies);
    const issueComments = await readGithubFeedbackConnection({
      route: ROUTE, repositoryId: '4210', number: '1284', connection: 'comments', cursor: 'issue-comments-cursor', kindId: 'issue',
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
    expect(issueComments).toMatchObject({
      kind: 'comments',
      previousCursor: 'issue-comments-before',
      rows: [{ id: 'IC_3', body: 'latest issue reply' }],
    });
    expect(threads).toMatchObject({
      kind: 'threads',
      previousCursor: 'threads-before',
      rows: [{ id: 'PRRT_1', isResolved: false, path: 'src/pump.ts', line: 42, previousRepliesCursor: 'thread-1-before', replies: [{ id: 'PRRC_1' }, { id: 'PRRC_2' }] }],
    });
    expect(reviews).toMatchObject({
      kind: 'reviews',
      reviewDecision: 'changes-requested',
      previousCursor: 'reviews-before',
      rows: [{ id: 'PRR_1', body: 'Please split this.' }],
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
    expect(variables).toEqual([
      expect.objectContaining({ commentCursor: 'comments-cursor', commentCount: 40 }),
      expect.objectContaining({ commentCursor: 'issue-comments-cursor', commentCount: 40 }),
      expect.objectContaining({ threadCursor: 'threads-cursor', threadCount: 12, replyCount: 3 }),
      expect.objectContaining({ reviewCursor: 'reviews-cursor', reviewCount: 8 }),
      expect.objectContaining({ requestCursor: 'requests-cursor', requestCount: 16 }),
      expect.objectContaining({ threadId: 'PRRT_1', replyCursor: 'replies-cursor', replyCount: 3 }),
    ]);
    expect(documents[1]).toContain('issue(number: $number)');
    expect(documents[1]).not.toContain('pullRequest(number: $number)');
    expect(documents[5]).toContain('node(id: $threadId)');
    expect(documents[5]).not.toContain('reviewThreads(first:');
  });
});
