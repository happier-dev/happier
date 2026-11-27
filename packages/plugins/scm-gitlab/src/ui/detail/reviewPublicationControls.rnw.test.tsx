// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { PluginError, type JsonValue } from '@happier-dev/plugin-sdk';
import {
  createReviewCommentLinkedIssueIdV1,
  type ReviewCommentV1,
} from '@happier-dev/plugin-sdk/reviews';
import { createPluginUiActionControlTestHost, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface, Tabs } from '@happier-dev/plugin-ui';
import {
  TriageEvidenceDisclosureProvider,
  TriagePostMutationCompletionProvider,
  triageSourcePanelIntentKeyV1,
  type TriageSourcePanelActionsV1,
  type TriageSourcePanelCommandV1,
  type TriageSourcePanelHandlerV1,
} from '@happier-dev/triage-sources/ui';
import type { TriageDetailSurfaceInputV1 } from '@happier-dev/triage-protocol/v1';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GITLAB_PLUGIN_ID,
  GITLAB_CONNECTED_ACCOUNT_PURPOSE,
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
      purpose: GITLAB_CONNECTED_ACCOUNT_PURPOSE,
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
type MountedFixture = PluginUiTestkit & { controls: ReturnType<typeof createPluginUiActionControlTestHost> };
const recorded: Array<{ action: unknown; input: unknown }> = [];
let nextResult: JsonValue = SETTLED;
let nextError: PluginError | null = null;
let completed = 0;

type MountedControl = 'merge-request' | 'thread-reply' | 'issue-comment';

/** The proposals reader's continuation: each Read more publishes the next page appended to the ready list. */
function PagedProposalControls(props: Readonly<{ input: TriageDetailSurfaceInputV1; pages: readonly (readonly GitlabStringReviewProposalV1[])[] }>) {
  const [loaded, setLoaded] = React.useState(1);
  const read = React.useMemo<GitlabReviewProposalReadV1>(() => ({
    status: 'ready',
    proposals: props.pages.slice(0, loaded).flat(),
    ...(loaded < props.pages.length ? { loadMore: () => setLoaded((count) => count + 1) } : {}),
  }), [loaded, props.pages]);
  return <GitlabMergeRequestPublicationControls input={props.input} proposals={read} open onOpenChange={() => {}} />;
}

async function mountControl(kind: MountedControl, options?: Readonly<{
  input: TriageDetailSurfaceInputV1;
  proposals: GitlabReviewProposalReadV1;
  withWalkthrough?: boolean;
  pages?: readonly (readonly GitlabStringReviewProposalV1[])[];
  panelActions?: TriageSourcePanelActionsV1;
}>): Promise<MountedFixture> {
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
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    recorded.push({ action, input });
    if (nextError !== null) return { ok: false, errorCode: nextError.diagnostics?.some(diagnostic => diagnostic.code === 'plugin_action_current_intent_rejected') ? 'approval_rejected' : nextError.code, error: nextError.message,
      ...(nextError.details === undefined ? {} : { details: nextError.details }) };
    return { ok: true, result: nextResult };
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-196', mountNonce: 'fixture-mount-196' },
      authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
      surface: defineUiSurface(() => (
        <TriageEvidenceDisclosureProvider disclosure={{ available: false, disclose: async () => ({ kind: 'inert' }),
          ...(options?.panelActions ? { panelActions: options.panelActions } : {}) }}>
        <TriagePostMutationCompletionProvider onComplete={async () => { completed += 1; }}>
          {kind === 'merge-request'
            // The Publish sheet lives in the merge request's Reviews panel; its draft commands bind while that panel is active.
            ? <Tabs value="reviews" onValueChange={() => {}} ariaLabel="Merge request">
              <Tabs.Item value="reviews" title="Reviews">
                {options?.pages
                  ? <PagedProposalControls input={options.input} pages={options.pages} />
                  : <GitlabMergeRequestPublicationControls input={options?.input ?? INPUT} proposals={options?.proposals ?? PROPOSALS}
                    open onOpenChange={() => {}} />}
              </Tabs.Item>
            </Tabs>
            : kind === 'thread-reply'
              ? <GitlabThreadReplyPublicationControl input={INPUT} discussionId="discussion-7" proposals={PROPOSALS} />
              : <GitlabIssueCommentPublicationControl input={issueInput} proposals={PROPOSALS} />}
        </TriagePostMutationCompletionProvider>
        </TriageEvidenceDisclosureProvider>
      )),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        actionControl: controls.handler,
        ...(options?.input.admittedReview ? {
          readResource: async () => ({
            contentType: 'application/json',
            digest: `sha256:${'1'.repeat(64)}`,
            bytes: new TextEncoder().encode(JSON.stringify({
              roundQuality: { roundOrdinal: 1, aggregation: 'median', score: 3.5, reviewers: [{ displayName: 'Claude', score: 2 }, { displayName: 'Codex', score: 5 }] },
              ...(options.withWalkthrough ? { roundWalkthrough: { roundOrdinal: 1, stops: [
                { title: 'Retry ownership', explanationMarkdown: 'The new scheduler owns retries. Keep this extra detail in Happier.' },
              ] } } : {}),
            })),
          }),
        } : {}),
        executeAction: async ({ action, input }) => {
          if (typeof action !== 'string' && Object.values(GITLAB_TRIAGE_MUTATION_ACTION_IDS).some(localId => localId === action.localId)) {
            throw new Error('A press write must execute through the host Action control.');
          }
          recorded.push({ action, input });
          if (nextError !== null) throw nextError;
          return nextResult;
        },
      },
    });
  });
  mounted.push(fixture);
  return { ...fixture, controls };
}

