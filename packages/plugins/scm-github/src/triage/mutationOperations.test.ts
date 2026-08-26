import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { describe, expect, it } from 'vitest';

import {
  GITHUB_CONNECTED_ACCOUNT_PURPOSE,
  GITHUB_PLUGIN_ID,
} from '../observations/githubProviderContracts.js';

import {
  GITHUB_FIXTURE_OWNER,
  GITHUB_FIXTURE_REPOSITORY,
  GITHUB_ISSUE_RESPONSE,
  GITHUB_PULL_REQUEST_RESPONSE,
  GITHUB_REPOSITORY_RESPONSE,
} from './__fixtures__/githubResponses.js';
import { encodeGithubTriageConfiguration } from './configuration.js';
import {
  GithubIssueDeltaResultV1Schema,
  GithubPullRequestMarkReadyResultV1Schema,
  GithubPullRequestMergeResultV1Schema,
  GithubPullRequestReviewersResultV1Schema,
  GithubPullRequestReviewPublicationResultV1Schema,
  GithubPullRequestStateResultV1Schema,
  GithubPullRequestThreadResolutionResultV1Schema,
  GithubPullRequestUpdateBranchResultV1Schema,
} from './mutations/contracts.js';
import {
  addGithubIssueAssigneesAction,
  addGithubIssueLabelsAction,
  addGithubPullRequestReviewersAction,
  closeGithubIssueAction,
  closeGithubPullRequestAction,
  markGithubPullRequestReadyAction,
  mergeGithubPullRequestAction,
  removeGithubIssueAssigneesAction,
  removeGithubIssueLabelAction,
  removeGithubPullRequestReviewersAction,
  publishGithubPullRequestReviewAction,
  reopenGithubIssueAction,
  reopenGithubPullRequestAction,
  setGithubPullRequestThreadResolutionAction,
  updateGithubPullRequestBranchAction,
} from './mutationOperations.js';
import {
  createStubGithubTransport,
  readRecordedJsonBody,
  type RecordedGithubRequest,
  type StubHttpResponse,
} from './testkit/githubTriage.test-support.js';

/**
 * The GitHub pull-request writes, driven through the real Action entrypoints.
 *
 * The mock sits at the genuine system boundary — the host HTTP service and the
 * generic Connected Accounts service — so the real API client, the real
 * admission, the real preflight read and the real failure classifier all run
 * beneath every case. No network call is made, and nothing in `triage/` is
 * stubbed.
 *
 * What these assert is what actually protects a user: the exact bytes sent, the
 * requests NOT sent, and the refusal to claim an effect the confirming read did
 * not observe.
 */

const REPOSITORY_KEY = `${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`.toLowerCase();
const OBSERVED_HEAD = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
const ADVANCED_HEAD = '0011223344556677889900aabbccddeeff001122';

const CONFIGURED_ACCOUNT: ConnectedAccountRef = Object.freeze({
  service: Object.freeze({ pluginId: GITHUB_PLUGIN_ID, localId: 'github-account' }),
  accountId: 'configured-account',
});

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
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
    binding: Object.freeze({
      purpose: GITHUB_CONNECTED_ACCOUNT_PURPOSE,
      account: CONFIGURED_ACCOUNT,
    }),
    localInstanceKey: 'github.com',
    configuration: Object.freeze({ v: 1 as const, token }),
  });
}

const PULL_REQUEST_REF = Object.freeze({
  kindId: 'pull-request',
  collisionScope: 'github:4210',
  entryId: '1284',
});

function mergeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    headRevision: OBSERVED_HEAD,
    mergeMethod: 'squash',
    ...overrides,
  };
}

function stateInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    ...overrides,
  };
}

type PullRequestShape = Readonly<{
  state?: 'open' | 'closed';
  merged?: boolean;
  headSha?: string;
  draft?: boolean;
}>;

function pullRequestBody(shape: PullRequestShape = {}): Readonly<Record<string, unknown>> {
  const state = shape.state ?? 'open';
  const merged = shape.merged ?? false;
  return Object.freeze({
    ...GITHUB_PULL_REQUEST_RESPONSE,
    state,
    merged,
    merged_at: merged ? '2026-08-13T10:00:00Z' : null,
    closed_at: state === 'closed' ? '2026-08-13T10:00:00Z' : null,
    draft: shape.draft ?? false,
    head: Object.freeze({
      ...(GITHUB_PULL_REQUEST_RESPONSE.head as Readonly<Record<string, unknown>>),
      sha: shape.headSha ?? OBSERVED_HEAD,
    }),
  });
}

function json(body: unknown, status = 200): StubHttpResponse {
  return { status, headers: { 'content-type': 'application/json' }, body };
}

const PULL_REQUEST_PATH = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/pulls/1284`;
const REPOSITORY_PATH = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}`;
const REVIEWERS_PATH = `${PULL_REQUEST_PATH}/requested_reviewers`;
const REVIEWS_PATH = `${PULL_REQUEST_PATH}/reviews`;
const UPDATE_BRANCH_PATH = `${PULL_REQUEST_PATH}/update-branch`;
const GRAPHQL_PATH = '/graphql';

/** GitHub's own node id for the fixture pull request, as REST publishes it. */
const PULL_REQUEST_NODE_ID = GITHUB_PULL_REQUEST_RESPONSE.node_id as string;

function reviewerCollection(input: Readonly<{
  users?: readonly string[];
  teams?: readonly string[];
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    users: (input.users ?? []).map((login) => ({ login, id: 1, type: 'User' })),
    teams: (input.teams ?? []).map((slug) => ({ slug, id: 2, name: slug })),
  });
}

/**
 * Answers the reads every write performs, and lets one case decide what the write
 * itself returns and what the CONFIRMING read then observes.
 */
