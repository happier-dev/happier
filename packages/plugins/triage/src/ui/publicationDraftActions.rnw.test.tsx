// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineUiSurface,
  Tabs,
  usePluginHostApi,
  useReviewCommentProposalsForEntry,
} from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
  createPluginUiActionControlTestHost,
  createPluginUiTestkit,
  createSurfaceContextFixture,
  type PluginUiTestkit,
} from '@happier-dev/plugin-sdk/testing';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import {
  TriageEvidenceDisclosureProvider,
  TriagePostMutationCompletionProvider,
  type TriageSourcePanelCommandV1,
  type TriageSourcePanelOperationV1,
} from '@happier-dev/triage-sources/ui';
import { AzureReviewPublicationControls } from '../../../scm-azure-devops/src/ui/detail/reviewPublication.js';
import { projectBitbucketDetailOverview } from '../../../scm-bitbucket/src/triage/source/detail.js';
import { BitbucketMutationControls } from '../../../scm-bitbucket/src/ui/detail/mutations.js';
import { PullRequestReviewPublicationWrite } from '../../../scm-github/src/ui/detail/reviewPublicationControls.js';
import { GitlabMergeRequestPublicationControls } from '../../../scm-gitlab/src/ui/detail/reviewPublicationControls.js';
import { createTriageMountedUiActionHandler } from '../actions/mountedUi.js';
import { bindTriageMountedUiActions } from './mountedActions.js';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: PluginUiTestkit[] = [];
afterEach(async () => {
  for (const page of mounted.splice(0))
    await act(async () => {
      await page.dispose();
    });
});

const base = createTriageSourceV1Fixture().detailInput;
const revision = base.observation.snapshot.reviewRevision!;

function proposal(id: string, severity: 'blocker' | 'nit', title: string) {
  return {
    id,
    body: `${title}.`,
    serverRevision: 3,
    anchor: { kind: 'line', filePath: 'src/retry.ts', line: 12, side: 'after' },
    snapshot: {
      kind: 'text',
      selectedLines: ['return ready;'],
      beforeContext: [],
      afterContext: [],
      selectedLinesHash: 'selected-hash',
      contextWindowHash: 'context-hash',
      capturedAt: 1,
      fileLength: 20,
      source: 'committed',
      commitSha: revision.headSha,
      isUncommitted: false,
      isUntracked: false,
      truncated: false,
      hasBidiControls: false,
      likelyMinified: false,
      diffContext: {
        side: 'after',
        baseSha: revision.baseSha,
        headSha: revision.headSha,
      },
    },
    linkedRefs: [{ kind: 'pullRequest', url: base.observation.locator.webUrl }],
    finding: {
      id: `finding-${id}`,
      severity,
      category: 'correctness',
      title,
      summary: `${title}.`,
    },
  } as unknown as React.ComponentProps<
    typeof GitlabMergeRequestPublicationControls
  >['proposals']['proposals'][number];
}

const PROPOSALS = [
  proposal('c1', 'blocker', 'Timer survives a manual reconnect'),
  proposal('c2', 'nit', 'README example uses the old option name'),
];
type Forge = 'gitlab' | 'github' | 'bitbucket' | 'azure-devops';

