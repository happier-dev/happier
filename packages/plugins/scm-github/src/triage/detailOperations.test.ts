import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it, vi } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REQUESTED_REVIEWERS_RESPONSE,
  githubChangedFile,
  githubCheckRun,
  githubCheckRunsResponse,
  githubCombinedStatusResponse,
  githubCommitStatus,
  githubFollowUpLinkHeader,
  githubIssueComment,
  githubReview,
  githubTimelineEvent,
} from './__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import {
  GithubChangedFilesResultV1Schema,
  GithubChecksResultV1Schema,
  GithubCommentsResultV1Schema,
  GithubFeedbackResultV1Schema,
  GithubReviewsResultV1Schema,
  GithubTimelineResultV1Schema,
} from './detail/contracts.js';
import { encodeGithubDetailContinuation } from './detail/continuation.js';
import {
  listGithubChangedFiles,
  listGithubComments,
  readGithubFeedback,
  listGithubTimeline,
  readGithubChecks,
  readGithubReviews,
} from './detailOperations.js';
import { GITHUB_MOUNTED_DETAIL_DEADLINE_MS } from './admission.js';
import { withGithubInvocationDeadline } from './invocation.js';
import {
  createStubGithubTransport,
  readRecordedJsonBody,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
const HEAD_SHA = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
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

it('bounds a never-settling mounted detail read with the source-owned invocation deadline', async () => {
  vi.useFakeTimers();
  try {
    const stub = createStubGithubTransport({
      respond: (request) => new URL(request.url).pathname.endsWith('/timeline')
        ? new Promise<StubHttpResponse>(() => {})
        : undefined,
    });
    const pending = withGithubInvocationDeadline(
      GITHUB_MOUNTED_DETAIL_DEADLINE_MS,
      listGithubTimeline,
    )(planeInput(), stub.context);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(pending).resolves.toEqual({
      kind: 'unavailable',
      failure: { class: 'transient', code: 'github_request_timed_out' },
    });
  } finally {
    vi.useRealTimers();
  }
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

/* --------------------------------------------------------------------- comments */

describe('GitHub comments plane', () => {
  it('reads the issue-level comment stream for both kinds', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => (request.url.includes('/issues/1284/comments')
        ? jsonResponse([
          githubIssueComment({ id: 11, body: 'First\r\n\r\nsecond', author: 'monalisa' }),
        ])
        : undefined),
    });

    for (const localRef of [PULL_REQUEST_REF, ISSUE_REF]) {
      const result = GithubCommentsResultV1Schema.parse(await listGithubComments(
        planeInput({ localRef, limit: 30 }),
        stub.context,
      ));
      if (result.kind !== 'comments') throw new Error('comments must settle as comments');
      expect(result.rows[0]?.id).toBe('github-issue-comment:11');
      expect(result.rows[0]?.author).toBe('monalisa');
      expect(result.rows[0]?.body).toBe('First\n\nsecond');
    }
    expect(stub.requests
      .filter((request) => request.url.includes('/comments?'))
      .every((request) => request.url.includes('per_page=30'))).toBe(true);
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
          commentCount: 40,
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

/* -------------------------------------------------------------------- reviews */

describe('GitHub reviews plane', () => {
  it('publishes the current review decision and requested people from their canonical resources', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        if (request.url.includes('/pulls/1284/reviews')) {
          return jsonResponse([
            githubReview({
              id: 101,
              login: 'monalisa',
              state: 'APPROVED',
              submittedAt: '2026-08-10T09:00:00Z',
            }),
            githubReview({
              id: 102,
              login: 'monalisa',
              state: 'CHANGES_REQUESTED',
              submittedAt: '2026-08-11T09:00:00Z',
            }),
          ]);
        }
        if (request.url.includes('/pulls/1284/requested_reviewers')) {
          return jsonResponse(GITHUB_REQUESTED_REVIEWERS_RESPONSE);
        }
        return undefined;
      },
    });

    const result = GithubReviewsResultV1Schema.parse(
      await readGithubReviews(checksInput(), stub.context),
    );
    if (result.kind !== 'reviews') throw new Error('the reviews read must settle as reviews');

    // The historical list is GitHub's current collapsed review state, not a
    // timeline fragment. The separately read requests retain both a user and a
    // team that are still awaiting review.
    expect(result.reviewed).toEqual([{
      login: 'monalisa',
      state: 'CHANGES_REQUESTED',
      submittedAtMs: Date.parse('2026-08-11T09:00:00Z'),
    }]);
    expect(result.requested).toEqual([
      { kind: 'user', subject: 'hubot' },
      { kind: 'team', subject: 'Client Platform' },
    ]);
    expect(result.reviewDecision).toBe('changes-requested');
    expect(stub.requests.filter((request) => request.url.includes('/pulls/1284/'))).toHaveLength(2);
    expect(stub.requests.some((request) => request.url.includes('/reviews?'))).toBe(true);
    expect(stub.requests.some((request) => request.url.includes('/requested_reviewers?'))).toBe(true);
  });

  it('publishes that a review walk stopped at GitHub\'s result ceiling', async () => {
    const stub = createStubGithubTransport({
      respond: (request) => {
        if (request.url.includes('/requested_reviewers')) {
          return jsonResponse({ users: [], teams: [] });
        }
        if (!request.url.includes('/pulls/1284/reviews')) return undefined;
        const page = Number(new URL(request.url).searchParams.get('page') ?? '1');
        return jsonResponse(
          [githubReview({ id: page, login: `reviewer-${page}`, state: 'COMMENTED' })],
          { link: githubFollowUpLinkHeader({ requestedUrl: request.url, nextPage: page + 1 }) },
        );
      },
    });

    const result = await readGithubReviews(checksInput(), stub.context);
    expect(result).toMatchObject({ kind: 'reviews', reviewsIncomplete: true });
  });
});
