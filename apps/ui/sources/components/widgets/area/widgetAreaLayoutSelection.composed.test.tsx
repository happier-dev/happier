import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createActionExecutor, normalizeActionsSettingsV1, type ActionExecutorDeps, RPC_METHODS, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol';
import { WidgetInstanceRefV1Schema, WidgetInstanceActionOutputSchemasV1 } from '@happier-dev/protocol/widgets';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@react-navigation/native', async () => (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
// The answering app publishes Sync before loading its UI Action consumers.
await loadSyncSingletonForTests();
const { createWorkspaceState, createWorkspaceEmptyTab, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { useCorePageWidgetAreaBinding } = await import('./useCorePageWidgetAreaBinding');
const { useWidgetAreaLayout } = await import('./useWidgetAreaLayout');
const { useProjectWidgetAreaBinding } = await import('./useProjectWidgetAreaBinding');
const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
const { API_TOKEN_FULL_GRANT_V1 } = await import('@happier-dev/protocol/auth/apiTokenGrant');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createClientActionReverseDispatcher } = await import('../../../../../cli/src/session/actions/clientActionReverseDispatch');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const releases: (() => void)[] = [];
beforeEach(async () => {
    await homes.reset();
    serverId = await homes.addHome({ name: 'Home', serverUrl: 'https://area-selection.test', accountId: 'account-a' });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://area-selection.test',
        serverIdentityId: 'srv_0123456789abcdefghijklmnopqrstuv', accountId: 'account-a', request: homes.request });
});
afterEach(async () => {
    for (const release of releases.splice(0)) release();
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

it('select through the answering client changes the mounted document and refuses after unmount', async () => {
    const routeChanges: string[] = [];
    const input = { serverId, pageId: 'automation', area: 'main', context: {}, onSelectLayout: (id: string) => routeChanges.push(id), presets: [
        { id: 'overview', name: 'Overview', items: [{ kind: 'widget' as const,
            instance: { v: 1 as const, id: 'child', definition: { kind: 'builtin' as const, id: 'project_about' }, bindings: {} } }] },
        { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => {
        const binding = useCorePageWidgetAreaBinding(input);
        return { binding, layout: useWidgetAreaLayout(binding.port!, input.context) };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', placements: [{ instance: { id: 'child' } }] }));
    const surface = hook.getCurrent().binding.surface!;
    if (surface.owner.kind !== 'corePage') throw new Error('Expected core-page area');
    const owner = surface.owner;
    const receive = createUiClientActionReverseHandler({ serverId: surface.serverId, accountId: surface.accountId, isCurrent: () => true });
    const execute = async (selectedSurface: typeof surface) => (await receive({ v: 1, actionId: 'widgets.area.layout.select', input: { surface: selectedSurface },
        context: { surface: 'mcp', authority: 'account_automation', externalActionCredential: {
            accountId: surface.accountId, principalId: 'select-only', credentialId: 'select-only',
            grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['widgets.area.layout.select'] } },
        } } }, { signal: new AbortController().signal })).execution;
    await act(async () => {
        const result = await execute({ ...surface, serverId, owner: { ...owner, layoutId: 'empty' } });
        expect(result, JSON.stringify(result)).toEqual({ ok: true, result: { surface: { ...surface, serverId, owner: { ...owner, layoutId: 'empty' } } } });
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready', surface: { owner: { layoutId: 'empty' } }, placements: [] }));
    expect(routeChanges).toEqual(['empty']);
    expect(homes.artifacts(serverId).list()).toEqual([]);
    await hook.unmount();
    expect(await execute(surface)).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
});

it('refuses an ambiguous mounted area without changing either owner', async () => {
    const input = { serverId, pageId: 'twice', area: 'main', context: {}, presets: [
        { id: 'overview', name: 'Overview', items: [] }, { id: 'empty', name: 'Empty', items: [] },
    ] };
    const hook = await renderHook(() => ({ first: useCorePageWidgetAreaBinding(input), second: useCorePageWidgetAreaBinding(input) }));
    const surface = hook.getCurrent().first.surface!;
    expect(await createDefaultActionExecutor().execute('widgets.area.layout.select', {
        surface: { ...surface, owner: { ...surface.owner, layoutId: 'empty' } },
    }, { surface: 'ui', serverId: surface.serverId, expectedAccountId: surface.accountId })).toMatchObject({
        ok: false, errorCode: 'widget_area_layout_owner_ambiguous',
    });
    expect(hook.getCurrent().first.surface).toEqual(surface);
    expect(hook.getCurrent().second.surface).toEqual(surface);
    await hook.unmount();
});

it('projects an acknowledged Project removal into the mounted area', async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const scope = { serverId: 'srv_0123456789abcdefghijklmnopqrstuv', accountId: 'account-a' };
    const settings = { ...storage.getState().settings,
        actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, approvalWaivedSurfaces: {
            'widgets.item.add': ['ui'], 'widgets.item.remove': ['ui'],
        } }),
    };
    storage.getState().applySettingsForScope(scope, settings, 1);
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'project-anchor' } };
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
    const instance = { v: 1 as const, id: 'copy', definition: { kind: 'builtin' as const, id: 'usage_coach' },
        bindings: { projects: { kind: 'context' as const, slot: 'projects' },
            period: { kind: 'value' as const, value: { relative: '7days' } },
            agents: { kind: 'value' as const, value: [] }, machines: { kind: 'value' as const, value: [] },
            sources: { kind: 'value' as const, value: [] }, session: { kind: 'value' as const, value: null },
            costBasis: { kind: 'value' as const, value: 'auto' } } };
    const added = await executor.execute('widgets.item.add', { surface, instance }, context);
    expect(added).toMatchObject({ ok: true, result: { instance } });
    const input = { serverId, projectName: 'Project', projectRef: {
        id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project-anchor', createdAtMs: 1,
    } };
    const hook = await renderHook(() => {
        const binding = useProjectWidgetAreaBinding(input);
        return useWidgetAreaLayout(binding.port!, binding.context);
    });
    try {
        await vi.waitFor(() => expect(hook.getCurrent().state).toMatchObject({ status: 'ready',
            placements: expect.arrayContaining([expect.objectContaining({ instance: { ...instance } })]) }));
        await act(async () => {
            expect(await hook.getCurrent().write({ actionId: 'widgets.item.remove', instanceId: instance.id }))
                .toEqual({ kind: 'applied' });
        });
        await vi.waitFor(() => {
            const state = hook.getCurrent().state;
            expect(state.status).toBe('ready');
            if (state.status === 'ready') {
                expect(state.placements.some(row => row.instance.id === instance.id)).toBe(false);
                expect(state.isCurrent()).toBe(true);
            }
        });
    } finally { await hook.unmount(); }
});

it('delivers Project selection through both reverse dispatchers using the portable Home address', async () => {
    const scope = { serverId: 'srv_0123456789abcdefghijklmnopqrstuv', accountId: 'account-a' };
    // Seed the Account policy at its settings producer and HTTP boundary. A
    // created approval is not the named-layout mutation this fixture requires.
    const { storage } = await import('@/sync/domains/state/storage');
    const settings = { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1,
        approvalWaivedSurfaces: { 'widgets.area.layout.create': ['ui'], 'widgets.item.add': ['ui'] },
    }) };
    storage.getState().applySettingsForScope(scope, settings, 1);
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    const surface = { ...scope, owner: { kind: 'project' as const, projectId: 'project-anchor' } };
    const context = { surface: 'ui' as const, serverId: scope.serverId, expectedAccountId: scope.accountId };
    const executor = createDefaultActionExecutor();
    const created = await executor.execute('widgets.area.layout.create', { surface, layoutId: 'checks', name: 'Checks' }, context);
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(created.errorCode);
    expect(WidgetInstanceActionOutputSchemasV1['widgets.area.layout.create'].parse(created.result)).toMatchObject({ name: 'Checks' });
    const target = { ...surface, owner: { ...surface.owner, layoutId: 'checks' } };
    const instance = { v: 1 as const, id: 'constant', bindings: {}, definition: { kind: 'inline' as const, definition: {
        v: 1 as const, id: 'constant', name: 'Constant', inputs: { fields: [] },
        inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false },
        sizeDeclaration: { sizes: ['medium' as const], defaultSize: 'medium' as const }, provenance: { source: { kind: 'authored' as const } },
        body: { kind: 'declarative' as const, document: { version: 1 as const, root: { kind: 'text' as const, text: 'Constant value' } } },
    } } };
    const added = await executor.execute('widgets.item.add', { surface: target, instance }, context);
    expect(added, JSON.stringify(added)).toMatchObject({ ok: true });
    const checkout = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project-anchor', createdAtMs: 1 };
    const hook = await renderHook(() => {
        const [layoutId, setLayoutId] = React.useState<string | null>(null);
        const binding = useProjectWidgetAreaBinding({ serverId, projectName: 'Project', projectRef: checkout,
            layoutId: layoutId ?? undefined, onSelectLayout: setLayoutId });
        return { layoutId, layout: useWidgetAreaLayout(binding.port!, binding.context) };
    });
    await vi.waitFor(() => expect(hook.getCurrent().layout.state).toMatchObject({ status: 'ready' }));
    const receive = createUiClientActionReverseHandler({ ...scope, isCurrent: () => true });
    let connectedMethod: string = RPC_METHODS.UI_ACTION_EXECUTE;
    const caller = createActionExecutor({ clientActionExecute: createClientActionReverseDispatcher(() => ({
        hasConnectedClientRpcHandler: method => method === connectedMethod,
        // Only the network hop is replaced; both dispatchers and Action owners run.
        callConnectedClientRpc: async (method, payload, options) => {
            // The server selects the receiver; no client bound to this RPC is typed absence.
            if (method !== connectedMethod) return { ok: false, errorCode: RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE };
            const request = UiActionDispatchRequestV1Schema.parse(payload);
            options.onIssued();
            return { ok: true, result: await receive(request, { signal: options.signal ?? new AbortController().signal }) };
        },
    })) } as unknown as ActionExecutorDeps);
    const remoteContext = { surface: 'cli' as const, authority: 'present_user' as const, serverId: scope.serverId };
    let workspace = createWorkspaceState(createWorkspaceEmptyTab('kept'));
    const workspaceBefore = workspace;
    const navigation = createWorkspaceNavigationAdapter({ getState: () => workspace,
        getCatalog: () => resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] }),
        dispatch: action => { workspace = reduceWorkspaceState(workspace, action); },
        transport: { commit: () => {} }, createId: () => 'unexpected-tab', onChange: () => {} });
    const workspaceExecute = createWorkspaceActionAdapter({ getState: () => workspace, navigation, readCanvas: () => null, createId: () => 'unexpected-tab' });
    releases.push(registerMountedWorkspaceAction(async request => workspaceExecute(request.actionId, request.input)));
    // A client bound to another RPC must not receive either widget Action.
    connectedMethod = 'wrong-widget-rpc';
    for (const request of [
        { id: 'widgets.area.layout.select' as const, input: { surface: target } },
        { id: 'widgets.item.refresh' as const, input: { ref: { surface: target, instanceId: instance.id } } },
    ]) {
        expect(await caller.execute(request.id, request.input, remoteContext)).toMatchObject({ ok: false, error: 'noClient' });
    }
    expect(hook.getCurrent().layoutId).toBeNull();
    connectedMethod = RPC_METHODS.UI_ACTION_EXECUTE;
    await act(async () => {
        const selected = await caller.execute('widgets.area.layout.select', { surface: target }, remoteContext);
        expect(selected, JSON.stringify(selected)).toMatchObject({ ok: true });
    });
    await vi.waitFor(() => expect(hook.getCurrent().layoutId).toBe('checks'));
    expect(workspace).toBe(workspaceBefore);
    const ref = WidgetInstanceRefV1Schema.parse({ surface: target, instanceId: instance.id });
    const refreshed = await caller.execute('widgets.item.refresh', { ref }, remoteContext);
    expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ ok: false, errorCode: 'widget_refresh_unavailable' });
    await hook.unmount();
    expect(await caller.execute('widgets.area.layout.select', { surface: target }, remoteContext)).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
    expect(await caller.execute('widgets.item.refresh', { ref }, remoteContext)).toMatchObject({ ok: false, errorCode: 'widget_area_layout_owner_unavailable' });
});
