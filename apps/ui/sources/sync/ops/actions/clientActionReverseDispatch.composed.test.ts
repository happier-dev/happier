import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ScopeActionOutputSchemas } from '@happier-dev/protocol/actions/scopeActionFamily';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema, ActionIdSchema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { SessionResumeRequestV1Schema } from '@happier-dev/protocol/sessions/control/sessionResumeRequestV1';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionDetailAccessProjectionQuery } from '@/sync/api/session/sessionDetailAccessProjection';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { createLocalConversationVoiceAdapter } from '@/voice/adapters/localConversation/localConversationAdapter';
import { getVoiceAdapterRegistry, registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import type { CurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import type { PluginUiContributionOriginV1 } from '@/sync/domains/plugins/ui/projectionOrigins';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';

const navigation = vi.hoisted(() => ({ push: vi.fn(), segments: [] as string[], sessionId: '' }));
// The cross-package daemon dispatcher can import Socket before the UI installs
// its transport; every consumer must retain the same canonical boundary.
vi.mock('socket.io-client', async (importOriginal) =>
  (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation, segments: () => navigation.segments,
    params: () => navigation.sessionId ? { id: navigation.sessionId } : {} }).module;
});

const clientSockets: Socket[] = [];
let answerDaemonRpc: (method: string, params: unknown, serverUrl: string | undefined) => unknown;
installDisconnectedServerSocketBoundary((socket, serverUrl) => {
  clientSockets.push(socket);
  // The real scoped-RPC pool can retain a socket across test Account restores.
  // This Home accepts every dial; individual daemon methods answer below.
  configureConnectedServerSocketBoundary(socket);
  socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
  // Retain real Socket listeners for the reverse receiver above; only the
  // external daemon's outgoing RPC acknowledgement is synthetic.
  socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload: unknown) => {
    if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
    if (!payload || typeof payload !== 'object' || !('method' in payload)
      || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed daemon RPC');
    return { ok: true, result: await answerDaemonRpc(payload.method, payload.params, serverUrl) };
  });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { storage } = await import('@/sync/domains/state/storage');
const { apiSocket } = await import('@/sync/api/session/apiSocket');
await loadSyncSingletonForTests();
const { createFindSurfaceRegistry } = await import('@/keyboard/findSurfaceRegistry');
const { registerFindActionRuntime } = await import('@/keyboard/findActionRuntime');
const { registerPendingNavigationRuntime } = await import('@/activity/source/pendingNavigationRuntime');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createWorkspaceState, createWorkspaceEmptyTab } = await import('@/components/appShell/workspace/workspaceState');
const { projectWorkspaceTabsList } = await import('@/components/appShell/workspace/workspaceActions');
const { createClientActionReverseDispatcher } = await import('../../../../../cli/src/session/actions/clientActionReverseDispatch');
const { listNewSessionDraftProjections } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { readNewSessionDraftProjectionFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const releases: (() => void)[] = [];
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
  navigation.segments = [];
  navigation.sessionId = '';
  clientSockets.length = 0;
  answerDaemonRpc = () => { throw Object.assign(new Error('RPC method not available'), { code: 'RPC_METHOD_NOT_AVAILABLE' }); };
  await homes.reset();
  serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://relay.test', accountId: 'relay-account' });
  // Let the real Sync bootstrap settle against the same external Session facts
  // used by the tests; an unclaimed active census is not an older Home here.
  const sessions = createSessionMetadataHttpBoundary(() => Object.fromEntries(
    Object.entries(storage.getState().sessions).filter(([, session]) => session.serverId === serverId)));
  for (const path of ['/v2/sessions', '/v2/sessions/active', '/v2/session-organization']) {
    homes.answer(serverId, `GET ${path}`, { select: async () => {
      const response = sessions.handle(new URL(path, 'https://relay.test'));
      if (!response) throw new Error(`Missing Session bootstrap fixture: ${path}`);
      return { status: response.status, body: await response.json() };
    } });
  }
  homes.answer(serverId, 'GET /v2/sessions/metadata-upgrades', { select: async () => {
    const response = createEmptyAccountBootstrapHttpResponse('/v2/sessions/metadata-upgrades');
    if (!response) throw new Error('Missing metadata-upgrade bootstrap fixture');
    return { body: await response.json() };
  } });
  connection = await restoreServerAccountForTest({ serverUrl: 'https://relay.test', accountId: 'relay-account', request: homes.request });
  installHomeGovernanceBoundaries(homes);
  const features = createRootLayoutFeaturesResponse();
  if (!tryWriteServerEnabledBitInPlace(features, 'sessions.following', true)) throw new Error('Following feature is undeclared');
  homes.answer(serverId, '/v1/features', { body: features });
  homes.answer(serverId, '/v1/features/authenticated', { body: features });
  const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } });
  // Restoring the Account withdraws its Machines' presence as module state; each test seeds its own Machines as live.
  clearMachineRequestReachabilityForTest();
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  standardCleanup();
  if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(homes); }
});