function transportFor(input: Readonly<{
  /** Answers, in order, the preflight read and then every following read. */
  reads: readonly Readonly<Record<string, unknown>>[];
  repository?: Readonly<Record<string, unknown>>;
  write?: StubHttpResponse | Error;
  readStatus?: number;
  /** Answers, in order, the reviewer preflight read and then the confirming read. */
  reviewerReads?: readonly Readonly<Record<string, unknown>>[];
  /** Answers, in order, the review-publication baseline and confirming reads. */
  reviewPublicationReads?: readonly unknown[][];
}>) {
  let read = 0;
  let reviewerRead = 0;
  let reviewPublicationRead = 0;
  /**
   * `write: new Error(...)` states that the boundary recorded the request and
   * then lost its answer, which is a rejected request rather than a response
   * with no status.
   */
  const writeAnswer = (fallback: StubHttpResponse): StubHttpResponse => {
    if (input.write instanceof Error) throw input.write;
    return input.write ?? fallback;
  };
  return createStubGithubTransport({
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
        if (input.readStatus !== undefined && read > 0) {
          read += 1;
          return { status: input.readStatus, headers: {}, body: {} };
        }
        const body = input.reads[Math.min(read, input.reads.length - 1)];
        read += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === REPOSITORY_PATH) {
        return json(input.repository ?? GITHUB_REPOSITORY_RESPONSE);
      }
      if (request.method === 'PUT' && path === `${PULL_REQUEST_PATH}/merge`) {
        return writeAnswer(json({ merged: true, sha: OBSERVED_HEAD }));
      }
      if (request.method === 'PATCH' && path === PULL_REQUEST_PATH) {
        return writeAnswer(json(input.reads[input.reads.length - 1]));
      }
      if (request.method === 'PUT' && path === UPDATE_BRANCH_PATH) {
        // GitHub answers a branch update with `202 Accepted`, which states only
        // that it took the request.
        return writeAnswer({
          status: 202,
          headers: { 'content-type': 'application/json' },
          body: { message: 'Updating pull request branch.' },
        });
      }
      if (request.method === 'POST' && path === GRAPHQL_PATH) {
        return writeAnswer(json({
          data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } },
        }));
      }
      if (request.method === 'GET' && path === REVIEWERS_PATH) {
        const collections = input.reviewerReads ?? [reviewerCollection({})];
        const body = collections[Math.min(reviewerRead, collections.length - 1)];
        reviewerRead += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === REVIEWS_PATH) {
        const pages = input.reviewPublicationReads ?? [[]];
        const body = pages[Math.min(reviewPublicationRead, pages.length - 1)];
        reviewPublicationRead += 1;
        return json(body);
      }
      if ((request.method === 'POST' || request.method === 'DELETE')
        && path === REVIEWERS_PATH) {
        if (input.write instanceof Error) throw input.write;
        return input.write ?? json(GITHUB_PULL_REQUEST_RESPONSE);
      }
      if (request.method === 'POST' && path === REVIEWS_PATH) {
        if (input.write instanceof Error) throw input.write;
        return input.write ?? json({ id: 991, state: 'APPROVED' }, 201);
      }
      return undefined;
    },
  });
}

/* ---------------------------------------------------------- review publication */

