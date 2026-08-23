import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { encodeAzureSourceConfiguration } from './configuration.js';
import { AZURE_DEVOPS_TRIAGE_PURPOSE } from './descriptor.js';
import { buildAzureCollisionScope } from './identity.js';
import {
  abandonAzureDevOpsPullRequest,
  completeAzureDevOpsPullRequest,
  reactivateAzureDevOpsPullRequest,
  requestAzureDevOpsPullRequestReview,
  setAzureDevOpsPullRequestThreadStatus,
} from './mutationActions.js';
import {
  AzureMutationResultV1Schema,
  AzureThreadStatusResultV1Schema,
} from './mutations/contracts.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';

/**
 * The deciding proofs for the two enabled Azure DevOps pull-request writes.
 *
 * Everything below the two boundary doubles runs for real: origin normalization, local-ref
 * admission, api-version pinning, the PATCH body, the polled confirming read, the row decoder and
 * the published result schema. Each assertion targets a way an Azure completion can be silently
 * wrong — a write against a merge source the user never saw, a queued completion rendered as
 * merged, a `200` whose fields Azure silently ignored — rather than restating the happy path.
 */

const BASE_URL = 'https://dev.azure.com/acme';
const PROJECT_ID = '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const REPOSITORY_ID = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
const PULL_REQUEST_ID = 17;
const VIEWER_ID = 'd6245f20-2af8-44f4-9451-8107cb2767db';
const OBSERVED_SOURCE_COMMIT = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const ADVANCED_SOURCE_COMMIT = '0f9e8d7c6b5a49382716059f8e7d6c5b4a392817';
const MERGE_COMMIT = '5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d';

function accountRef(accountId: string): QualifiedConnectedAccountRef {
  return {
    service: { pluginId: 'happier.scm.forge.azure-devops', localId: AZURE_DEVOPS_TRIAGE_PURPOSE },
    accountId,
  };
}

function configuredOrigin() {
  const result = normalizeAzureDevOpsBaseUrl(BASE_URL);
  if (!result.ok) throw new Error('fixture base is not normalizable');
  return result.origin;
}

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.azure-devops', localId: 'azure-devops-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: accountRef('account-1') },
    localInstanceKey: BASE_URL,
    configuration: encodeAzureSourceConfiguration(configuredOrigin()),
  };
}

function localRef() {
  const scope = buildAzureCollisionScope({
    origin: configuredOrigin(),
    repositoryId: REPOSITORY_ID,
  });
  if (scope === null) throw new Error('the fixture repository must have a scope');
  return { kindId: 'pull-request', collisionScope: scope, entryId: String(PULL_REQUEST_ID) };
}

function completeInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: localRef(),
    observedSourceCommitId: OBSERVED_SOURCE_COMMIT,
    deleteSourceBranch: false,
    ...overrides,
  };
}

function abandonInput() {
  return { v: 1, instance: configuredInstance(), localRef: localRef() };
}

/** One Azure pull-request body, at whichever state the case needs. */
function pullRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    pullRequestId: PULL_REQUEST_ID,
    repository: {
      id: REPOSITORY_ID,
      name: 'payments',
      project: { id: PROJECT_ID, name: 'Payments' },
      url: `${BASE_URL}/_apis/git/repositories/${REPOSITORY_ID}`,
    },
    title: 'Tighten the completion gate',
    status: 'active',
    isDraft: false,
    createdBy: { id: VIEWER_ID, displayName: 'Alex Rivera', uniqueName: 'alex@example.test' },
    creationDate: '2026-08-01T00:00:00Z',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: OBSERVED_SOURCE_COMMIT },
    reviewers: [],
    ...overrides,
  };
}

/** The pull request as Azure reports it once completion has actually finished. */
function completed(completionOptions: Readonly<Record<string, unknown>>) {
  return pullRequest({
    status: 'completed',
    mergeStatus: 'succeeded',
    lastMergeCommit: { commitId: MERGE_COMMIT },
    completionOptions,
  });
}

type Reply = Readonly<{ status?: number; body: unknown }>;
type Captured = Readonly<{ url: string; method: string; body: unknown }>;

/**
 * A harness whose pull-request reads walk a scripted sequence of bodies.
 *
 * A mutation reads the entry before the write and again after it, so a fixture that answered the
 * same body every time could not tell a confirmed effect from an unconfirmed one.
 */
