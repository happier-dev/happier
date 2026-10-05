import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol';
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
  connection = await restoreServerAccountForTest({ serverUrl: 'https://relay.test', accountId: 'relay-account' });
  installHomeGovernanceBoundaries(homes);
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  standardCleanup();
  if (connection) { await connection.dispose(); connection = null; installHomeGovernanceBoundaries(homes); }
});

describe('admitted daemon-to-app Action continuation', () => {
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
