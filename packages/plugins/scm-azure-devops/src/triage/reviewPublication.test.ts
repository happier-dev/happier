import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';
import type { ReviewCommentPublicationPlanV1 } from '@happier-dev/plugin-sdk/reviews';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { encodeAzureSourceConfiguration } from './configuration.js';
import { AZURE_DEVOPS_TRIAGE_PURPOSE } from './descriptor.js';
import { buildAzureCollisionScope } from './identity.js';
import { AzureReviewPublicationResultV1Schema } from './mutations/contracts.js';
import { normalizeAzureDevOpsBaseUrl } from './origin.js';
import {
  createAzureDevOpsPullRequestThreadComment,
  replyAzureDevOpsPullRequestThread,
  submitAzureDevOpsPullRequestReview,
} from './reviewPublication.js';

const BASE_URL = 'https://dev.azure.com/acme';
const PROJECT_ID = '5feb1c2d-3e4f-4a5b-8c9d-0e1f2a3b4c5d';
const REPOSITORY_ID = 'f4b7c1a2-3d4e-4f50-9a6b-7c8d9e0f1a2b';
const PULL_REQUEST_ID = 17;
const ROUTING_TOKEN = 'acme/Payments/payments';
const VIEWER_ID = 'd6245f20-2af8-44f4-9451-8107cb2767db';
const BASE_COMMIT = '1b0847af63d5c1e299f2c1a7d4b6e08f3a5c9d2e';
const HEAD_COMMIT = '9f2c1a7d4b6e08f3a5c9d2e1b0847af63d5c1e29';
const ADVANCED_BASE = 'ffeeddccbbaa0099887766554433221100ffeedd';
const ADVANCED_HEAD = '0011223344556677889900aabbccddeeff001122';
const PLAN_ID = 'P'.repeat(43);
const VERDICT_CORRELATION = 'V'.repeat(43);

function accountRef(accountId: string): QualifiedConnectedAccountRef {
  return {
    service: {
      pluginId: 'happier.scm.forge.azure-devops',
      localId: AZURE_DEVOPS_TRIAGE_PURPOSE,
    },
    accountId,
  };
}

function configuredOrigin() {
  const parsed = normalizeAzureDevOpsBaseUrl(BASE_URL);
  if (!parsed.ok) throw new Error('fixture base must normalize');
  return parsed.origin;
}

function configuredInstance(accountId = 'account-1'): TriageConfiguredSourceInstanceV1 {
  return {
    v: 1,
    instance: {
      source: {
        pluginId: 'happier.scm.forge.azure-devops',
        localId: 'azure-devops-forge',
      },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: { purpose: AZURE_DEVOPS_TRIAGE_PURPOSE, account: accountRef(accountId) },
    localInstanceKey: BASE_URL,
    configuration: encodeAzureSourceConfiguration(configuredOrigin()),
  };
}

function localRef() {
  const collisionScope = buildAzureCollisionScope({
    origin: configuredOrigin(),
    repositoryId: REPOSITORY_ID,
  });
  if (collisionScope === null) throw new Error('fixture repository scope must encode');
  return { kindId: 'pull-request', collisionScope, entryId: String(PULL_REQUEST_ID) };
}

function pullRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    pullRequestId: PULL_REQUEST_ID,
    repository: {
      id: REPOSITORY_ID,
      name: 'payments',
      project: { id: PROJECT_ID, name: 'Payments' },
      url: `${BASE_URL}/_apis/git/repositories/${REPOSITORY_ID}`,
    },
    title: 'Publish an exact review',
    status: 'active',
    supportsIterations: true,
    isDraft: false,
    createdBy: { id: VIEWER_ID, displayName: 'Alex Rivera', uniqueName: 'alex@example.test' },
    creationDate: '2026-08-01T00:00:00Z',
    sourceRefName: 'refs/heads/feature',
    targetRefName: 'refs/heads/main',
    mergeStatus: 'succeeded',
    lastMergeSourceCommit: { commitId: HEAD_COMMIT },
    lastMergeTargetCommit: { commitId: BASE_COMMIT },
    reviewers: [],
    ...overrides,
  };
}