describe('GitHub pull-request review publication', () => {
  function publicationInput(overrides: Readonly<Record<string, unknown>> = {}) {
    return {
      v: 1,
      instance: configuredInstance(),
      localRef: PULL_REQUEST_REF,
      routingToken: REPOSITORY_KEY,
      headRevision: OBSERVED_HEAD,
      verdict: 'approve',
      summary: 'The implementation is ready to merge.',
      ...overrides,
    };
  }

  it('submits summary and verdict atomically at the observed head, then returns the authoritative detail', async () => {
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody()] });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.observation.kind).toBe('present');
    expect(entryReads(stub)).toHaveLength(2);
    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(REVIEWS_PATH);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      commit_id: OBSERVED_HEAD,
      event: 'APPROVE',
      body: 'The implementation is ready to merge.',
      comments: [],
    });
  });

  it('rejects a moved observed head before dispatch and returns what GitHub has now', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ headSha: ADVANCED_HEAD })] });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reports uncertainty when GitHub accepted the one submission but the authoritative reread fails', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      readStatus: 503,
      write: json({ id: 991, state: 'CHANGES_REQUESTED' }, 201),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(
        publicationInput({ verdict: 'requestChanges' }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
  });

  it('does not fabricate rejection when GitHub returns a server failure after dispatch', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('uncertain');
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(1);
  });

  it('confirms an answer-lost submission from a new authoritative review and never writes twice', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      reviewPublicationReads: [
        [],
        [{
          id: 991,
          commit_id: OBSERVED_HEAD,
          state: 'APPROVED',
          body: 'The implementation is ready to merge.',
          user: { login: 'octocat' },
          submitted_at: '2026-08-13T10:00:00Z',
        }],
      ],
      // The boundary records the POST and then loses its answer. The source must
      // reconcile that one attempt; issuing another POST would duplicate the review.
      write: new Error('socket closed after request dispatch'),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === REVIEWS_PATH)).toHaveLength(2);
  });

  it('keeps an answer-lost submission uncertain when the authoritative review read cannot decide', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewPublicationReads: [[], [{}]],
      write: new Error('socket closed after request dispatch'),
    });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(publicationInput(), stub.context),
    );

    expect(result.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === REVIEWS_PATH)).toHaveLength(2);
  });

  it('rejects inline anchors the source cannot currently project instead of guessing positions', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewPublicationResultV1Schema.parse(
      await publishGithubPullRequestReviewAction(
        publicationInput({ comments: [{ path: 'src/index.ts', line: 12, body: 'Explain this.' }] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('rejected');
    if (result.kind !== 'rejected') throw new Error(`expected rejected, got ${result.kind}`);
    expect(result.reason).toBe('invalid_input');
    expect(stub.requests).toHaveLength(0);
  });
});

function writes(stub: ReturnType<typeof transportFor>): readonly RecordedGithubRequest[] {
  return stub.requests.filter((request) => request.method !== 'GET');
}

function entryReads(stub: ReturnType<typeof transportFor>): readonly RecordedGithubRequest[] {
  return stub.requests.filter((request) => request.method === 'GET'
    && new URL(request.url).pathname === PULL_REQUEST_PATH);
}

/* ---------------------------------------------------------------------- merge */

describe('GitHub pull-request merge', () => {
  it('merges at the exact observed head and claims it only after the confirming read', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
    });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(
        mergeInput({ commitTitle: 'Stream terminal frames (#1284)' }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected an applied merge, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.observation.kind).toBe('present');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PUT');
    // The user's pinned head goes to GitHub's OWN precondition, verbatim, and the
    // body carries nothing GitHub's merge endpoint does not document.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      sha: OBSERVED_HEAD,
      merge_method: 'squash',
      commit_title: 'Stream terminal frames (#1284)',
    });
    // GitHub's merge owns ONE external effect. A successful merge is never followed
    // by a source-ref delete: that endpoint has no expected-tip guard, so it would
    // race a collaborator's later push.
    expect(stub.requests.some((request) => request.method === 'DELETE')).toBe(false);
    // The claim rests on a confirming read, not on the write's own response.
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === PULL_REQUEST_PATH)).toHaveLength(2);
  });

  it('refuses a merge whose head advanced, with zero writes and the head GitHub now has', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ headSha: ADVANCED_HEAD })] });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    // The host must re-render with the head GitHub currently has. A generic error
    // would leave it rendering the commits the user already decided about.
    expect(result.observation?.kind).toBe('present');
    if (result.observation?.kind !== 'present') throw new Error('unreachable');
    // `nativeRevision` is a top-level field of the published present observation,
    // not a snapshot field: the snapshot schema is `additive-open/drop`, so
    // asserting it there would silently read `undefined` forever and pass against
    // any head the provider returned.
    expect(result.observation.nativeRevision).toBe(ADVANCED_HEAD);
    expect(writes(stub)).toHaveLength(0);
  });

  it('treats a 409 as a moved head, confirms once, and never reissues the write', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ headSha: ADVANCED_HEAD })],
      write: { status: 409, headers: {}, body: { message: 'Head branch was modified.' } },
    });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reports a 405 as not mergeable rather than as a bare provider error', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: { status: 405, headers: {}, body: { message: 'Pull Request is not mergeable' } },
    });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('not_mergeable');
    expect(writes(stub)).toHaveLength(1);
  });

  it('refuses a merge method the repository forbids instead of dispatching it', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      repository: { ...GITHUB_REPOSITORY_RESPONSE, allow_rebase_merge: false },
    });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput({ mergeMethod: 'rebase' }), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('merge_method_not_allowed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('never turns an unstated repository merge setting into a prohibition', async () => {
    // GitHub omits `allow_*` for some credentials and visibilities. Silence is
    // unknown, and refusing on it would block a merge the repository allows.
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
      repository: GITHUB_REPOSITORY_RESPONSE,
    });
    expect(Object.keys(GITHUB_REPOSITORY_RESPONSE)).not.toContain('allow_rebase_merge');

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput({ mergeMethod: 'rebase' }), stub.context),
    );
    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
  });

  it('returns the re-observed entity for an already merged pull request without writing', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed', merged: true })] });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    // A second merge converges on the same state rather than creating a second
    // object — but it is answered from the read, not from a request.
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reports an accepted merge whose confirming read failed as uncertain, not as success', async () => {
    const stub = transportFor({ reads: [pullRequestBody()], readStatus: 500 });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.failure?.class).toBe('transient');
    // One write, and no retry: the user's decision was about the state they saw.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after dispatch before reporting the merge outcome', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed', merged: true })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(mergeInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    // A 5xx can arrive after GitHub applied the merge. The authoritative reread,
    // rather than the failed response, decides the one outcome we report.
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('makes no request at all for a ref this write does not apply to', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestMergeResultV1Schema.parse(
      await mergeGithubPullRequestAction(
        mergeInput({ localRef: { ...PULL_REQUEST_REF, kindId: 'issue' } }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });
});

/* --------------------------------------------------------------- close/reopen */

describe('GitHub pull-request close and reopen', () => {
  it('closes an open pull request through the native state patch and confirms it', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PATCH');
    // Exactly the named transition. Nothing else about the pull request is
    // replaced by a write the user did not ask for.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({ state: 'closed' });
  });

  it('answers an already closed pull request from the read, with no second write', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed' })] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reopens a closed, unmerged pull request', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ state: 'closed' }), pullRequestBody()],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await reopenGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest)).toEqual({ state: 'open' });
  });

  it('refuses to reopen a merged pull request and never patches it', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ state: 'closed', merged: true })] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await reopenGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('state_changed');
    expect(result.observation?.kind).toBe('present');
    expect(writes(stub)).toHaveLength(0);
  });

  it('maps a rejected state patch to its classified provider failure', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      write: {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'pull_requests=write' },
        body: { message: 'Resource not accessible' },
      },
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'insufficient_scope' });
  });

  it('reconciles a possibly-applied state patch after a server error', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed' })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubPullRequestAction(stateInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('rebinds the exact configured account on every write invocation', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ state: 'closed' })],
    });

    await closeGithubPullRequestAction(stateInput(), stub.context);
    // Cached corpus bytes never authorize a mutation: the account is
    // rematerialized for THIS invocation, against the exact configured ref.
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ----------------------------------------------------------------- mark ready */

