import { describe, expect, it } from 'vitest';

import {
  GITHUB_REQUESTED_REVIEWERS_RESPONSE,
  githubReview,
} from './__fixtures__/githubResponses.js';
import {
  createStubGithubTransport,
  createTestGithubApiClient,
  fixedClock,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';
import {
  deriveGithubReviewDecision,
  readGithubPullRequestReviewers,
  readGithubPullRequestReviewPublicationRecords,
} from './reviews.js';

const ROUTE = Object.freeze({ owner: 'octo-org', name: 'example-app' });

async function readReviewers(
  respond: (request: RecordedGithubRequest) => StubHttpResponse | undefined,
) {
  const transport = createStubGithubTransport({ respond });
  const client = await createTestGithubApiClient(transport);
  const surface = await readGithubPullRequestReviewers(
    { route: ROUTE, number: '1284' },
    { client, now: fixedClock(1_000), signal: transport.context.signal },
  );
  return { surface, transport };
}

describe('GitHub pull-request review people', () => {
  it('unions team reviewers with user reviewers rather than dropping them', async () => {
    const { surface } = await readReviewers((request) => (request.url.includes('/requested_reviewers')
      ? { status: 200, body: GITHUB_REQUESTED_REVIEWERS_RESPONSE }
      : { status: 200, body: [] }));

    expect(surface.outstanding).toEqual([
      { kind: 'user', login: 'hubot' },
      { kind: 'team', slug: 'client-platform', name: 'Client Platform' },
    ]);
  });

  it('renders historical reviewers separately from outstanding review requests', async () => {
    const { surface } = await readReviewers((request) => (request.url.includes('/requested_reviewers')
      ? { status: 200, body: GITHUB_REQUESTED_REVIEWERS_RESPONSE }
      : {
        status: 200,
        body: [
          githubReview({ id: 1, login: 'monalisa', state: 'APPROVED' }),
          githubReview({ id: 2, login: 'octocat', state: 'COMMENTED' }),
        ],
      }));

    expect(surface.historical.map((reviewer) => reviewer.login)).toEqual(['monalisa', 'octocat']);
    expect(surface.outstanding.map((reviewer) => (reviewer.kind === 'user' ? reviewer.login : reviewer.slug)))
      .toEqual(['hubot', 'client-platform']);
    // A person who reviewed is history; a requested team is an unresolved request.
    expect(surface.historical.some((reviewer) => reviewer.login === 'hubot')).toBe(false);
  });

  it('collapses repeated reviews by one author onto their newest state', () => {
    expect(deriveGithubReviewDecision([
      { login: 'monalisa', state: 'APPROVED', submittedAtMs: 2 },
    ])).toBe('approved');
    expect(deriveGithubReviewDecision([
      { login: 'monalisa', state: 'APPROVED', submittedAtMs: 2 },
      { login: 'octocat', state: 'CHANGES_REQUESTED', submittedAtMs: 3 },
    ])).toBe('changes-requested');
    expect(deriveGithubReviewDecision([
      { login: 'octocat', state: 'COMMENTED', submittedAtMs: 3 },
    ])).toBeNull();
  });

  it('keeps the review decision unresolved rather than synthesizing Review required', async () => {
    const { surface } = await readReviewers((request) => (request.url.includes('/requested_reviewers')
      ? { status: 200, body: GITHUB_REQUESTED_REVIEWERS_RESPONSE }
      : { status: 200, body: [] }));

    // An outstanding request is not evidence that a branch protection rule REQUIRES a
    // review; that arm lives on a surface this read never touched.
    expect(surface.outstanding).toHaveLength(2);
    expect(surface.reviewDecision).toBeNull();
  });

  it('takes the newest review per author when the same person reviewed twice', async () => {
    const { surface } = await readReviewers((request) => (request.url.includes('/requested_reviewers')
      ? { status: 200, body: { users: [], teams: [] } }
      : {
        status: 200,
        body: [
          githubReview({
            id: 1,
            login: 'monalisa',
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-08-10T10:00:00Z',
          }),
          githubReview({
            id: 2,
            login: 'monalisa',
            state: 'APPROVED',
            submittedAt: '2026-08-12T10:00:00Z',
          }),
        ],
      }));

    expect(surface.historical).toEqual([
      { login: 'monalisa', state: 'APPROVED', submittedAtMs: Date.parse('2026-08-12T10:00:00Z') },
    ]);
    expect(surface.reviewDecision).toBe('approved');
  });

  it('renders the surviving connection when the other one fails', async () => {
    const { surface } = await readReviewers((request) => (request.url.includes('/requested_reviewers')
      ? { status: 403, body: { message: 'Resource not accessible' } }
      : { status: 200, body: [githubReview({ id: 1, login: 'monalisa', state: 'APPROVED' })] }));

    expect(surface.historical).toHaveLength(1);
    expect(surface.reviewDecision).toBe('approved');
    expect(surface.requestsFailure).toEqual({ class: 'permission', code: 'github_forbidden' });
    expect(surface.reviewsFailure).toBeNull();
  });

  it('leaves the decision unresolved when the reviews read itself failed', async () => {
    const { surface } = await readReviewers((request) => (request.url.includes('/requested_reviewers')
      ? { status: 200, body: { users: [], teams: [] } }
      : { status: 500, body: { message: 'Server Error' } }));

    expect(surface.reviewDecision).toBeNull();
    expect(surface.reviewsFailure).toEqual({ class: 'transient', code: 'github_server_error' });
  });

  it('pages the reviews connection on its own validated cursor', async () => {
    const pages: string[] = [];
    const { surface } = await readReviewers((request) => {
      if (request.url.includes('/requested_reviewers')) {
        return { status: 200, body: { users: [], teams: [] } };
      }
      const page = new URL(request.url).searchParams.get('page') ?? '1';
      pages.push(page);
      if (page === '1') {
        return {
          status: 200,
          headers: {
            link: '<https://api.github.com/repos/octo-org/example-app/pulls/1284/'
              + 'reviews?per_page=100&page=2>; rel="next"',
          },
          body: [githubReview({ id: 1, login: 'monalisa', state: 'COMMENTED' })],
        };
      }
      return { status: 200, body: [githubReview({ id: 2, login: 'octocat', state: 'APPROVED' })] };
    });

    expect(pages).toEqual(['1', '2']);
    expect(surface.historical.map((reviewer) => reviewer.login)).toEqual(['monalisa', 'octocat']);
  });

  it('follows the reviews connection beyond the search-only 1,000-result ceiling', async () => {
    const { surface, transport } = await readReviewers((request) => {
      if (request.url.includes('/requested_reviewers')) {
        return { status: 200, body: { users: [], teams: [] } };
      }
      const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
      return page <= 10 ? {
        status: 200,
        headers: {
          link: `<https://api.github.com/repos/octo-org/example-app/pulls/1284/reviews?per_page=100&page=${page + 1}>; rel="next"`,
        },
        body: [githubReview({ id: page, login: `reviewer-${page}`, state: 'COMMENTED' })],
      } : { status: 200, body: [githubReview({ id: page, login: `reviewer-${page}`, state: 'COMMENTED' })] };
    });

    expect(transport.requests.filter((request) => request.url.includes('/reviews?'))).toHaveLength(11);
    expect(surface.reviewsIncomplete).toBe(false);
    expect(surface.reviewsFailure).toBeNull();
  });

  it('settles a repeated validated review cursor instead of rereading it until the deadline', async () => {
    const { surface, transport } = await readReviewers((request) => {
      if (request.url.includes('/requested_reviewers')) {
        return { status: 200, body: { users: [], teams: [] } };
      }
      return {
        status: 200,
        headers: { link: `<${request.url}>; rel="next"` },
        body: [githubReview({ id: 1, login: 'monalisa', state: 'COMMENTED' })],
      };
    });

    expect(transport.requests.filter((request) => request.url.includes('/reviews?'))).toHaveLength(1);
    expect(surface.reviewsFailure).toEqual({
      class: 'unsupportedContract',
      code: 'github_reviews_link_invalid',
    });
  });
});

describe('GitHub review publication marker reconciliation', () => {
  it('retains a marker with a deleted author and future review state beside malformed rows', async () => {
    const transport = createStubGithubTransport({
      respond: () => ({
        status: 200,
        body: [
          { nope: true },
          {
            id: 991,
            body: 'kept <!-- happier-review-verdict:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -->',
            user: null,
            state: 'FUTURE_GITHUB_STATE',
          },
        ],
      }),
    });
    const client = await createTestGithubApiClient(transport);
    const read = await readGithubPullRequestReviewPublicationRecords(
      { route: ROUTE, number: '1284' },
      { client, now: fixedClock(1_000), signal: transport.context.signal },
    );
    expect(read.failure).toBeNull();
    expect(read.incomplete).toBe(false);
    expect(read.reviews).toEqual([{
      providerId: '991',
      body: 'kept <!-- happier-review-verdict:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA -->',
    }]);
  });
});