function harness(input: Readonly<{
  reads: readonly unknown[];
  /** Answers a request before the pull-request read sequence sees it. */
  respond?: (request: Readonly<{ url: string; method: string }>) => Reply | undefined;
}>) {
  const requests: Captured[] = [];
  let read = 0;
  const services = {
    connectedAccounts: {
      // Every authorized read re-confirms its exact configured base against the account's
      // own published bases, so the fixture account publishes the one these tests route by.
      async listAccounts() {
        return {
          status: 'complete' as const,
          accounts: [{
            account: accountRef('account-1'),
            displayName: 'Acme',
            state: 'connected' as const,
            connectedAccountOrigins: ['https://dev.azure.com'],
            connectedAccountBases: [BASE_URL],
          }],
        };
      },
      async getBinding(purpose: string) {
        return {
          purpose,
          service: accountRef('account-1').service,
          account: accountRef('account-1'),
          target: { kind: 'account' as const, displayName: 'Acme' },
        };
      },
      async materializeListedAccount() {
        return { kind: 'httpHeaders' as const, headers: { authorization: 'Basic <pat>' } };
      },
    },
    http: {
      async request(request: Readonly<{ url: string; method?: string; body?: unknown }>) {
        const method = request.method ?? 'GET';
        const raw = request.body;
        const decoded = raw instanceof Uint8Array
          ? JSON.parse(new TextDecoder().decode(raw)) as unknown
          : undefined;
        requests.push({ url: request.url, method, body: decoded });

        let reply: Reply;
        const answered = input.respond?.({ url: request.url, method });
        if (request.url.includes('/_apis/connectionData')) {
          reply = { body: { authenticatedUser: { id: VIEWER_ID, providerDisplayName: 'Alex' } } };
        } else if (answered !== undefined) {
          reply = answered;
        } else if (method === 'PATCH') {
          // Azure acknowledges the update. What it acknowledges is the status field, never the
          // merge, so the body it echoes is deliberately not what the assertions read.
          reply = { body: pullRequest() };
        } else {
          reply = { body: input.reads[Math.min(read, input.reads.length - 1)] };
          read += 1;
        }
        return {
          status: reply.status ?? 200,
          finalUrl: request.url,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(reply.body)),
        };
      },
    },
  };
  const context = {
    plugin: { id: 'happier.scm.forge.azure-devops', version: '0.0.0' },
    contribution: { id: 'azure-devops-forge', qualifiedId: 'x/contributions/azure-devops-forge' },
    surface: 'background',
    caller: { kind: 'plugin', pluginId: 'happier.triage' },
    signal: new AbortController().signal,
    services: services as unknown as PluginInvocationContext['services'],
  } as unknown as PluginInvocationContext;
  return { context, requests };
}

const writes = (requests: readonly Captured[]): readonly Captured[] =>
  requests.filter((request) => request.method === 'PATCH');

const nonReadRequests = (requests: readonly Captured[]): readonly Captured[] =>
  requests.filter((request) => request.method !== 'GET');

/* ------------------------------------------------------------------ complete */

