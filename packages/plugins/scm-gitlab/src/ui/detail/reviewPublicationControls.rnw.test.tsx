// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  createReviewCommentLinkedIssueIdV1,
  type ReviewCommentV1,
} from '@happier-dev/plugin-sdk/reviews';
import { createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { TriagePostMutationCompletionProvider } from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it } from 'vitest';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_TRIAGE_DETAIL_ACTION_IDS,
  GITLAB_TRIAGE_MUTATION_ACTION_IDS,
} from '../../triage/contribution.js';
import { renderSurface } from '../renderSurface.js';
import {
  GitlabIssueCommentPublicationControl,
  GitlabMergeRequestPublicationControls,
  GitlabThreadReplyPublicationControl,
  type GitlabReviewProposalReadV1,
  type GitlabStringReviewProposalV1,
} from './reviewPublicationControls.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE = '1'.repeat(40);
const HEAD = '2'.repeat(40);
const INPUT = {
  v: 1,
  instance: {
    v: 1,
    instance: {
      source: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' },
      sourceInstanceId: '9d2a6b1e-6c1a-4b7d-9f31-1d4a6c8b2e70',
    },
    binding: {
      purpose: 'gitlab-api',
      account: {
        service: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-account' },
        accountId: 'account-1',
      },
    },
    localInstanceKey: 'gitlab-com',
    configuration: { v: 1, token: 'configuration-token' },
  },
  observation: {
    entryRef: {
      source: { pluginId: GITLAB_PLUGIN_ID, localId: 'gitlab-forge' },
      kindId: 'merge-request',
      collisionScope: 'gitlab.com:group/project',
      entryId: '42',
    },
    observedAtMs: 1,
    locator: {
      v: 1,
      webUrl: 'https://gitlab.com/group/project/-/merge_requests/42',
      displayPath: 'group/project !42',
      routingToken: 'group/project',
    },
    snapshot: {
      v: 1,
      title: 'Keep publication exact',
      scopeLabel: 'group/project',
      state: { presentation: 'active', nativeLabel: 'opened' },
      facts: [],
      reviewRevision: { baseSha: BASE, headSha: HEAD, nativeRevision: HEAD },
    },
    viewer: { involvement: ['reviewRequested'] },
    nativeRevision: HEAD,
  },
  linkedSessions: [{ sessionId: 'review-session', displayTitle: 'Review this merge request' }],
} as unknown as TriageDetailSurfaceInputV1;

const PROPOSAL = {
  id: 'review-comment-1',
  body: 'Keep this normalization at the canonical owner.',
  serverRevision: 3,
  anchor: { kind: 'line', filePath: 'src/index.ts', line: 12, side: 'after' },
  snapshot: {
    kind: 'text',
    selectedLines: ['return canonical;'],
    beforeContext: [],
    afterContext: [],
    selectedLinesHash: 'selected-hash',
    contextWindowHash: 'context-hash',
    capturedAt: 1,
    fileLength: 20,
    source: 'committed',
    commitSha: HEAD,
    isUncommitted: false,
    isUntracked: false,
    truncated: false,
    hasBidiControls: false,
    likelyMinified: false,
    diffContext: { side: 'after', baseSha: BASE, headSha: HEAD, startSha: BASE },
  },
  linkedRefs: [{ kind: 'pullRequest', url: INPUT.observation.locator.webUrl }],
} as unknown as ReviewCommentV1 & GitlabStringReviewProposalV1;

const PROPOSALS: GitlabReviewProposalReadV1 = {
  status: 'ready',
  proposals: [PROPOSAL],
};

const SETTLED = {
  kind: 'settled',
  publication: {
    publicationPlanId: 'P'.repeat(43),
    entries: [{
      happierCommentId: PROPOSAL.id,
      publicationCorrelationId: 'C'.repeat(43),
      outcome: { kind: 'published', externalRef: 'draft-1' },
    }],
    verdict: { kind: 'notRequested' },
  },
  preexistingDraftCount: 0,
} as unknown as JsonValue;

const mounted: PluginUiTestkit[] = [];
const recorded: Array<{ action: unknown; input: unknown }> = [];
let nextResult: JsonValue = SETTLED;
let nextError: PluginError | null = null;
let completed = 0;

type MountedControl = 'merge-request' | 'thread-reply' | 'issue-comment';