/** The Publish sheet in the Triage detail's Reviews panel, with the real panel registry and mounted Action. */
async function mountPublishSheet(forge: Forge, emptyFirstPage = false) {
  const source = { pluginId: `happier.scm.forge.${forge}`, localId: `${forge}-forge` };
  const input = TriageDetailSurfaceInputV1Schema.parse({
    ...base,
    panel: 'reviews',
    admittedReview: { reviewId: 'admitted-review', roundOrdinal: 1 },
    instance: { ...base.instance, instance: { ...base.instance.instance, source } },
    observation: {
      ...base.observation,
      entryRef: { ...base.observation.entryRef, source, kindId: forge === 'gitlab' ? 'merge-request' : 'pull-request' },
    },
  });
  const scope = createTriageEphemeralSharedScopeFixture();
  let commands: readonly TriageSourcePanelCommandV1[] = [];
  let page!: PluginUiTestkit;
  const proposalRequests: unknown[] = [];
  const publishedInputs: unknown[] = [];
  const actionControls = createPluginUiActionControlTestHost(async ({ input: prepared }) => {
    publishedInputs.push(prepared);
    return { ok: true, result: { kind: 'rejected', reason: 'provider-rejected' } };
  });
  const sheet = forge === 'gitlab' || forge === 'github';

  function SheetPublication() {
    const [open, setOpen] = React.useState(true);
    const proposals = useReviewCommentProposalsForEntry({
      reviewId: input.admittedReview?.reviewId,
      linkedSessionIds: input.linkedSessions.map(session => session.sessionId),
      entry: { kind: 'pullRequest', url: input.observation.locator.webUrl },
    });
    return forge === 'gitlab'
      ? <GitlabMergeRequestPublicationControls input={input} proposals={proposals} open={open} onOpenChange={setOpen} />
      : <PullRequestReviewPublicationWrite
          input={input} publicationProposals={proposals} open={open} onOpenChange={setOpen}
          WriteControl={() => null} onObserved={() => {}} capabilities={{ kind: 'loading' }}
        />;
  }
  // What an agent's current-context command runs: the declared mounted Action, parsing its declared input.
  const invoke = (operation: TriageSourcePanelOperationV1) =>
    createTriageMountedUiActionHandler()(
      { mountId: 'detail', operation },
      {
        plugin: { id: 'happier.triage', version: '0.0.0' },
        contribution: {
          id: 'ui/mounted-v1',
          qualifiedId: 'happier.triage/actions/ui/mounted-v1',
        },
        invocationSurface: 'agent',
        signal: new AbortController().signal,
        ui: page.context.hostApi,
        ephemeralSharedScope: scope,
      },
    );
  function Surface() {
    const hostApi = usePluginHostApi();
    const panelActions = useTriageSourcePanelActionsV1(
      scope,
      'detail',
      'entry',
      true,
      hostApi,
    );
    commands = panelActions.commands;
    React.useLayoutEffect(
      () =>
        bindTriageMountedUiActions(scope, 'detail', async () => ({
          status: 'unavailable',
        })),
      [],
    );
    return (
      <TriageEvidenceDisclosureProvider
        disclosure={{
          available: false,
          disclose: async () => ({ kind: 'inert' }),
          panelActions: panelActions.actions,
        }}
      >
        <TriagePostMutationCompletionProvider onComplete={async () => {}}>
          <Tabs
            value="reviews"
            onValueChange={() => {}}
            ariaLabel="Merge request"
          >
            <Tabs.Item value="reviews" title="Reviews">
              {sheet ? <SheetPublication /> : forge === 'bitbucket' ? <BitbucketMutationControls
                input={input} overview={{
                  ...projectBitbucketDetailOverview(input), state: { presentation: 'active', nativeLabel: null },
                }}
              /> : <AzureReviewPublicationControls input={input} />}
            </Tabs.Item>
          </Tabs>
        </TriagePostMutationCompletionProvider>
      </TriageEvidenceDisclosureProvider>
    );
  }
  await act(async () => {
    page = await createPluginUiTestkit({
      identity: { instanceId: 'publish-draft', mountNonce: 'publish-draft' },
      authorPlugin: { id: source.pluginId, version: '0.0.0' },
      surface: defineUiSurface(() => <Surface />),
      surfaceContext: createSurfaceContextFixture(),
      launchInput: input,
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: {
        actionControl: actionControls.handler,
        // The admitted round's saved Walkthrough, as the Review Resource carries it.
        readResource: async () => ({
          contentType: 'application/json',
          digest: `sha256:${'1'.repeat(64)}`,
          bytes: new TextEncoder().encode(JSON.stringify({ roundWalkthrough: { roundOrdinal: 1, stops: [
            { title: 'Retry ownership', explanationMarkdown: 'The new scheduler owns retries.' },
          ] } })),
        }),
        executeAction: async ({ action, input: request }) => {
          const id = typeof action === 'string' ? action : action.localId;
          if (id === 'reviews.comments.list') {
            const query = request as { reviewId: string; cursor?: string };
            proposalRequests.push(query);
            if (emptyFirstPage && query.cursor === undefined) return {
              items: [{ ...PROPOSALS[0], linkedRefs: [{ kind: 'pullRequest', url: 'https://example.test/another/pr' }] }],
              cursor: 'next',
            };
            return { items: PROPOSALS, cursor: null };
          }
          if (id === 'ui/mounted-v1')
            return await invoke(
              (request as { operation: TriageSourcePanelOperationV1 })
                .operation,
            );
          return {
            kind: 'unavailable',
            failure: { class: 'transient', code: 'fixture-unused' },
          };
        },
      },
    });
  });
  mounted.push(page);
  return { page, invoke, sheet, proposalRequests, actionControls, publishedInputs, commands: () => commands };
}

