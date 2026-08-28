import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ReviewCommentPublicationPlanV1 } from '@happier-dev/plugin-sdk/reviews';
import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';
import { describe, expect, it } from 'vitest';

import { encodeBitbucketConfiguration } from '../instance.js';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { BITBUCKET_CONNECTED_ACCOUNT_PURPOSE } from './descriptor.js';
import {
  BITBUCKET_TRIAGE_MUTATION_ACTION_IDS,
  createBitbucketPullRequestReviewCommentAction,
  publishBitbucketPullRequestReviewAction,
  replyToBitbucketPullRequestReviewCommentAction,
} from './mutationActions.js';
import {
  accountRef,
  createConnectedAccountsStub,
  createHttpStub,
  createInvocationContext,
} from './testSupport.js';

const WORKSPACE_UUID = '{4b2f0e6c-8a71-4f2e-9d51-6c3b70a19d44}';
const REPOSITORY_UUID = '{1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9}';
const VIEWER_UUID = '{9f8e7d6c-5b4a-4938-8271-6059f8e7d6c5}';
const BASE = '1111111111111111111111111111111111111111';
const HEAD = '2222222222222222222222222222222222222222';
const PULL_REQUEST_URL = 'https://api.bitbucket.org/2.0/repositories'
  + `/${encodeURIComponent(WORKSPACE_UUID)}/${encodeURIComponent(REPOSITORY_UUID)}`
  + '/pullrequests/42';

function configuredInstance(): TriageConfiguredSourceInstanceV1 {
  const encoded = encodeBitbucketConfiguration({ v: 1, workspaceUuid: WORKSPACE_UUID });
  if (!encoded.ok) throw new Error('fixture configuration must encode');
  return {
    v: 1,
    instance: {
      source: { pluginId: 'happier.scm.forge.bitbucket', localId: 'bitbucket-forge' },
      sourceInstanceId: '2f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05',
    },
    binding: {
      purpose: BITBUCKET_CONNECTED_ACCOUNT_PURPOSE,
      account: accountRef('account-1'),
    },
    localInstanceKey: WORKSPACE_UUID,
    configuration: { v: 1, token: encoded.token },
  } as TriageConfiguredSourceInstanceV1;
}

const LOCAL_REF = Object.freeze({
  kindId: 'pull-request',
  collisionScope: `bitbucket:${REPOSITORY_UUID}`,
  entryId: '42',
});

function pullRequest(participantState: 'approved' | 'changes_requested' | null = null) {
  return {
    type: 'pullrequest',
    id: 42,
    title: 'Review the publication path',
    state: 'OPEN',
    destination: {
      commit: { hash: BASE },
      repository: { uuid: REPOSITORY_UUID, full_name: 'example/repository' },
    },
    source: {
      branch: { name: 'feature' },
      commit: { hash: HEAD },
      repository: { uuid: REPOSITORY_UUID, full_name: 'example/repository' },
    },
    author: { uuid: VIEWER_UUID, nickname: 'viewer' },
    participants: participantState === null ? [] : [{
      type: 'participant',
      user: { uuid: VIEWER_UUID, nickname: 'viewer' },
      role: 'PARTICIPANT',
      approved: participantState === 'approved',
      state: participantState,
    }],
    created_on: '2026-08-01T00:00:00Z',
    updated_on: '2026-08-02T00:00:00Z',
  };
}

function entry(id: string, line: number) {
  return {
    happierCommentId: id,
    expectedServerRevision: 1,
    anchor: { kind: 'line' as const, filePath: 'src/index.ts', line, side: 'after' as const },
    snapshot: {
      kind: 'text' as const,
      selectedLines: ['const value = true;'],
      beforeContext: [],
      afterContext: [],
      selectedLinesHash: 'selected',
      contextWindowHash: 'context',
      capturedAt: 1,
      fileLength: 20,
      source: 'diffSide' as const,
      commitSha: HEAD,
      isUncommitted: false,
      isUntracked: false,
      truncated: false,
      hasBidiControls: false,
      likelyMinified: false,
      diffContext: { side: 'after' as const, baseSha: BASE, headSha: HEAD },
    },
    body: `Comment ${id}`,
  };
}

