// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { defineUiSurface, usePluginHostApi } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { createPluginUiTestkit, createSurfaceContextFixture, type PluginUiTestkit } from '@happier-dev/plugin-sdk/testing';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';
import { TriageDetailSurfaceInputV1Schema } from '@happier-dev/triage-protocol/v1';
import { TriageEvidenceDisclosureProvider, TriagePostMutationCompletionProvider, type TriageSourcePanelCommandV1, type TriageSourcePanelOperationV1 } from '@happier-dev/triage-sources/ui';
import { renderSurface as renderGitlab } from '../../../scm-gitlab/src/ui/renderSurface.js';
import { renderSurface as renderBitbucket } from '../../../scm-bitbucket/src/ui/renderSurface.js';
import { renderSurface as renderAzure } from '../../../scm-azure-devops/src/ui/renderSurface.js';
import { renderSurface as renderGithub } from '../../../scm-github/src/ui/renderSurface.js';
import { GITHUB_TRIAGE_DETAIL_ACTION_IDS_V1 as GH } from '../../../scm-github/src/triage/contribution.js';
import { GITLAB_TRIAGE_DETAIL_ACTION_IDS as GL } from '../../../scm-gitlab/src/triage/contribution.js';
import { BITBUCKET_TRIAGE_DETAIL_ACTION_IDS as BB } from '../../../scm-bitbucket/src/triage/source/detailActions.js';
import { AZURE_DEVOPS_TRIAGE_DETAIL_ACTION_IDS as AZ } from '../../../scm-azure-devops/src/triage/detailActions.js';
import { AZURE_THREAD_REPLY_WINDOW_V1, AZURE_THREAD_WINDOW_V1 } from '../../../scm-azure-devops/src/ui/detail/tabDeclarations.js';
import { createTriageMountedUiActionHandler } from '../actions/mountedUi.js';
import { bindTriageMountedUiActions } from './mountedActions.js';
import { useTriageSourcePanelActionsV1 } from './useSourcePanelActions.js';
import { createTriageEphemeralSharedScopeFixture } from './window/ephemeralSharedScope.test-support.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: PluginUiTestkit[] = [];
afterEach(async () => { for (const page of mounted.splice(0)) await act(async () => { await page.dispose(); }); });
const unavailable = { kind: 'unavailable', failure: { class: 'transient', code: 'fixture-unused' } };
const pageResult = (kind: string, rows: JsonValue[], more = false) => ({ kind, rows, omittedRowCount: 0, projectionTruncated: false, ...(more ? { continuation: 'next-page' } : {}) });
const azureIterations = { ...pageResult('iterations', [{ id: 2 }]), currentIterationId: 2 };

