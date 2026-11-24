// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defineUiSurface,
  Tabs,
  usePluginHostApi,
} from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import {
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
const source = {
  pluginId: 'happier.scm.forge.gitlab',
  localId: 'gitlab-forge',
};
const input = TriageDetailSurfaceInputV1Schema.parse({
  ...base,
  panel: 'reviews',
  admittedReview: { reviewId: 'admitted-review', roundOrdinal: 1 },
  instance: {
    ...base.instance,
    instance: { ...base.instance.instance, source },
  },
  observation: {
    ...base.observation,
    entryRef: { ...base.observation.entryRef, source, kindId: 'merge-request' },
  },
});

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

const PROPOSALS = {
  status: 'ready' as const,
  proposals: [
    proposal('c1', 'blocker', 'Timer survives a manual reconnect'),
    proposal('c2', 'nit', 'README example uses the old option name'),
  ],
};

/** The Publish sheet in the Triage detail's Reviews panel, with the real panel registry and mounted Action. */
async function mountPublishSheet() {
  const scope = createTriageEphemeralSharedScopeFixture();
  let commands: readonly TriageSourcePanelCommandV1[] = [];
  let page!: PluginUiTestkit;
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
              <GitlabMergeRequestPublicationControls
                input={input}
                proposals={PROPOSALS}
              />
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
  return { page, invoke, commands: () => commands };
}

describe('the Publish sheet draft as agent Actions', () => {
  it('runs each draft command through the mounted Action and changes the draft the person sees', async () => {
    const sheet = await mountPublishSheet();
    const checkbox = (name: string) =>
      sheet.page.getByRole('checkbox', { name });
    await vi.waitFor(async () =>
      expect(await checkbox('Timer survives a manual reconnect')).toMatchObject(
        { state: { checked: true } },
      ),
    );
    const finding = (proposalId: string) =>
      sheet
        .commands()
        .find(
          (row) =>
            row.operation.kind === 'setPublicationFindingIncluded' &&
            row.operation.proposalId === proposalId,
        );
    expect(finding('c1')?.operation).toMatchObject({ included: false });
    expect(finding('c2')?.operation).toMatchObject({ included: true });

    await act(async () => {
      expect(await sheet.invoke(finding('c1')!.operation)).toEqual({
        status: 'applied',
      });
    });
    await expect(
      checkbox('Timer survives a manual reconnect'),
    ).resolves.toMatchObject({ state: { checked: false } });
    await act(async () => {
      expect(await sheet.invoke(finding('c2')!.operation)).toEqual({
        status: 'applied',
      });
    });
    await expect(
      checkbox('README example uses the old option name'),
    ).resolves.toMatchObject({ state: { checked: true } });
    expect(finding('c1')?.operation).toMatchObject({ included: true });
    expect(finding('c2')?.operation).toMatchObject({ included: false });

    // Once a verdict carries a summary, the walkthrough fold has its command too, through the same Action.
    await act(async () => { await sheet.page.press(await sheet.page.getByRole('radio', { name: 'Comment' })); });
    const walkthrough = () => sheet.commands().find((row) => row.operation.kind === 'setPublicationWalkthroughIncluded');
    await vi.waitFor(() => expect(walkthrough()?.operation).toMatchObject({ included: false }));
    await act(async () => { expect(await sheet.invoke(walkthrough()!.operation)).toEqual({ status: 'applied' }); });
    await expect(sheet.page.getByRole('switch', { name: 'Include the walkthrough' }))
      .resolves.toMatchObject({ state: { checked: false } });
    expect(walkthrough()?.operation).toMatchObject({ included: true });
  });
});