function summaryEntry(id: string) {
  return {
    ...entry(id, 1),
    anchor: { kind: 'workspace' as const, workspaceId: 'workspace-review' },
  };
}

function plan(input: Readonly<{
  entries?: readonly ReturnType<typeof entry>[];
  verdict?: ReviewCommentPublicationPlanV1['verdict'];
}> = {}): ReviewCommentPublicationPlanV1 {
  return {
    target: {
      providerId: 'bitbucket',
      configuredAccountId: 'account-1',
      entryRef: {
        sourceId: 'happier.scm.forge.bitbucket/bitbucket-forge',
        kindId: LOCAL_REF.kindId,
        collisionScope: LOCAL_REF.collisionScope,
        entryId: LOCAL_REF.entryId,
      },
      subtarget: null,
    },
    baseRevision: BASE,
    headRevision: HEAD,
    entries: input.entries ?? [entry('comment-1', 12), entry('comment-2', 18)],
    verdict: input.verdict === undefined
      ? { kind: 'requestChanges', body: 'Please address these findings.' }
      : input.verdict,
  };
}

function request(publicationPlan: ReviewCommentPublicationPlanV1) {
  return { v: 1, instance: configuredInstance(), localRef: LOCAL_REF, publicationPlan };
}

function withClaim(
  context: PluginInvocationContext,
  publicationPlan: ReviewCommentPublicationPlanV1,
  disposition: 'dispatch' | 'reconcile' = 'dispatch',
): PluginInvocationContext {
  return {
    ...context,
    services: {
      ...context.services,
      actions: {
        execute: async (actionId: string) => {
          expect(actionId).toBe('reviews.comments.claimPublicationDispatch');
          return {
            disposition,
            publicationPlanId: 'P'.repeat(43),
            entries: publicationPlan.entries.map((candidate, index) => ({
              happierCommentId: candidate.happierCommentId,
              publicationCorrelationId: String.fromCharCode(65 + index).repeat(43),
            })),
            verdict: publicationPlan.verdict === null
              ? null
              : { publicationCorrelationId: 'V'.repeat(43) },
          };
        },
      },
    },
  } as PluginInvocationContext;
}