async function mountProvider(provider: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops', panel: string,
  read: (id: string, input: Record<string, JsonValue>) => JsonValue, kind?: string) {
  const scope = createTriageEphemeralSharedScopeFixture();
  const base = createTriageSourceV1Fixture().detailInput;
  const pluginId = `happier.scm.forge.${provider}`;
  const source = { pluginId, localId: `${provider}-forge` };
  const input = TriageDetailSurfaceInputV1Schema.parse({ ...base, panel,
    instance: { ...base.instance, instance: { ...base.instance.instance, source } },
    observation: { ...base.observation, entryRef: { ...base.observation.entryRef, source,
      kindId: kind ?? (provider === 'github' ? 'issue' : provider === 'gitlab' ? 'merge-request' : 'pull-request') } } });
  let commands: readonly TriageSourcePanelCommandV1[] = [];
  let page!: PluginUiTestkit;
  const invoke = (operation: TriageSourcePanelOperationV1) => createTriageMountedUiActionHandler()({ mountId: 'scm', operation }, {
    plugin: { id: 'happier.triage', version: '0.0.0' },
    contribution: { id: 'ui/mounted-v1', qualifiedId: 'happier.triage/actions/ui/mounted-v1' },
    invocationSurface: 'agent', signal: new AbortController().signal, ui: page.context.hostApi, ephemeralSharedScope: scope,
  });
  function Surface({ context }: { context: RenderContext }) {
    const hostApi = usePluginHostApi();
    const panelActions = useTriageSourcePanelActionsV1(scope, 'scm', 'entry', true, hostApi);
    commands = panelActions.commands;
    React.useLayoutEffect(() => bindTriageMountedUiActions(scope, 'scm', async () => ({ status: 'unavailable' })), []);
    const render = provider === 'github' ? renderGithub : provider === 'gitlab' ? renderGitlab : provider === 'bitbucket' ? renderBitbucket : renderAzure;
    return <TriageEvidenceDisclosureProvider disclosure={{ available: false, disclose: async () => ({ kind: 'inert' }), panelActions: panelActions.actions }}>
      <TriagePostMutationCompletionProvider onComplete={async () => {}}>{render({ ...context, launchInput: input }) as React.ReactNode}</TriagePostMutationCompletionProvider>
    </TriageEvidenceDisclosureProvider>;
  }
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: 'scm-parity', mountNonce: 'scm-parity' },
      authorPlugin: { id: pluginId, version: '0.0.0' }, surface: defineUiSurface(context => <Surface context={context} />),
      surfaceContext: createSurfaceContextFixture(), launchInput: input, adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: async ({ action, input: request }) => {
        const id = typeof action === 'string' ? action : action.localId;
        if (id === 'ui/mounted-v1') return await invoke((request as { operation: TriageSourcePanelOperationV1 }).operation);
        return read(id, request as Record<string, JsonValue>);
      } },
    });
  });
  mounted.push(page);
  return { page, invoke, commands: () => commands };
}

