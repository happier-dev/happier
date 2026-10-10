import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema, ActionIdSchema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { SessionAuthoringOpenResultV1Schema } from '@happier-dev/protocol/plugins/ui';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createFindSurfaceRegistry } from '@/keyboard/findSurfaceRegistry';
import { registerFindActionRuntime } from '@/keyboard/findActionRuntime';
import { registerPendingNavigationRuntime } from '@/activity/source/pendingNavigationRuntime';
import { registerMountedWorkspaceAction } from '@/components/appShell/workspace/workspaceActionRuntime';
import { createWorkspaceState, createWorkspaceEmptyTab } from '@/components/appShell/workspace/workspaceState';
import { projectWorkspaceTabsList } from '@/components/appShell/workspace/workspaceActions';
import { createClientActionReverseDispatcher } from '../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { storage } from '@/sync/domains/state/storage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { listNewSessionDraftProjections } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { readNewSessionDraftProjectionFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
  const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
  return createExpoRouterMock({ router: navigation }).module;
});

installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { createUiClientActionReverseHandler } = await import('./clientActionReverseDispatch');
const releases: (() => void)[] = [];
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
beforeEach(async () => {
  await homes.reset();
  serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://relay.test', accountId: 'relay-account' });
  connection = await restoreServerAccountForTest({ serverUrl: 'https://relay.test', accountId: 'relay-account', request: homes.request });
  installHomeGovernanceBoundaries(homes);
  const features = createRootLayoutFeaturesResponse();
  if (!tryWriteServerEnabledBitInPlace(features, 'sessions.following', true)) throw new Error('Following feature is undeclared');
  homes.answer(serverId, '/v1/features', { body: features });
  homes.answer(serverId, '/v1/features/authenticated', { body: features });
  const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
  primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
  storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1 }) } });
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  standardCleanup();
  if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(homes); }
});

describe('admitted daemon-to-app Action continuation', () => {
  it('reaches the captured Home registry owner through the public app Settings executor after focus changes', async () => {
    const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
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
    { owner: 'Follow', anchor: 'notifications.autoFollowAssigned', value: true, actionId: 'session.follow.preferences.set' },
  ] as const)('never turns an outer Settings-only credential grant into ambient $owner administrative authority', async ({ anchor, value, actionId }) => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    // A legitimate Home policy waiver must not waive the requester's credential grant.
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'home.settings.set': ['cli'] } },
    } }, version: 1 } });
    homes.answer(serverId, '/v1/home/settings/get', { body: projection(600) });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const followPath = getActionSpec('session.follow.preferences.get').serverTransport?.path;
    if (!followPath) throw new Error('Follow preference transport is undeclared');
    homes.answer(serverId, `GET ${followPath}`, { body: { assigned: false, direct: true, team: false, group: true } });
    homes.answer(serverId, `PUT ${followPath}`, { body: { assigned: true, direct: true, team: false, group: true } });
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const clientActionExecute = createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
      callConnectedClientRpc: async (_method, payload, options) => {
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    }));
    // Unused process dependencies cannot be reached by this client-placed root Action.
    const caller = createActionExecutor({ clientActionExecute } as unknown as ActionExecutorDeps);
    const result = await caller.execute('settings.set', { anchor, value }, {
      surface: 'cli', authority: 'account_automation', serverId, bypassApprovals: true,
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
    { anchor: 'notifications.autoFollowAssigned', value: true, ownerId: 'session.follow.preferences.set' },
  ] as const)('routes reverse $ownerId aliases through their captured domain owner', async ({ anchor, value, ownerId }) => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const projection = (value: number) => ({ revision: 3, startedAt: null, entries: [{ key, value,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
      actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [ownerId]: ['cli'] } },
    } }, version: 1 } });
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
      v: 1, approvalWaivedSurfaces: { [ownerId]: ['cli'] },
    }) } });
    homes.answer(serverId, '/v1/home/settings/get', { body: projection(600) });
    homes.answer(serverId, '/v1/home/settings/set', { body: projection(900) });
    const followPath = getActionSpec('session.follow.preferences.get').serverTransport?.path;
    if (!followPath) throw new Error('Follow preference transport is undeclared');
    homes.answer(serverId, `GET ${followPath}`, { body: { assigned: false, direct: true, team: false, group: true } });
    homes.answer(serverId, `PUT ${followPath}`, { body: { assigned: true, direct: true, team: false, group: true } });
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, payload, options) => {
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    })) } as unknown as ActionExecutorDeps);
    const result = await caller.execute('settings.set', { anchor, value }, {
      surface: 'cli', authority: 'present_user', serverId, bypassApprovals: true, actionRequestId: 'settings-alias-request',
    });
    expect(result).toEqual({ ok: true, result: { anchor, value } });
    const path = ownerId === 'home.settings.set' ? '/v1/home/settings/set' : followPath;
    expect(homes.requestsFor(path).every(request => request.serverId === serverId)).toBe(true);
    expect(homes.requestsFor(path)).toEqual(expect.arrayContaining([expect.objectContaining({ serverId,
      input: ownerId === 'home.settings.set' ? { expectedRevision: 3, values: { [key]: 900 } }
        : { assigned: true, direct: true, team: false, group: true },
    })]));
  });
  it('returns nested Home approval with original requester identity without executing the Home write', async () => {
    const key = 'HAPPIER_API_CORS_MAX_AGE_SECONDS';
    const anchor = `homeAdministration.serverSettings.${key}`;
    homes.answer(serverId, '/v1/home/settings/get', { body: { revision: 3, startedAt: null, entries: [{ key, value: 600,
      source: 'home', fixed: false, editable: 'home', apply: 'restart', declaration: { type: 'int', section: 'server' } }] } });
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'relay-account', isCurrent: () => true });
    const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => ({
      hasConnectedClientRpcHandler: () => true,
      callConnectedClientRpc: async (_method, payload, options) => {
        options.onIssued();
        return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
      },
    })) } as unknown as ActionExecutorDeps);
    expect(await caller.execute('settings.set', { anchor, value: 900 }, {
      surface: 'cli', authority: 'present_user', serverId, bypassApprovals: true, actionRequestId: 'nested-home-request',
    })).toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'home.settings.set' } });
    expect(homes.requestsFor('/v1/home/settings/set')).toEqual([]);
    expect(homes.artifacts(serverId).list()).toHaveLength(1);
    const artifact = homes.artifacts(serverId).list()[0];
    expect(JSON.parse(homes.artifacts(serverId).readPlainBody(artifact.id)!)).toMatchObject({
      executionOriginV1: { requestId: 'nested-home-request', surface: 'cli', authority: 'present_user', caller: { kind: 'host' } },
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
      hasConnectedClientRpcHandler: method => method === RPC_METHODS.UI_ACTION_EXECUTE,
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

  it('keeps a mounted Machine continuation current when another Machine appears, and retires it on unmount', async () => {
    const { ClientActionReverseRuntime } = await import('@/components/appShell/runtime/ClientActionReverseRuntime');
    const machine = createMachineFixture({ id: 'machine-one' });
    const another = createMachineFixture({ id: 'machine-two' });
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