async function mountControl(kind: MountedControl): Promise<PluginUiTestkit> {
  const { reviewRevision: _reviewRevision, ...issueSnapshot } = INPUT.observation.snapshot;
  const issueInput = kind === 'issue-comment'
    ? ({
      ...INPUT,
      observation: {
        ...INPUT.observation,
        entryRef: { ...INPUT.observation.entryRef, kindId: 'issue' },
        snapshot: issueSnapshot,
      },
    } as TriageDetailSurfaceInputV1)
    : INPUT;
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: GITLAB_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'gitlab-publication-test',
        generation: `gitlab-publication-${kind}`,
      },
      surface: defineUiSurface(() => (
        <TriagePostMutationCompletionProvider onComplete={async () => { completed += 1; }}>
          {kind === 'merge-request'
            ? <GitlabMergeRequestPublicationControls input={INPUT} proposals={PROPOSALS} />
            : kind === 'thread-reply'
              ? <GitlabThreadReplyPublicationControl input={INPUT} discussionId="discussion-7" proposals={PROPOSALS} />
              : <GitlabIssueCommentPublicationControl input={issueInput} proposals={PROPOSALS} />}
        </TriagePostMutationCompletionProvider>
      )),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        executeAction: async ({ action, input }) => {
          recorded.push({ action, input });
          if (nextError !== null) throw nextError;
          return nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

async function mountRenderedDetail(input: TriageDetailSurfaceInputV1): Promise<PluginUiTestkit> {
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: {
        pluginId: GITLAB_PLUGIN_ID,
        pluginVersion: '0.0.0',
        viewId: 'gitlab-detail',
        generation: 'gitlab-publication-real-surface',
      },
      surface: (context) => (
        <TriagePostMutationCompletionProvider onComplete={async () => { completed += 1; }}>
          {renderSurface(context) as React.ReactNode}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input as unknown as JsonValue,
      handlers: {
        executeAction: async ({ action, input: dispatched }) => {
          recorded.push({ action, input: dispatched });
          if (nextError !== null) throw nextError;
          if (action === 'reviews.comments.list') {
            const proposal = input.observation.entryRef.kindId === 'issue'
              ? {
                ...PROPOSAL,
                linkedRefs: [{
                  kind: 'issue',
                  id: createReviewCommentLinkedIssueIdV1(input.observation.entryRef),
                  url: input.observation.locator.webUrl,
                }],
              }
              : {
                ...PROPOSAL,
                linkedRefs: [{ kind: 'pullRequest', url: input.observation.locator.webUrl }],
              };
            return { items: [proposal], cursor: null } as unknown as JsonValue;
          }
          const localId = (action as Readonly<{ localId?: string }>).localId;
          if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.readApprovals) {
            return {
              kind: 'approvals',
              approvedBy: [],
              omittedApproverCount: 0,
              rules: { kind: 'editionUnsupported' },
              projectionTruncated: false,
            } as JsonValue;
          }
          if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listDiscussions) {
            return {
              kind: 'discussions',
              rows: [{
                id: 'discussion-7',
                individualNote: false,
                notes: [{ id: 'note-1', body: 'Please keep this in one owner.', system: false }],
                omittedNoteCount: 0,
              }],
              omittedRowCount: 0,
              projectionTruncated: false,
            } as JsonValue;
          }
          if (localId === GITLAB_TRIAGE_DETAIL_ACTION_IDS.listNotes) {
            return {
              kind: 'notes',
              rows: [],
              omittedRowCount: 0,
              projectionTruncated: false,
            } as JsonValue;
          }
          return nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return fixture;
}

afterEach(async () => {
  recorded.splice(0);
  nextResult = SETTLED;
  nextError = null;
  completed = 0;
  for (const fixture of mounted.splice(0)) await fixture.dispose();
});

function actionRef(localId: string) {
  return { pluginId: GITLAB_PLUGIN_ID, localId };
}

describe('mounted GitLab Review publication controls', () => {
  it('reaches all four controls through the real GitLab MR/issue surface compositions', async () => {
    const mergeRequest = await mountRenderedDetail(INPUT);
    await act(async () => mergeRequest.press(await mergeRequest.getByRole('tab', { name: 'Reviews' })));
    await expect(mergeRequest.findByRole('checkbox', { name: PROPOSAL.body })).resolves.toMatchObject({
      state: { checked: true },
    });
    for (const name of ['Submit review', 'Publish selected comment', 'Publish reply']) {
      await expect(mergeRequest.getByRole('button', { name })).resolves.toBeDefined();
    }

    const { reviewRevision: _reviewRevision, ...issueSnapshot } = INPUT.observation.snapshot;
    const issueInput = {
      ...INPUT,
      observation: {
        ...INPUT.observation,
        entryRef: { ...INPUT.observation.entryRef, kindId: 'issue' },
        snapshot: issueSnapshot,
        locator: {
          ...INPUT.observation.locator,
          webUrl: 'https://gitlab.com/group/project/-/issues/42',
        },
      },
    } as TriageDetailSurfaceInputV1;
    const issue = await mountRenderedDetail(issueInput);
    await act(async () => issue.press(await issue.getByRole('tab', { name: 'Comments' })));
    await expect(issue.findByRole('radio', { name: PROPOSAL.body })).resolves.toBeDefined();
    await expect(issue.getByRole('button', { name: 'Publish comment' })).resolves.toBeDefined();
  });

  it('mounts and dispatches submit-review plus standalone review-comment-create', async () => {
    const detail = await mountControl('merge-request');
    await expect(detail.getByRole('button', { name: 'Submit review' })).resolves.toBeDefined();
    await expect(detail.getByRole('button', { name: 'Publish selected comment' })).resolves.toBeDefined();
    await expect(detail.getByRole('checkbox', { name: PROPOSAL.body })).resolves.toMatchObject({
      state: { checked: true },
    });

    await act(async () => detail.press(await detail.getByRole('button', { name: 'Submit review' })));
    expect(recorded.at(-1)).toMatchObject({
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview),
      input: {
        publicationPlan: {
          target: { providerId: 'gitlab', subtarget: null },
          baseRevision: BASE,
          headRevision: HEAD,
          entries: [{ happierCommentId: PROPOSAL.id }],
          verdict: null,
        },
      },
    });

    await act(async () => detail.press(await detail.getByRole('button', { name: 'Publish selected comment' })));
    expect(recorded.at(-1)).toMatchObject({
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestReviewCommentCreate),
      input: { publicationPlan: { entries: [{ happierCommentId: PROPOSAL.id }], verdict: null } },
    });
    expect(completed).toBe(2);
  });

  it('offers only GitLab-safe verdicts and requires a summary for comment or approve', async () => {
    const detail = await mountControl('merge-request');
    await expect(detail.queryByRole('radio', { name: 'Request changes' })).resolves.toBeUndefined();
    await act(async () => detail.press(await detail.getByRole('radio', { name: 'Approve' })));
    await expect(detail.getByRole('button', { name: 'Submit review' })).resolves.toMatchObject({
      state: { disabled: true },
    });
    await expect(detail.getByText('Add a summary before publishing this verdict.')).resolves.toBeDefined();
  });

  it('reports a declined host confirmation as canceled with no provider completion', async () => {
    nextError = new PluginError({
      code: 'plugin_action_current_intent_rejected',
      message: 'The current confirmation intent was declined.',
    });
    const detail = await mountControl('merge-request');
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Submit review' })));
    await expect(detail.getByText('Publication canceled')).resolves.toBeDefined();
    await expect(detail.getByText('Nothing was sent to GitLab.')).resolves.toBeDefined();
    expect(completed).toBe(0);
  });

  it('requests the canonical exact get after an error that may have followed dispatch', async () => {
    nextError = new PluginError({
      code: 'gitlab-publication-dispatch-failed',
      message: 'The handler did not return a publication result.',
    });
    const detail = await mountControl('merge-request');
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Submit review' })));
    await expect(detail.getByText('Publication did not settle')).resolves.toBeDefined();
    expect(completed).toBe(1);
  });

  it('reports pre-existing drafts, does not redispatch, and requires a second explicit press', async () => {
    nextResult = {
      kind: 'rejected',
      reason: 'preexisting_drafts',
      preexistingDraftCount: 2,
      preexistingDraftIds: ['draft-9', 'draft-10'],
    } as JsonValue;
    const detail = await mountControl('merge-request');
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Submit review' })));

    expect(recorded).toHaveLength(1);
    await expect(detail.getByText(
      'Happier left 2 existing draft(s) pending and published nothing. Continue only if you want to publish this Happier review without those drafts.',
    )).resolves.toBeDefined();

    nextResult = SETTLED;
    await act(async () => detail.press(await detail.getByRole('button', {
      name: 'Continue without publishing existing drafts',
    })));
    expect(recorded).toHaveLength(2);
    expect(recorded.at(-1)).toMatchObject({
      input: { acknowledgedPreexistingDraftIds: ['draft-9', 'draft-10'] },
    });
  });

  it('binds a reply to the exact review-thread subtarget before dispatch', async () => {
    const detail = await mountControl('thread-reply');
    await act(async () => detail.press(await detail.getByRole('radio', { name: PROPOSAL.body })));
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Publish reply' })));
    expect(recorded).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestThreadReply),
      input: expect.objectContaining({
        discussionId: 'discussion-7',
        publicationPlan: expect.objectContaining({
          target: expect.objectContaining({
            subtarget: { kindId: 'review-thread', targetId: 'discussion-7' },
          }),
          baseRevision: null,
          headRevision: null,
        }),
      }),
    }]);
  });

  it('mounts issue/comment as an unversioned top-level publication', async () => {
    const detail = await mountControl('issue-comment');
    await act(async () => detail.press(await detail.getByRole('radio', { name: PROPOSAL.body })));
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Publish comment' })));
    expect(recorded).toEqual([{
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.issueComment),
      input: expect.objectContaining({
        publicationPlan: expect.objectContaining({
          target: expect.objectContaining({ subtarget: null, entryRef: expect.objectContaining({ kindId: 'issue' }) }),
          baseRevision: null,
          headRevision: null,
        }),
      }),
    }]);
  });

  it('renders uncertain and skipped outcomes without calling them complete', async () => {
    nextResult = {
      kind: 'settled',
      publication: {
        publicationPlanId: 'P'.repeat(43),
        entries: [{
          happierCommentId: PROPOSAL.id,
          publicationCorrelationId: 'C'.repeat(43),
          outcome: { kind: 'uncertain' },
        }],
        verdict: { kind: 'notRequested' },
      },
      preexistingDraftCount: 0,
    } as JsonValue;
    const detail = await mountControl('merge-request');
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Submit review' })));
    await expect(detail.getByText('Publication outcome unknown')).resolves.toBeDefined();
    await expect(detail.getByText(
      '0/1 comments published; 1 unconfirmed; 0 failed; 0 not attempted. Verdict: notRequested.',
    )).resolves.toBeDefined();
  });
});