describe('GitHub pull-request mark ready for review', () => {
  it('marks a draft ready through GitHub’s own transition at the observed head', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true }), pullRequestBody({ draft: false })],
    });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    // `PATCH /pulls/{n}` documents no draft field, and a REST field GitHub does
    // not document is silently ignored — the worst outcome, because the user
    // would believe every reviewer was summoned.
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(GRAPHQL_PATH);
    const body = readRecordedJsonBody(dispatched[0] as RecordedGithubRequest) as {
      query: string;
      variables: Record<string, unknown>;
    };
    expect(body.query).toContain('markPullRequestReadyForReview');
    // Addressed by the node id THIS validated read published, never by a guess
    // built from the number.
    expect(body.variables).toEqual({ pullRequestId: PULL_REQUEST_NODE_ID });
    // The claim rests on the confirming read, not on the mutation payload.
    expect(entryReads(stub)).toHaveLength(2);
  });

  it('refuses a draft whose head advanced, with zero writes and the head GitHub now has', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true, headSha: ADVANCED_HEAD })],
    });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    // The write's effect IS the notification fan-out. Against a stale head it
    // summons reviewers to commits the acting user never saw.
    expect(result.reason).toBe('head_advanced');
    if (result.observation?.kind !== 'present') throw new Error('expected the observed entity');
    expect(result.observation.nativeRevision).toBe(ADVANCED_HEAD);
    expect(writes(stub)).toHaveLength(0);
  });

  it('answers a pull request that is already ready from the read, with no notification', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ draft: false })] });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('refuses a draft that is no longer open instead of dispatching a transition', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true, state: 'closed' })],
    });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('state_changed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('never reads a GraphQL 200 carrying errors as a successful transition', async () => {
    // GraphQL answers `200 OK` for its own failures: a rejected mutation returns
    // `data: null` with a populated `errors` array. A transport success is not a
    // claim that the provider changed anything.
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true })],
      write: json({
        data: null,
        errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }],
      }),
    });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'github_forbidden' });
    expect(writes(stub)).toHaveLength(1);
    // A rejected mutation changed nothing, so there is no second read to make.
    expect(entryReads(stub)).toHaveLength(1);
  });

  it('never dispatches a transition for an entity the read published no node id for', async () => {
    const { node_id: _omitted, ...withoutNodeId } = pullRequestBody({ draft: true });
    const stub = transportFor({ reads: [withoutNodeId] });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({
      class: 'unsupportedContract',
      code: 'github_entity_id_unavailable',
    });
    // Addressing the transition with a guessed id would mark whatever currently
    // occupies that route ready for review.
    expect(writes(stub)).toHaveLength(0);
  });

  it('reports an accepted transition the confirming read still sees as draft as uncertain', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true }), pullRequestBody({ draft: true })],
    });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.observation?.kind).toBe('present');
    // One request, and no retry: a retry would re-decide on the user's behalf.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after GitHub may have marked the pull request ready', async () => {
    const stub = transportFor({
      reads: [pullRequestBody({ draft: true }), pullRequestBody({ draft: false })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestMarkReadyResultV1Schema.parse(
      await markGithubPullRequestReadyAction(stateInput({ headRevision: OBSERVED_HEAD }), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });
});

/* -------------------------------------------------------------- update branch */

describe('GitHub pull-request update branch', () => {
  it('sends GitHub’s own expected-head precondition and applies once the head moved', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ headSha: ADVANCED_HEAD })],
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PUT');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(UPDATE_BRANCH_PATH);
    // The user's pinned head goes to GitHub's OWN precondition verbatim, and the
    // body carries nothing else.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ expected_head_sha: OBSERVED_HEAD });
  });

  it('reports an accepted update the confirming read cannot yet observe as pending', async () => {
    // `202 Accepted` states that GitHub took the request, not that the branch
    // moved. Calling this applied would tell the user their branch was updated
    // while the update is still queued.
    const stub = transportFor({ reads: [pullRequestBody(), pullRequestBody()] });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'pending') throw new Error(`expected pending, got ${result.kind}`);
    if (result.observation.kind !== 'present') throw new Error('expected the observed entity');
    expect(result.observation.nativeRevision).toBe(OBSERVED_HEAD);
    // Accepted once. No poll on a source timer, and no second PUT.
    expect(writes(stub)).toHaveLength(1);
    expect(entryReads(stub)).toHaveLength(2);
  });

  it('confirms an answer-lost update once and never maps it to definite failure', async () => {
    let pullRequestRead = 0;
    const stub = createStubGithubTransport({
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
          const body = pullRequestRead++ === 0
            ? pullRequestBody()
            : pullRequestBody({ headSha: ADVANCED_HEAD });
          return json(body);
        }
        if (request.method === 'PUT' && path === UPDATE_BRANCH_PATH) {
          return Promise.reject(new Error('answer lost after dispatch'));
        }
        return undefined;
      },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
    expect(entryReads(stub)).toHaveLength(2);
  });

  it('refuses an update whose head advanced, with zero PUTs', async () => {
    const stub = transportFor({ reads: [pullRequestBody({ headSha: ADVANCED_HEAD })] });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(writes(stub)).toHaveLength(0);
  });

  it('maps a 422 whose confirming read shows a moved head to head_advanced, and never reissues', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ headSha: ADVANCED_HEAD })],
      write: { status: 422, headers: {}, body: { message: 'Expected head sha didn’t match' } },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'refused') throw new Error(`expected a refusal, got ${result.kind}`);
    expect(result.reason).toBe('head_advanced');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after GitHub may have accepted an update branch request', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody({ headSha: ADVANCED_HEAD })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(entryReads(stub)).toHaveLength(2);
    expect(writes(stub)).toHaveLength(1);
  });

  it('maps a 422 whose head did not move to the classified provider failure', async () => {
    const stub = transportFor({
      reads: [pullRequestBody(), pullRequestBody()],
      write: { status: 422, headers: {}, body: { message: 'merge conflict between base and head' } },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'unsupportedContract', code: 'github_unprocessable' });
    expect(writes(stub)).toHaveLength(1);
  });

  it('maps a 403 to the permission failure GitHub’s own header names, with no second read', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      write: {
        status: 403,
        headers: { 'x-accepted-github-permissions': 'contents=write' },
        body: { message: 'Resource not accessible' },
      },
    });

    const result = GithubPullRequestUpdateBranchResultV1Schema.parse(
      await updateGithubPullRequestBranchAction(
        stateInput({ headRevision: OBSERVED_HEAD }),
        stub.context,
      ),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'insufficient_scope' });
    expect(entryReads(stub)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- add reviewers */

describe('GitHub pull-request reviewer requests', () => {
  it('requests exactly the named users and teams and confirms each named addition', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({}),
        reviewerCollection({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.requestedReviewers).toEqual({
      users: ['octocat'],
      teams: ['frame-pump-reviewers'],
    });

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(REVIEWERS_PATH);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      reviewers: ['octocat'],
      team_reviewers: ['frame-pump-reviewers'],
    });
  });

  it('sends an exact delta, so a reviewer somebody else requested is never withdrawn', async () => {
    // A desired full set would silently withdraw `monalisa`, whom a colleague
    // requested between our read and our write. A delta cannot.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['monalisa'] }),
        reviewerCollection({ users: ['monalisa', 'octocat'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    // Only the named addition leaves, and no team member is sent at all.
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest))
      .toEqual({ reviewers: ['octocat'] });
    // Confirmation checks only the requested addition; the unrelated reviewer is
    // reported, not equality-checked.
    expect(result.requestedReviewers.users).toEqual(['monalisa', 'octocat']);
  });

  it('answers an already pending reviewer from the read rather than re-notifying them', async () => {
    // GitHub logins are case-insensitive and it answers in its own canonical
    // casing. Re-requesting a pending reviewer is not free: it notifies again.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['OctoCat'] })],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects an empty delta before any request leaves', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(stateInput(), stub.context),
    );
    expect(result.kind).toBe('failed');
    // An empty request is rejected rather than turned into a request for nobody.
    expect(stub.requests).toHaveLength(0);
  });

  it('reports an addition the confirming read did not observe as uncertain, not as success', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({}), reviewerCollection({})],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.requestedReviewers).toEqual({ users: [], teams: [] });
    // One request, never retried: a retry would notify a second time.
    expect(writes(stub)).toHaveLength(1);
  });

  it('confirms an answer-lost reviewer request once and never re-notifies', async () => {
    let reviewerRead = 0;
    const stub = createStubGithubTransport({
      respond: (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === 'GET' && path === PULL_REQUEST_PATH) {
          return json(pullRequestBody());
        }
        if (request.method === 'GET' && path === REVIEWERS_PATH) {
          return json(reviewerRead++ === 0
            ? reviewerCollection({})
            : reviewerCollection({ users: ['octocat'] }));
        }
        if (request.method === 'POST' && path === REVIEWERS_PATH) {
          return Promise.reject(new Error('answer lost after dispatch'));
        }
        return undefined;
      },
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => (
      request.method === 'GET' && new URL(request.url).pathname === REVIEWERS_PATH
    ))).toHaveLength(2);
  });

  it('reconciles a server error after a reviewer request may have been applied', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({}), reviewerCollection({ users: ['octocat'] })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => (
      request.method === 'GET' && new URL(request.url).pathname === REVIEWERS_PATH
    ))).toHaveLength(2);
  });

  it('never requests reviewers on a route whose entry identity no longer validates', async () => {
    // A stale routing token that resolves to another repository's pull request
    // would otherwise summon strangers to somebody else's code.
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await addGithubPullRequestReviewersAction(
        stateInput({
          users: ['octocat'],
          localRef: { ...PULL_REQUEST_REF, collisionScope: 'github:8815' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests.some((request) => (
      new URL(request.url).pathname === REVIEWERS_PATH
    ))).toBe(false);
  });

  it('rebinds the exact configured account on a reviewer request', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({}), reviewerCollection({ users: ['octocat'] })],
    });

    await addGithubPullRequestReviewersAction(
      stateInput({ users: ['octocat'] }),
      stub.context,
    );
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ------------------------------------------------------- reviewer withdrawal */

describe('GitHub pull-request reviewer withdrawal', () => {
  it('withdraws exactly the named users and teams and confirms each named removal', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
        reviewerCollection({}),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'], teams: ['frame-pump-reviewers'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.requestedReviewers).toEqual({ users: [], teams: [] });

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    // GitHub's own withdrawal endpoint, which is a DELETE on the same collection —
    // never `PUT /requested_reviewers` and never a desired full set.
    expect(dispatched[0]?.method).toBe('DELETE');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(REVIEWERS_PATH);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest)).toEqual({
      reviewers: ['octocat'],
      team_reviewers: ['frame-pump-reviewers'],
    });
  });

  it('sends an exact delta, so a reviewer somebody else requested is never withdrawn', async () => {
    // The one failure a desired full set makes unavoidable: `monalisa` was
    // requested by a colleague between our read and our write and must survive a
    // withdrawal that never named her.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['octocat', 'monalisa'] }),
        reviewerCollection({ users: ['monalisa'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest))
      .toEqual({ reviewers: ['octocat'] });
    // Confirmation checks only the requested removal. The reviewer nobody asked to
    // withdraw is reported, not equality-checked and not restored.
    expect(result.requestedReviewers.users).toEqual(['monalisa']);
  });

  it('answers a reviewer who is not requested from the read, with no write at all', async () => {
    // GitHub logins are case-insensitive and it answers in its own canonical
    // casing, so `OctoCat` present must count as `octocat` still requested.
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['monalisa'] })],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('rejects an empty delta before any request leaves', async () => {
    const stub = transportFor({ reads: [pullRequestBody()] });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(stateInput(), stub.context),
    );
    expect(result.kind).toBe('failed');
    // An empty withdrawal is rejected rather than turned into a removal of nobody.
    expect(stub.requests).toHaveLength(0);
  });

  it('reports a withdrawal the confirming read still observes as uncertain, not as success', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [
        reviewerCollection({ users: ['octocat'] }),
        reviewerCollection({ users: ['octocat'] }),
      ],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.requestedReviewers).toEqual({ users: ['octocat'], teams: [] });
    // Accepted and unconfirmed is never retried on the user's behalf.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a server error after a reviewer withdrawal may have been applied', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['octocat'] }), reviewerCollection({})],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({ users: ['octocat'] }),
        stub.context,
      ),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => (
      request.method === 'GET' && new URL(request.url).pathname === REVIEWERS_PATH
    ))).toHaveLength(2);
  });

  it('never withdraws reviewers on a route whose entry identity no longer validates', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['octocat'] })],
    });

    const result = GithubPullRequestReviewersResultV1Schema.parse(
      await removeGithubPullRequestReviewersAction(
        stateInput({
          users: ['octocat'],
          localRef: { ...PULL_REQUEST_REF, collisionScope: 'github:8815' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests.some((request) => (
      new URL(request.url).pathname === REVIEWERS_PATH
    ))).toBe(false);
  });

  it('rebinds the exact configured account on a reviewer withdrawal', async () => {
    const stub = transportFor({
      reads: [pullRequestBody()],
      reviewerReads: [reviewerCollection({ users: ['octocat'] }), reviewerCollection({})],
    });

    await removeGithubPullRequestReviewersAction(
      stateInput({ users: ['octocat'] }),
      stub.context,
    );
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* --------------------------------------------------------------- issue writes */

const ISSUE_REF = Object.freeze({
  kindId: 'issue',
  collisionScope: 'github:4210',
  entryId: '7',
});

const ISSUE_PATH = `/repos/${GITHUB_FIXTURE_OWNER}/${GITHUB_FIXTURE_REPOSITORY}/issues/7`;

function issueInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: ISSUE_REF,
    routingToken: REPOSITORY_KEY,
    ...overrides,
  };
}

type IssueShape = Readonly<{
  state?: 'open' | 'closed';
  labels?: readonly string[];
  assignees?: readonly string[];
}>;

function issueBody(shape: IssueShape = {}): Readonly<Record<string, unknown>> {
  const state = shape.state ?? 'open';
  return Object.freeze({
    ...GITHUB_ISSUE_RESPONSE,
    number: 7,
    state,
    closed_at: state === 'closed' ? '2026-08-13T10:00:00Z' : null,
    labels: (shape.labels ?? []).map((name) => ({ id: 1, name, color: 'ededed' })),
    assignees: (shape.assignees ?? []).map((login) => ({ login, id: 2, type: 'User' })),
  });
}

/** Answers the issue reads every issue write performs, in order. */
function issueTransportFor(input: Readonly<{
  reads: readonly Readonly<Record<string, unknown>>[];
  write?: StubHttpResponse;
}>) {
  let read = 0;
  return createStubGithubTransport({
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === ISSUE_PATH) {
        const body = input.reads[Math.min(read, input.reads.length - 1)];
        read += 1;
        return json(body);
      }
      if (request.method === 'GET' && path === REPOSITORY_PATH) {
        return json(GITHUB_REPOSITORY_RESPONSE);
      }
      if (request.method !== 'GET' && path.startsWith(ISSUE_PATH)) {
        return input.write ?? json(input.reads[input.reads.length - 1]);
      }
      return undefined;
    },
  });
}

