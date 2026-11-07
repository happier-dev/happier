// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { TriageMountedUiInputV1Schema } from './mountedUiProtocol.js';
import { createPluginClientTestkit, createPluginUiTestkit, createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import type { PluginClientTestkit } from '@happier-dev/plugin-sdk/testing';
import { defineUiSurface } from '@happier-dev/plugin-ui';
import { createPluginUiRnwSemanticSurfaceAdapter } from '@happier-dev/plugin-ui/testing';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { activate } from './mountedUi.js';
import { TriageTaskDraftLaunchV1Schema } from './tasksProtocol.js';
import { PluginUiOpenSurfaceRequestV1Schema } from '@happier-dev/protocol/plugins/ui';
import { MessageActionAvailableSnapshotV1Schema } from '@happier-dev/protocol';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { createTriageEphemeralSharedScopeOriginFixture } from '../ui/window/ephemeralSharedScope.test-support.js';
import { readTriageTaskDraftLaunch } from '../ui/taskDraftHandoff.js';
import { renderSurface as renderTasksSurface } from '../ui/tasksSurface.js';
import { createTestkitCorpusCollections } from '../corpus/testkit/corpusCollections.test-support.js';
import { listTriageEntries } from './listEntries.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1, TriageListEntriesInputV1Schema } from './listEntriesProtocol.js';
import { listTriagePinnedEntries } from './userMarks.js';
import { TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1, TriageListPinnedEntriesInputV1Schema } from './userMarksProtocol.js';
import { readTriageSavedViewsForSurface } from './savedViews.js';
import { TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1, TriageReadSavedViewsInputV1Schema } from './savedViewsProtocol.js';
import { readTriageActionsForSurface } from './actionsCatalog.js';
import { TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1, TriageReadActionsInputV1Schema } from './actionsCatalogProtocol.js';
import { createTestkitAccountKv } from '../settings/testkit/accountKv.test-support.js';
import { TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1 } from '../settings/actions.js';
import { TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1 } from '../settings/savedViews.js';

/** The New task draft's first line (lab `tasks-create`). */
const DRAFT_PURPOSE = 'Where does it belong? It\u2019s created there and stays there.';

const clients: PluginClientTestkit[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.dispose(); });

async function registeredDraftAction() {
  const declaration = PLUGIN_MANIFEST.contributes.actions.find((action) => action.id === 'tasks/open-create-v1');
  if (declaration?.execution.target !== 'client') throw new Error('Missing Tasks draft Action');
  const target = { ...declaration.execution.client, platform: 'web' as const };
  const client = await createPluginClientTestkit({ manifest: PLUGIN_MANIFEST, target, activate });
  clients.push(client);
  const handler = client.registration('actions', declaration.id);
  if (!handler) throw new Error('Tasks draft Action was not registered');
  return { declaration, handler };
}