async function mountRenderedDetail(input: TriageDetailSurfaceInputV1): Promise<MountedFixture> {
  const controls = createPluginUiActionControlTestHost(async ({ action, input }) => {
    recorded.push({ action, input });
    if (nextError !== null) return { ok: false, errorCode: nextError.diagnostics?.some(diagnostic => diagnostic.code === 'plugin_action_current_intent_rejected') ? 'approval_rejected' : nextError.code, error: nextError.message,
      ...(nextError.details === undefined ? {} : { details: nextError.details }) };
    return { ok: true, result: nextResult };
  });
  let fixture!: PluginUiTestkit;
  await act(async () => {
    fixture = await createPluginUiTestkit({
      identity: { instanceId: 'fixture-instance-197', mountNonce: 'fixture-mount-197' },
      authorPlugin: { id: GITLAB_PLUGIN_ID, version: '0.0.0' },
      surface: (context) => (
        <TriagePostMutationCompletionProvider onComplete={async () => { completed += 1; }}>
          {renderSurface(context) as React.ReactNode}
        </TriagePostMutationCompletionProvider>
      ),
      surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      launchInput: input as unknown as JsonValue,
      handlers: {
        actionControl: controls.handler,
        readResource: async ({ resource }) => {
          if (typeof resource === 'string' || !('hostRead' in resource)) throw new Error('Expected the admitted Review Resource');
          const value = resource.hostRead === 'review.get' ? {
            review: { reviewId: 'embedded-review', state: 'completed', counts: { total: 1, needsDecision: 1 } },
            human: { needsYou: { needsYou: true } },
          } : {
            status: 'loaded', cursor: null, pending: {}, comments: [], unavailableFindings: [],
            rows: [{ rowId: PROPOSAL.id,
              finding: { id: 'engine-finding', title: 'Use the shared persisted finding', severity: 'high',
                category: 'correctness', summary: 'This finding also opens in Reviews.' },
              // A finding's revised body (bodyVersion 2 of a finding comment) is what the opened finding shows.
              comment: { ...PROPOSAL, finding: { id: 'engine-finding', title: 'Use the shared persisted finding', severity: 'high',
                category: 'correctness', summary: 'This finding also opens in Reviews.' }, bodyVersion: 2,
                body: 'Persisted current body after a decision.', reviewId: 'embedded-review', state: 'open', reviewTriageStatus: 'reject',
                author: { kind: 'plugin', pluginId: 'review-engine' }, transitions: [], edits: [] } }],
          };
          return { contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(value)), digest: `sha256:${'1'.repeat(64)}` };
        },
        watchResource: async () => ({ digest: `sha256:${'1'.repeat(64)}` }),
        executeAction: async ({ action, input: dispatched }) => {
          if (typeof action !== 'string' && Object.values(GITLAB_TRIAGE_MUTATION_ACTION_IDS).some(localId => localId === action.localId)) {
            throw new Error('A press write must execute through the host Action control.');
          }
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
                resolved: false,
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
  return { ...fixture, controls };
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
  it('keeps Overview free of proposal reads and reads the admitted Review once for Publish', async () => {
    const input = { ...INPUT, admittedReview: { reviewId: 'embedded-review', roundOrdinal: 1 } };
    await mountRenderedDetail({ ...input, panel: 'overview' });
    const reads = () => recorded.filter(({ action }) => action === 'reviews.comments.list');
    expect(reads()).toHaveLength(0);
    const detail = await mountRenderedDetail({ ...input, panel: 'activity' });
    expect(reads()).toHaveLength(1);
    await act(async () => detail.press(await detail.getByRole('button', { name: 'Publish review' })));
    expect(reads()).toHaveLength(1);
    expect(reads()[0]?.input).toEqual(expect.objectContaining({ reviewId: 'embedded-review' }));
    expect(reads()[0]?.input).not.toHaveProperty('sessionId');
  });

  it.each(['overview', 'activity'] as const)('opens the admitted persisted finding through the production merge request summary and shared body (%s)', async panel => {
    const detail = await mountRenderedDetail({ ...INPUT, panel,
      admittedReview: { reviewId: 'embedded-review', roundOrdinal: 1 } });
    await vi.waitFor(() => detail.getByText('Use the shared persisted finding'));
    await detail.press(await detail.getByRole('button', { name: 'Use the shared persisted finding' }));
    await expect(detail.getByText('Persisted current body after a decision.')).resolves.toBeDefined();
    await expect(detail.getByText('Ignored')).resolves.toBeDefined();
  });
  it('reaches all four controls through the real GitLab MR/issue surface compositions', async () => {
    const mergeRequest = await mountRenderedDetail(INPUT);
    await act(async () => mergeRequest.press(await mergeRequest.getByRole('tab', { name: 'Reviews' })));
    // Publishing is its own step: the Reviews panel offers it as one row, and the sheet opens from there.
    expect(await mergeRequest.queryByRole('checkbox', { name: PROPOSAL.body })).toBeUndefined();
    await act(async () => mergeRequest.press(await mergeRequest.findByRole('button', { name: 'Publish review' })));
    await expect(mergeRequest.findByRole('checkbox', { name: PROPOSAL.body })).resolves.toMatchObject({
      state: { checked: true },
    });
    for (const name of ['Publish 1 comment', 'Publish reply']) {
      await expect(Promise.resolve(mergeRequest.controls.presentation(name))).resolves.toBeDefined();
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
    await expect(Promise.resolve(issue.controls.presentation('Publish comment'))).resolves.toBeDefined();
  });

  it('mounts and dispatches one submit-review action, with no standalone comment twin', async () => {
    const detail = await mountControl('merge-request');
    await expect(Promise.resolve(detail.controls.presentation('Publish 1 comment'))).resolves.toBeDefined();
    expect(detail.controls.presentation('Publish selected comment')).toBeUndefined();
    await expect(detail.getByRole('checkbox', { name: PROPOSAL.body })).resolves.toMatchObject({
      state: { checked: true },
    });

    await act(async () => detail.controls.press('Publish 1 comment'));
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
    expect(completed).toBe(1);
  });

  it('offers Request changes and requires a summary before publishing a verdict', async () => {
    const detail = await mountControl('merge-request');
    await act(async () => detail.press(await detail.getByRole('radio', { name: 'Request changes' })));
    await expect(Promise.resolve(detail.controls.presentation('Publish 1 comment'))).resolves.toMatchObject({
      disabled: true,
    });
    // The reason stands beside the disabled control, with what to do.
    await expect(detail.getByText('Write a summary to publish.')).resolves.toBeDefined();
  });

  it.each([false, true])('previews the verdict as Markdown with a native Walkthrough fold (walkthrough=%s)', async withWalkthrough => {
    const detail = await mountControl('merge-request', {
      input: { ...INPUT, admittedReview: { reviewId: 'selected-review', roundOrdinal: 1 } },
      withWalkthrough,
      proposals: { status: 'ready', proposals: [{
        ...PROPOSAL,
        finding: { id: 'model-finding', severity: 'high', category: 'correctness',
          title: 'Keep retry state consistent', summary: 'Current retry policy discards the saved attempt.' },
      }] },
    });
    await act(async () => detail.press(await detail.getByRole('radio', { name: 'Request changes' })));
    const box = document.body.querySelector('textarea');
    if (!box) throw new Error('Expected the verdict summary editor');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    const authored = 'Check the retry behavior before merging.';
    await act(async () => {
      setValue.call(box, authored);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const readPreview = () => document.body.querySelector('[data-testid="gitlab-review-publication-preview"]')?.textContent;
    await vi.waitFor(() => expect(readPreview()).toContain('Quality: 3/5 (median of 2). Reviewer scores: Claude 2, Codex 5.'));
    const walkthroughLabel = 'Walkthrough · 1 stop';
    if (withWalkthrough) {
      const fold = await detail.getByRole('button', { name: walkthroughLabel });
      expect(readPreview()).not.toContain('The new scheduler owns retries.');
      await act(async () => detail.press(fold));
      expect(readPreview()).toContain('The new scheduler owns retries.');
      expect(readPreview()).not.toContain('Keep this extra detail in Happier.');
      const include = await detail.getByRole('switch', { name: 'Include the walkthrough' });
      await act(async () => detail.press(include));
      expect(readPreview()).not.toContain(walkthroughLabel);
      await act(async () => detail.press(await detail.getByRole('switch', { name: 'Include the walkthrough' })));
      expect(readPreview()).toContain(walkthroughLabel);
    }
    const preview = readPreview();
    expect(preview).toContain(authored);
    // Happier's preview names the short head; the posted body below keeps the whole revision.
    expect(preview).toContain(`Head: ${HEAD.slice(0, 7)}`);
    expect(preview).not.toContain(HEAD);
    expect(preview).toContain('Reviewed with Happier');
    expect(preview).toContain('[Open in Happier](https://cloud.happier.dev/artifacts/selected-review)');
    expect(preview).toContain('[Fix in Happier](https://cloud.happier.dev/artifacts/selected-review?thread=review-comment-1)');
    expect(preview).not.toContain('<details>');

    await act(async () => detail.controls.press('Publish 1 comment'));
    const submittedBody = [
      '**Request changes · 1 finding**',
      `Head: ${HEAD}`,
      authored,
      '**Should fix**\n- Keep retry state consistent',
      'Quality: 3/5 (median of 2). Reviewer scores: Claude 2, Codex 5.',
      ...(withWalkthrough ? [`<details>\n<summary>${walkthroughLabel}</summary>\n\n- **Retry ownership.** The new scheduler owns retries.\n\n</details>`] : []),
      '[Open in Happier](https://cloud.happier.dev/artifacts/selected-review) · [Fix in Happier](https://cloud.happier.dev/artifacts/selected-review?thread=review-comment-1)',
      'Reviewed with Happier',
    ].join('\n\n');
    expect(recorded.at(-1)).toMatchObject({
      action: actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview),
      input: { publicationPlan: { verdict: { kind: 'requestChanges', body: submittedBody } } },
    });
  });

  describe('the shared Publish sheet drives the one publication plan', () => {
    const finding = (id: string, severity: 'blocker' | 'nit', title: string, line: number) => ({
      ...PROPOSAL,
      id,
      threadId: id,
      body: `${title}.`,
      anchor: { kind: 'line', filePath: 'src/retry/policy.ts', line, side: 'after' },
      finding: { id: `finding-${id}`, severity, category: 'correctness', title, summary: `${title}.` },
    }) as typeof PROPOSAL;
    const THREE: GitlabReviewProposalReadV1 = { status: 'ready', proposals: [
      PROPOSAL,
      finding('review-comment-2', 'blocker', 'Timer survives a manual reconnect', 57),
      finding('review-comment-3', 'nit', 'README example uses the old option name', 88),
    ] };
    const entryIds = () => (recorded.at(-1)?.input as { publicationPlan: { entries: Array<{ happierCommentId: string }> } })
      .publicationPlan.entries.map(entry => entry.happierCommentId);

    it('posts only the checked findings and counts them on Publish', async () => {
      const detail = await mountControl('merge-request', { input: INPUT, proposals: THREE });
      // Nits start unchecked and stay listed as not posted.
      await expect(detail.getByRole('checkbox', { name: 'README example uses the old option name' }))
        .resolves.toMatchObject({ state: { checked: false } });
      await expect(detail.getByText('Nit · policy.ts:88 · not posted')).resolves.toBeDefined();
      await expect(detail.getByText('2 of 3 · ignored ones are never posted')).resolves.toBeDefined();
      expect(detail.controls.presentation('Publish 2 comments')?.disabled).toBe(false);

      await act(async () => detail.press(await detail.getByRole('checkbox', { name: 'Timer survives a manual reconnect' })));
      expect(detail.controls.presentation('Publish 2 comments')).toBeUndefined();
      await act(async () => detail.controls.press('Publish 1 comment'));
      expect(recorded.at(-1)?.action).toMatchObject(actionRef(GITLAB_TRIAGE_MUTATION_ACTION_IDS.mergeRequestSubmitReview));
      expect(entryIds()).toEqual([PROPOSAL.id]);
    });

    it('leaves the walkthrough out of the preview and the posted summary when it is switched off', async () => {
      const detail = await mountControl('merge-request', {
        input: { ...INPUT, admittedReview: { reviewId: 'selected-review', roundOrdinal: 1 } },
        withWalkthrough: true,
        proposals: THREE,
      });
      await act(async () => detail.press(await detail.getByRole('radio', { name: 'Comment' })));
      const box = document.body.querySelector('textarea');
      if (!box) throw new Error('Expected the summary editor');
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Two findings to fix.');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const readPreview = () => document.body.querySelector('[data-testid="gitlab-review-publication-preview"]')?.textContent ?? '';
      await vi.waitFor(() => expect(readPreview()).toContain('Walkthrough · 1 stop'));
      expect(readPreview()).toContain('2 inline comments');
      await expect(detail.getByText('Folded under the summary · 1 stop, its title and first sentence')).resolves.toBeDefined();

      await act(async () => detail.press(await detail.getByRole('switch', { name: 'Include the walkthrough' })));
      expect(readPreview()).not.toContain('Walkthrough');
      await act(async () => detail.controls.press('Publish 2 comments'));
      const verdict = (recorded.at(-1)?.input as { publicationPlan: { verdict: { body: string } } }).publicationPlan.verdict;
      expect(verdict.body).toContain('Two findings to fix.');
      expect(verdict.body).not.toContain('Walkthrough');
      expect(entryIds()).toEqual([PROPOSAL.id, 'review-comment-2']);
    });

    it('cannot publish once every finding is unchecked', async () => {
      const detail = await mountControl('merge-request', { input: INPUT, proposals: THREE });
      for (const name of [PROPOSAL.body, 'Timer survives a manual reconnect']) {
        await act(async () => detail.press(await detail.getByRole('checkbox', { name })));
      }
      await expect(detail.getByText('0 of 3 · ignored ones are never posted')).resolves.toBeDefined();
      expect(detail.controls.presentation('Publish 0 comments')?.disabled).toBe(true);
      expect(recorded).toHaveLength(0);
    });

    it('keeps every finding unchecked when the next page of proposals loads', async () => {
      const detail = await mountControl('merge-request', { input: INPUT, proposals: THREE, pages: [
        THREE.proposals,
        [finding('review-comment-4', 'blocker', 'A delayed reconnect drops the active timer', 9)],
      ] });
      for (const name of [PROPOSAL.body, 'Timer survives a manual reconnect']) {
        await act(async () => detail.press(await detail.getByRole('checkbox', { name })));
      }
      await expect(detail.getByText('0 of 3 · ignored ones are never posted')).resolves.toBeDefined();
      // Reading more proposals republishes the ready list with the next page appended.
      await act(async () => detail.press(await detail.getByRole('button', { name: 'Read more' })));
      await expect(detail.getByText('0 of 4 · ignored ones are never posted')).resolves.toBeDefined();
      for (const name of [PROPOSAL.body, 'Timer survives a manual reconnect', 'A delayed reconnect drops the active timer']) {
        await expect(detail.getByRole('checkbox', { name })).resolves.toMatchObject({ state: { checked: false } });
      }
      expect(detail.controls.presentation('Publish 0 comments')?.disabled).toBe(true);
      expect(recorded).toHaveLength(0);
    });
  });

  it('lets the mounted commands edit the open draft the person sees, and the checklist change the same draft', async () => {
    // The Triage detail host's panel registry, as the mounted Action reaches it: bindings by intent, commands listed.
    const bound = new Map<string, { invoke: TriageSourcePanelHandlerV1; commands: readonly TriageSourcePanelCommandV1[] }>();
    const panelActions: TriageSourcePanelActionsV1 = {
      bind(key, invoke, commands) { bound.set(key, { invoke, commands }); return () => { bound.delete(key); }; },
      execute: async (operation, signal) => await bound.get(triageSourcePanelIntentKeyV1(operation))?.invoke(operation, signal ?? new AbortController().signal)
        ?? { status: 'unavailable' },
    };
    const commands = () => [...bound.values()].flatMap((binding) => binding.commands);
    const THREE_WITH_WALKTHROUGH: GitlabReviewProposalReadV1 = { status: 'ready', proposals: [
      { ...PROPOSAL, finding: { id: 'finding-1', severity: 'blocker', category: 'correctness', title: 'Timer survives a manual reconnect', summary: 'x.' } } as typeof PROPOSAL,
      { ...PROPOSAL, id: 'review-comment-nit', threadId: 'review-comment-nit',
        finding: { id: 'finding-nit', severity: 'nit', category: 'style', title: 'README example uses the old option name', summary: 'y.' } } as typeof PROPOSAL,
    ] };
    const detail = await mountControl('merge-request', {
      input: { ...INPUT, admittedReview: { reviewId: 'selected-review', roundOrdinal: 1 } },
      withWalkthrough: true,
      proposals: THREE_WITH_WALKTHROUGH,
      panelActions,
    });
    const finding = (proposalId: string) => commands().find((row) =>
      row.operation.kind === 'setPublicationFindingIncluded' && row.operation.proposalId === proposalId);
    expect(finding(PROPOSAL.id)?.operation).toMatchObject({ included: false });
    expect(finding('review-comment-nit')?.operation).toMatchObject({ included: true });
    // The command leaves the blocker out of the draft the person sees, and the Publish count follows.
    await act(async () => { expect(await panelActions.execute(finding(PROPOSAL.id)!.operation)).toEqual({ status: 'applied' }); });
    await expect(detail.getByRole('checkbox', { name: 'Timer survives a manual reconnect' })).resolves.toMatchObject({ state: { checked: false } });
    expect(finding(PROPOSAL.id)?.operation).toMatchObject({ included: true });
    // The person's press changes the same draft the commands read.
    await act(async () => detail.press(await detail.getByRole('checkbox', { name: 'README example uses the old option name' })));
    expect(finding('review-comment-nit')?.operation).toMatchObject({ included: false });
    expect(detail.controls.presentation('Publish 1 comment')).toBeDefined();
    // The walkthrough switch has its command too, once a verdict carries a summary to fold it under.
    await act(async () => detail.press(await detail.getByRole('radio', { name: 'Comment' })));
    const walkthrough = () => commands().find((row) => row.operation.kind === 'setPublicationWalkthroughIncluded');
    await vi.waitFor(() => expect(walkthrough()?.operation).toMatchObject({ included: false }));
    await act(async () => { expect(await panelActions.execute(walkthrough()!.operation)).toEqual({ status: 'applied' }); });
    await expect(detail.getByRole('switch', { name: 'Include the walkthrough' })).resolves.toMatchObject({ state: { checked: false } });
  });

  it('reports a declined host confirmation as canceled with no provider completion', async () => {
    nextError = new PluginError({
      code: 'plugin_action_current_intent_rejected',
      message: 'The current confirmation intent was declined.',
    });
    const detail = await mountControl('merge-request');
    await act(async () => detail.controls.press('Publish 1 comment'));
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
    await act(async () => detail.controls.press('Publish 1 comment'));
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
    await act(async () => detail.controls.press('Publish 1 comment'));

    expect(recorded).toHaveLength(1);
    await expect(detail.getByText(
      'Happier left 2 existing draft(s) pending and published nothing. Continue only if you want to publish this Happier review without those drafts.',
    )).resolves.toBeDefined();

    nextResult = SETTLED;
    await act(async () => detail.controls.press('Continue without publishing existing drafts'));
    expect(recorded).toHaveLength(2);
    expect(recorded.at(-1)).toMatchObject({
      input: { acknowledgedPreexistingDraftIds: ['draft-9', 'draft-10'] },
    });
  });

  it('binds a reply to the exact review-thread subtarget before dispatch', async () => {
    const detail = await mountControl('thread-reply');
    await act(async () => detail.press(await detail.getByRole('radio', { name: PROPOSAL.body })));
    await act(async () => detail.controls.press('Publish reply'));
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
    await act(async () => detail.controls.press('Publish comment'));
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
    await act(async () => detail.controls.press('Publish 1 comment'));
    await expect(detail.getByText('Publication outcome unknown')).resolves.toBeDefined();
    await expect(detail.getByText(
      '0/1 comments published; 1 unconfirmed; 0 failed; 0 not attempted. Verdict: notRequested.',
    )).resolves.toBeDefined();
  });
});