describe('Bitbucket canonical review publication', () => {
  it('settles an unresolvable provider anchor exactly without a provider write', async () => {
    const invalid = entry('comment-1', 12);
    const publicationPlan = plan({
      entries: [{ ...invalid, anchor: { kind: 'file' as const, filePath: 'src/index.ts' } }],
    });
    let claims = 0;
    const { http, requests } = createHttpStub((url) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const base = createInvocationContext(connectedAccounts, http);
    const context = {
      ...base,
      services: {
        ...base.services,
        actions: {
          execute: async () => {
            claims += 1;
            return {
              disposition: 'dispatch',
              publicationPlanId: 'P'.repeat(43),
              entries: [{ happierCommentId: 'comment-1', publicationCorrelationId: 'A'.repeat(43) }],
              verdict: { publicationCorrelationId: 'V'.repeat(43) },
            };
          },
        },
      },
    } as PluginInvocationContext;

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: {
          entries: [{ outcome: { kind: 'failed', code: 'anchor_unresolvable' } }],
          verdict: { outcome: { kind: 'skippedPriorFailure' } },
        },
      });
    expect(claims).toBe(1);
    expect(requests.filter((candidate) => candidate.method !== 'GET')).toHaveLength(0);
  });

  it('publishes comments in order, stops at the first failure, and marks the suffix skipped', async () => {
    const publicationPlan = plan();
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') {
        const raw = (requestInfo.body as { content?: { raw?: string } })?.content?.raw ?? '';
        return raw.includes('A'.repeat(43))
          ? { status: 201, body: { id: 101 } }
          : { status: 403, body: { error: { message: 'forbidden' } } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    const result = await publishBitbucketPullRequestReviewAction(request(publicationPlan), context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [
          { happierCommentId: 'comment-1', outcome: { kind: 'published' } },
          { happierCommentId: 'comment-2', outcome: { kind: 'failed' } },
        ],
        verdict: { outcome: { kind: 'skippedPriorFailure' } },
      },
    });
    const writes = requests.filter((candidate) => candidate.method !== 'GET');
    expect(writes.map((candidate) => candidate.url)).toEqual([commentsUrl, commentsUrl]);
  });

  it('submits changes requested last and confirms the viewer participant state', async () => {
    const publicationPlan = plan({ entries: [entry('comment-1', 12)] });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const verdictUrl = `${PULL_REQUEST_URL}/request-changes`;
    let pullRequestReads = 0;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) {
        pullRequestReads += 1;
        return { body: pullRequest(pullRequestReads > 1 ? 'changes_requested' : null) };
      }
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') return { status: 201, body: { id: 101 } };
      if (url === verdictUrl) {
        return { status: 200, body: pullRequest('changes_requested').participants[0] };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    const result = await publishBitbucketPullRequestReviewAction(request(publicationPlan), context);

    expect(result).toMatchObject({
      kind: 'settled',
      publication: {
        entries: [{ outcome: { kind: 'published' } }],
        verdict: { outcome: { kind: 'published' } },
      },
    });
    expect(requests.filter((candidate) => candidate.method !== 'GET').map((candidate) => candidate.url))
      .toEqual([commentsUrl, commentsUrl, verdictUrl]);
  });

  it('reconciles an ambiguous comment response by exact marker without writing again', async () => {
    const publicationPlan = plan({ entries: [entry('comment-1', 12)], verdict: null });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    let commentWrites = 0;
    let commentReads = 0;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url === commentsUrl && requestInfo?.method === 'POST') {
        commentWrites += 1;
        return { status: 502, body: { error: { message: 'answer lost' } } };
      }
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') {
        commentReads += 1;
        return {
          body: {
            values: commentReads === 1
              ? []
              : [{ id: 991, content: { raw: `landed\n\n<!-- happier-review-comment:v1:${'A'.repeat(43)} -->` } }],
          },
        };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { entries: [{ outcome: { kind: 'published', externalRef: '991' } }] },
      });
    expect(commentWrites).toBe(1);
    expect(requests.filter((candidate) => candidate.url === commentsUrl && candidate.method === 'POST'))
      .toHaveLength(1);
  });

  it('keeps duplicate exact markers uncertain and emits no provider write', async () => {
    const publicationPlan = plan({ entries: [entry('comment-1', 12)], verdict: null });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const exactMarker = `<!-- happier-review-comment:v1:${'A'.repeat(43)} -->`;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') {
        return { body: { values: [
          { id: 991, content: { raw: `first\n\n${exactMarker}` } },
          { id: 992, content: { raw: `second\n\n${exactMarker}` } },
        ] } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { entries: [{ outcome: { kind: 'uncertain' } }] },
      });
    expect(requests.some((candidate) => candidate.method === 'POST')).toBe(false);
  });

  it('publishes even when the comment collection carries a row this build cannot render', async () => {
    const publicationPlan = plan({ entries: [entry('comment-1', 12)], verdict: null });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') {
        // A deleted tombstone: Bitbucket enumerates the row, and it carries no
        // readable content. It cannot bear a marker, so it must not poison the
        // reconciliation walk — a pull request with one deleted comment is an
        // ordinary pull request, not an unreadable one.
        return { body: { values: [{ id: 777, deleted: true }] } };
      }
      if (url === commentsUrl && requestInfo?.method === 'POST') return { status: 201, body: { id: 771 } };
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { entries: [{ outcome: { kind: 'published', externalRef: '771' } }] },
      });
    expect(requests.filter((candidate) => candidate.method === 'POST')).toHaveLength(1);
  });

  it('keeps an answer-lost markerless verdict uncertain even when participant state now matches', async () => {
    const publicationPlan = plan({ entries: [], verdict: { kind: 'approve', body: 'Approved.' } });
    const verdictUrl = `${PULL_REQUEST_URL}/approve`;
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    let reads = 0;
    let verdictWrites = 0;
    const { http } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) {
        reads += 1;
        return { body: pullRequest(reads > 2 ? 'approved' : null) };
      }
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') return { status: 201, body: { id: 501 } };
      if (url === verdictUrl && requestInfo?.method === 'POST') {
        verdictWrites += 1;
        return { status: 502, body: { error: { message: 'answer lost' } } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { verdict: { outcome: { kind: 'uncertain' } } },
      });
    expect(verdictWrites).toBe(1);
  });

  it('publishes a comment verdict as the real marker-bearing summary with no participant write', async () => {
    const publicationPlan = plan({ entries: [], verdict: { kind: 'comment', body: 'General feedback.' } });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') {
        expect((requestInfo.body as { content: { raw: string } }).content.raw)
          .toContain('General feedback.');
        return { status: 201, body: { id: 502 } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { verdict: { outcome: { kind: 'published', externalRef: '502' } } },
      });
    expect(requests.filter((candidate) => candidate.method === 'POST').map((candidate) => candidate.url))
      .toEqual([commentsUrl]);
  });

  it('reconciles an answer-lost summary by its exact verdict marker without reposting it', async () => {
    const publicationPlan = plan({ entries: [], verdict: { kind: 'comment', body: 'General feedback.' } });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    let reads = 0;
    let writes = 0;
    const { http } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') {
        reads += 1;
        return {
          body: {
            values: reads > 1
              ? [{
                id: 503,
                content: {
                  raw: `General feedback.\n\n<!-- happier-review-verdict:v1:${'V'.repeat(43)} -->`,
                },
              }]
              : [],
          },
        };
      }
      if (url === commentsUrl && requestInfo?.method === 'POST') {
        writes += 1;
        return { status: 502, body: { error: { message: 'answer lost' } } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { verdict: { outcome: { kind: 'published', externalRef: '503' } } },
      });
    expect(writes).toBe(1);
  });

  it('keeps a failed pre-summary reconciliation uncertain and issues no provider write', async () => {
    const publicationPlan = plan({ entries: [], verdict: { kind: 'approve', body: 'Approved.' } });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') {
        return { status: 403, body: { error: { message: 'forbidden' } } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { verdict: { outcome: { kind: 'uncertain' } } },
      });
    expect(requests.filter((candidate) => candidate.method !== 'GET')).toHaveLength(0);
  });

  it('folds no-file entries and their markers into the explicit verdict summary', async () => {
    const publicationPlan = plan({
      entries: [summaryEntry('summary-entry')],
      verdict: { kind: 'comment', body: 'Overall summary.' },
    });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') {
        const body = (requestInfo.body as { content: { raw: string } }).content.raw;
        expect(body).toContain(`<!-- happier-review-comment:v1:${'A'.repeat(43)} -->`);
        expect(body).toContain(`<!-- happier-review-verdict:v1:${'V'.repeat(43)} -->`);
        return { status: 201, body: { id: 504 } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: {
          entries: [{ outcome: { kind: 'published', externalRef: '504' } }],
          verdict: { outcome: { kind: 'published', externalRef: '504' } },
        },
      });
  });

  it('rejects a no-file entry without an explicit verdict before claim or write', async () => {
    const publicationPlan = plan({ entries: [summaryEntry('summary-entry')], verdict: null });
    let claims = 0;
    const { http, requests } = createHttpStub((url) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const base = createInvocationContext(connectedAccounts, http);
    const context = {
      ...base,
      services: {
        ...base.services,
        actions: { execute: async () => { claims += 1; throw new Error('must not claim'); } },
      },
    } as PluginInvocationContext;

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({ kind: 'rejected', reason: 'unsupported_anchor' });
    expect(claims).toBe(0);
    expect(requests.filter((candidate) => candidate.method !== 'GET')).toHaveLength(0);
  });

  it('reconciles all folded entry and verdict markers to the same summary comment', async () => {
    const publicationPlan = plan({
      entries: [summaryEntry('summary-entry')],
      verdict: { kind: 'comment', body: 'Overall summary.' },
    });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const body = [
      `Comment summary-entry\n\n<!-- happier-review-comment:v1:${'A'.repeat(43)} -->`,
      `Overall summary.\n\n<!-- happier-review-verdict:v1:${'V'.repeat(43)} -->`,
    ].join('\n\n');
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') {
        return { body: { values: [{ id: 505, content: { raw: body } }] } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(
      createInvocationContext(connectedAccounts, http),
      publicationPlan,
      'reconcile',
    );

    await expect(publishBitbucketPullRequestReviewAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: {
          entries: [{ outcome: { kind: 'published', externalRef: '505' } }],
          verdict: { outcome: { kind: 'published', externalRef: '505' } },
        },
      });
    expect(requests.filter((candidate) => candidate.method !== 'GET')).toHaveLength(0);
  });

  it('declares the candidate publication Action id', () => {
    expect(BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.submitReview).toBe('pull-request-submit-review');
    expect(BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.createReviewComment)
      .toBe('pull-request-review-comment-create');
    expect(BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.replyToReviewComment)
      .toBe('pull-request-thread-reply');
  });

  it('registers all three canonical Reviews publication Actions in the source manifest', () => {
    const ids = new Set(PLUGIN_MANIFEST.contributes.actions.map((action) => action.id));
    for (const id of [
      BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.submitReview,
      BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.createReviewComment,
      BITBUCKET_TRIAGE_MUTATION_ACTION_IDS.replyToReviewComment,
    ]) expect(ids.has(id)).toBe(true);
  });

  it('publishes one pinned standalone comment through the canonical claim', async () => {
    const publicationPlan = plan({ entries: [entry('comment-1', 12)], verdict: null });
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http, requests } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url.startsWith(commentsUrl) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') return { status: 201, body: { id: 701 } };
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(createBitbucketPullRequestReviewCommentAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'settled',
        publication: { entries: [{ outcome: { kind: 'published', externalRef: '701' } }] },
      });
    expect(requests.filter((candidate) => candidate.method === 'POST')).toHaveLength(1);
  });

  it('preserves the exact account admission failure for standalone publication', async () => {
    const publicationPlan = plan({ entries: [entry('comment-1', 12)], verdict: null });
    const { http } = createHttpStub(() => undefined);
    const { connectedAccounts } = createConnectedAccountsStub({
      accounts: [{ accountId: 'account-1', materializationError: new Error('reauth required') }],
    });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(createBitbucketPullRequestReviewCommentAction(request(publicationPlan), context))
      .resolves.toMatchObject({
        kind: 'rejected',
        reason: 'admission_failed',
        failure: { class: 'authentication', code: 'account-materialization-failed' },
      });
  });

  it('preflights and publishes one unversioned reply beneath its exact parent', async () => {
    const publicationPlan: ReviewCommentPublicationPlanV1 = {
      ...plan({ entries: [entry('reply-1', 12)], verdict: null }),
      target: {
        ...plan().target,
        subtarget: { kindId: 'review-comment', targetId: '55' },
      },
      baseRevision: null,
      headRevision: null,
    };
    const commentsUrl = `${PULL_REQUEST_URL}/comments`;
    const { http } = createHttpStub((url, requestInfo) => {
      if (url.endsWith('/2.0/user')) return { body: { uuid: VIEWER_UUID } };
      if (url === PULL_REQUEST_URL) return { body: pullRequest() };
      if (url === `${commentsUrl}/55`) return { body: { id: 55, content: { raw: 'parent' } } };
      if (url.startsWith(`${commentsUrl}?`) && requestInfo?.method === 'GET') return { body: { values: [] } };
      if (url === commentsUrl && requestInfo?.method === 'POST') {
        expect(requestInfo.body).toMatchObject({ parent: { id: '55' } });
        return { status: 201, body: { id: 702 } };
      }
      return undefined;
    });
    const { connectedAccounts } = createConnectedAccountsStub({ accounts: [{ accountId: 'account-1' }] });
    const context = withClaim(createInvocationContext(connectedAccounts, http), publicationPlan);

    await expect(replyToBitbucketPullRequestReviewCommentAction({
      ...request(publicationPlan),
      parentCommentId: '55',
    }, context)).resolves.toMatchObject({
      kind: 'settled',
      publication: { entries: [{ outcome: { kind: 'published', externalRef: '702' } }] },
    });
  });
});