function entry(id: string) {
  return {
    happierCommentId: id,
    expectedServerRevision: 1,
    anchor: { kind: 'file' as const, filePath: 'src/index.ts' },
    snapshot: {
      kind: 'text' as const,
      selectedLines: ['return ready;'],
      beforeContext: [],
      afterContext: [],
      selectedLinesHash: `selected-${id}`,
      contextWindowHash: `context-${id}`,
      capturedAt: 1,
      fileLength: 1,
      source: 'committed' as const,
      commitSha: HEAD_COMMIT,
      isUncommitted: false,
      isUntracked: false,
      truncated: false,
      hasBidiControls: false,
      likelyMinified: false,
      diffContext: { side: 'after' as const, baseSha: BASE_COMMIT, headSha: HEAD_COMMIT },
    },
    body: `Body ${id}`,
  };
}

function summaryEntry(id: string, anchor: 'folder' | 'project' | 'run' | 'finding' = 'project') {
  const base = entry(id);
  return {
    ...base,
    anchor: anchor === 'folder'
      ? { kind: 'folder' as const, folderPath: 'src' }
      : anchor === 'project'
      ? { kind: 'project' as const, projectId: 'Payments' }
      : anchor === 'run'
        ? { kind: 'run' as const, runId: 'run-1' }
        : { kind: 'finding' as const, runId: 'run-1', findingId: 'finding-1' },
  };
}

function plan(overrides: Partial<ReviewCommentPublicationPlanV1> = {}): ReviewCommentPublicationPlanV1 {
  return {
    target: {
      providerId: 'azure-devops',
      configuredAccountId: 'account-1',
      entryRef: {
        sourceId: 'happier.scm.forge.azure-devops/azure-devops-forge',
        ...localRef(),
      },
      subtarget: null,
    },
    baseRevision: BASE_COMMIT,
    headRevision: HEAD_COMMIT,
    entries: [entry('comment-1')],
    verdict: null,
    ...overrides,
  };
}

function request(publicationPlan: ReviewCommentPublicationPlanV1, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    v: 1,
    instance: configuredInstance(),
    localRef: localRef(),
    routingToken: ROUTING_TOKEN,
    publicationPlan,
    ...overrides,
  };
}

function marker(correlation: string): string {
  return `<!-- happier-review-comment:v1:${correlation} -->`;
}

function verdictMarker(correlation = VERDICT_CORRELATION): string {
  return `<!-- happier-review-verdict:v1:${correlation} -->`;
}

function thread(id: number, comments: readonly Readonly<{ id: number; content: string }>[]) {
  return { id, comments };
}

type Reply = Readonly<{ status?: number; body: unknown }>;
type Captured = Readonly<{ url: string; method: string; body: unknown }>;