describe('GitHub issue close and reopen', () => {
  it('closes an open issue with the caller’s explicit reason and confirms it', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ state: 'closed' })],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'not_planned' }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('PATCH');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(ISSUE_PATH);
    // The reason is CARRIED, never chosen: GitHub shows "closed as not planned"
    // differently from "completed" to everyone watching.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ state: 'closed', state_reason: 'not_planned' });
  });

  it('refuses a close whose reason the caller did not supply, before any request leaves', async () => {
    const stub = issueTransportFor({ reads: [issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput(), stub.context),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });

  it('answers an already closed issue from the read, with no second write', async () => {
    const stub = issueTransportFor({ reads: [issueBody({ state: 'closed' })] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('reopens a closed issue and sends no reason of its own', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ state: 'closed' }), issueBody()],
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await reopenGithubIssueAction(issueInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    // GitHub owns `state_reason: 'reopened'`; inventing one here would publish a
    // claim the person did not make.
    expect(readRecordedJsonBody(writes(stub)[0] as RecordedGithubRequest))
      .toEqual({ state: 'open' });
  });

  it('reports a close the confirming read still sees open as uncertain, not as success', async () => {
    const stub = issueTransportFor({ reads: [issueBody(), issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    // Accepted and unconfirmed is never retried on the user's behalf.
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a possibly-applied issue close after a server error', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ state: 'closed' })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(issueInput({ stateReason: 'completed' }), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === ISSUE_PATH)).toHaveLength(2);
  });

  it('never writes an issue transition on a route whose entry identity no longer validates', async () => {
    const stub = issueTransportFor({ reads: [issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(
        issueInput({
          stateReason: 'completed',
          localRef: { ...ISSUE_REF, collisionScope: 'github:8815' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(writes(stub)).toHaveLength(0);
  });

  it('refuses a pull-request ref on an issue write and calls nothing at all', async () => {
    const stub = issueTransportFor({ reads: [issueBody()] });

    const result = GithubPullRequestStateResultV1Schema.parse(
      await closeGithubIssueAction(
        issueInput({ stateReason: 'completed', localRef: PULL_REQUEST_REF }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });
});

describe('GitHub issue assignee and label deltas', () => {
  it('adds exactly the named assignees through GitHub’s own delta endpoint', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ assignees: ['monalisa'] }), issueBody({ assignees: ['monalisa', 'octocat'] })],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueAssigneesAction(issueInput({ usernames: ['octocat'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(`${ISSUE_PATH}/assignees`);
    // Only the named addition leaves. `PATCH /issues/{n}` with an `assignees`
    // array would have replaced the set and dropped `monalisa`.
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ assignees: ['octocat'] });
  });

  it('removes exactly the named assignees and leaves everyone else assigned', async () => {
    const stub = issueTransportFor({
      reads: [
        issueBody({ assignees: ['octocat', 'monalisa'] }),
        issueBody({ assignees: ['monalisa'] }),
      ],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await removeGithubIssueAssigneesAction(issueInput({ usernames: ['octocat'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    const dispatched = writes(stub);
    expect(dispatched[0]?.method).toBe('DELETE');
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ assignees: ['octocat'] });
  });

  it('answers an assignee delta that already holds from the read, with no write', async () => {
    const stub = issueTransportFor({ reads: [issueBody({ assignees: ['OctoCat'] })] });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueAssigneesAction(issueInput({ usernames: ['octocat'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(writes(stub)).toHaveLength(0);
  });

  it('adds exactly the named labels and never replaces the set', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ labels: ['bug'] }), issueBody({ labels: ['bug', 'needs triage'] })],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueLabelsAction(issueInput({ labels: ['needs triage'] }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    const dispatched = writes(stub);
    expect(dispatched[0]?.method).toBe('POST');
    expect(new URL(dispatched[0]?.url ?? '').pathname).toBe(`${ISSUE_PATH}/labels`);
    expect(readRecordedJsonBody(dispatched[0] as RecordedGithubRequest))
      .toEqual({ labels: ['needs triage'] });
  });

  it('removes one label through the single-label delete, path-encoded as one segment', async () => {
    const stub = issueTransportFor({
      reads: [
        issueBody({ labels: ['bug', 'area/sync engine'] }),
        issueBody({ labels: ['bug'] }),
      ],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await removeGithubIssueLabelAction(issueInput({ label: 'area/sync engine' }), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');

    const dispatched = writes(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.method).toBe('DELETE');
    // The label is ONE segment. Unencoded, `area/sync engine` would address
    // `.../labels/area/sync%20engine`, which is a different route entirely.
    expect(new URL(dispatched[0]?.url ?? '').pathname)
      .toBe(`${ISSUE_PATH}/labels/area%2Fsync%20engine`);
    // GitHub's single-label delete carries no body.
    expect(dispatched[0]?.body).toBeUndefined();
  });

  it('rejects an empty or oversized delta before any request leaves', async () => {
    for (const overrides of [
      { usernames: [] },
      { usernames: Array.from({ length: 11 }, (_, index) => `person${index}`) },
      { usernames: ['octocat', 'octocat'] },
    ]) {
      const stub = issueTransportFor({ reads: [issueBody()] });
      const result = GithubIssueDeltaResultV1Schema.parse(
        await addGithubIssueAssigneesAction(issueInput(overrides), stub.context),
      );
      expect(result.kind).toBe('failed');
      expect(stub.requests).toHaveLength(0);
    }
  });

  it('reports a delta the confirming read did not observe as uncertain, not as success', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ labels: ['bug'] }), issueBody({ labels: ['bug'] })],
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueLabelsAction(issueInput({ labels: ['needs triage'] }), stub.context),
    );
    expect(result.kind).toBe('uncertain');
    expect(writes(stub)).toHaveLength(1);
  });

  it('reconciles a possibly-applied delta after a server error', async () => {
    const stub = issueTransportFor({
      reads: [issueBody({ labels: ['bug'] }), issueBody({ labels: ['bug', 'needs triage'] })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubIssueDeltaResultV1Schema.parse(
      await addGithubIssueLabelsAction(issueInput({ labels: ['needs triage'] }), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(writes(stub)).toHaveLength(1);
    expect(stub.requests.filter((request) => request.method === 'GET'
      && new URL(request.url).pathname === ISSUE_PATH)).toHaveLength(2);
  });

  it('rebinds the exact configured account on an issue delta', async () => {
    const stub = issueTransportFor({
      reads: [issueBody(), issueBody({ labels: ['bug'] })],
    });

    await addGithubIssueLabelsAction(issueInput({ labels: ['bug'] }), stub.context);
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});

/* ------------------------------------------------------- review thread resolution */

/**
 * Resolving and reopening one line-anchored review thread.
 *
 * A thread node id is OPAQUE and global: it names a thread anywhere GitHub will
 * let this account reach, not necessarily the pull request the user is looking
 * at. So the read that precedes the write is not only a preflight — it is the
 * identity proof, and every case below asserts what was and was not dispatched.
 */

const THREAD_ID = 'PRRT_kwDOABCD1M4AAbCd';

function threadInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: PULL_REQUEST_REF,
    routingToken: REPOSITORY_KEY,
    threadId: THREAD_ID,
    resolved: true,
    ...overrides,
  };
}

type ThreadShape = Readonly<{
  isResolved?: boolean;
  number?: number;
  owner?: string;
  repository?: string;
}>;

function threadNode(shape: ThreadShape = {}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    data: Object.freeze({
      node: Object.freeze({
        __typename: 'PullRequestReviewThread',
        id: THREAD_ID,
        isResolved: shape.isResolved ?? false,
        pullRequest: Object.freeze({
          number: shape.number ?? 1284,
          repository: Object.freeze({
            // GitHub answers in ITS canonical casing, which is not the lowercased
            // routing token, so a case-sensitive comparison would refuse every
            // legitimate thread.
            name: shape.repository ?? GITHUB_FIXTURE_REPOSITORY.toUpperCase(),
            owner: Object.freeze({ login: shape.owner ?? GITHUB_FIXTURE_OWNER.toUpperCase() }),
          }),
        }),
      }),
    }),
  });
}

/**
 * Answers the thread reads in order and lets one case decide what the mutation
 * itself returns. Every GraphQL request is a POST to one URL, so a case can only
 * be proved by reading the DOCUMENTS that were sent.
 */
function threadTransportFor(input: Readonly<{
  reads: readonly Readonly<Record<string, unknown>>[];
  write?: StubHttpResponse;
}>) {
  let read = 0;
  return createStubGithubTransport({
    respond: (request: RecordedGithubRequest): StubHttpResponse | undefined => {
      const path = new URL(request.url).pathname;
      if (request.method !== 'POST' || path !== GRAPHQL_PATH) return undefined;
      const document = String(
        (readRecordedJsonBody(request) as Readonly<{ query?: unknown }>).query ?? '',
      );
      if (document.includes('resolveReviewThread')) {
        return input.write ?? json({
          data: {
            [document.includes('unresolveReviewThread') ? 'unresolveReviewThread' : 'resolveReviewThread']:
              { thread: { id: THREAD_ID, isResolved: !document.includes('unresolveReviewThread') } },
          },
        });
      }
      const body = input.reads[Math.min(read, input.reads.length - 1)];
      read += 1;
      return json(body);
    },
  });
}

/** Every GraphQL document this invocation actually sent, in order. */
function graphqlDocuments(stub: ReturnType<typeof threadTransportFor>): readonly string[] {
  return stub.requests
    .filter((request) => request.method === 'POST'
      && new URL(request.url).pathname === GRAPHQL_PATH)
    .map((request) => String(
      (readRecordedJsonBody(request) as Readonly<{ query?: unknown }>).query ?? '',
    ));
}

function threadMutations(stub: ReturnType<typeof threadTransportFor>): readonly string[] {
  return graphqlDocuments(stub).filter((document) => document.includes('solveReviewThread('));
}

describe('GitHub review-thread resolution', () => {
  it('resolves a thread on this pull request and claims it only after the confirming read', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: true })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.thread).toEqual({ id: THREAD_ID, isResolved: true });

    const dispatched = threadMutations(stub);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toContain('resolveReviewThread(');
    expect(dispatched[0]).not.toContain('unresolveReviewThread(');
    // The mutation's own payload is not the claim. Two reads bracket the write:
    // the identity/preflight read and the confirming read.
    expect(graphqlDocuments(stub)).toHaveLength(3);
    // The write carries the caller's exact opaque node id and nothing else.
    const written = stub.requests.filter((request) => request.method === 'POST');
    expect((readRecordedJsonBody(written[1] as RecordedGithubRequest) as Readonly<{
      variables?: unknown;
    }>).variables).toEqual({ threadId: THREAD_ID });
  });

  it('reopens a resolved thread through GitHub’s own unresolve mutation', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: true }), threadNode({ isResolved: false })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(
        threadInput({ resolved: false }),
        stub.context,
      ),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(result.thread.isResolved).toBe(false);

    const dispatched = threadMutations(stub);
    expect(dispatched).toHaveLength(1);
    // The direction the caller asked for is the direction dispatched. An
    // implementation that always resolves would collapse "reopen" into its
    // opposite and report success for it.
    expect(dispatched[0]).toContain('unresolveReviewThread(');
  });

  it('answers a thread that already holds the requested state from the read, with no write', async () => {
    const stub = threadTransportFor({ reads: [threadNode({ isResolved: true })] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('alreadySatisfied');
    expect(result.thread).toEqual({ id: THREAD_ID, isResolved: true });
    expect(threadMutations(stub)).toHaveLength(0);
    expect(graphqlDocuments(stub)).toHaveLength(1);
  });

  it('refuses a thread that belongs to another pull request and dispatches nothing', async () => {
    const stub = threadTransportFor({ reads: [threadNode({ number: 990 })] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure.code).toBe('github_review_thread_not_on_entry');
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('refuses a thread that belongs to another repository and dispatches nothing', async () => {
    // The SAME pull-request number in a DIFFERENT repository: an implementation
    // that compared only the number would resolve a stranger's thread.
    const stub = threadTransportFor({
      reads: [threadNode({ owner: 'someone-else', repository: 'another-repo' })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure.code).toBe('github_review_thread_not_on_entry');
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('never dispatches for a node GitHub did not answer as a review thread', async () => {
    const stub = threadTransportFor({
      reads: [{ data: { node: { __typename: 'Issue', id: THREAD_ID } } }],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure.code).toBe('github_review_thread_absent');
    expect(threadMutations(stub)).toHaveLength(0);
  });

  it('never reads a GraphQL 200 carrying errors as a resolution', async () => {
    const stub = threadTransportFor({
      reads: [threadNode()],
      write: json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'nope' }] }),
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'failed') throw new Error(`expected failed, got ${result.kind}`);
    expect(result.failure).toEqual({ class: 'permission', code: 'github_forbidden' });
    // One read, one rejected write, and no confirming read for an effect that
    // never happened.
    expect(graphqlDocuments(stub)).toHaveLength(2);
  });

  it('reports a resolution the confirming read still contradicts as uncertain, not as success', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: false })],
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );
    if (result.kind !== 'uncertain') throw new Error(`expected uncertain, got ${result.kind}`);
    expect(result.thread).toEqual({ id: THREAD_ID, isResolved: false });
    // Accepted and unobserved is never retried: a second dispatch would re-decide
    // against state the user never saw.
    expect(threadMutations(stub)).toHaveLength(1);
  });

  it('reconciles a server error after GitHub may have resolved the thread', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: true })],
      write: json({ message: 'Internal Server Error' }, 503),
    });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context),
    );

    expect(result.kind).toBe('applied');
    if (result.kind !== 'applied') throw new Error(`expected applied, got ${result.kind}`);
    expect(result.effect).toBe('changed');
    expect(threadMutations(stub)).toHaveLength(1);
    expect(graphqlDocuments(stub)).toHaveLength(3);
  });

  it('refuses an issue ref on a thread write and calls nothing at all', async () => {
    const stub = threadTransportFor({ reads: [threadNode()] });

    const result = GithubPullRequestThreadResolutionResultV1Schema.parse(
      await setGithubPullRequestThreadResolutionAction(
        threadInput({
          localRef: { kindId: 'issue', collisionScope: 'github:4210', entryId: '1284' },
        }),
        stub.context,
      ),
    );
    expect(result.kind).toBe('failed');
    expect(stub.requests).toHaveLength(0);
  });

  it('rebinds the exact configured account on a thread resolution', async () => {
    const stub = threadTransportFor({
      reads: [threadNode({ isResolved: false }), threadNode({ isResolved: true })],
    });

    await setGithubPullRequestThreadResolutionAction(threadInput(), stub.context);
    expect(stub.materializeCount()).toBe(1);
    expect(stub.materializations[0]?.account).toEqual(CONFIGURED_ACCOUNT);
    expect(stub.materializations[0]?.purpose).toBe(GITHUB_CONNECTED_ACCOUNT_PURPOSE);
  });
});