describe('the Publish sheet draft as agent Actions', () => {
  it.each([
    ['gitlab', 'Summary'],
    ['github', 'Summary'],
    ['bitbucket', 'Review summary'],
    ['azure-devops', 'Review summary'],
  ] as const)('edits the same mounted publication draft on %s', async (forge, summaryLabel) => {
    const sheet = await mountPublishSheet(forge);
    const finding = (proposalId: string) =>
      sheet
        .commands()
        .find(
          (row) =>
            row.operation.kind === 'setPublicationFindingIncluded' &&
            row.operation.proposalId === proposalId,
        );
    await vi.waitFor(() => expect(finding('c1')?.operation).toMatchObject({ included: false }));
    expect(sheet.proposalRequests).toEqual([expect.objectContaining({ reviewId: 'admitted-review' })]);
    expect(sheet.proposalRequests[0]).not.toHaveProperty('sessionId');
    expect(finding('c2')?.operation).toMatchObject({ included: true });

    await act(async () => {
      expect(await sheet.invoke(finding('c1')!.operation)).toEqual({
        status: 'applied',
      });
    });
    await act(async () => {
      expect(await sheet.invoke(finding('c2')!.operation)).toEqual({
        status: 'applied',
      });
    });
    expect(finding('c1')?.operation).toMatchObject({ included: true });
    expect(finding('c2')?.operation).toMatchObject({ included: false });
    if (sheet.sheet) {
      await expect(sheet.page.getByRole('checkbox', { name: 'Timer survives a manual reconnect' }))
        .resolves.toMatchObject({ state: { checked: false } });
      await expect(sheet.page.getByRole('checkbox', { name: 'README example uses the old option name' }))
        .resolves.toMatchObject({ state: { checked: true } });
    }

    // Once a verdict carries a summary, the walkthrough fold has its command too, through the same Action.
    await changeVerdictAndSummary(sheet, summaryLabel);
    const walkthrough = () => sheet.commands().find((row) => row.operation.kind === 'setPublicationWalkthroughIncluded');
    await vi.waitFor(() => expect(walkthrough()?.operation).toMatchObject({ included: false }));
    const submit = async () => {
      await act(async () => { await sheet.actionControls.press('Submit review'); });
      const payload = sheet.publishedInputs.at(-1);
      expect(payload).toMatchObject({
        publicationPlan: { entries: [{ happierCommentId: 'c2' }], verdict: { kind: 'comment' } },
      });
      return (payload as { publicationPlan: { verdict: { body: string } } }).publicationPlan.verdict.body;
    };
    if (!sheet.sheet) {
      await act(async () => {
        expect(await sheet.invoke({ kind: 'setPublicationSummary', summary: 'A verdict with evidence.' }))
          .toEqual({ status: 'applied' });
      });
      expect(await submit()).toContain('Retry ownership');
    }
    await act(async () => { expect(await sheet.invoke(walkthrough()!.operation)).toEqual({ status: 'applied' }); });
    if (!sheet.sheet) {
      expect(await submit()).not.toContain('Retry ownership');
      expect(sheet.publishedInputs).toHaveLength(2);
    }
    await expect(sheet.page.getByRole('switch', { name: 'Include the walkthrough' }))
      .resolves.toMatchObject({ state: { checked: false } });
    expect(walkthrough()?.operation).toMatchObject({ included: true });
    expect(sheet.proposalRequests).toHaveLength(1);
    if (sheet.sheet) {
      await act(async () => { await sheet.page.press(await sheet.page.getByRole('button', { name: 'Cancel' })); });
      expect(sheet.commands()).toEqual([]);
      await expect(sheet.invoke({ kind: 'setPublicationSummary', summary: 'After closing' }))
        .resolves.toEqual({ status: 'unavailable' });
    }
  });

  it.each([
    ['gitlab', 'Read more'],
    ['github', 'Load more comments'],
    ['bitbucket', 'Read more'],
    ['azure-devops', 'Read more'],
  ] as const)('continues past an empty matching proposals page on %s', async (forge, label) => {
    const draft = await mountPublishSheet(forge, true);
    await vi.waitFor(() => expect(draft.proposalRequests).toHaveLength(1));
    const more = await draft.page.getByRole('button', { name: label });
    expect(draft.commands().some(row => row.operation.kind === 'setPublicationFindingIncluded')).toBe(false);
    await act(async () => { await draft.page.press(more); });
    await vi.waitFor(() => expect(draft.commands().some(row => row.operation.kind === 'setPublicationFindingIncluded')).toBe(true));
    expect(draft.proposalRequests).toEqual([
      expect.objectContaining({ reviewId: 'admitted-review' }),
      expect.objectContaining({ reviewId: 'admitted-review', cursor: 'next' }),
    ]);
  });

  it.each([
    ['github', 'Summary', false],
    ['bitbucket', 'Review summary', false],
    ['azure-devops', 'Review summary', true],
  ] as const)('edits the visible verdict and summary on %s', async (forge, summaryLabel, offersNoVerdict) => {
    const sheet = await mountPublishSheet(forge);
    await changeVerdictAndSummary(sheet, summaryLabel);
    await act(async () => {
      expect(await sheet.invoke({ kind: 'setPublicationVerdict', verdict: 'requestChanges' })).toEqual({ status: 'applied' });
      expect(await sheet.invoke({ kind: 'setPublicationVerdict', verdict: 'none' }))
        .toEqual({ status: offersNoVerdict ? 'applied' : 'rejected' });
    });
    await expect(sheet.page.getByRole('radio', { name: offersNoVerdict ? 'No verdict' : 'Request changes' }))
      .resolves.toMatchObject({ state: { checked: true } });
  });
});