describe('Azure DevOps pull-request completion', () => {
  it('refuses a completion whose pinned merge source has moved, with zero writes', async () => {
    const { context, requests } = harness({
      reads: [pullRequest({ lastMergeSourceCommit: { commitId: ADVANCED_SOURCE_COMMIT } })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(completeInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('an advanced merge source must refuse');
    expect(settled.reason).toBe('head-advanced');
    expect(settled.observation.kind).toBe('present');
    expect(writes(requests)).toHaveLength(0);
  });

  it('sends completion options in full, with work items and policy bypass explicitly false', async () => {
    const options = { deleteSourceBranch: true, transitionWorkItems: false, bypassPolicy: false };
    const { context, requests } = harness({
      reads: [pullRequest(), completed(options)],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(
        completeInput({ deleteSourceBranch: true }),
        context,
      ),
    );

    if (settled.kind !== 'applied') throw new Error('a terminal completion must be applied');
    const write = writes(requests)[0];
    expect(write?.method).toBe('PATCH');
    // All three options travel on every completion. Omitting `transitionWorkItems` would inherit
    // whatever a stored completion option decided — and this pull request's stored options in the
    // wider fixtures carry `transitionWorkItems: true`.
    expect(write?.body).toEqual({
      status: 'completed',
      completionOptions: {
        deleteSourceBranch: true,
        transitionWorkItems: false,
        bypassPolicy: false,
        // `bypassReason` is a STORED completion option like its three neighbours: somebody who
        // enabled auto-complete through the web UI can already have written one. Omitting it
        // while sending `bypassPolicy: false` would leave that stranded justification attached
        // to a merge this build performed, attributing a reason nobody here wrote.
        bypassReason: '',
      },
    });
    // Every URL this Action built carries its pinned api-version rather than a server default.
    expect(requests.every((request) => request.url.includes('api-version='))).toBe(true);
  });

  it('never reports a queued completion as applied, and says when auto-complete owns it', async () => {
    const { context } = harness({
      reads: [
        pullRequest(),
        // Accepted and still queued: `lastMergeCommit` is documented as empty while the merge is
        // in progress, so `status: 'completed'` alone proves nothing.
        pullRequest({
          status: 'completed',
          mergeStatus: 'queued',
          autoCompleteSetBy: { id: VIEWER_ID, displayName: 'Alex Rivera' },
        }),
      ],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(completeInput(), context),
    );

    if (settled.kind !== 'pending') throw new Error('a queued completion is not applied');
    expect(settled.autoCompleteEnabled).toBe(true);
  });

  it('reports a policy rejection as its own terminal outcome with Azure\'s own message', async () => {
    const { context } = harness({
      reads: [
        pullRequest(),
        pullRequest({
          mergeStatus: 'rejectedByPolicy',
          mergeFailureMessage: 'Required reviewers have not approved.',
        }),
      ],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(completeInput(), context),
    );

    if (settled.kind !== 'rejected') throw new Error('a policy rejection is terminal');
    // Three distinct outcomes, never one generic error.
    expect(settled.reason).toBe('rejectedByPolicy');
    expect(settled.detail).toBe('Required reviewers have not approved.');
  });

  it('refuses to call a completion applied when Azure silently ignored the options we sent', async () => {
    const { context } = harness({
      reads: [
        pullRequest(),
        // Terminal by status, merge status and merge commit — but the branch decision we sent is
        // not the one Azure stored. A status-code check would call this a success and the user's
        // branch would survive a deletion they asked for, or vice versa.
        completed({ deleteSourceBranch: false, transitionWorkItems: false, bypassPolicy: false }),
      ],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(
        completeInput({ deleteSourceBranch: true }),
        context,
      ),
    );

    if (settled.kind !== 'rejected') throw new Error('an ignored field is not a success');
    expect(settled.reason).toBe('fields-ignored');
  });
});

/**
 * The stored justification, overwritten rather than inherited.
 *
 * Azure documents no default for `completionOptions` and does not say what an omitted object
 * does to the stored one. A completion that sent `bypassPolicy: false` while leaving a stored
 * `bypassReason` in place would attach somebody else's justification to this merge, and the
 * status alone would still read `completed`.
 */
describe('Azure DevOps completion bypass reason', () => {
  it('reports a surviving stored bypassReason as a silently ignored write rather than applied', async () => {
    const { context } = harness({
      reads: [
        pullRequest(),
        completed({
          deleteSourceBranch: false,
          transitionWorkItems: false,
          bypassPolicy: false,
          // Azure acknowledged the status and kept the stored reason.
          bypassReason: 'approved out of band by the release manager',
        }),
      ],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(completeInput(), context),
    );

    if (settled.kind !== 'rejected') throw new Error('an ignored completion option must reject');
    expect(settled.reason).toBe('fields-ignored');
  });

  it('accepts a completion whose bypassReason came back as the empty value it sent', async () => {
    const { context } = harness({
      reads: [
        pullRequest(),
        completed({
          deleteSourceBranch: false,
          transitionWorkItems: false,
          bypassPolicy: false,
          bypassReason: '',
        }),
      ],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await completeAzureDevOpsPullRequest(completeInput(), context),
    );

    expect(settled.kind).toBe('applied');
  });
});

/* ------------------------------------------------------------------- abandon */

describe('Azure DevOps pull-request abandonment', () => {
  it('abandons an active pull request and proves the stored status with a fresh read', async () => {
    const { context, requests } = harness({
      reads: [pullRequest(), pullRequest({ status: 'abandoned' })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await abandonAzureDevOpsPullRequest(abandonInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed abandon must be applied');
    // Only `status` travels: every other property is either outside Azure's seven updatable ones
    // or a decision this Action was not asked to make.
    expect(writes(requests)[0]?.body).toEqual({ status: 'abandoned' });
  });

  it('refuses to abandon a pull request that is already completed, with zero writes', async () => {
    const { context, requests } = harness({
      reads: [completed({ deleteSourceBranch: false })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await abandonAzureDevOpsPullRequest(abandonInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('a completed pull request cannot be abandoned');
    expect(settled.reason).toBe('entry-not-active');
    expect(writes(requests)).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------- reactivate */

const REVIEWER_A = 'aa11bb22-cc33-4d44-8e55-ff6677889900';
const REVIEWER_B = 'bb22cc33-dd44-4e55-9f66-001122334455';
const REVIEWER_NEW = 'cc33dd44-ee55-4f66-a077-112233445566';

function reactivateInput() {
  return { v: 1, instance: configuredInstance(), localRef: localRef() };
}

describe('Azure DevOps pull-request reactivation', () => {
  it('reactivates an abandoned pull request and proves the stored status with a fresh read', async () => {
    const { context, requests } = harness({
      reads: [pullRequest({ status: 'abandoned' }), pullRequest({ status: 'active' })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await reactivateAzureDevOpsPullRequest(reactivateInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed reactivation must be applied');
    // Only `status` travels. Resending `completionOptions` would re-decide a branch outcome
    // nobody asked about while reopening.
    expect(writes(requests)[0]?.body).toEqual({ status: 'active' });
    expect(writes(requests)).toHaveLength(1);
  });

  it('refuses to reactivate a completed pull request, with zero writes', async () => {
    // The deciding case: a completed pull request is ALSO not active, so a gate written as
    // "status !== 'active'" would accept it and try to undo a merge that already landed.
    const { context, requests } = harness({
      reads: [completed({ deleteSourceBranch: false })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await reactivateAzureDevOpsPullRequest(reactivateInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('a completed pull request cannot be reopened');
    expect(settled.reason).toBe('entry-not-abandoned');
    expect(writes(requests)).toHaveLength(0);
  });

  it('reports a reactivation Azure silently ignored as pending rather than applied', async () => {
    const { context } = harness({
      reads: [pullRequest({ status: 'abandoned' }), pullRequest({ status: 'abandoned' })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await reactivateAzureDevOpsPullRequest(reactivateInput(), context),
    );

    expect(settled.kind).toBe('pending');
  });
});

/* ------------------------------------------------------------ request review */

function requestReviewInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: localRef(),
    observedSourceCommitId: OBSERVED_SOURCE_COMMIT,
    reviewerIds: [REVIEWER_NEW],
    ...overrides,
  };
}

function reviewer(id: string, vote: number) {
  return { id, displayName: `Reviewer ${id.slice(0, 2)}`, vote, isRequired: true };
}

const REVIEWERS_URL_FRAGMENT = `/pullRequests/${String(PULL_REQUEST_ID)}/reviewers?`;

describe('Azure DevOps request review', () => {
  it('adds reviewers with one bulk identity-only POST and confirms through the reviewer list', async () => {
    const { context, requests } = harness({
      reads: [
        pullRequest({ reviewers: [reviewer(REVIEWER_A, 10)] }),
        pullRequest({ reviewers: [reviewer(REVIEWER_A, 10), reviewer(REVIEWER_NEW, 0)] }),
      ],
      respond: ({ url, method }) => (
        method === 'POST' && url.includes(REVIEWERS_URL_FRAGMENT) ? { body: [] } : undefined
      ),
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(requestReviewInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed reviewer addition must be applied');
    const written = nonReadRequests(requests);
    expect(written).toHaveLength(1);
    const write = written[0];
    // The bulk additive route, never the per-reviewer `PUT …/reviewers/{id}` create-or-vote one.
    expect(write?.method).toBe('POST');
    expect(write?.url).toContain(REVIEWERS_URL_FRAGMENT);
    expect(write?.url).toContain('api-version=7.1');
    // Strict identity only. A `vote` here resets an approval; an existing reviewer here is a
    // replacement set. Neither is representable in what actually left.
    expect(write?.body).toEqual([{ id: REVIEWER_NEW }]);
  });

  it('preserves an existing nonzero vote by refusing to re-add that reviewer, with zero writes', async () => {
    const { context, requests } = harness({
      reads: [pullRequest({ reviewers: [reviewer(REVIEWER_A, 10), reviewer(REVIEWER_B, 0)] })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(
        requestReviewInput({ reviewerIds: [REVIEWER_A] }),
        context,
      ),
    );

    if (settled.kind !== 'refused') throw new Error('an existing reviewer must not be re-added');
    expect(settled.reason).toBe('reviewer-already-present');
    expect(nonReadRequests(requests)).toHaveLength(0);
  });

  it('refuses a review request whose pinned merge source has moved, with zero writes', async () => {
    const { context, requests } = harness({
      reads: [pullRequest({ lastMergeSourceCommit: { commitId: ADVANCED_SOURCE_COMMIT } })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(requestReviewInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('an advanced merge source must refuse');
    expect(settled.reason).toBe('head-advanced');
    expect(nonReadRequests(requests)).toHaveLength(0);
  });

  it('refuses reviewer metadata outright rather than dropping it, with zero writes', async () => {
    const { context, requests } = harness({ reads: [pullRequest()] });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(
        requestReviewInput({ reviewerIds: [{ id: REVIEWER_NEW, vote: 10, isRequired: true }] }),
        context,
      ),
    );

    // Silently stripping the vote would be worse than refusing: the caller would believe a vote
    // they named was honoured somewhere.
    if (settled.kind !== 'unavailable') throw new Error('reviewer metadata is not a valid input');
    expect(settled.failure.code).toContain('mutation-input-invalid');
    expect(nonReadRequests(requests)).toHaveLength(0);
  });

  /**
   * Azure hands the same identity GUID back in whatever case the producing service wrote it.
   * A case-sensitive membership test answers *not a reviewer* about somebody who is one, and
   * the additive bulk route then carries a vote for a reviewer Azure already knows — so a
   * button labelled *request review* resets that person's approval.
   */
  it('refuses a reviewer already present under a different GUID case, with zero writes', async () => {
    const { context, requests } = harness({
      reads: [pullRequest({ reviewers: [reviewer(REVIEWER_A.toUpperCase(), 10)] })],
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(
        requestReviewInput({ reviewerIds: [REVIEWER_A] }),
        context,
      ),
    );

    if (settled.kind !== 'refused') throw new Error('an existing reviewer must not be re-added');
    expect(settled.reason).toBe('reviewer-already-present');
    expect(nonReadRequests(requests)).toHaveLength(0);
  });

  /**
   * A `502` on the additive `POST` says nothing about what Azure did: the request may have
   * reached it and been applied after our client stopped listening. Reporting that as
   * `unavailable` tells the reader nothing happened about an effect nobody observed, and the
   * natural response is to press the button again — the blind repeat this Action must never
   * make. Reconciliation through the authoritative list is the only thing that can answer.
   */
  it('reconciles an ambiguous reviewer POST through the authoritative list instead of reporting it unavailable', async () => {
    const { context } = harness({
      reads: [
        pullRequest({ reviewers: [] }),
        pullRequest({ reviewers: [reviewer(REVIEWER_NEW, 0)] }),
      ],
      respond: ({ url, method }) => (
        method === 'POST' && url.includes(REVIEWERS_URL_FRAGMENT)
          ? { status: 502, body: { message: 'gateway' } }
          : undefined
      ),
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(requestReviewInput(), context),
    );

    // The list proves the addition landed despite the ambiguous response.
    expect(settled.kind).toBe('applied');
  });

  it('still reports a reviewer POST Azure itself refused as unavailable, with no reconciliation claim', async () => {
    const { context } = harness({
      reads: [
        pullRequest({ reviewers: [] }),
        pullRequest({ reviewers: [reviewer(REVIEWER_NEW, 0)] }),
      ],
      respond: ({ url, method }) => (
        method === 'POST' && url.includes(REVIEWERS_URL_FRAGMENT)
          ? { status: 403, body: { message: 'forbidden' } }
          : undefined
      ),
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(requestReviewInput(), context),
    );

    // A decision is not an ambiguity. Reconciling a refusal would let a stale list row report
    // an addition Azure explicitly declined to make.
    if (settled.kind !== 'unavailable') throw new Error('a refused write must stay unavailable');
    expect(settled.failure.code).toBe('azure-devops/forbidden');
  });

  it('reports an unconfirmed reviewer addition as pending rather than applied', async () => {
    const { context } = harness({
      reads: [pullRequest({ reviewers: [] }), pullRequest({ reviewers: [] })],
      respond: ({ url, method }) => (
        method === 'POST' && url.includes(REVIEWERS_URL_FRAGMENT) ? { body: [] } : undefined
      ),
    });

    const settled = AzureMutationResultV1Schema.parse(
      await requestAzureDevOpsPullRequestReview(requestReviewInput(), context),
    );

    expect(settled.kind).toBe('pending');
  });
});

/* ------------------------------------------------------------- thread status */

const THREAD_ID = 91;
const THREAD_URL_FRAGMENT = `/pullRequests/${String(PULL_REQUEST_ID)}/threads/${String(THREAD_ID)}?`;

function threadStatusInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: localRef(),
    threadId: String(THREAD_ID),
    status: 'fixed',
    ...overrides,
  };
}

/** A harness whose single-thread reads walk their own scripted sequence. */
function threadHarness(statuses: readonly (string | null)[]) {
  let read = 0;
  return harness({
    reads: [pullRequest()],
    respond: ({ url, method }) => {
      if (!url.includes(THREAD_URL_FRAGMENT)) return undefined;
      if (method !== 'GET') return { body: {} };
      const status = statuses[Math.min(read, statuses.length - 1)];
      read += 1;
      return { body: status === null ? { id: THREAD_ID } : { id: THREAD_ID, status } };
    },
  });
}

describe('Azure DevOps thread status', () => {
  it('sends status alone and confirms it from the thread it changed', async () => {
    const { context, requests } = threadHarness(['active', 'fixed']);

    const settled = AzureThreadStatusResultV1Schema.parse(
      await setAzureDevOpsPullRequestThreadStatus(threadStatusInput(), context),
    );

    if (settled.kind !== 'applied') throw new Error('a confirmed thread status must be applied');
    expect(settled.status).toBe('fixed');
    const written = nonReadRequests(requests);
    expect(written).toHaveLength(1);
    expect(written[0]?.method).toBe('PATCH');
    expect(written[0]?.url).toContain(THREAD_URL_FRAGMENT);
    expect(written[0]?.url).toContain('api-version=7.1');
    // No comments array and no thread context: a status change must not rewrite the conversation.
    expect(written[0]?.body).toEqual({ status: 'fixed' });
  });

  it('writes nothing when the thread already carries the requested status', async () => {
    const { context, requests } = threadHarness(['fixed']);

    const settled = AzureThreadStatusResultV1Schema.parse(
      await setAzureDevOpsPullRequestThreadStatus(threadStatusInput(), context),
    );

    if (settled.kind !== 'refused') throw new Error('a converged status is not a write');
    expect(settled.reason).toBe('already-in-status');
    expect(nonReadRequests(requests)).toHaveLength(0);
  });

  it('calls a status Azure answered 200 for and never applied what it is', async () => {
    const { context } = threadHarness(['active', 'active']);

    const settled = AzureThreadStatusResultV1Schema.parse(
      await setAzureDevOpsPullRequestThreadStatus(threadStatusInput(), context),
    );

    if (settled.kind !== 'rejected') throw new Error('an ignored field is not a success');
    expect(settled.reason).toBe('fields-ignored');
    expect(settled.status).toBe('active');
  });

  it('reads a thread with no status, and one Azure named something else, as unknown', async () => {
    const { context } = threadHarness([null, 'somethingElse']);

    const settled = AzureThreadStatusResultV1Schema.parse(
      await setAzureDevOpsPullRequestThreadStatus(threadStatusInput(), context),
    );

    // Neither answer is `active`: telling a reviewer an unrecognized state is an open one is the
    // failure this tri-state exists to prevent.
    if (settled.kind !== 'rejected') throw new Error('an unknown status did not become fixed');
    expect(settled.status).toBe('unknown');
  });

  it('refuses a thread id that is not a positive integer, with zero requests', async () => {
    const { context, requests } = threadHarness(['active']);

    const settled = AzureThreadStatusResultV1Schema.parse(
      await setAzureDevOpsPullRequestThreadStatus(
        threadStatusInput({ threadId: '0' }),
        context,
      ),
    );

    if (settled.kind !== 'unavailable') throw new Error('a non-positive thread id is not a thread');
    expect(requests).toHaveLength(0);
  });
});
