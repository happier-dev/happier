// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { renderSurface as renderGithub } from '../../../scm-github/src/ui/renderSurface.js';
import { renderSurface as renderBitbucket } from '../../../scm-bitbucket/src/ui/renderSurface.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 } from '../../../scm-github/src/triage/contribution.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS } from '../../../scm-bitbucket/src/triage/source/detailContracts.js';
import { createTriageMountedUiActionHandler } from '../actions/mountedUi.js';
import { TriageMountedUiInputV1Schema } from '../actions/mountedUiProtocol.js';
import { SourcePanelActionsFixture, invokeSourcePanelFixtureAction } from './sourcePanelActions.test-support.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const page of mounted.splice(0)) await page.dispose(); });

async function mountFiles(source: 'github' | 'bitbucket') {
  const scope = createTriageEphemeralSharedScopeFixture();
  const fixture = createTriageSourceV1Fixture();
  const input = { ...fixture.detailInput, panel: 'files',
    observation: { ...fixture.detailInput.observation, entryRef: { ...fixture.detailInput.observation.entryRef, kindId: 'pull-request' },
      locator: { v: 1, routingToken: 'octo-org/example-app', displayPath: 'octo-org/example-app#1' } } };
  let reads = 0;
  let diffs = 0;
  let page!: PluginUiTestkit;
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: `files-${source}`, mountNonce: 'files' },
      authorPlugin: { id: 'happier.triage', version: '0.0.0' },
      surface: defineUiSurface((context) => <SourcePanelActionsFixture scope={scope}>
        {(source === 'github' ? renderGithub : renderBitbucket)({ ...context, launchInput: input as unknown as JsonValue })}
      </SourcePanelActionsFixture>), surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(source === 'github' ? { changedFilesReview: true } : {}),
      handlers: { executeAction: async ({ action, input: request, signal }) => {
        const localId = typeof action === 'string' ? action : action.localId;
        if (localId.startsWith('ui/')) return await invokeSourcePanelFixtureAction(scope, localId, request, page.context, signal);
        if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles && 'filePath' in (request as Record<string, unknown>)) {
          diffs += 1;
          return { kind: 'changedFiles', rows: [{ path: 'src/one.ts', status: 'modified', additions: 1, deletions: 1, changes: 2,
            diffAvailable: true, evidence: { state: 'available', patch: '@@ -1 +1 @@\n-old\n+new' } }], omittedRowCount: 0, projectionTruncated: false };
        }
        if (localId === GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1.listChangedFiles || localId === BITBUCKET_TRIAGE_DETAIL_ACTION_IDS.readDiff) {
          reads += 1;
          const continuation = (request as { continuation?: string }).continuation;
          const path = continuation === undefined ? 'src/one.ts' : 'src/two.ts';
          return source === 'github' ? { kind: 'changedFiles', rows: [{ path, status: 'modified', additions: 1, deletions: 1, changes: 2, diffAvailable: true }],
            omittedRowCount: 0, projectionTruncated: false, ...(continuation === undefined ? { continuation: 'second-page' } : {}) }
            : { kind: 'diff', files: [{ path, status: 'modified', linesAdded: 1, linesRemoved: 1 }], omittedRowCount: 0, projectionTruncated: false,
              ...(continuation === undefined ? { continuation: 'second-page', raw: { kind: 'available', text: 'diff --git a/one.ts b/one.ts', truncated: false } } : {}) };
        }
        return { kind: 'unavailable', failure: { class: 'transient', code: 'fixture-not-configured' } };
      } } });
  });
  mounted.push(page);
  const invoke = async (operation: unknown) => createTriageMountedUiActionHandler()(TriageMountedUiInputV1Schema.parse({ mountId: 'source-test', operation }), {
    plugin: { id: 'happier.triage', version: '0.0.0' }, contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
    invocationSurface: 'agent', signal: new AbortController().signal, ui: page.context.hostApi, ephemeralSharedScope: scope,
  });
  return { page, invoke, reads: () => reads, diffs: () => diffs };
}

describe('public mounted source Files intents', () => {
  it('opens and closes a GitHub file in the Files List through the agent Action and the same UI intent', async () => {
    const { page, invoke, reads, diffs } = await mountFiles('github');
    expect(reads()).toBe(1);
    expect(diffs()).toBe(0);
    await act(async () => { expect(await invoke({ kind: 'setSourceItemExpanded', list: 'files', itemId: 'src/one.ts', expanded: true })).toEqual({ status: 'applied' }); });
    await vi.waitFor(() => expect(document.body.textContent).toContain('+new'));
    expect(diffs()).toBe(1);
    // The List row's one disclosure is the same fact for agent and reader, so an agent's close is applied too.
    await act(async () => { expect(await invoke({ kind: 'setSourceItemExpanded', list: 'files', itemId: 'src/one.ts', expanded: false })).toEqual({ status: 'applied' }); });
    expect(await invoke({ kind: 'setSourceItemExpanded', list: 'other', itemId: 'src/one.ts', expanded: true })).toEqual({ status: 'unavailable' });
    expect(await invoke({ kind: 'setSourceItemExpanded', list: 'files', itemId: 'not-loaded.ts', expanded: true })).toEqual({ status: 'unavailable' });
    await act(async () => { await page.press((await page.queryAllByRole('button')).find(button => button.name?.startsWith('src/one.ts'))!); });
    await vi.waitFor(() => expect(diffs()).toBe(2));
    expect(document.body.textContent).toContain('+new');
  });

  it.each(['github', 'bitbucket'] as const)('pages %s Files via agent and UI without a second provider walk', async (source) => {
    const { page, invoke, reads } = await mountFiles(source);
    expect(reads()).toBe(1);
    expect(await invoke({ kind: 'loadMoreSourceItems', list: 'other' })).toEqual({ status: 'unavailable' });
    await act(async () => { expect(await invoke({ kind: 'loadMoreSourceItems', list: 'files' })).toEqual({ status: 'applied' }); });
    expect(reads()).toBe(2);
    expect(document.body.textContent).toContain('two.ts');
    expect(await invoke({ kind: 'loadMoreSourceItems', list: 'files' })).toEqual({ status: 'unavailable' });
    expect(reads()).toBe(2);
    await act(async () => { await page.dispose(); });
    expect(await invoke({ kind: 'loadMoreSourceItems', list: 'files' })).toEqual({ status: 'unavailable' });
    const ui = await mountFiles(source);
    await act(async () => { await ui.page.press(await ui.page.getByRole('button', { name: source === 'github' ? 'Show more files' : 'Show more changed files' })); });
    expect(ui.reads()).toBe(2);
    expect(document.body.textContent).toContain('two.ts');
  });
});