describe('SCM mounted source controls', () => {
  it('widens the returned Azure thread slice without another provider read', async () => {
    let reads = 0;
    const total = 2 * AZURE_THREAD_WINDOW_V1 + 1;
    const fixture = await mountProvider('azure-devops', 'activity', id => {
      reads += 1;
      if (id === AZ.readIterations) return azureIterations;
      if (id === AZ.listCommits) return pageResult('commits', []);
      if (id === AZ.readThreads) return pageResult('threads', Array.from({ length: total }, (_, n) => ({
        id: String(n), status: 'active', omittedCommentCount: 0, comments: [{ id: String(n), content: `thread-body-${n}` }],
      })));
      return unavailable;
    });
    // The Timeline virtualizes rows; its footer reports the complete visible slice.
    expect(document.body.textContent).toContain(`${AZURE_THREAD_WINDOW_V1} of ${total} thread(s) shown.`);
    const command = fixture.commands().find(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === 'threads');
    expect(command).toBeDefined();
    const before = reads;
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'applied' }); });
    expect(document.body.textContent).toContain(`${2 * AZURE_THREAD_WINDOW_V1} of ${total} thread(s) shown.`);
    const next = fixture.commands().find(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === 'threads');
    expect(next).toBeDefined();
    await act(async () => { await fixture.page.press(await fixture.page.getByRole('button', { name: next!.title })); });
    expect(document.body.textContent).toContain(`${total} of ${total} thread(s) shown.`);
    expect(reads).toBe(before);
    expect(fixture.commands().some(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === 'threads')).toBe(false);
  });
  it.each(['issue', 'pull-request'])('pages GitHub %s comments through the activity command', async kind => {
    let pages = 0;
    const fixture = await mountProvider('github', 'activity', (id, request) => {
      if (id === GH.listTimeline) return pageResult('timeline', []);
      if (id !== GH.readFeedback) return unavailable;
      const connection = String(request.connection);
      if (connection !== 'comments') return pageResult(connection, []);
      pages += 1;
      return { ...pageResult('comments', [{ id: String(pages), body: `github-body-${pages}` }]), ...(pages === 1 ? { previousCursor: 'older-comments' } : {}) };
    }, kind);
    const command = fixture.commands().find(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === 'comments');
    expect(command).toBeDefined();
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'applied' }); });
    expect(pages).toBe(2);
    expect(document.body.textContent).toContain('github-body-2');
  });

  it('pages GitHub nested replies independently of the activity collections', async () => {
    let pages = 0;
    const fixture = await mountProvider('github', 'activity', (id, request) => {
      if (id === GH.listTimeline) return pageResult('timeline', []);
      if (id !== GH.readFeedback) return unavailable;
      if (request.connection === 'threads') return pageResult('threads', [{ id: 'thread-1', isResolved: false, replyCount: 4,
        firstReply: { id: 'root', body: 'Root remark' }, replies: [{ id: 'root', body: 'Root remark' }], previousRepliesCursor: 'reply-page-1' }]);
      if (request.connection !== 'threadReplies') return pageResult(String(request.connection), []);
      pages += 1;
      return { ...pageResult('threadReplies', [{ id: `reply-${pages}`, body: `nested-body-${pages}` }]), threadId: 'thread-1', ...(pages < 3 ? { previousCursor: `reply-page-${pages + 1}` } : {}) };
    }, 'pull-request');
    expect(pages).toBe(1);
    const command = fixture.commands().find(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === 'thread-replies:thread-1');
    expect(command).toBeDefined();
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'applied' }); });
    expect(pages).toBe(2);
    expect(document.body.textContent).toContain('nested-body-2');
    await act(async () => { await fixture.page.press(await fixture.page.getByRole('button', { name: command!.title })); });
    expect(pages).toBe(3);
    expect(fixture.commands().some(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === 'thread-replies:thread-1')).toBe(false);
  });
  it.each([
    ['github', 'timeline', GH.listTimeline],
    ['gitlab', 'notes', GL.listNotes],
    ['bitbucket', 'comments', BB.listComments],
    ['azure-devops', 'commits', AZ.listCommits],
  ] as const)('pages the %s activity stream through its published continuation', async (provider, list, actionId) => {
    let pages = 0;
    const fixture = await mountProvider(provider, 'activity', (id, request) => {
      if (id === AZ.readIterations) return azureIterations;
      if (id === actionId) {
        pages += 1;
        const second = request.continuation !== undefined;
        if (list === 'timeline') return pageResult('timeline', [{ id: String(pages), kind: 'closed', rawKind: 'closed', summary: `page-body-${pages}` }], !second);
        if (list === 'notes') return pageResult('notes', [{ id: String(pages), body: `page-body-${pages}`, system: false }], !second);
        if (list === 'comments') return pageResult('comments', [{ id: String(pages), body: `page-body-${pages}`, deleted: false, resolution: 'unknown' }], !second);
        return { ...pageResult('commits', [{ commitId: `commit${pages}`, comment: `page-body-${pages}` }]), ...(pages === 1 ? { continuationToken: 'older-commits' } : {}) };
      }
      if (id === GL.listDiscussions) return pageResult('discussions', []);
      if (id === BB.listActivity) return pageResult('activity', []);
      if (id === AZ.readThreads) return pageResult('threads', []);
      return unavailable;
    });
    const command = fixture.commands().find(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === list);
    expect(command).toBeDefined();
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'applied' }); });
    expect(pages).toBe(2);
    expect(document.body.textContent).toContain('page-body-2');
    expect(fixture.commands().some(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === list)).toBe(false);
  });
  it.each([
    ['gitlab', 'files', 'files', GL.listChanges],
    ['gitlab', 'checks', 'pipelines', GL.listPipelines],
    ['bitbucket', 'checks', 'builds', BB.listBuilds],
    ['azure-devops', 'files', 'files', AZ.listIterationChanges],
  ] as const)('pages %s %s through the published command and the visible control', async (provider, panel, list, actionId) => {
    const positions: unknown[] = [];
    const fixture = await mountProvider(provider, panel, (id, request) => {
      if (id === AZ.readIterations) return azureIterations;
      if (id !== actionId) return unavailable;
      positions.push(request.continuation ?? request.skip ?? null);
      const n = positions.length;
      if (provider === 'azure-devops') return { ...pageResult('iterationChanges', [{ path: `/file-${n}.ts`, changeType: 'edit', isFolder: false }]), iterationId: 2, ...(n < 3 ? { nextSkip: n * 30, nextTop: 30 } : {}) };
      const continuation = n < 3 ? { continuation: `next-page-${n}` } : {};
      if (list === 'files') return { ...pageResult('changes', [{ path: `file-${n}.ts`, newFile: false, renamedFile: false, deletedFile: false, collapsed: false, tooLarge: false }]), diffLimitStatus: 'reported', ...continuation };
      return { ...pageResult(list, provider === 'gitlab' ? [{ id: String(n), status: 'success', ref: `pipeline-${n}` }] : [{ key: String(n), name: `build-${n}`, state: 'SUCCESSFUL' }]), ...continuation };
    });
    expect(positions).toHaveLength(1);
    const command = fixture.commands().find(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === list);
    expect(command).toBeDefined();
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'applied' }); });
    expect(positions).toHaveLength(2);
    await act(async () => { await fixture.page.press(await fixture.page.getByRole('button', { name: command!.title })); });
    expect(positions).toHaveLength(3);
    expect(fixture.commands().some(row => row.operation.kind === 'loadMoreSourceItems' && row.operation.list === list)).toBe(false);
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'unavailable' }); });
    expect(positions).toHaveLength(3);
  });

  it.each(['gitlab', 'bitbucket', 'azure-devops'] as const)('reveals %s returned replies without a provider read', async provider => {
    let reads = 0;
    const fixture = await mountProvider(provider, 'activity', id => {
      reads += 1;
      if (id === AZ.readIterations) return azureIterations;
      if (id === GL.listNotes) return pageResult('notes', []);
      if (id === GL.listActivityEvents) return { ...pageResult('activityEvents', []), source: 'state' };
      if (id === GL.listDiscussions) return pageResult('discussions', [{ id: 'thread-1', individualNote: false, resolved: false, omittedNoteCount: 0,
        notes: Array.from({ length: 10 }, (_, n) => ({ id: String(n), body: `reply-body-${n}`, system: false, author: 'Reviewer' })) }]);
      if (id === BB.listActivity) return pageResult('activity', []);
      if (id === BB.listComments) return pageResult('comments', Array.from({ length: 4 }, (_, n) => ({ id: String(n), body: `reply-body-${n}`, deleted: false, resolution: 'unknown', ...(n === 0 ? {} : { parentId: '0' }) })));
      if (id === AZ.listCommits) return pageResult('commits', []);
      if (id === AZ.readThreads) return pageResult('threads', [{ id: 'thread-1', status: 'active', omittedCommentCount: 0,
        comments: Array.from({ length: 3 * AZURE_THREAD_REPLY_WINDOW_V1 }, (_, n) => ({ id: String(n), content: `reply-body-${n}`, author: 'Reviewer' })) }]);
      return unavailable;
    });
    const command = fixture.commands().find(row => row.operation.kind === 'setSourceItemExpanded');
    expect(command).toBeDefined();
    const before = reads;
    const bodyBefore = document.body.textContent;
    await act(async () => { expect(await fixture.invoke(command!.operation)).toEqual({ status: 'applied' }); });
    expect(document.body.textContent).not.toBe(bodyBefore);
    expect(reads).toBe(before);
    if (provider !== 'bitbucket') {
      const next = fixture.commands().find(row => row.operation.kind === 'setSourceItemExpanded');
      expect(next).toBeDefined();
      await act(async () => { await fixture.page.press(await fixture.page.getByRole('button', { name: next!.title })); });
      expect(reads).toBe(before);
    }
    expect(fixture.commands().filter(row => row.operation.kind === 'setSourceItemExpanded')).toEqual([]);
    expect(document.body.textContent).toContain('reply-body-0');
  });
});