it('opens its reviewable draft directly without a second host input form', async () => {
  const { declaration } = await registeredDraftAction();
  expect(normalizePluginActionInputHintsV2(declaration.inputHints, declaration.inputSchema)?.fields).toEqual([]);
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each([
  { name: 'explicit draft', fromMessage: false, input: { title: 'Fix reconnect handling', body: 'Explicit body' }, expected: { title: 'Fix reconnect handling', body: 'Explicit body' } },
  { name: 'selected message', fromMessage: true, input: {}, expected: { title: 'Selected answer' } },
  { name: 'paragraph message', fromMessage: true, input: {},
    selectedText: 'Read-only inspection complete. The investigation found several follow-up items that belong in their own task.\n\n- Check the affected flow\n- Retain the original evidence',
    expected: { title: 'Read-only inspection complete.' } },
  { name: 'leading empty lines and a question', fromMessage: true, input: {},
    selectedText: '\n\r\n  Can the Session reconnect? Keep all of this context available.\nMore evidence follows.',
    expected: { title: 'Can the Session reconnect?' } },
  { name: 'non-Latin sentence boundary', fromMessage: true, input: {},
    selectedText: '接続を修正する。元の説明を保持する。', expected: { title: '接続を修正する。' } },
  { name: 'blank message', fromMessage: true, input: {}, selectedText: '\n  \r\n', noProposedTitle: true, expected: {} },
  { name: 'explicit draft with a selected message', fromMessage: true, input: { title: 'Keep title', body: 'Explicit body' }, expected: { title: 'Keep title', body: 'Explicit body' } },
  { name: 'explicit empty title', fromMessage: true, input: { title: '' }, expected: { title: '' } },
  { name: 'explicit empty body', fromMessage: true, input: { body: '' }, expected: { title: 'Selected answer', body: '' } },
  ...[1_000, 9_000, 32_768].map((size) => ({ name: `selected ${size}-byte message`, fromMessage: true,
    input: {}, selectedText: 'a'.repeat(size), expected: { title: 'a'.repeat(size) } })),
  { name: 'multibyte message above navigation boundary', fromMessage: true, input: {},
    selectedText: '答🙂\n'.repeat(1_500), expected: { title: '答🙂' } },
  { name: 'explicit large body takes precedence', fromMessage: true, input: { body: 'explicit\n'.repeat(1_500) },
    expected: { body: 'explicit\n'.repeat(1_500) } },
])('opens a reviewable task draft without writing: $name', async (testCase) => {
  const { fromMessage, input, expected } = testCase;
  const selectedText = 'selectedText' in testCase ? testCase.selectedText : 'Selected answer\nwith details';
  const { declaration, handler } = await registeredDraftAction();
  const opened: unknown[] = [];
  const writes: string[] = [];
  const sessionReads: string[] = [];
  const shared = createTriageEphemeralSharedScopeOriginFixture();
  const actionScope = shared.forExecutionOrigin('action');
  const pageScope = shared.forExecutionOrigin('page');
  const fixture = await createPluginUiTestkit({ identity: { instanceId: 'task-launch', mountNonce: 'launch' },
    authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    surface: defineUiSurface(() => null), surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
      readSession: ({ sessionId }) => { sessionReads.push(sessionId); return { sessionId, serverId: 'home-a', title: 'Reconnect investigation',
        acceptedWorkspace: { checkout: { serverId: 'home-a', workspaceId: 'workspace-a', machineId: 'machine-a', rootPath: '/workspace' },
          repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' } },
        lifecycle: 'active', runtime: 'waiting', operational: 'ready',
        workStatus: { state: 'ready', bucket: 'idle', tone: 'neutral', attentionType: null, word: 'Ready' }, pendingPermissions: [],
      }; },
      openSurface: ({ view, input }) => {
        const request = PluginUiOpenSurfaceRequestV1Schema.parse({ destination: view, input, subPath: 'tasks,mine' });
        expect(request.destination).toEqual({ pluginId: 'happier.triage', localId: 'tasks' });
        opened.push(request.input);
      },
      executeAction: ({ action }) => { writes.push(String(action)); throw new Error('Opening a draft must not write a task'); },
    } });
  try {
    expect(await handler(input, {
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
      invocationSurface: 'agent', signal: new AbortController().signal,
      ui: fixture.context.hostApi, ephemeralSharedScope: actionScope,
      ...(fromMessage ? { messageAction: MessageActionAvailableSnapshotV1Schema.parse({
        sessionId: 'session-a', messageId: 'message-a', observedRevision: 'revision-a',
        role: 'agent' as const, contentCategory: 'text' as const, seq: 1,
        visibleText: selectedText, structuredPresentationSummary: null,
        provenanceCategory: 'owner' as const,
      }) } : {}),
    })).toEqual({ status: 'applied' });
    // Opening one draft reads only its origin Session; mount/replay never fans out or polls.
    expect(sessionReads).toEqual(fromMessage ? ['session-a'] : []);
    expect(opened).toHaveLength(1);
    const launch = TriageTaskDraftLaunchV1Schema.parse(opened[0]);
    expect(launch).not.toHaveProperty('fields');
    const received = readTriageTaskDraftLaunch(pageScope, launch);
    expect(received).toMatchObject({ status: 'ready', fields: expected });
    if (received.status !== 'ready') throw new Error('Missing draft');
    if ('noProposedTitle' in testCase) expect(received.fields).not.toHaveProperty('title');
    // Full evidence stays in origin; Notes contains only deliberate draft input.
    if (fromMessage && !('body' in input)) expect(received.fields).not.toHaveProperty('body');
    if (fromMessage) expect(received.fields).toMatchObject({ origin: {
      sessionId: 'session-a', messageId: 'message-a', observedRevision: 'revision-a', role: 'agent', quote: selectedText,
      serverId: 'home-a', sessionTitle: 'Reconnect investigation',
      repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/repository' },
    } });
    else expect(received.fields).not.toHaveProperty('origin');
    // Reading during an interrupted render must not consume the handoff.
    expect(readTriageTaskDraftLaunch(pageScope, launch)).toMatchObject({ status: 'ready', fields: expected });
    // The real destination resolves the same address and opens the existing create owner.
    const { collections } = createTestkitCorpusCollections();
    const accountKv = createTestkitAccountKv();
    const adapter = createPluginUiRnwSemanticSurfaceAdapter({ ephemeralSharedScope: pageScope });
    let pageMount: Awaited<ReturnType<typeof adapter.mount>> | undefined;
    let page: Awaited<ReturnType<typeof createPluginUiTestkit>> | undefined;
    try {
      const mountPage = async () => { await act(async () => {
        page = await createPluginUiTestkit({ identity: { instanceId: 'tasks-page', mountNonce: 'page' },
          authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
          surface: renderTasksSurface, launchInput: launch, subPath: 'tasks,mine',
          surfaceContext: createSurfaceContextFixture(),
          adapter: { mount: async (input) => { pageMount = await adapter.mount(input); return pageMount; } },
          handlers: { executeAction: async ({ action, input }) => {
            if (action === 'tasks/create-v1') { writes.push(action); throw new Error('Opening a draft must not create a task'); }
            if (action === TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1) return await listTriageEntries(TriageListEntriesInputV1Schema.parse(input), {
              sourceInstances: collections.sourceInstances, readAdmittedSources: async () => [],
              executeScan: async () => { throw new Error('No source has been configured'); },
            });
            if (action === TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1) return await listTriagePinnedEntries(
              TriageListPinnedEntriesInputV1Schema.parse(input), { collections, nowMs: () => Date.now() });
            if (action === TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1) return await readTriageSavedViewsForSurface(
              TriageReadSavedViewsInputV1Schema.parse(input), { catalog: accountKv.catalog(TRIAGE_SAVED_VIEWS_ACCOUNT_KV_KEY_V1), mintViewId: () => 'unused' });
            if (action === TRIAGE_READ_ACTIONS_ACTION_LOCAL_ID_V1) return await readTriageActionsForSurface(
              TriageReadActionsInputV1Schema.parse(input), { catalog: accountKv.catalog(TRIAGE_ACTIONS_ACCOUNT_KV_KEY_V1) });
            throw new Error('Account read unavailable');
          } },
        });
      }); };
      await mountPage();
      expect(document.body.textContent).toContain('Where does it belong?');
      await expect(page!.getByText(DRAFT_PURPOSE)).resolves.toEqual({ content: DRAFT_PURPOSE });
      // Context snapshots may reconstruct equal JSON after the form has taken custody.
      await act(async () => { await pageMount!.update({ ...page!.context, launchInput: { ...launch } }); });
      await expect(page!.getByText(DRAFT_PURPOSE)).resolves.toEqual({ content: DRAFT_PURPOSE });
      // A host can replace its physical surface while settling the execution
      // origin. The same navigation must keep its unsubmitted draft available.
      await page!.dispose();
      await mountPage();
      await expect(page!.getByText(DRAFT_PURPOSE)).resolves.toEqual({ content: DRAFT_PURPOSE });
    } finally { if (page !== undefined) await page.dispose(); }
    received.discard();
    expect(readTriageTaskDraftLaunch(pageScope, launch)).toEqual({ status: 'unavailable' });
    expect(writes).toEqual([]);
  } finally { await fixture.dispose(); shared.retire(); }
});

it('discards a refused navigation and never resolves a draft in a different Account/generation', async () => {
  const { declaration, handler } = await registeredDraftAction();
  const shared = createTriageEphemeralSharedScopeOriginFixture();
  const other = createTriageEphemeralSharedScopeOriginFixture();
  const sharedScope = shared.forExecutionOrigin('action');
  const opened: unknown[] = [];
  let refuse = true;
  const fixture = await createPluginUiTestkit({ identity: { instanceId: 'refused', mountNonce: 'refused' },
    authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    surface: defineUiSurface(() => null), surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: { openSurface: ({ view, input }) => {
      opened.push(PluginUiOpenSurfaceRequestV1Schema.parse({ destination: view, input }).input);
      if (refuse) throw new Error('Navigation refused');
    } },
  });
  const context = {
    plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
    invocationSurface: 'agent' as const, signal: new AbortController().signal,
    ui: fixture.context.hostApi, ephemeralSharedScope: sharedScope,
  };
  try {
    expect(await handler({ body: 'a'.repeat(9_000) }, context)).toEqual({ status: 'unavailable' });
    expect(readTriageTaskDraftLaunch(sharedScope, opened[0])).toEqual({ status: 'unavailable' });
    refuse = false;
    expect(await handler({ body: 'second draft' }, context)).toEqual({ status: 'applied' });
    expect(readTriageTaskDraftLaunch(other.forExecutionOrigin('page'), opened[1])).toEqual({ status: 'unavailable' });
    expect(readTriageTaskDraftLaunch(sharedScope, opened[1])).toMatchObject({ status: 'ready', fields: { body: 'second draft' } });
    shared.retire();
    expect(readTriageTaskDraftLaunch(sharedScope, opened[1])).toEqual({ status: 'unavailable' });
    expect(await handler({}, { ...context, ephemeralSharedScope: null })).toEqual({ status: 'unavailable' });
    expect(await handler({}, { ...context, signal: AbortSignal.abort() })).toEqual({ status: 'unavailable' });
    expect(opened).toHaveLength(2);
  } finally { await fixture.dispose(); shared.retire(); other.retire(); }
});

it('shows an unavailable draft instead of an empty form when its client lifetime has ended', async () => {
  let page!: Awaited<ReturnType<typeof createPluginUiTestkit>>;
  await act(async () => {
    page = await createPluginUiTestkit({ identity: { instanceId: 'missing-draft', mountNonce: 'missing' },
      authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version }, surface: renderTasksSurface,
      launchInput: { v: 1, kind: 'createTask', draftId: 'retired-draft' }, surfaceContext: createSurfaceContextFixture(),
      adapter: createPluginUiRnwSemanticSurfaceAdapter(),
      handlers: { executeAction: () => { throw new Error('An unavailable draft must not write'); } },
    });
  });
  try {
    await expect(page.getByText('This task draft is no longer available. Open it again from the message or action.')).resolves.toBeDefined();
    await expect(page.getByText(DRAFT_PURPOSE)).rejects.toBeDefined();
  } finally { await page.dispose(); }
});

it.each(['cancelled', 'retired'] as const)('does not navigate or retain a draft when the exact Session read settles after %s', async (ending) => {
  const { declaration, handler } = await registeredDraftAction();
  const shared = createTriageEphemeralSharedScopeOriginFixture();
  const scope = shared.forExecutionOrigin('action');
  const controller = new AbortController();
  let finishRead!: (value: null) => void;
  let startedRead!: () => void;
  const readStarted = new Promise<void>(resolve => { startedRead = resolve; });
  const pendingRead = new Promise<null>(resolve => { finishRead = resolve; });
  const opened: unknown[] = [];
  const fixture = await createPluginUiTestkit({ identity: { instanceId: 'ending-draft', mountNonce: ending },
    authorPlugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
    surface: defineUiSurface(() => null), surfaceContext: createSurfaceContextFixture(),
    adapter: createPluginUiRnwSemanticSurfaceAdapter(), handlers: {
      readSession: async () => { startedRead(); return await pendingRead; },
      openSurface: ({ input }) => { opened.push(input); },
    },
  });
  try {
    const pending = handler({}, {
      plugin: { id: PLUGIN_MANIFEST.id, version: PLUGIN_MANIFEST.version },
      contribution: { id: declaration.id, qualifiedId: `${PLUGIN_MANIFEST.id}/actions/${declaration.id}` },
      invocationSurface: 'agent', signal: controller.signal, ui: fixture.context.hostApi, ephemeralSharedScope: scope,
      messageAction: { sessionId: 'session-a', messageId: 'message-a', observedRevision: 'revision-a',
        role: 'agent', contentCategory: 'text', seq: 1, visibleText: 'Keep the source quote',
        structuredPresentationSummary: null, provenanceCategory: 'owner' },
    });
    await readStarted;
    if (ending === 'cancelled') controller.abort(); else shared.retire();
    finishRead(null);
    expect(await pending).toEqual({ status: 'unavailable' });
    expect(opened).toEqual([]);
  } finally { await fixture.dispose(); shared.retire(); }
});

describe('mounted source-panel intents', () => {
  it('admits explicit completed-group disclosure without accepting unknown groups or fields', () => {
    const operation = { kind: 'setGroupExpanded', group: 'completed', expanded: true };
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'tasks-page', operation }).success).toBe(true);
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'tasks-page', operation: { ...operation, expanded: false } }).success).toBe(true);
    for (const invalid of [{ ...operation, group: 'unknown' }, { kind: 'setGroupExpanded', group: 'completed' },
      { ...operation, persisted: true }]) {
      expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'tasks-page', operation: invalid }).success).toBe(false);
    }
  });
  it('admits linked-session selection without admitting an unaddressed or empty selection', () => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'detail', operation: {
      kind: 'selectLinkedSession', sessionId: 'session-other',
    } }).success).toBe(true);
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'detail', operation: {
      kind: 'selectLinkedSession', sessionId: '',
    } }).success).toBe(false);
  });
  it.each([
    { kind: 'selectSourceOccurrence', occurrenceId: 'second' },
    { kind: 'setSourceOrdering', order: 'spread' },
    { kind: 'revealSourceUser', occurrenceId: 'second', revealed: false },
  ])('admits $kind on the existing mounted corridor', (operation) => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'mounted-page', operation }).success).toBe(true);
  });
  it.each([
    { kind: 'insertSelectedEvidence', occurrenceId: 'second' },
    { kind: 'revealSourceUser', occurrenceId: 'second', revealed: true },
  ])('does not admit approval-bearing $kind through the ordinary mounted Action', (operation) => {
    expect(TriageMountedUiInputV1Schema.safeParse({ mountId: 'mounted-page', operation }).success).toBe(false);
  });
});