function harness(input: Readonly<{
  pullRequests?: readonly unknown[];
  threadReads?: readonly unknown[];
  claimDisposition?: 'dispatch' | 'reconcile';
  respond?: (request: Captured) => Reply | undefined;
}>) {
  const requests: Captured[] = [];
  const claimedPlans: unknown[] = [];
  let pullRequestRead = 0;
  let threadRead = 0;
  const pullRequests = input.pullRequests ?? [pullRequest()];
  const threadReads = input.threadReads ?? [{ value: [] }];
  const services = {
    connectedAccounts: {
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
    actions: {
      async execute(actionId: string, actionInput: unknown) {
        expect(actionId).toBe('reviews.comments.claimPublicationDispatch');
        claimedPlans.push(actionInput);
        const candidate = actionInput as ReviewCommentPublicationPlanV1;
        return {
          disposition: input.claimDisposition ?? 'dispatch',
          publicationPlanId: PLAN_ID,
          entries: candidate.entries.map((candidateEntry, index) => ({
            happierCommentId: candidateEntry.happierCommentId,
            publicationCorrelationId: String.fromCharCode(65 + index).repeat(43),
          })),
          verdict: candidate.verdict === null
            ? null
            : { publicationCorrelationId: VERDICT_CORRELATION },
        };
      },
    },
    http: {
      async request(rawRequest: Readonly<{ url: string; method?: string; body?: unknown }>) {
        const method = rawRequest.method ?? 'GET';
        const body = rawRequest.body instanceof Uint8Array
          ? JSON.parse(new TextDecoder().decode(rawRequest.body)) as unknown
          : undefined;
        const captured = { url: rawRequest.url, method, body };
        requests.push(captured);
        const path = new URL(rawRequest.url).pathname.toLowerCase();
        let reply = input.respond?.(captured);
        if (reply === undefined && path.endsWith('/_apis/connectiondata')) {
          reply = { body: { authenticatedUser: { id: VIEWER_ID, providerDisplayName: 'Alex' } } };
        } else if (reply === undefined && method === 'GET' && path.endsWith(`/pullrequests/${String(PULL_REQUEST_ID)}`)) {
          reply = { body: pullRequests[Math.min(pullRequestRead, pullRequests.length - 1)] };
          pullRequestRead += 1;
        } else if (reply === undefined && method === 'GET' && path.endsWith(`/pullrequests/${String(PULL_REQUEST_ID)}/threads`)) {
          reply = { body: threadReads[Math.min(threadRead, threadReads.length - 1)] };
          threadRead += 1;
        } else if (reply === undefined && method === 'GET' && path.endsWith(`/pullrequests/${String(PULL_REQUEST_ID)}/iterations`)) {
          reply = { body: { value: [{ id: 3 }] } };
        } else if (reply === undefined && method === 'GET' && path.includes(`/pullrequests/${String(PULL_REQUEST_ID)}/iterations/3/changes`)) {
          reply = {
            body: {
              changeEntries: [{ changeTrackingId: 42, item: { path: 'src/index.ts' } }],
            },
          };
        } else if (reply === undefined && method === 'POST' && path.endsWith('/comments')) {
          reply = { status: 201, body: { id: 902 } };
        } else if (reply === undefined && method === 'POST' && path.endsWith('/threads')) {
          reply = { status: 201, body: { id: 900, comments: [{ id: 901 }] } };
        } else if (reply === undefined && method === 'PUT' && path.includes('/reviewers/')) {
          reply = { body: { id: VIEWER_ID, vote: 10 } };
        }
        const settled = reply ?? { status: 404, body: { message: `Unhandled ${method} ${path}` } };
        return {
          status: settled.status ?? 200,
          finalUrl: rawRequest.url,
          headers: { 'content-type': 'application/json' },
          body: new TextEncoder().encode(JSON.stringify(settled.body)),
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
  return { context, requests, claimedPlans };
}

const providerWrites = (requests: readonly Captured[]) =>
  requests.filter((candidate) => candidate.method === 'POST' || candidate.method === 'PUT');

const threadWrites = (requests: readonly Captured[]) =>
  requests.filter((candidate) => candidate.method === 'POST'
    && new URL(candidate.url).pathname.toLowerCase().includes('/threads'));

describe('Azure DevOps Reviews publication', () => {
  it.each([
    ['provider', { providerId: 'github' }],
    ['account', { configuredAccountId: 'account-2' }],
    ['source', { entryRef: { ...plan().target.entryRef, sourceId: 'wrong/source' } }],
    ['kind', { entryRef: { ...plan().target.entryRef, kindId: 'issue' } }],
    ['scope', { entryRef: { ...plan().target.entryRef, collisionScope: 'azure-devops:wrong' } }],
    ['entry', { entryRef: { ...plan().target.entryRef, entryId: '99' } }],
    ['subtarget', { subtarget: { kindId: 'review-thread', targetId: '7' } }],
  ])('rejects a mismatched %s target before admission, claim, or write', async (_label, targetOverride) => {
    const publicationPlan = plan({ target: { ...plan().target, ...targetOverride } as ReviewCommentPublicationPlanV1['target'] });
    const { context, requests, claimedPlans } = harness({});

    const result = await submitAzureDevOpsPullRequestReview(request(publicationPlan), context);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid-input' });
    expect(claimedPlans).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ['base', { lastMergeTargetCommit: { commitId: ADVANCED_BASE } }, 'base-advanced'],
    ['head', { lastMergeSourceCommit: { commitId: ADVANCED_HEAD } }, 'head-advanced'],
  ])('rejects a moved %s before the canonical claim and any provider write', async (_label, moved, reason) => {
    const { context, requests, claimedPlans } = harness({ pullRequests: [pullRequest(moved)] });

    const result = await submitAzureDevOpsPullRequestReview(request(plan()), context);

    expect(result).toMatchObject({ kind: 'rejected', reason });
    expect(claimedPlans).toHaveLength(0);
    expect(providerWrites(requests)).toHaveLength(0);
  });

  it('treats a malformed raw thread row as incomplete reconciliation and never risks a duplicate', async () => {
    const { context, requests } = harness({
      threadReads: [
        { value: [] },
        { value: [{ id: 'not-an-integer', comments: [{ id: 4, content: 'possibly the marker' }] }] },
      ],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan()), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'uncertain' } }] },
    });
    expect(threadWrites(requests)).toHaveLength(0);
  });

  it('treats duplicate exact entry and verdict markers as uncertain and emits no duplicate write', async () => {
    for (const kind of ['entry', 'verdict'] as const) {
      const exactMarker = kind === 'entry' ? marker('A'.repeat(43)) : verdictMarker();
      const duplicates = { value: [
        thread(70, [{ id: 71, content: exactMarker }]),
        thread(72, [{ id: 73, content: exactMarker }]),
      ] };
      const publicationPlan = kind === 'entry'
        ? plan()
        : plan({ entries: [], verdict: { kind: 'comment', body: 'Summary' } });
      const { context, requests } = harness({
        threadReads: [{ value: [] }, duplicates],
      });

      const result = AzureReviewPublicationResultV1Schema.parse(
        await submitAzureDevOpsPullRequestReview(request(publicationPlan), context),
      );

      expect(result).toMatchObject(kind === 'entry'
        ? { kind: 'settled', publication: { entries: [{ outcome: { kind: 'uncertain' } }] } }
        : { kind: 'settled', publication: { verdict: { outcome: { kind: 'uncertain' } } } });
      expect(providerWrites(requests)).toHaveLength(0);
    }
  });

  it('keeps a failed entry write uncertain when only the post-dispatch inventory has duplicate markers', async () => {
    const exactMarker = marker('A'.repeat(43));
    const duplicates = { value: [
      thread(70, [{ id: 71, content: exactMarker }]),
      thread(72, [{ id: 73, content: exactMarker }]),
    ] };
    const { context, requests } = harness({
      threadReads: [{ value: [] }, { value: [] }, duplicates],
      respond: ({ method, url }) => method === 'POST'
        && new URL(url).pathname.toLowerCase().endsWith('/threads')
        ? { status: 422, body: { message: 'The anchor was rejected.' } }
        : undefined,
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan()), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'uncertain' } }] },
    });
    expect(threadWrites(requests)).toHaveLength(1);
  });

  it('keeps an ambiguous verdict summary uncertain when only its post-dispatch inventory has duplicate markers', async () => {
    const exactMarker = verdictMarker();
    const duplicates = { value: [
      thread(80, [{ id: 81, content: exactMarker }]),
      thread(82, [{ id: 83, content: exactMarker }]),
    ] };
    const { context, requests } = harness({
      threadReads: [{ value: [] }, { value: [] }, duplicates],
      respond: ({ method, url }) => method === 'POST'
        && new URL(url).pathname.toLowerCase().endsWith('/threads')
        ? { status: 503, body: { message: 'answer lost after summary dispatch' } }
        : undefined,
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [],
        verdict: { kind: 'comment', body: 'Summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: 'uncertain' } } },
    });
    expect(threadWrites(requests)).toHaveLength(1);
  });

  it('ignores deleted unrelated threads and comments when reconciling an exact marker', async () => {
    const exactMarker = marker('A'.repeat(43));
    const deletedOnly = { value: [
      { isDeleted: true, id: 'malformed-deleted-thread', comments: 'not-a-list' },
      {
        id: 60,
        comments: [{ isDeleted: true, id: 'malformed-deleted-comment', content: exactMarker }],
      },
    ] };
    const landed = { value: [
      ...deletedOnly.value,
      thread(70, [{ id: 71, content: exactMarker }]),
    ] };
    const { context, requests } = harness({
      threadReads: [deletedOnly, deletedOnly, landed],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan()), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'published', externalRef: '70:71' } }] },
    });
    expect(threadWrites(requests)).toHaveLength(1);
  });

  it('publishes an ordered prefix, stops at the first failed comment, and skips the suffix and verdict', async () => {
    const entries = [entry('comment-1'), entry('comment-2'), entry('comment-3')];
    const firstMarker = marker('A'.repeat(43));
    const firstLanded = { value: [thread(100, [{ id: 101, content: firstMarker }])] };
    let post = 0;
    const { context, requests } = harness({
      threadReads: [
        { value: [] },
        { value: [] },
        firstLanded,
        firstLanded,
        firstLanded,
      ],
      respond: ({ method, url }) => {
        const path = new URL(url).pathname.toLowerCase();
        if (method !== 'POST' || !path.endsWith('/threads')) return undefined;
        post += 1;
        return post === 1
          ? { status: 201, body: thread(100, [{ id: 101, content: firstMarker }]) }
          : { status: 422, body: { message: 'The second anchor is no longer valid.' } };
      },
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries,
        verdict: { kind: 'comment', body: 'Review summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [
          { happierCommentId: 'comment-1', outcome: { kind: 'published' } },
          { happierCommentId: 'comment-2', outcome: { kind: 'failed' } },
          { happierCommentId: 'comment-3', outcome: { kind: 'skippedPriorFailure' } },
        ],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    });
    expect(threadWrites(requests)).toHaveLength(2);
    expect(threadWrites(requests)[0]?.body).toMatchObject({
      threadContext: { filePath: 'src/index.ts' },
      pullRequestThreadContext: {
        changeTrackingId: 42,
        iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 },
      },
    });
  });

  it('stops before the next effect when the head moves after the claim and published prefix', async () => {
    const firstMarker = marker('A'.repeat(43));
    const firstLanded = { value: [thread(100, [{ id: 101, content: firstMarker }])] };
    const { context, requests } = harness({
      pullRequests: [
        pullRequest(),
        pullRequest(),
        pullRequest(),
        pullRequest({ lastMergeSourceCommit: { commitId: ADVANCED_HEAD } }),
        pullRequest({ lastMergeSourceCommit: { commitId: ADVANCED_HEAD } }),
      ],
      threadReads: [{ value: [] }, { value: [] }, firstLanded, firstLanded],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [entry('comment-1'), entry('comment-2')],
        verdict: { kind: 'comment', body: 'Summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [
          { happierCommentId: 'comment-1', outcome: { kind: 'published' } },
          {
            happierCommentId: 'comment-2',
            outcome: { kind: 'failed', code: 'azure-devops/review-head-advanced' },
          },
        ],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    });
    expect(threadWrites(requests)).toHaveLength(1);
  });

  it('folds diff-less entries into one verdict summary in plan order while publishing inline entries first', async () => {
    const entries = [
      summaryEntry('project-summary', 'project'),
      entry('inline-comment'),
      summaryEntry('run-summary', 'run'),
      summaryEntry('finding-summary', 'finding'),
    ];
    const inlineMarker = marker('B'.repeat(43));
    const summaryContent = [
      entries[0]!.body, marker('A'.repeat(43)),
      entries[2]!.body, marker('C'.repeat(43)),
      entries[3]!.body, marker('D'.repeat(43)),
      'Overall summary', verdictMarker(),
    ].join('\n\n');
    const inlineLanded = { value: [thread(100, [{ id: 101, content: inlineMarker }])] };
    const allLanded = { value: [
      thread(100, [{ id: 101, content: inlineMarker }]),
      thread(110, [{ id: 111, content: summaryContent }]),
    ] };
    const { context, requests } = harness({
      threadReads: [
        { value: [] },
        { value: [] },
        inlineLanded,
        inlineLanded,
        allLanded,
      ],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries,
        verdict: { kind: 'comment', body: 'Overall summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [
          { happierCommentId: 'project-summary', outcome: { kind: 'published', externalRef: '110:111' } },
          { happierCommentId: 'inline-comment', outcome: { kind: 'published', externalRef: '100:101' } },
          { happierCommentId: 'run-summary', outcome: { kind: 'published', externalRef: '110:111' } },
          { happierCommentId: 'finding-summary', outcome: { kind: 'published', externalRef: '110:111' } },
        ],
        verdict: { outcome: { kind: 'published', externalRef: '110:111' } },
      },
    });
    expect(threadWrites(requests)).toHaveLength(2);
    expect(threadWrites(requests)[1]?.body).toMatchObject({
      comments: [{ content: summaryContent }],
    });
  });

  it('rejects a diff-less entry without a verdict before claim or provider write', async () => {
    const { context, requests, claimedPlans } = harness({});

    const result = await submitAzureDevOpsPullRequestReview(request(plan({
      entries: [summaryEntry('summary-only')],
      verdict: null,
    })), context);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'unsupported-anchor' });
    expect(claimedPlans).toHaveLength(0);
    expect(providerWrites(requests)).toHaveLength(0);
  });

  it('folds the generic folder anchor into the one marker-bearing verdict summary', async () => {
    const exactSummary = [
      'Body folder-summary', marker('A'.repeat(43)),
      'Overall summary', verdictMarker(),
    ].join('\n\n');
    const landed = { value: [thread(110, [{ id: 111, content: exactSummary }])] };
    const { context, requests } = harness({
      threadReads: [{ value: [] }, { value: [] }, landed],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [summaryEntry('folder-summary', 'folder')],
        verdict: { kind: 'comment', body: 'Overall summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [{ outcome: { kind: 'published', externalRef: '110:111' } }],
        verdict: { outcome: { kind: 'published', externalRef: '110:111' } },
      },
    });
    expect(threadWrites(requests)).toHaveLength(1);
    expect(threadWrites(requests)[0]?.body).toMatchObject({ comments: [{ content: exactSummary }] });
  });

  it('uses Azure Server legacy inline context without probing unsupported iteration resources', async () => {
    const exactMarker = marker('A'.repeat(43));
    const landed = { value: [thread(100, [{ id: 101, content: exactMarker }])] };
    const { context, requests } = harness({
      pullRequests: [pullRequest({ supportsIterations: false })],
      threadReads: [{ value: [] }, { value: [] }, landed],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan()), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'published' } }] },
    });
    expect(requests.some(({ url }) => new URL(url).pathname.toLowerCase().includes('/iterations'))).toBe(false);
    expect(threadWrites(requests)[0]?.body).toMatchObject({
      threadContext: { filePath: 'src/index.ts' },
    });
    expect(threadWrites(requests)[0]?.body).not.toHaveProperty('pullRequestThreadContext');
  });

  it('binds an unversioned reply to its exact thread target and parent before claiming and posting', async () => {
    const replyPlan = plan({
      target: {
        ...plan().target,
        subtarget: { kindId: 'review-thread', targetId: '7' },
      },
      baseRevision: null,
      headRevision: null,
      entries: [entry('reply-1')],
      verdict: null,
    });
    const landed = { value: [thread(7, [
      { id: 11, content: 'Parent' },
      { id: 12, content: marker('A'.repeat(43)) },
    ])] };
    const { context, requests } = harness({
      threadReads: [
        { value: [thread(7, [{ id: 11, content: 'Parent' }])] },
        { value: [thread(7, [{ id: 11, content: 'Parent' }])] },
        landed,
      ],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await replyAzureDevOpsPullRequestThread({
        ...request(replyPlan),
        threadId: 7,
        parentCommentId: 11,
      }, context),
    );

    expect(result).toMatchObject({ kind: 'settled', publication: { entries: [{ outcome: { kind: 'published' } }] } });
    const write = threadWrites(requests)[0];
    expect(new URL(write?.url ?? '').pathname.toLowerCase()).toMatch(/\/threads\/7\/comments$/u);
    expect(write?.body).toMatchObject({ parentCommentId: 11, commentType: 1 });
  });

  it.each(['workspace', 'finding'] as const)(
    'publishes one unversioned %s-anchored reply without folding it into a verdict summary',
    async (anchorKind) => {
      const replyEntry = anchorKind === 'workspace'
        ? { ...entry('reply-1'), anchor: { kind: 'workspace' as const, workspaceId: 'workspace-1' } }
        : summaryEntry('reply-1', 'finding');
      const replyPlan = plan({
        target: {
          ...plan().target,
          subtarget: { kindId: 'review-thread', targetId: '7' },
        },
        baseRevision: null,
        headRevision: null,
        entries: [replyEntry],
        verdict: null,
      });
      const landed = { value: [thread(7, [
        { id: 11, content: 'Parent' },
        { id: 12, content: marker('A'.repeat(43)) },
      ])] };
      const { context, requests } = harness({
        threadReads: [
          { value: [thread(7, [{ id: 11, content: 'Parent' }])] },
          { value: [thread(7, [{ id: 11, content: 'Parent' }])] },
          landed,
        ],
      });

      const result = AzureReviewPublicationResultV1Schema.parse(
        await replyAzureDevOpsPullRequestThread({
          ...request(replyPlan),
          threadId: 7,
          parentCommentId: 11,
        }, context),
      );

      expect(result).toMatchObject({
        kind: 'settled',
        publication: {
          entries: [{ outcome: { kind: 'published', externalRef: '7:12' } }],
          verdict: { kind: 'notRequested' },
        },
      });
      expect(threadWrites(requests)).toHaveLength(1);
    },
  );

  it('does not let the same marker in another thread suppress the exact target-thread reply', async () => {
    const exactMarker = marker('A'.repeat(43));
    const replyPlan = plan({
      target: {
        ...plan().target,
        subtarget: { kindId: 'review-thread', targetId: '7' },
      },
      baseRevision: null,
      headRevision: null,
      entries: [summaryEntry('reply-1', 'finding')],
      verdict: null,
    });
    const before = { value: [
      thread(7, [{ id: 11, content: 'Parent' }]),
      thread(8, [{ id: 81, content: exactMarker }]),
    ] };
    const after = { value: [
      thread(7, [
        { id: 11, content: 'Parent' },
        { id: 12, content: exactMarker },
      ]),
      thread(8, [{ id: 81, content: exactMarker }]),
    ] };
    const { context, requests } = harness({ threadReads: [before, before, after] });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await replyAzureDevOpsPullRequestThread({
        ...request(replyPlan),
        threadId: 7,
        parentCommentId: 11,
      }, context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'published', externalRef: '7:12' } }] },
    });
    expect(threadWrites(requests)).toHaveLength(1);
  });

  it('rejects a reply whose target does not name the exact thread with zero claim and zero write', async () => {
    const replyPlan = plan({
      target: {
        ...plan().target,
        subtarget: { kindId: 'review-thread', targetId: '8' },
      },
      baseRevision: null,
      headRevision: null,
      entries: [entry('reply-1')],
      verdict: null,
    });
    const { context, requests, claimedPlans } = harness({});

    const result = await replyAzureDevOpsPullRequestThread({
      ...request(replyPlan),
      threadId: 7,
      parentCommentId: 11,
    }, context);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'invalid-input' });
    expect(claimedPlans).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('rejects a missing exact reply parent before the canonical claim and any write', async () => {
    const replyPlan = plan({
      target: {
        ...plan().target,
        subtarget: { kindId: 'review-thread', targetId: '7' },
      },
      baseRevision: null,
      headRevision: null,
      entries: [entry('reply-1')],
      verdict: null,
    });
    const { context, requests, claimedPlans } = harness({
      threadReads: [{ value: [thread(7, [{ id: 11, content: 'The only current parent' }])] }],
    });

    const result = await replyAzureDevOpsPullRequestThread({
      ...request(replyPlan),
      threadId: 7,
      parentCommentId: 12,
    }, context);

    expect(result).toMatchObject({ kind: 'rejected', reason: 'thread-not-found' });
    expect(claimedPlans).toHaveLength(0);
    expect(providerWrites(requests)).toHaveLength(0);
  });

  it('publishes and reconciles a marker-bearing comment verdict without ever changing the viewer vote', async () => {
    for (const disposition of ['dispatch', 'reconcile'] as const) {
      const exactMarker = verdictMarker();
      const landed = { value: [thread(80, [{ id: 81, content: `Summary\n\n${exactMarker}` }])] };
      const { context, requests } = harness({
        claimDisposition: disposition,
        threadReads: disposition === 'dispatch'
          ? [{ value: [] }, { value: [] }, landed]
          : [landed],
      });

      const result = AzureReviewPublicationResultV1Schema.parse(
        await submitAzureDevOpsPullRequestReview(request(plan({
          entries: [],
          verdict: { kind: 'comment', body: 'Summary' },
        })), context),
      );

      expect(result).toMatchObject({
        kind: 'settled',
        publication: { verdict: { outcome: { kind: 'published', externalRef: '80:81' } } },
      });
      expect(requests.filter((candidate) => candidate.method === 'PUT')).toHaveLength(0);
      expect(threadWrites(requests)).toHaveLength(disposition === 'dispatch' ? 1 : 0);
    }
  });

  it.each([
    ['approve', 10],
    ['requestChanges', -10],
  ] as const)(
    'publishes the marker-bearing summary before the markerless %s vote and settles synchronous acceptance',
    async (kind, vote) => {
      const exactMarker = verdictMarker();
      const landed = { value: [thread(90, [{ id: 91, content: `Summary\n\n${exactMarker}` }])] };
      const { context, requests, claimedPlans } = harness({
        threadReads: [{ value: [] }, { value: [] }, landed],
      });

      const result = AzureReviewPublicationResultV1Schema.parse(
        await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [],
          verdict: { kind, body: 'Summary' },
        })), context),
      );

      expect(result).toMatchObject({
        kind: 'settled',
        publication: { verdict: { outcome: { kind: 'published', externalRef: '90:91' } } },
      });
      expect(claimedPlans).toHaveLength(1);
      expect(providerWrites(requests).map(({ method }) => method)).toEqual(['POST', 'PUT']);
      expect(providerWrites(requests)[0]?.body).toMatchObject({
        comments: [{ content: `Summary\n\n${exactMarker}` }],
      });
      expect(providerWrites(requests)[1]?.body).toEqual({ id: VIEWER_ID, vote });
    },
  );

  it('keeps an answer-lost vote uncertain even when the final authoritative read shows that vote', async () => {
    const exactMarker = verdictMarker();
    const landed = { value: [thread(90, [{ id: 91, content: `Summary\n\n${exactMarker}` }])] };
    const { context, requests } = harness({
      pullRequests: [
        pullRequest(),
        pullRequest(),
        pullRequest({ reviewers: [{ id: VIEWER_ID, vote: 10 }] }),
      ],
      threadReads: [{ value: [] }, { value: [] }, landed],
      respond: ({ method, url }) => method === 'PUT'
        && new URL(url).pathname.toLowerCase().includes('/reviewers/')
        ? { status: 503, body: { message: 'answer lost after vote dispatch' } }
        : undefined,
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [],
        verdict: { kind: 'approve', body: 'Summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: 'uncertain', externalRef: '90:91' } } },
      observation: { kind: 'present' },
    });
    expect(providerWrites(requests).map(({ method }) => method)).toEqual(['POST', 'PUT']);
  });

  it('keeps a replayed markerless vote uncertain while reconciling its summary marker', async () => {
    const exactMarker = verdictMarker();
    const landed = { value: [thread(90, [{ id: 91, content: `Summary\n\n${exactMarker}` }])] };
    const { context, requests } = harness({
      claimDisposition: 'reconcile',
      pullRequests: [pullRequest({ reviewers: [{ id: VIEWER_ID, vote: 10 }] })],
      threadReads: [landed, landed],
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [],
        verdict: { kind: 'approve', body: 'Summary' },
      })), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { verdict: { outcome: { kind: 'uncertain', externalRef: '90:91' } } },
    });
    expect(providerWrites(requests)).toHaveLength(0);
  });

  it('preserves the confirmed summary ref on a failed vote without enumerable undefined fields', async () => {
    const exactMarker = verdictMarker();
    const landed = { value: [thread(90, [{ id: 91, content: `Summary\n\n${exactMarker}` }])] };
    const { context } = harness({
      threadReads: [{ value: [] }, { value: [] }, landed],
      respond: ({ method, url }) => method === 'PUT'
        && new URL(url).pathname.toLowerCase().includes('/reviewers/')
        ? { status: 422, body: {} }
        : undefined,
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await submitAzureDevOpsPullRequestReview(request(plan({
        entries: [],
        verdict: { kind: 'requestChanges', body: 'Summary' },
      })), context),
    );

    if (result.kind !== 'settled' || !('outcome' in result.publication.verdict)) {
      throw new Error('failed vote must settle its canonical verdict result');
    }
    expect(result.publication.verdict.outcome).toMatchObject({
      kind: 'failed', externalRef: '90:91',
    });
    expect(Object.values(result.publication.verdict.outcome)).not.toContain(undefined);
  });

  it('performs the authoritative target reread after a write that may have taken effect', async () => {
    const { context, requests } = harness({
      pullRequests: [pullRequest(), pullRequest()],
      threadReads: [{ value: [] }, { value: [] }, { value: [] }],
      respond: ({ method, url }) => method === 'POST'
        && new URL(url).pathname.toLowerCase().endsWith('/threads')
        ? { status: 503, body: { message: 'answer lost after dispatch' } }
        : undefined,
    });

    const result = AzureReviewPublicationResultV1Schema.parse(
      await createAzureDevOpsPullRequestThreadComment(request(plan()), context),
    );

    expect(result).toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'uncertain' } }] },
      observation: { kind: 'present' },
    });
    const targetReads = requests.filter(({ method, url }) => method === 'GET'
      && new URL(url).pathname.toLowerCase().endsWith(`/pullrequests/${String(PULL_REQUEST_ID)}`));
    // Currentness is also rechecked before each ordered outward effect. The deciding assertion is
    // that the last exact target read occurs after the ambiguous POST, not the incidental number
    // of earlier safety reads.
    expect(targetReads.length).toBeGreaterThan(0);
    expect(requests.lastIndexOf(targetReads[targetReads.length - 1]!)).toBeGreaterThan(
      requests.findIndex(({ method, url }) => method === 'POST'
        && new URL(url).pathname.toLowerCase().endsWith('/threads')),
    );
    expect(threadWrites(requests)).toHaveLength(1);
  });
});