async function changeVerdictAndSummary(sheet: Awaited<ReturnType<typeof mountPublishSheet>>, summaryLabel: string) {
  const operation = { kind: 'setPublicationVerdict', verdict: 'approve' } as const;
  expect(sheet.commands().map((row) => row.operation)).toContainEqual(operation);
  await act(async () => {
    expect(await sheet.invoke(operation)).toEqual({ status: 'applied' });
  });
  await expect(sheet.page.getByRole('radio', { name: 'Approve' }))
    .resolves.toMatchObject({ state: { checked: true } });

  const summary = summaryLabel === 'Summary'
    ? '**Retry ownership**\n\nThe scheduler now owns retries.'
    : '**Retry ownership** belongs to the scheduler.';
  await act(async () => {
    expect(await sheet.invoke({ kind: 'setPublicationSummary', summary: 'Draft to replace' })).toEqual({ status: 'applied' });
    expect(await sheet.invoke({ kind: 'setPublicationSummary', summary })).toEqual({ status: 'applied' });
  });
  await expect(sheet.page.getByRole('textbox', { name: summaryLabel })).resolves.toMatchObject({ value: summary });
  const clear = { kind: 'setPublicationSummary', summary: '' } as const;
  expect(sheet.commands().map((row) => row.operation)).toContainEqual(clear);
  await act(async () => {
    expect(await sheet.invoke(clear)).toEqual({ status: 'applied' });
    expect(await sheet.invoke({ kind: 'setPublicationVerdict', verdict: 'comment' })).toEqual({ status: 'applied' });
  });
  await expect(sheet.page.getByRole('textbox', { name: summaryLabel })).resolves.toMatchObject({ value: '' });
  await expect(sheet.page.getByRole('radio', { name: 'Comment' }))
    .resolves.toMatchObject({ state: { checked: true } });
}