describe('admitted app Actions and daemon-to-app continuations', () => {
  it.each(['cli', 'agent'] as const)('changes the answering device Administration target through the %s reverse-dispatch path', async surface => {
    const target = { serverIdentityId: 'srv_administration_destination', machineId: 'chosen-machine' };
    const sibling = { serverIdentityId: 'srv_other_destination', machineId: 'other-machine' };
    storage.setState(state => ({ settings: { ...state.settings,
      machineAdministrationTargetsLocalV1: { preserved: sibling } } }));
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Restored Account lifetime is unavailable');
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: lifetime.isCurrent });
    const { selectRpcTarget } = await import('../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    let multipleClients = true;
    let unrelatedEffects = 0;
    // Only the daemon-to-App network hop is synthetic. Placement, strict envelopes,
    // receiving Account admission and the device preference owner remain real.
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (method, payload, options) => {
        expect(method).toBe(RPC_METHODS.UI_ACTION_EXECUTE);
        expect(options.answeringClient).toMatchObject({ requireSingle: true });
        const target = { id: 'chosen-app', timeout: () => ({ emitWithAck: async () => await receive(JSON.parse(JSON.stringify(payload)),
          { signal: options.signal ?? new AbortController().signal }) }) };
        const unrelated = { id: 'other-app', timeout: () => ({ emitWithAck: async () => {
          unrelatedEffects++; throw new Error('Unselected client executed an Action');
        } }) };
        const selection = selectRpcTarget({ targets: multipleClients ? [target, unrelated] : [target], answeringClient: options.answeringClient });
        if (selection.type === 'ambiguous') return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS', answeringClients: selection.clients };
        if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        options.onIssued();
        return { ok: true, result: await selection.target.timeout(0).emitWithAck(SOCKET_RPC_EVENTS.REQUEST, payload) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse });
    const context = { surface, authority: 'account_automation',
      ...(surface === 'agent' ? { defaultSessionId: 'background-agent-session' } : {}) } as const;
    const input = { anchor: 'machines.administrationTarget', key: 'agents', value: target, clientId: 'chosen-app' };
    expect(await caller.execute('settings.get', { anchor: input.anchor, key: input.key }, context))
      .toMatchObject({ ok: false, errorCode: 'client_ambiguous', details: {
        clients: [{ id: 'chosen-app', deviceLabel: null }, { id: 'other-app', deviceLabel: null }],
        recovery: { inputField: 'clientId' },
      } });
    expect(await caller.execute('settings.set', input, context)).toEqual({ ok: true, result: { anchor: input.anchor, value: target } });
    expect(storage.getState().settings.machineAdministrationTargetsLocalV1).toEqual({ preserved: sibling, agents: target });
    expect(await caller.execute('settings.get', { anchor: input.anchor, key: input.key, clientId: input.clientId }, context))
      .toEqual({ ok: true, result: { anchor: input.anchor, value: target } });
    expect(await caller.execute('settings.set', { ...input, value: null }, context))
      .toEqual({ ok: true, result: { anchor: input.anchor, value: null } });
    expect(storage.getState().settings.machineAdministrationTargetsLocalV1).toEqual({ preserved: sibling });
    multipleClients = false;
    expect(await caller.execute('settings.get', { anchor: input.anchor, key: input.key }, context))
      .toEqual({ ok: true, result: { anchor: input.anchor, value: null } });
    expect(unrelatedEffects).toBe(0);
  });
  it('delivers unbound empty Next and All-Machines search through a connected app without an availability hint', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { NextPendingNavigationHost } = await import('@/components/sessions/pendingNavigation/NextPendingNavigationHost');
    const { KeyboardShortcutProvider } = await import('@/keyboard/KeyboardShortcutProvider');
    const { selectRpcTarget } = await import('../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    const machine = createMachineFixture({ id: 'account-action-machine', activeAt: Date.now(),
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    const offline = createMachineFixture({ id: 'account-action-offline', active: false, activeAt: 1 });
    storage.setState(state => ({ profile: { ...state.profile!, id: 'relay-account' },
      machines: { [machine.id]: machine, [offline.id]: offline }, machineListByServerId: {},
      sessions: {}, sessionListRowsByServerId: {} }));
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account reverse receiver absent');
    const registered = new Set<string>();
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
      }
      return socket;
    });
    releases.push(() => emit.mockRestore());
    const receiver = { id: 'connected-app', timeout: () => ({ emitWithAck: async (_event: string, payload: unknown) =>
      await new Promise<unknown>(resolve => {
        for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) receive(payload, resolve);
      }) }) };
    const reverse = createClientActionReverseDispatcher(() => ({
      // Drop the advertisement, not the real server registration. Only the
      // network hop is synthetic; registration, selection and both executors run.
      hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async (method, payload, options) => {
        const selection = selectRpcTarget({ targets: registered.has(`${machine.id}:${method}`) ? [receiver] : [],
          answeringClient: options.answeringClient });
        if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        options.onIssued();
        return { ok: true, result: await selection.target.timeout(0).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
          { method: `${machine.id}:${method}`, params: JSON.parse(JSON.stringify(payload)) }) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    const context = { surface: 'mcp', authority: 'account_automation', defaultSessionId: 'cli-global' } as const;
    expect(await caller.execute('session.pending.next', {}, context))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
    const runtime = await renderScreen(React.createElement(KeyboardShortcutProvider, {},
      React.createElement(ClientActionReverseRuntime), React.createElement(NextPendingNavigationHost)));
    try {
      expect([...registered].some(method => method.includes('.session.'))).toBe(false);
      homes.answer(serverId, '/v2/sessions/lookup-by-tags', { body: { sessions: [] } });
      const backgroundAgent = { ...context, defaultSessionId: 'background-agent-session' };
      expect(await caller.execute('ui.voice_global.history.search', { refresh: true }, backgroundAgent))
        .toEqual({ ok: true, result: { sessionId: null, loadedRowCount: 0, hasMore: null, rows: [] } });
      const voice = await caller.execute('ui.voice_global.get', {}, backgroundAgent);
      expect(voice).toMatchObject({ ok: true, result: { voice: { status: 'disconnected', attemptId: null } } });
      expect(await caller.execute('session.pending.next', {}, context)).toEqual({ ok: true, result: { status: 'none' } });
      const result = await caller.execute('search.conversations', {
        query: { v: 1, query: 'owned-phrase', scope: { type: 'global' }, mode: 'deep' }, mode: 'indexed',
      }, context);
      expect(result).toMatchObject({ ok: true, result: { hits: [], machines: expect.arrayContaining([
        { machineId: machine.id, status: 'partial' }, { machineId: offline.id, status: 'offline' },
      ]) } });
      expect(await caller.execute('ui.find', { op: 'read' }, context))
        .toEqual({ ok: true, result: { status: 'noMountedSurface' } });
    } finally { await runtime.unmount(); }
    expect(await caller.execute('session.pending.next', {}, context))
      .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
    expect(await caller.execute('ui.voice_global.history.search', {}, { ...context, defaultSessionId: 'background-agent-session' }))
      .toMatchObject({ ok: false, errorCode: 'unavailable', details: { reason: 'client_unavailable' } });
  });
  it('keeps reverse binding renders and in-flight Actions independent of executable-only AppShell publications', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { AppShellPluginUiProjectionValueProvider } = await import('@/components/appShell/plugins/AppShellPluginUiProjection');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { EMPTY_PLUGIN_UI_PROJECTION } = await import('@/sync/domains/plugins/ui/projection');
    const { PluginProjectedActionV2Schema, PluginMachineExecutionOriginV1Schema } = await import('@happier-dev/protocol');
    const { PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY } = await import('@/sync/domains/plugins/ui/projectionUnion');
    const { createDeferred, flushHookEffects } = await import('@/dev/testkit');
    const machine = createMachineFixture({ id: 'declaration-bound-machine', activeAt: Date.now() });
    const other = createMachineFixture({ id: 'next-declaration-machine', activeAt: Date.now() });
    await act(async () => {
      storage.setState(state => ({ profile: { ...state.profile!, id: 'relay-account' },
        machines: { [machine.id]: machine, [other.id]: other }, machineListByServerId: {} }));
    });
    const lifetime = captureActiveServerAccountScopeLifetime();
    expect(lifetime?.isCurrent()).toBe(true);
    const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_reverse', materializationRef: { machineId: machine.id,
      pluginId: 'test.reverse', materializationId: 'reverse-installation' } });
    const action = PluginProjectedActionV2Schema.parse({ id: 'inspect', pluginId: 'test.reverse', occurrenceId: 'test-reverse-occurrence',
      title: 'Inspect', scopes: ['global'], surfaces: ['agent'], dangerLevel: 'safe', available: true,
      execution: { target: 'client', client: { artifactId: 'reverse-client', exportName: 'inspect' }, platforms: ['web'] },
      executionOrigin,
      authorization: { generation: { targetGeneration: 'test-reverse-occurrence', desiredGeneration: 'test-reverse-occurrence',
        appliedGeneration: 'test-reverse-occurrence' }, resourceSelections: [], scopedGrants: [], serviceAvailability: [], operatingSystemAuthorization: [] } });
    const origin = { machineId: machine.id, serverId, interactionEnabled: true, phase: 'current' as const,
      executionOrigin };
    let bindingRenders = 0;
    const project = (hostOrigin: PluginUiContributionOriginV1) => ({ ...EMPTY_PLUGIN_UI_PROJECTION,
      actionsById: { 'test.reverse/inspect': { ...action, executionOrigin: hostOrigin.executionOrigin ?? executionOrigin,
        get [PLUGIN_UI_CONTRIBUTION_ORIGIN_KEY]() {
        // Observe the real render's consumed input, not a mocked hook/component.
        // An ancestor Profiler misses context-only descendant updates in this renderer.
        if (new Error().stack?.includes('ClientActionReverseRuntime')) bindingRenders++;
        return hostOrigin;
      } } } });
    const projection = project(origin);
    const value = { pluginUiProjection: projection, pluginBrowserProjection: null, phase: 'current' as const,
      interactionEnabled: true, machineId: machine.id, serverId, platform: 'web' as const, accountLifetime: lifetime,
      clientExecutableActivation: { status: 'ready' as const }, reloadClientExecutables() {}, reloadConnectedAccountProjection() {} };
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account reverse receiver absent');
    const methods = new Set<string>();
    const registrations: string[] = [];
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) { methods.add(payload.method); registrations.push(payload.method); }
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) methods.delete(payload.method);
      }
      return socket;
    });
    releases.push(() => emit.mockRestore());
    const registered = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler');
    releases.push(() => registered.mockRestore());
    const child = React.createElement(ClientActionReverseRuntime);
    const render = (next: React.ComponentProps<typeof AppShellPluginUiProjectionValueProvider>['value']) =>
      React.createElement(AppShellPluginUiProjectionValueProvider, { value: next, children: child });
    const screen = await renderScreen(render(value));
    const pendingNavigation = createDeferred<Readonly<{ status: 'none' }>>();
    let navigationStarted = false;
    releases.push(registerPendingNavigationRuntime(async () => { navigationStarted = true; return await pendingNavigation.promise; }));
    try {
      await flushHookEffects();
      const receive = registered.mock.calls.find(([id, method]) => id === machine.id && method === RPC_METHODS.UI_ACTION_EXECUTE)?.[2];
      if (!receive) throw new Error('Mounted Action registration absent');
      const request = { v: 1, actionId: 'session.pending.next', input: {}, context: { surface: 'agent', authority: 'account_automation' } };
      const pending = receive(request, { signal: new AbortController().signal });
      await vi.waitFor(() => expect(navigationStarted).toBe(true));
      const settledRenders = bindingRenders;
      const settledRegistrations = [...registrations];
      for (let revision = 1; revision <= 5; revision++) {
        await screen.update(render({ ...value, connectedAccountProjectionRevision: revision,
          clientExecutableActivation: { status: 'establishing' } }));
      }
      expect(bindingRenders - settledRenders).toBe(0);
      expect(registrations).toEqual(settledRegistrations);
      expect(methods.has(`${machine.id}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(true);
      pendingNavigation.resolve({ status: 'none' });
      expect(await pending).toMatchObject({ execution: { ok: true, result: { status: 'none' } } });
      for (const unavailableOrigin of [{ ...origin, phase: 'retainedOffline' as const },
        { ...origin, interactionEnabled: false }, { ...origin, serverId: 'another-home' }]) {
        await screen.update(render(value));
        expect(methods.has(`${machine.id}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(true);
        await screen.update(render({ ...value, pluginUiProjection: project(unavailableOrigin) }));
        expect(methods.has(`${machine.id}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(false);
      }
      await screen.update(render({ ...value, pluginUiProjection: project({ ...origin, machineId: other.id,
        executionOrigin: { ...executionOrigin, materializationRef: { ...executionOrigin.materializationRef, machineId: other.id } } }) }));
      expect(methods.has(`${other.id}:${RPC_METHODS.UI_CONTRIBUTED_ACTION_EXECUTE}`)).toBe(true);
      expect(bindingRenders).toBeGreaterThan(settledRenders);
      await act(async () => { storage.getState().clearProfileScope(); });
      expect(lifetime?.isCurrent()).toBe(false);
      expect(methods.size).toBe(0);
      expect(await receive(request, { signal: new AbortController().signal }))
        .toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
    } finally { pendingNavigation.resolve({ status: 'none' }); await screen.unmount(); }
  });
  it('keeps Agent Next, search, Find, picker and composer on the viewed Session with unrelated generic clients', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const { setFocusedSessionId } = await import('@/sync/domains/session/sessionSurfaceVisibility');
    const { createFileViewerFindModel } = await import('@/components/workspaces/files/details/useFileViewerFind');
    const { registerSessionComposerPresentationTarget } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    const { ComposerSnapshotV1Schema } = await import('@happier-dev/protocol/plugins/ui/composer');
    const { selectRpcTarget } = await import('../../../../../server/sources/app/api/socket/rpc/rpcTargetSelection');
    const sessionId = 'viewed-session';
    navigation.segments = ['session', '[id]'];
    navigation.sessionId = sessionId;
    const machine = createMachineFixture({ id: 'viewed-machine', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    storage.setState(state => ({ profile: { ...state.profile!, id: 'relay-account' }, machines: { [machine.id]: machine },
      sessions: { [sessionId]: createSessionFixture({ id: sessionId, serverId }) }, machineListByServerId: {} }));
    setFocusedSessionId(sessionId, serverId);
    releases.push(() => setFocusedSessionId(null));
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account reverse receiver absent');
    const registered = new Set<string>();
    const nextReceiptOrder: string[] = [];
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) {
          registered.delete(payload.method);
          if (payload.method === `${machine.id}:${RPC_METHODS.UI_ACTION_EXECUTE}.session.${encodeURIComponent(JSON.stringify(sessionId))}`) nextReceiptOrder.push('unregistered');
        }
      }
      return socket;
    });
    releases.push(() => emit.mockRestore());
    const find = createFindSurfaceRegistry();
    const model = createFileViewerFindModel(() => ({ path: 'notes.md', mode: 'file', text: 'needle\nneedle' }));
    releases.push(registerFindActionRuntime(find));
    releases.push(find.register({ surfaceId: 'file:notes', controller: model, open: model.open,
      containsFocus: () => true, isOpen: () => model.getSnapshot().open, isInputFocused: () => true }));
    let draft = ComposerSnapshotV1Schema.parse({ revision: 1, ref: { kind: 'session', sessionId }, text: 'draft', references: [], attachments: [],
      layout: 'wrap', capabilities: { text: true, references: false, attachments: false, submit: false },
      state: { focused: true, editable: true, submittable: false, submitting: false, running: false } });
    let pickerOpened = false;
    releases.push(registerSessionComposerPresentationTarget({ serverId, sessionId }, {
      readRevision: () => draft.revision, readSnapshot: () => draft, readScope: () => ({ serverId, accountId: 'relay-account' }),
      replace: () => { throw new Error('Use the revision-bound transaction'); },
      openPromptPicker: () => { pickerOpened = true; return true; },
      commitDocument: ({ expectedRevision, mutation }) => {
        if (expectedRevision !== draft.revision) return { status: 'conflict', currentRevision: draft.revision };
        draft = ComposerSnapshotV1Schema.parse({ ...draft, ...mutation, revision: draft.revision + 1 });
        return { status: 'applied', revision: draft.revision };
      },
    }));
    let foreignEffects = 0;
    let alsoViewing = false;
    const foreign = { id: 'a-foreign-client', timeout: () => ({ emitWithAck: async () => {
      foreignEffects++; return { v: 1, execution: { ok: true, result: { status: 'noMountedSurface' } } };
    } }) };
    const unrelated = { ...foreign, id: 'b-unrelated-generic-client' };
    const viewed = { id: 'z-viewed-client', timeout: () => ({ emitWithAck: async (_event: string, payload: unknown) => {
      if (!payload || typeof payload !== 'object' || !('method' in payload) || !('params' in payload)) throw new Error('Malformed Socket request');
      return await new Promise<unknown>(resolve => {
        for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) receive(payload, (result: unknown) => {
          nextReceiptOrder.push('receipt');
          resolve(result);
        });
      });
    } }) };
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => false,
      callConnectedClientRpc: async (method, payload, options) => {
        // Only Socket.IO is replaced. Use the real server selection owner over the
        // clients' actual method memberships, then the actual app receiver.
        // Two unrelated generic clients must neither receive nor block this call.
        const targets = [...(method === RPC_METHODS.UI_ACTION_EXECUTE ? [foreign, unrelated] : alsoViewing ? [foreign] : []),
          ...(registered.has(`${machine.id}:${method}`) ? [viewed] : [])];
        const selection = selectRpcTarget({ targets, answeringClient: options.answeringClient });
        if (selection.type === 'ambiguous') return { ok: false, errorCode: 'RPC_CLIENT_AMBIGUOUS' };
        if (selection.type !== 'target') return { ok: false, errorCode: 'RPC_CLIENT_NOT_AVAILABLE' };
        options.onIssued();
        return { ok: true, result: await selection.target.timeout(0).emitWithAck(SOCKET_RPC_EVENTS.REQUEST,
          { method: `${machine.id}:${method}`, params: JSON.parse(JSON.stringify(payload)) }) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: sessionId } as const;
    releases.push(registerPendingNavigationRuntime(async () => {
      await act(async () => {
        navigation.sessionId = 'next-question';
        setFocusedSessionId('next-question', serverId);
      });
      return { status: 'opened' };
    }));
    const runtime = await renderMountedCurrentUiContext(React.createElement(ClientActionReverseRuntime));
    try {
      expect(await caller.execute('ui.find', { op: 'set', query: 'needle' }, context))
        .toMatchObject({ ok: true, result: { status: 'results', current: 1, total: 2 } });
      expect(await caller.execute('ui.find', { op: 'read' }, context)).toMatchObject({ ok: true, result: { current: 1, total: 2 } });
      expect(await caller.execute('ui.find', { op: 'step', direction: 1 }, context)).toMatchObject({ ok: true, result: { current: 2, total: 2 } });
      expect(await caller.execute('ui.prompts.picker.open', {}, context)).toMatchObject({ ok: true, result: { status: 'opened' } });
      expect(pickerOpened).toBe(true);
      expect(draft.text).toBe('draft');
      expect(await caller.execute('composer.transaction.apply', { scope: { serverId, accountId: 'relay-account' }, ref: draft.ref,
        transaction: { expectedRevision: draft.revision, operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'needle ' }] } }, context))
        .toEqual({ ok: true, result: { status: 'applied', revision: 2 } });
      expect(draft.text).toBe('needle draft');
      const searchInput = { query: { v: 1 as const, query: 'needle', scope: { type: 'global' as const }, mode: 'deep' as const }, mode: 'indexed' as const };
      expect(await caller.execute('search.conversations', searchInput, context))
        .toMatchObject({ ok: true, result: { hits: [], machines: [{ machineId: machine.id, status: 'partial' }] } });
      expect(foreignEffects).toBe(0);
      alsoViewing = true;
      expect(await caller.execute('ui.find', { op: 'step', direction: -1 }, context))
        .toMatchObject({ ok: false, errorCode: 'client_ambiguous' });
      expect(model.status).toMatchObject({ current: 2 });
      expect(await caller.execute('session.pending.next', {}, context))
        .toMatchObject({ ok: false, errorCode: 'client_ambiguous' });
      expect(await caller.execute('search.conversations', searchInput, context))
        .toMatchObject({ ok: false, errorCode: 'client_ambiguous' });
      expect(foreignEffects).toBe(0);
      alsoViewing = false;
      // Secure storage is an external boundary. A delivered request can fail
      // there before its mounted owner runs; retain a content-free cause in
      // the receipt instead of erasing it as a generic Action failure.
      const { TokenStorage } = await import('@/auth/storage/tokenStorage');
      const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl');
      const diagnostic = { reason: 'client_execution_exception', errorClass: 'TypeError', errorCode: null, httpStatus: null };
      try {
        credentials.mockRejectedValueOnce(new TypeError('private credential-store detail'));
        expect(await caller.execute('search.conversations', { query: { v: 1, query: 'needle', scope: { type: 'global' }, mode: 'deep' }, mode: 'indexed' }, context))
          .toMatchObject({ ok: false, errorCode: 'action_failed', details: diagnostic });
        credentials.mockRejectedValueOnce(new TypeError('private credential-store detail'));
        expect(await caller.execute('composer.transaction.apply', { scope: { serverId, accountId: 'relay-account' }, ref: draft.ref,
          transaction: { expectedRevision: draft.revision, operations: [{ kind: 'text.insert', position: { offset: 0 }, text: 'unapplied ' }] } }, context))
          .toMatchObject({ ok: false, errorCode: 'outcome_uncertain', details: diagnostic });
        expect(draft.text).toBe('needle draft');
      } finally { credentials.mockRestore(); }
      nextReceiptOrder.length = 0;
      expect(await caller.execute('session.pending.next', {}, context))
        .toEqual({ ok: true, result: { status: 'opened' } });
      expect(nextReceiptOrder[0]).toBe('receipt');
      await act(async () => { setFocusedSessionId(null); });
      expect(await caller.execute('ui.find', { op: 'read' }, context))
        .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
      expect(await caller.execute('session.pending.next', {}, context))
        .toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
      expect(await caller.execute('search.conversations', searchInput, context))
        .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
      expect(foreignEffects).toBe(0);
    } finally { await runtime.unmount(); }
    expect(await caller.execute('ui.find', { op: 'read' }, context)).toEqual({ ok: true, result: { status: 'unavailable', reason: 'noClient' } });
    expect(foreignEffects).toBe(0);
  });
  it('keeps Usage view, period and filter switches at zero binding mounts and registrations across 46 Machines', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { currentUiContextCommandClientRpcMethod } = await import('@happier-dev/protocol/actions/clientDispatchV1');
    const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const { useUsageWidgetPageContext, usePublishUsageWidgetPageContext } = await import('@/components/settings/usage/useUsageWidgetPageContext');
    const { useOptionalCurrentUiContextReader } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { executeCurrentUiContextAction } = await import('@/components/appShell/currentUiContext/currentUiContextActionRuntime');
    const { getUsagePeriodDefinition } = await import('@/sync/api/account/usagePeriods');
    const { t } = await import('@/text');
    // P03-WEB-PERF observed about 46 selectable Machines in the affected Account.
    const machines = Array.from({ length: 46 }, (_, index) => createMachineFixture({
      id: `usage-command-machine-${index}`, activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
    }));
    await act(async () => { storage.setState(state => ({ profile: { ...state.profile!, id: 'relay-account' },
      machines: Object.fromEntries(machines.map(machine => [machine.id, machine])), machineListByServerId: {} })); });
    const authority = captureActiveServerAccountScopeLifetime();
    let reader: CurrentUiContextReader | null = null;
    let page: ReturnType<typeof useUsageWidgetPageContext> | undefined;
    let selectView: ((view: string) => void) | undefined;
    let addFilter: (() => void) | undefined;
    let removeFilter: (() => void) | undefined;
    let latestInvocation = '';
    function UsageCommands(): React.ReactElement {
      const [layoutId, setLayoutId] = React.useState('costs');
      const [extraFilter, setExtraFilter] = React.useState(false);
      // The full-page route echoes page-owned filters back through its URL params.
      const [initialFilters, setInitialFilters] = React.useState<Parameters<typeof useUsageWidgetPageContext>[0]['initialFilters']>();
      selectView = setLayoutId;
      addFilter = () => setExtraFilter(true);
      removeFilter = () => setExtraFilter(false);
      page = useUsageWidgetPageContext({ authority, nowMs: 1_790_000_000_000, initialFilters, onFiltersChange: setInitialFilters });
      usePublishUsageWidgetPageContext({ authority, page, layoutId, costBasisOptions: ['auto', 'reported'],
        layouts: [{ id: 'costs', name: 'Costs' }, { id: 'plans', name: 'Plans' }],
        selectLayout: next => { setLayoutId(next); return true; },
        filterCommands: [{ field: 'agents', id: 'codex', title: 'Agent: Codex',
          invoke: () => { latestInvocation = layoutId; return true; } },
          ...(extraFilter ? [
            { field: 'agents', id: 'claude', title: 'Agent: Claude', invoke: () => true },
            { field: 'agents', id: 'gemini', title: 'Agent: Gemini', invoke: () => true },
          ] : [])] });
      reader = useOptionalCurrentUiContextReader();
      return React.createElement(ClientActionReverseRuntime);
    }
    const registrations = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler');
    releases.push(() => registrations.mockRestore());
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account reverse receiver absent');
    const emissions = vi.spyOn(socket, 'emit');
    releases.push(() => emissions.mockRestore());
    const unregisteredMethods = () => emissions.mock.calls.flatMap(([event, payload]) =>
      event === SOCKET_RPC_EVENTS.UNREGISTER && payload && typeof payload === 'object'
        && 'method' in payload && typeof payload.method === 'string' && payload.method.startsWith('usage-command-machine-')
        ? [payload.method] : []);
    const runtime = await renderMountedCurrentUiContext(React.createElement(UsageCommands));
    const machineIds = new Set(machines.map(machine => machine.id));
    // Count the runtime's actual descendants, independent of component names or props.
    const bindingNodes = () => runtime.findByType(ClientActionReverseRuntime).children;
    const initialBindings = new Set(bindingNodes());
    expect(initialBindings.size, 'RPC registration must not mount React bindings').toBe(0);
    expect(new Set(registrations.mock.calls.map(([machineId]) => machineId))).toEqual(machineIds);
    const originalCommands = reader!.readCurrentUiContext()!.commands;
    const originalIds = originalCommands.map(command => command.id);
    const commandPairs = (ids: readonly string[]) => machines.flatMap(machine =>
      ids.map(id => `${machine.id}:${currentUiContextCommandClientRpcMethod(id)}`));
    expect(registrations.mock.calls.map(([machineId, method]) => `${machineId}:${method}`))
      .toEqual(expect.arrayContaining(commandPairs(originalIds)));
    const filterId = originalCommands.find(command => command.title === 'Agent: Codex')!.id;
    const originalSignal = reader!.resolveCurrentUiCommand(filterId)!.retirementSignal;
    const invoke = (commandId: string) => executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke',
      input: { commandId }, context: { surface: 'ui' } });
    try {
      for (const switchContext of [() => selectView?.('plans'), () => page?.setPeriod('today'),
        () => page?.setScope({ agents: ['codex'] })]) {
        registrations.mockClear();
        emissions.mockClear();
        await act(async () => { switchContext(); });
        expect.soft(reader!.readCurrentUiContext()!.commands.map(command => command.id)).toEqual(originalIds);
        expect.soft(bindingNodes().filter(node => !initialBindings.has(node)), 'unchanged command set mounts no bindings').toHaveLength(0);
        expect.soft(registrations.mock.calls, 'unchanged command set registers no methods').toHaveLength(0);
        expect.soft(unregisteredMethods(), 'unchanged command set withdraws no methods').toHaveLength(0);
      }
      expect(reader!.readCurrentUiContext()!.entity?.summary).toBe(t(getUsagePeriodDefinition('today').translationKey));
      expect(originalSignal.aborted).toBe(false);
      await act(async () => { expect(await invoke(filterId)).toMatchObject({ ok: true }); });
      expect(latestInvocation).toBe('plans');
      registrations.mockClear();
      emissions.mockClear();
      await act(async () => { addFilter?.(); });
      const added = reader!.readCurrentUiContext()!.commands.filter(command => !originalIds.includes(command.id));
      expect(added).toHaveLength(2);
      const addedPairs = commandPairs(added.map(command => command.id));
      expect(registrations.mock.calls).toHaveLength(addedPairs.length);
      expect(new Set(registrations.mock.calls.map(([machineId, method]) => `${machineId}:${method}`)))
        .toEqual(new Set(addedPairs));
      expect(unregisteredMethods()).toHaveLength(0);
      expect(bindingNodes().filter(node => !initialBindings.has(node)), 'new commands reuse mounted Machine bindings').toHaveLength(0);
      registrations.mockClear();
      emissions.mockClear();
      await act(async () => { removeFilter?.(); });
      expect(registrations.mock.calls).toHaveLength(0);
      expect(unregisteredMethods()).toHaveLength(addedPairs.length);
      expect(new Set(unregisteredMethods())).toEqual(new Set(addedPairs));
      for (const command of added) expect(reader!.resolveCurrentUiCommand(command.id)).toBeNull();
      expect(reader!.resolveCurrentUiCommand(filterId)?.retirementSignal.aborted).toBe(false);
      await act(async () => { storage.getState().clearProfileScope(); });
      expect(originalSignal.aborted).toBe(true);
      expect(await invoke(filterId)).toMatchObject({ ok: false });
    } finally { await runtime.unmount(); }
  });
  it('keeps reverse registrations stable across fresh current-UI snapshots and retires replaced commands', async () => {
    const insertionUpdates: Error[] = [];
    const originalConsoleError = console.error;
    const diagnostics = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (args[0] === 'useInsertionEffect must not schedule updates.') {
        insertionUpdates.push(new Error('Current-UI subscription scheduled an insertion-phase update'));
      }
      originalConsoleError(...args);
    });
    releases.push(() => diagnostics.mockRestore());
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const { useOptionalCurrentUiContextReader, usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
    const { currentUiContextCommandClientRpcMethod, currentUiContextReadClientRpcMethod } = await import('@happier-dev/protocol/actions/clientDispatchV1');
    const machine = createMachineFixture({ id: 'stable-context-machine', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    const offline = createMachineFixture({ id: 'offline-machine', active: false, activeAt: 1 });
    const revoked = createMachineFixture({ id: 'revoked-machine', activeAt: Date.now(), revokedAt: 1 });
    const replaced = createMachineFixture({ id: 'replaced-machine', activeAt: Date.now(), replacedByMachineId: machine.id });
    const foreign = createMachineFixture({ id: 'foreign-home-machine', activeAt: Date.now() });
    await act(async () => {
      storage.setState(state => ({ profile: { ...state.profile!, id: 'relay-account' },
        machines: { [machine.id]: machine, [offline.id]: offline, [revoked.id]: revoked, [replaced.id]: replaced },
        machineListByServerId: { 'foreign-home': [foreign] } }));
    });
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account transport did not install its reverse receiver');
    const registered = new Set<string>();
    const registrations: string[] = [];
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) { registered.add(payload.method); registrations.push(payload.method); }
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
      }
      return socket;
    });
    releases.push(() => emit.mockRestore());
    let readContext: CurrentUiContextReader['readCurrentUiContext'] | undefined;
    let subscribeContext: CurrentUiContextReader['subscribe'] | undefined;
    let replaceCommand: (() => void) | undefined;
    let refreshDeclaration: (() => void) | undefined;
    function CurrentContextOwner(): React.ReactElement {
      const reader = useOptionalCurrentUiContextReader();
      readContext = reader?.readCurrentUiContext;
      subscribeContext = reader?.subscribe;
      const [version, setVersion] = React.useState(0);
      const [revision, setRevision] = React.useState(0);
      replaceCommand = () => setVersion(value => value + 1);
      refreshDeclaration = () => setRevision(value => value + 1);
      const enrichment = React.useMemo(() => ({ detail: { revision }, commands: [{ title: 'Open issue', command: {
        kind: 'openSurface' as const, destination: { pluginId: 'triage', localId: 'issues' }, input: { issueNumber: version },
      } }] }), [version, revision]);
      usePublishCurrentUiContext(enrichment);
      return React.createElement(ClientActionReverseRuntime);
    }
    const runtime = await renderMountedCurrentUiContext(React.createElement(CurrentContextOwner));
    let retirementNotified = false;
    const unsubscribe = subscribeContext?.(() => {
      if (readContext?.() === null) retirementNotified = true;
    });
    try {
      const snapshot = readContext?.();
      expect(snapshot?.commands).toHaveLength(1);
      // This is a fresh presentational DTO, not a valid external-store snapshot.
      expect(readContext?.()).not.toBe(snapshot);
      expect(readContext?.()).toEqual(snapshot);
      const command = snapshot!.commands[0]!;
      const method = (id: string) => `${machine.id}:${currentUiContextCommandClientRpcMethod(id)}`;
      expect(registered.has(`${machine.id}:${RPC_METHODS.UI_ACTION_EXECUTE}`)).toBe(true);
      expect(registered.has(`${machine.id}:${currentUiContextReadClientRpcMethod()}`)).toBe(true);
      expect(registered.has(method(command.id))).toBe(true);
      expect([...new Set([...registered].map(method => method.slice(0, method.indexOf(':'))))]).toEqual([machine.id]);
      const beforeRefresh = [...registrations];
      await act(async () => { refreshDeclaration?.(); });
      expect(readContext?.()?.commands[0]?.id).toBe(command.id);
      expect(registrations).toEqual(beforeRefresh);
      await act(async () => {
        storage.setState(state => ({ machines: { ...state.machines, [offline.id]: { ...offline, active: true, activeAt: Date.now() } } }));
      });
      expect(registered.has(`${offline.id}:${currentUiContextCommandClientRpcMethod(command.id)}`)).toBe(true);
      const stableRegistrations = registrations.filter(method => method.startsWith(`${machine.id}:`));
      await act(async () => {
        storage.setState(state => ({ machines: { ...state.machines, [offline.id]: { ...offline, revokedAt: 1 } } }));
      });
      expect([...registered].some(method => method.startsWith(`${offline.id}:`))).toBe(false);
      expect(registrations.filter(method => method.startsWith(`${machine.id}:`))).toEqual(stableRegistrations);
      await act(async () => { replaceCommand?.(); });
      const replacement = readContext?.()?.commands[0];
      expect(replacement?.id).not.toBe(command.id);
      expect(registered.has(method(command.id))).toBe(false);
      expect(registered.has(method(replacement!.id))).toBe(true);
    } finally {
      await runtime.unmount();
      unsubscribe?.();
    }
    expect(registered.size).toBe(0);
    expect(retirementNotified).toBe(true);
    expect(insertionUpdates.map(error => error.stack)).toEqual([]);
  });
  it('routes current UI context through its mounted app instead of another generic app socket', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { renderMountedCurrentUiContext } = await import('@/dev/testkit/harness/mountedCurrentUiContext');
    const { usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
    const machine = createMachineFixture({ id: 'current-ui-machine', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    await act(async () => {
      storage.setState(state => ({ ...state, profile: { ...state.profile!, id: 'relay-account' },
        machines: { [machine.id]: machine }, machineListByServerId: {} }));
    });
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account transport did not install its reverse receiver');
    const registered = new Set<string>();
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
      }
      return socket;
    });
    let invoked = 0;
    function CurrentContextOwner(): React.ReactElement {
      const enrichment = React.useMemo(() => ({ commands: [{ title: 'Choose Studio Home', command: {
        kind: 'hostLocal' as const,
        invoke: () => { invoked++; return { ok: true as const }; },
      } }] }), []);
      usePublishCurrentUiContext(enrichment);
      return React.createElement(ClientActionReverseRuntime);
    }
    // The generic response models the earlier-sorting background App socket from
    // QA. Only the mounted provider registers the capability-specific methods.
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE
        || registered.has(`${machine.id}:${method}`),
      callConnectedClientRpc: async (method, payload, options) => {
        options.onIssued();
        if (method === RPC_METHODS.UI_ACTION_EXECUTE) return { ok: true, result: { v: 1, execution: {
          ok: false, errorCode: 'unsupported_action', error: 'current_ui_context_unavailable',
        } } };
        const wire = UiActionDispatchRequestV1Schema.parse(JSON.parse(JSON.stringify(payload)));
        const result = await new Promise<unknown>(resolve => {
          for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) {
            receive({ method: `${machine.id}:${method}`, params: wire }, resolve);
          }
        });
        return { ok: true, result };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    const context = { surface: 'agent', authority: 'account_automation', serverId } as const;
    expect(await caller.execute('ui.current_context.read', {}, context))
      .toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    const runtime = await renderMountedCurrentUiContext(React.createElement(CurrentContextOwner));
    try {
      const read = await caller.execute('ui.current_context.read', {}, context);
      expect(read).toMatchObject({ ok: true, result: { commands: [{ title: 'Choose Studio Home' }] } });
      if (!read.ok || !read.result || typeof read.result !== 'object') throw new Error('Current UI context was not returned');
      const commandId = Reflect.get(read.result, 'commands')?.[0]?.id;
      expect(typeof commandId).toBe('string');
      expect(await caller.execute('ui.current_context.command.invoke', { commandId }, context)).toMatchObject({ ok: true });
      expect(invoked).toBe(1);
    } finally {
      await runtime.unmount();
      emit.mockRestore();
    }
    expect(await caller.execute('ui.current_context.read', {}, context))
      .toEqual({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });
  it('routes Work reads to the mounted Session owner instead of another connected client', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { registerMountedWorkReadOwner } = await import('./mountedWorkReadAction');
    const { projectWork } = await import('@/components/sessions/work/workProjection');
    const machine = createMachineFixture({ id: 'work-machine', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    await act(async () => {
      storage.setState(state => ({ ...state, profile: { ...state.profile!, id: 'relay-account' },
        machines: { [machine.id]: machine }, machineListByServerId: {} }));
    });
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account transport did not install its reverse receiver');
    const registered = new Set<string>();
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
      }
      return socket;
    });
    releases.push(() => emit.mockRestore());
    // Socket.IO is the only synthetic hop. An earlier-sorting connected browser
    // has the generic handler but no Work owner; exact mounted registration must win.
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE || registered.has(`${machine.id}:${method}`),
      callConnectedClientRpc: async (method, payload, options) => {
        options.onIssued();
        if (method === RPC_METHODS.UI_ACTION_EXECUTE) return { ok: true,
          result: { v: 1, execution: { ok: true, result: { status: 'unavailable' } } } };
        const wire = UiActionDispatchRequestV1Schema.parse(JSON.parse(JSON.stringify(payload)));
        const result = await new Promise<unknown>(resolve => {
          for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) receive({ method: `${machine.id}:${method}`, params: wire }, resolve);
        });
        return { ok: true, result };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    const projection = projectWork({ sessionId: 'work-lead', reportSessions: [], agentEntries: [],
      workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(), describeAgentStatus: () => '', describeProgress: () => '' });
    const runtime = await renderScreen(React.createElement(ClientActionReverseRuntime));
    let remove = () => {};
    try {
      await act(async () => {
        remove = registerMountedWorkReadOwner({ scope: { serverId, accountId: 'relay-account' }, sessionId: 'work-lead',
          isCurrent: () => true, read: () => ({ projection, transcriptLoaded: true,
            managedRuns: { phase: 'loaded', refreshFailed: false } }) });
      });
      const context = { surface: 'cli', authority: 'present_user', serverId } as const;
      expect(await caller.execute('session.work.get', { sessionId: 'work-lead' }, context))
        .toMatchObject({ ok: true, result: { status: 'ready', sessionId: 'work-lead', summary: projection.summary, items: [] } });
      expect(await caller.execute('session.work.get', { sessionId: 'unmounted' }, context))
        .toEqual({ ok: true, result: { status: 'unavailable' } });
      await act(async () => { remove(); });
      expect(await caller.execute('session.work.get', { sessionId: 'work-lead' }, context))
        .toEqual({ ok: true, result: { status: 'unavailable' } });
    } finally { await act(async () => { remove(); }); await runtime.unmount(); }
  });
  it('routes driver Library Actions through the mounted client registration and strict receiver', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const { useWorkflowLibraryView } = await import('@/components/workflows/library/useWorkflowLibraryView');
    const rows: Parameters<typeof useWorkflowLibraryView>[0] = [];
    function LibraryOwner() {
      useWorkflowLibraryView(rows, null, true);
      return null;
    }
    const machine = createMachineFixture({ id: 'driver-machine', activeAt: Date.now(), storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    await act(async () => {
      storage.setState(state => ({ ...state, profile: { ...state.profile!, id: 'relay-account' },
        machines: { [machine.id]: machine }, machineListByServerId: {} }));
    });
    const socket = clientSockets.slice().reverse().find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
    if (!socket) throw new Error('Account transport did not install its reverse receiver');
    const registered = new Set<string>();
    // Socket.IO delivery is the external boundary. Production Runtime registration,
    // ApiSocket decoding, both Action executors and the Library controller stay real.
    const emit = vi.spyOn(socket, 'emit').mockImplementation((event, ...args) => {
      const payload: unknown = args[0];
      if (payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string') {
        if (event === SOCKET_RPC_EVENTS.REGISTER) registered.add(payload.method);
        if (event === SOCKET_RPC_EVENTS.UNREGISTER) registered.delete(payload.method);
      }
      return socket;
    });
    releases.push(() => emit.mockRestore());
    const reverse = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => registered.has(`${machine.id}:${method}`),
      callConnectedClientRpc: async (method, payload, options) => {
        const wire = UiActionDispatchRequestV1Schema.parse(JSON.parse(JSON.stringify(payload)));
        options.onIssued();
        const result = await new Promise<unknown>(resolve => {
          for (const receive of socket.listeners(SOCKET_RPC_EVENTS.REQUEST)) {
            receive({ method: `${machine.id}:${method}`, params: wire }, resolve);
          }
        });
        return { ok: true, result };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute: reverse } as unknown as ActionExecutorDeps);
    const context = { surface: 'mcp' as const, authority: 'account_automation' as const,
      defaultSessionId: 'driver-session', defaultSessionMachineId: machine.id };
    const library = await renderScreen(React.createElement(LibraryOwner));
    // A mounted Library alone cannot answer a driver: its client transport must be bound.
    expect(await caller.execute('workflow.library.view.get', {}, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    expect(await caller.execute('home.runtime.get', { force: true }, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
    const runtime = await renderScreen(React.createElement(ClientActionReverseRuntime));
    expect(await caller.execute('home.runtime.get', { force: true }, context))
      .toMatchObject({ ok: true, result: { status: 'ready' } });
    expect(await caller.execute('workflow.library.view.get', {}, context)).toEqual({ ok: true,
      result: ScopeActionOutputSchemas['workflow.library.view.get'].parse({ view: 'all', searchQuery: '', offeredViews: ['all'], visibleKeys: [] }) });
    await act(async () => {
      expect(await caller.execute('workflow.library.view.set', { searchQuery: 'QA-FIN35c' }, context))
        .toEqual({ ok: true, result: { ok: true } });
    });
    expect(await caller.execute('workflow.library.view.get', {}, context)).toMatchObject({ ok: true, result: { searchQuery: 'QA-FIN35c' } });
    await library.unmount();
    expect(await caller.execute('workflow.library.view.get', {}, context))
      .toMatchObject({ ok: false, errorCode: 'client_surface_unavailable' });
    await runtime.unmount();
    expect(await caller.execute('workflow.library.view.get', {}, context))
      .toMatchObject({ ok: false, errorCode: 'unavailable', error: 'noClient' });
  });
  it('reaches the captured Home registry owner through the public app Settings executor after focus changes', async () => {
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const anchor = `homeAdministration.serverSettings.${key}`;
    const otherServerId = await homes.addHome({ name: 'Other', serverUrl: 'https://other.test', accountId: 'other-account', active: false });
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'home.settings.set': ['ui'] } },
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { select: async () => {
      await setActiveServerId(otherServerId, { scope: 'device' });
      return { body: projection(600) };
    } });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const result = await createDefaultActionExecutor().execute('settings.set', { anchor, value: 900 }, {
      surface: 'ui', serverId, expectedAccountId: 'relay-account',
    });
    expect(result).toEqual({ ok: true, result: { anchor, value: 900 } });
    expect(homes.requestsFor('/v1/home/settings/get').map(request => request.serverId)).toEqual([serverId]);
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([expect.objectContaining({ serverId,
      input: { expectedRevision: 3, values: { [key]: 900 } } })]);
  });
  it.each([
    { owner: 'Home', anchor: 'homeAdministration.serverSettings.HAPPIER_API_CORS_MAX_AGE_SECONDS', value: 900, actionId: 'home.settings.set' },
    { owner: 'Follow', anchor: 'coordination.autoFollowAssigned', value: true, actionId: 'follow.preferences.set' },
  ] as const)('never turns an outer Settings-only credential grant into ambient $owner administrative authority', async ({ anchor, value, actionId }) => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    // A legitimate domain policy waiver must not waive the requester's credential grant.
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
      approvalWaivedSurfaces: { [actionId]: ['agent'] },
    });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1,
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { body: projection(600) });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const followPath = getActionSpec('follow.preferences.get').serverTransport?.path;
    if (!followPath) throw new Error('Follow preference transport is undeclared');
    homes.answer(serverId, `GET ${followPath}`, { body: { assigned: false, direct: true, team: false, group: true } });
    homes.answer(serverId, `PUT ${followPath}`, { body: { assigned: true, direct: true, team: false, group: true } });
    // Home/Follow declarations now execute at their owning host. The strict
    // reverse-dispatch schema rejects them because they are no longer client-placed.
    const caller = createDefaultActionExecutor();
    const result = await caller.execute('settings.set', { anchor, value }, {
      surface: 'agent', authority: 'account_automation', serverId, bypassApprovals: true,
      actionRequestId: 'restricted-settings-root', externalActionCredential: {
        accountId: 'relay-account', principalId: 'limited-principal', credentialId: 'limited-credential',
        grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['settings.set'] } },
      },
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(homes.requestsFor('/v1/home/settings/get')).toEqual([]);
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([]);
    expect(homes.requestsFor(followPath)).toEqual([]);
    expect(homes.artifacts(serverId).list()).toEqual([]);
  });
  it.each([
    { anchor: 'homeAdministration.serverSettings.HAPPIER_API_CORS_MAX_AGE_SECONDS', value: 900, ownerId: 'home.settings.set' },
    { anchor: 'coordination.autoFollowAssigned', value: true, ownerId: 'follow.preferences.set' },
  ] as const)('routes admitted $ownerId Settings aliases through their captured domain owner', async ({ anchor, value, ownerId }) => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [ownerId]: ['ui'] } },
    } }, version: 1 } });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, approvalWaivedSurfaces: { [ownerId]: ['ui'] },
    }) } });
    homes.answer(serverId, '/v1/home/settings/get', { body: projection(600) });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const followPath = getActionSpec('follow.preferences.get').serverTransport?.path;
    if (!followPath) throw new Error('Follow preference transport is undeclared');
    homes.answer(serverId, `GET ${followPath}`, { body: { assigned: false, direct: true, team: false, group: true } });
    homes.answer(serverId, `PUT ${followPath}`, { body: { assigned: true, direct: true, team: false, group: true } });
    const caller = createDefaultActionExecutor();
    const result = await caller.execute('settings.set', { anchor, value }, {
      surface: 'ui', authority: 'present_user', serverId, bypassApprovals: true, actionRequestId: 'settings-alias-request',
    });
    expect(result).toEqual({ ok: true, result: { anchor, value } });
    const path = ownerId === 'home.settings.set' ? '/v1/home/settings/set' : followPath;
    expect(homes.requestsFor(path).every(request => request.serverId === serverId)).toBe(true);
    expect(homes.requestsFor(path)).toEqual(expect.arrayContaining([expect.objectContaining({ serverId,
      input: ownerId === 'home.settings.set' ? { expectedRevision: 3, values: { [key]: 900 } }
        : { assigned: true, direct: true, team: false, group: true },
    })]));
  });
  it('returns nested Account Home approval with original requester identity without executing the Home write', async () => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const anchor = `homeAdministration.serverSettings.${key}`;
    // UI danger writes are normally direct; this Home policy explicitly requires
    // approval and must survive the outer Settings Action's approved bypass.
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { 'home.settings.set': { approvalRequiredSurfaces: ['ui'] } },
    });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1 } });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1,
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { body: { revision: 3, startedAt: null, entries: [{ key, value: 600,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] } });
    const caller = createDefaultActionExecutor();
    expect(await caller.execute('settings.set', { anchor, value: 900 }, {
      surface: 'ui', authority: 'present_user', serverId, bypassApprovals: true, actionRequestId: 'nested-home-request',
    })).toEqual({ ok: true, result: { kind: 'approval_request_created', actionId: 'home.settings.set', artifactId: expect.any(String) } });
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([]);
    expect(homes.artifacts(serverId).list()).toHaveLength(1);
    const artifact = homes.artifacts(serverId).list()[0];
    expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!)).toMatchObject({
      executionOriginV1: { requestId: 'nested-home-request', surface: 'ui', authority: 'present_user', caller: { kind: 'host' } },
    });
  });
  it('opens one canonical editable authoring draft through the real answering-client owner', async () => {
    const actionId = ActionIdSchema.parse('session.authoring.open');
    const scope = { serverId, accountId: 'relay-account' };
    const before = listNewSessionDraftProjections(scope).length;
    const sessionsBefore = storage.getState().sessions;
    const receive = createUiClientActionReverseHandler({ ...scope, isCurrent: () => true });
    const result = await receive({ v: 1, actionId, input: { seed: {
      prompt: 'Help me author this checkout.', profileId: 'profile-review',
      placement: { kind: 'exactTarget', serverId, machineId: 'machine-authoring', directory: '/checkout' },
    } }, context: { surface: 'agent', authority: 'account_automation' } }, { signal: new AbortController().signal });
    expect(result).toMatchObject({ v: 1, execution: { ok: true, result: { kind: 'opened', destination: 'newSession' } } });
    const execution = result.execution;
    if (!execution.ok || !('result' in execution)) throw new Error('Authoring did not open');
    const acknowledgement = SessionAuthoringOpenResultV1Schema.parse(execution.result);
    if (acknowledgement.kind !== 'opened') throw new Error('Authoring did not open');
    const draft = readNewSessionDraftProjectionFromRepository({ scope, draftId: acknowledgement.draftId });
    expect(draft?.draft).toMatchObject({
      input: 'Help me author this checkout.', selectedProfileId: 'profile-review',
      selectedMachineId: 'machine-authoring', selectedPath: '/checkout',
    });
    expect(listNewSessionDraftProjections(scope)).toHaveLength(before + 1);
    expect(navigation.push).toHaveBeenLastCalledWith({ pathname: '/new', params: { draftId: acknowledgement.draftId } });
    expect(storage.getState().sessions).toBe(sessionsBefore);
  });
  it.each(['agent', 'mcp'] as const)('executes Find, Next and workspace list through the real app executor on %s', async surface => {
    const find = createFindSurfaceRegistry();
    releases.push(registerFindActionRuntime(find));
    find.register({ surfaceId: 'chat:caller-session', containsFocus: () => true,
      open() {}, isOpen: () => true, isInputFocused: () => true, controller: {
        query: 'private corpus query', options: { regex: false, matchCase: false },
        status: { kind: 'results', current: 0, total: 2, coverage: 'loaded' }, capabilities: { regex: true, stop: true },
        setQuery() {}, setOptions() {}, step() {}, stop() {}, close() {},
      } });
    let navigatedHome: string | null | undefined;
    // The mounted navigation effect is the UI boundary; Account capture, policy,
    // schemas, Action executor and runtime registry above it remain real.
    releases.push(registerPendingNavigationRuntime(async options => {
      navigatedHome = options.expectedServerId; return { status: 'opened' };
    }));
    const state = createWorkspaceState(createWorkspaceEmptyTab('visible-tab'));
    releases.push(registerMountedWorkspaceAction(async ({ actionId }) => {
      if (actionId !== 'workspace.tabs.list') throw new Error('unexpected Action');
      return projectWorkspaceTabsList(state);
    }));
    // Only the network hop is replaced. Both dispatchers and both canonical
    // executors run, including the real credential/store/network testkit.
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE
        || method === `${RPC_METHODS.UI_ACTION_EXECUTE}.session.${encodeURIComponent(JSON.stringify('caller-session'))}`,
      callConnectedClientRpc: async (_method, payload, options) => {
        expect(UiActionDispatchRequestV1Schema.parse(payload).context).toMatchObject({ surface, authority: 'account_automation' });
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute } as unknown as ActionExecutorDeps);
    const context = { surface, authority: 'account_automation' as const, defaultSessionId: 'caller-session' };
    expect(await caller.execute('ui.find', { op: 'read' }, context)).toEqual({ ok: true,
      result: { status: 'results', current: 0, total: 2, coverage: 'loaded' } });
    expect(await caller.execute('session.pending.next', {}, context)).toEqual({ ok: true, result: { status: 'opened' } });
    expect(navigatedHome).toBe(serverId);
    expect(await caller.execute('workspace.tabs.list', {}, context)).toEqual({ ok: true, result: projectWorkspaceTabsList(state) });
  });

  it.each(['ui', 'agent', 'mcp'] as const)('reuses a same-Home Voice carrier through the admitted client continuation on %s', async (surface) => {
    const previousAdapters = getVoiceAdapterRegistry().list();
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    releases.push(() => registerVoiceAdapters(previousAdapters));
    const rootId = 'teleport-root';
    const carrierId = 'teleport-carrier';
    const machine = createMachineFixture({ id: 'teleport-machine', activeAt: Date.now(),
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER });
    const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId: 'relay-account' });
    homes.answer(serverId, '/v1/machines', { body: [machineRow] });
    homes.answer(serverId, `/v1/machines/${machine.id}`, { body: { machine: machineRow } });
    const resumedCarrierIds: string[] = [];
    answerDaemonRpc = (qualifiedMethod, params, serverUrl) => {
      expect(serverUrl?.replace(/\/+$/, '')).toBe('https://relay.test');
      const separator = qualifiedMethod.indexOf(':');
      expect(qualifiedMethod.slice(0, separator)).toBe(machine.id);
      const method = qualifiedMethod.slice(separator + 1);
      if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
        // This daemon has no optional installed-plugin projection. Bundled
        // Agent identity is resolved by the real canonical catalog owner.
        return { error: 'RPC method not found', errorCode: 'RPC_METHOD_NOT_FOUND' };
      }
      if (method !== RPC_METHODS.SPAWN_HAPPY_SESSION && method !== RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
        throw new Error('Unexpected Voice daemon method: ' + method);
      }
      const resume = SessionResumeRequestV1Schema.parse(params);
      expect(resume).toMatchObject({ type: 'resume-session', sessionId: carrierId,
        directory: '/Users/tester/project', agentTarget: { kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } });
      resumedCarrierIds.push(resume.sessionId);
      return { type: 'success', sessionId: resume.sessionId };
    };
    const voice = voiceSettingsParse({ providerId: 'local_conversation', providers: {
      local_conversation: { schemaVersion: 1, config: {
        conversationMode: 'agent', agent: { stayInVoiceHome: false, teleportEnabled: true },
      } },
    } });
    const previousVoice = storage.getState().settings.voice;
    releases.push(() => storage.setState(state => ({ settings: { ...state.settings, voice: previousVoice } })));
    storage.setState(state => ({ ...state,
      settings: { ...state.settings, voice },
      machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
    }));
    const metadata = { path: '/Users/tester/project', homeDir: '/Users/tester',
      host: 'tester.local', machineId: machine.id, flavor: 'codex',
      codexBackendMode: 'appServer', codexSessionId: 'teleport-root-thread' };
    const carrierMetadata = { ...metadata,
      codexSessionId: 'teleport-carrier-thread',
      // Reuse requires the carrier's admitted permission to match the Voice recipe.
      permissionMode: 'read-only' as const,
      systemSessionV1: { v: 1 as const, key: 'voice_conversation', hidden: true },
      voiceConversationScopeV1: { v: 1 as const, kind: 'session_root' as const, sessionRootId: rootId },
    };
    storage.getState().applySessions([
      createSessionFixture({ id: rootId, serverId, metadata }),
      createSessionFixture({ id: carrierId, serverId, metadata: carrierMetadata }),
    ]);
    let carrier = createPlainSessionCurrentProjectionRecordFixture({ id: carrierId, metadata: carrierMetadata });
    const root = createPlainSessionCurrentProjectionRecordFixture({ id: rootId, metadata });
    homes.answer(serverId, `GET /v2/sessions/${rootId}${buildSessionDetailAccessProjectionQuery(serverId)}`, { body: { session: root } });
    const carrierPath = `/v2/sessions/${carrierId}`;
    homes.answer(serverId, `GET ${carrierPath}${buildSessionDetailAccessProjectionQuery(serverId)}`, { select: () => ({ body: { session: carrier } }) });
    const sessionBatch = createSessionReadBatchHttpBoundary(request => request.path === '/v2/sessions/read-batch' ? undefined
      : homes.request(request.url, { method: request.method, headers: request.headers, signal: request.signal }));
    homes.answer(serverId, 'POST /v2/sessions/read-batch', { select: async (body, request) => {
      const url = new URL(request.url);
      const response = await sessionBatch.handle({ url, path: url.pathname, home: serverId, accountId: 'relay-account',
        method: 'POST', headers: new Headers(request.init?.headers), signal: request.signal, body });
      if (!response) throw new Error('Expected the canonical Session batch fixture to respond');
      return { status: response.status, body: await response.json() };
    } });
    homes.answer(serverId, `PATCH ${carrierPath}`, { select: input => {
      // Only the Home's HTTP tuple storage/ACK is replaced; Sync's parser,
      // privacy projection, binding and carrier custody remain real.
      const patch = SessionMetadataTuplePatchV1Schema.parse(input);
      if (patch.mode !== 'owner') throw new Error('Expected an owner metadata tuple');
      expect(patch.sharedMetadata.expectedVersion).toBe(carrier.metadataVersion);
      expect(patch.agentState.expectedVersion).toBe(carrier.agentStateVersion);
      carrier = { ...carrier, metadata: patch.sharedMetadata.ciphertext,
        metadataVersion: carrier.metadataVersion + 1, ownerMetadata: patch.ownerMetadata,
        agentState: patch.agentState.ciphertext, agentStateVersion: carrier.agentStateVersion + 1 };
      return { body: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true,
        metadataLayoutVersion: 1, sharedMetadata: { version: carrier.metadataVersion },
        agentState: { version: carrier.agentStateVersion } }) };
    } });
    releases.push(() => voiceSessionBindingStore.getState().unbind(carrierId));
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    }));
    const caller = createActionExecutor({ clientActionExecute });
    const result = await caller.execute('ui.voice_agent.teleport', { sessionId: rootId },
      { surface, authority: surface === 'ui' ? 'present_user' : 'account_automation',
        ...(surface === 'agent' ? { defaultSessionId: rootId } : {}) });
    expect(result)
      .toEqual({ ok: true, result: { ok: true, sessionId: rootId } });
    expect(resumedCarrierIds).toEqual([carrierId]);
    expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID))
      .toMatchObject({ conversationSessionAddress: { serverId, sessionId: carrierId },
        targetSessionAddress: { serverId, sessionId: rootId } });
    expect(carrier.metadataVersion).toBeGreaterThan(1);
    expect(homes.requestsFor(carrierPath).every(request => request.serverId === serverId)).toBe(true);
    if (surface === 'agent') {
      const committedVersion = carrier.metadataVersion;
      storage.getState().applySessions([createSessionFixture({ id: 'another-root', serverId, metadata })]);
      expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'another-root' }, {
        surface, authority: 'account_automation', defaultSessionId: rootId,
      })).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/another-root'))).toBe(false);
      expect(carrier.metadataVersion).toBe(committedVersion);
      expect(voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID)?.targetSessionAddress)
        .toEqual({ serverId, sessionId: rootId });
    }
  });

  it('refuses Voice teleport before carrier publication when the target, provider, binding or relay is unavailable', async () => {
    const previousVoice = storage.getState().settings.voice;
    releases.push(() => storage.setState(state => ({ settings: { ...state.settings, voice: previousVoice } })));
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const connected = () => ({
      hasConnectedClientRpcHandler: (method: string) => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method: string, payload: unknown, options: { onIssued(): void; signal?: AbortSignal }) => {
        options.onIssued();
        return { ok: true as const, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    });
    const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(connected) });
    const context = { surface: 'ui' as const, authority: 'present_user' as const };
    expect(await caller.execute('ui.voice_agent.teleport', {}, context)).toMatchObject({ ok: false, errorCode: 'session_not_selected' });
    for (const [agent, code] of [
      [{ stayInVoiceHome: false, teleportEnabled: false }, 'VOICE_TELEPORT_DISABLED'],
      [{ stayInVoiceHome: true, teleportEnabled: true }, 'VOICE_TELEPORT_BLOCKED_BY_HOME'],
    ] as const) {
      storage.setState(state => ({ settings: { ...state.settings, voice: voiceSettingsParse({
        providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1,
          config: { conversationMode: 'agent', agent } } },
      }) } }));
      expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
        .toMatchObject({ ok: false, errorCode: code });
    }
    const previousAdapters = getVoiceAdapterRegistry().list();
    registerVoiceAdapters([]);
    releases.push(() => registerVoiceAdapters(previousAdapters));
    storage.setState(state => ({ settings: { ...state.settings, voice: voiceSettingsParse({
      providerId: 'local_conversation', providers: { local_conversation: { schemaVersion: 1,
        config: { conversationMode: 'agent', agent: { stayInVoiceHome: false, teleportEnabled: true } } } },
    }) } }));
    expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
      .toMatchObject({ ok: false, errorCode: 'VOICE_TELEPORT_UNAVAILABLE' });
    storage.setState(state => ({ settings: { ...state.settings, voice: voiceSettingsParse({ providerId: 'off' }) } }));
    expect(await caller.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
      .toMatchObject({ ok: false, errorCode: 'VOICE_TELEPORT_UNAVAILABLE' });
    const unavailable = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => null) });
    expect(await unavailable.execute('ui.voice_agent.teleport', { sessionId: 'unbound-root' }, context))
      .toMatchObject({ ok: false, errorCode: 'machine_transport_unavailable' });
    expect(homes.requests.some(request => request.path.startsWith('/v2/sessions/unbound-root'))).toBe(false);
  });

  it('does not create a second approval at the trusted continuation', async () => {
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, actions: { 'ui.find': { approvalRequiredSurfaces: ['mcp'] } } },
    } }, version: 1 } });
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    expect(await receive({ v: 1, actionId: 'ui.find', input: { op: 'read' }, context: { surface: 'mcp', authority: 'account_automation' } },
      { signal: new AbortController().signal })).toEqual({ v: 1, execution: { ok: true, result: { status: 'noMountedSurface' } } });
    expect(homes.artifacts(serverId).list()).toEqual([]);
  });

  it('refuses a caller-authored bypass or another Account before disclosure', async () => {
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'another-account', isCurrent: () => true });
    const request = { v: 1, actionId: 'ui.find', input: { op: 'read' }, context: { surface: 'agent', authority: 'account_automation' } };
    expect(await receive({ ...request, context: { ...request.context, bypassApprovals: true } }, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: false, errorCode: 'invalid_action_input' } });
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: false, errorCode: 'action_account_scope_changed' } });
  });

  it('withholds a retired Account read without claiming that an effect may have happened', async () => {
    let current = true;
    const state = createWorkspaceState(createWorkspaceEmptyTab('private-tab'));
    releases.push(registerMountedWorkspaceAction(async ({ actionId }) => {
      if (actionId !== 'workspace.tabs.list') throw new Error('Unexpected Action');
      current = false;
      return projectWorkspaceTabsList(state);
    }));
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => current });
    expect(await receive({ v: 1, actionId: 'workspace.tabs.list', input: {},
      context: { surface: 'agent', authority: 'account_automation' } }, { signal: new AbortController().signal }))
      .toEqual({ v: 1, execution: { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } });
  });

  it('keeps a content-free cause when an issued client effect loses its Account before its receipt', async () => {
    let current = true;
    releases.push(registerPendingNavigationRuntime(async () => {
      current = false;
      return { status: 'none' };
    }));
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => current });
    expect(await receive({ v: 1, actionId: 'session.pending.next', input: {},
      context: { surface: 'agent', authority: 'account_automation' } }, { signal: new AbortController().signal }))
      .toEqual({ v: 1, execution: { ok: false, errorCode: 'outcome_uncertain', error: 'outcome_uncertain',
        details: { reason: 'client_account_scope_changed' } } });
  });

  it('keeps a mounted Machine continuation current when another Machine appears, and retires it on unmount', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const machine = createMachineFixture({ id: 'machine-one', activeAt: Date.now() });
    const another = createMachineFixture({ id: 'machine-two', activeAt: Date.now() });
    await act(async () => {
      storage.setState(state => ({ ...state, profile: { ...(state.profile ?? {}), id: 'relay-account' },
        machines: { [machine.id]: machine }, machineListByServerId: {} }));
    });
    // Observe the real registry, not a replacement for its retirement behavior.
    const registered = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler');
    releases.push(() => registered.mockRestore());
    const screen = await renderScreen(React.createElement(ClientActionReverseRuntime));
    const initial = registered.mock.calls.find(([id, method]) => id === machine.id && method === RPC_METHODS.UI_ACTION_EXECUTE);
    if (!initial) throw new Error('Mounted client did not register its Action handler');
    const receive = initial[2];
    const request = { v: 1, actionId: 'ui.find', input: { op: 'read' }, context: { surface: 'agent', authority: 'account_automation' } };
    expect(await receive(request, { signal: new AbortController().signal }))
      .toEqual({ v: 1, execution: { ok: true, result: { status: 'noMountedSurface' } } });
    await act(async () => {
      storage.setState(state => ({ ...state, machines: { [machine.id]: machine, [another.id]: another } }));
    });
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: true, result: { status: 'noMountedSurface' } } });
    await screen.unmount();
    expect(await receive(request, { signal: new AbortController().signal }))
      .toMatchObject({ execution: { ok: false, errorCode: 'target_unavailable' } });
  });
});
