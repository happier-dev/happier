import { createBuiltinRelayAccessSelection as relaySelection } from '@happier-dev/cli-common/relayAccess/catalog';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});
import type { SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';
import { ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { sessionUiActionClientRpcMethod } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createClientActionReverseDispatcher } from '../../../../../../cli/src/session/actions/clientActionReverseDispatch';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit/render/renderScreen';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const bridge = vi.hoisted(() => ({ specs: [] as SystemTaskSpec[], taskIds: [] as string[], sequence: 0, cancelled: [] as string[], desktopCalls: [] as string[], startError: undefined as unknown, responses: [] as { taskId: string; answer: unknown }[], listeners: new Map<string, SystemTaskBridgeListenerSet>(), extraRunnerKinds: new Set<string>(), statusRunner: null as ReturnType<typeof import('@happier-dev/cli-common/systemTasks').createSystemTasksRunner> | null }));
// Native task transport is the external boundary; admission, Action policy,
// material resolution, task construction and runner remain real.
vi.mock('@/components/systemTasks/createNativeSshBridge', () => ({ createNativeSshBridge: () => ({
    start: async (spec: SystemTaskSpec) => {
        const taskId = `relay-${++bridge.sequence}`;
        bridge.specs.push(spec); bridge.taskIds.push(taskId);
        if (bridge.startError) throw bridge.startError;
        if (bridge.statusRunner && (spec.kind === 'relay.access.status.v1' || bridge.extraRunnerKinds.has(spec.kind))) {
            await bridge.statusRunner.start({ taskId, kind: spec.kind, params: spec.params ?? {} });
        }
        return taskId;
    },
    subscribe: async (id: string, listeners: SystemTaskBridgeListenerSet) => {
        bridge.listeners.set(id, listeners);
        const kind = bridge.specs[bridge.taskIds.indexOf(id)]?.kind;
        if (bridge.statusRunner && kind && (kind === 'relay.access.status.v1' || bridge.extraRunnerKinds.has(kind))) {
            const result = await bridge.statusRunner.wait({ taskId: id });
            const snapshot = await bridge.statusRunner.poll({ taskId: id, cursor: 0 });
            snapshot.events.forEach(event => listeners.onEvent(event));
            listeners.onResult(result);
        }
        return () => { bridge.listeners.delete(id); };
    },
    cancel: async (id: string) => { bridge.cancelled.push(id); }, respond: async (taskId: string, answer: unknown) => { bridge.responses.push({ taskId, answer }); },
}) }));
const cloudflareCredentialRefs = [{ purpose: 'tunnel.manage', credentialRef: { kind: 'connectedAccount' as const,
    account: { service: { pluginId: 'happier.deploy.cloudflare', localId: 'cloudflare' }, accountId: 'account-reference' } } }];
const account = createProviderSettingsAccountHarness();
const home = account.home;
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
beforeEach(async () => { await account.reset(); });

function installDesktopCommandBoundary(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
    const internals = { invoke };
    vi.stubGlobal('__TAURI_INTERNALS__', internals);
    // Tauri's own SDK reads the WebView window; the host adapter also supports
    // globalThis. Both must describe the same genuine native command boundary.
    vi.stubGlobal('window', { __TAURI_INTERNALS__: internals,
        location: { pathname: '/', search: '', hash: '', origin: 'https://renderer.fixture.test' } });
}
async function pressProgressLogs(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const row = screen.findAllByTestId('system-task-progress-open-logs').find(node =>
        typeof node.type !== 'string' && typeof node.props.onPress === 'function');
    if (!row) throw new Error('Expected desktop native log row');
    // The painted native press wrapper intentionally discards returned promises.
    // Invoke the actual row callback once so its native effect can settle before
    // this fixture retires the OS window boundary.
    await row.props.onPress();
}
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'native');
const { storage } = await import('@/sync/domains/state/storage');
const [{ getActiveServerSnapshot }, { setActiveServerId },
    { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability }, { settingsParse },
    { getSystemTasksRunner }, { useRelayAccessControl }] = await Promise.all([
    import('@/sync/domains/server/serverRuntime'), import('@/sync/domains/server/serverProfiles'),
    import('@/sync/runtime/orchestration/appliedActiveServerRuntime'), import('@/sync/domains/settings/settings'),
    import('@/components/systemTasks/systemTasksRuntime'), import('./useRelayAccessControl'),
]);

afterEach(async () => {
    await standardCleanup();
    const [{ resetRemoteHostCatalogEngineForTests }, { resetRemoteHostCatalogSnapshotsForTests }] = await Promise.all([
        import('@/sync/engine/settings/remoteHostCatalogEngine'), import('@/sync/store/settings/remoteHostCatalogSnapshot'),
    ]);
    // This suite recreates the same Home/Account at its HTTP boundary. Retained
    // observer-gap state belongs to the previous fixture, not that new Account.
    resetRemoteHostCatalogEngineForTests();
    resetRemoteHostCatalogSnapshotsForTests();
    publishAppliedActiveServerRuntimeAvailability(false);
    await account.reset();
    bridge.specs.length = 0;
    bridge.taskIds.length = 0;
    bridge.cancelled.length = 0;
    bridge.desktopCalls.length = 0;
    bridge.startError = undefined;
    bridge.statusRunner = null;
    bridge.extraRunnerKinds.clear();
    bridge.responses.length = 0;
    bridge.listeners.clear();
    vi.unstubAllGlobals();
});

async function openRelay(actionsSettingsV1: unknown, identity?: Readonly<{ accountId: string; serverIdentityId: string }>, local = false) {
    const accountId = identity?.accountId ?? 'account';
    const { serverId } = await account.restore({ accountId, machines: [], settings: settingsParse({ actionsSettingsV1 }),
        ...(identity ? { serverIdentityId: identity.serverIdentityId } : {}) });
    const scope = { serverId, accountId };
    const issued = getActiveServerSnapshot();
    home.answer(serverId, '/v2/account/settings/history', { body: { snapshots: [] } });
    home.answer(serverId, '/v1/account/entity-rows/profiles/transfer', { body: { status: 'absent' } });
    const host = { id: 'issued-host', name: 'Issued host', createdAt: 1, updatedAt: 2, lastUsedAt: null,
        ssh: { target: 'dev@private.example', authMode: 'agent' as const } };
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { body: { status: 'present', revision: 4,
        content: { t: 'plain', v: { v: 1, hosts: [host] } } } });
    const relay = await renderHook(() => useRelayAccessControl({ runner: getSystemTasksRunner(),
        ...(local ? { actionScope: scope } : {}),
        target: { kind: 'ssh', ssh: { target: 'display-only@wrong.example', auth: 'agent' } }, upstreamUrl: 'https://wrong.test',
        ...(local ? { target: { kind: 'local' as const } } : { remoteHost: { scope, hostId: host.id, expectedRevision: 4 } }) }));
    return { relay, host, serverId, issued };
}

it('signed-in local Reach and Runtime controls obey disabled Actions before native launch', async () => {
    const { relay, serverId } = await openRelay({ v: 1, actions: {
        'relay.access.status': { enabled: false }, 'relay.access.configure': { enabled: false },
        'relay.access.disable': { enabled: false }, 'relay.runtime.status': { enabled: false },
        'relay.runtime.start': { enabled: false },
    } }, undefined, true);
    const { useLocalRelayRuntimeControl } = await import('../localControl/useLocalRelayRuntimeControl');
    const runtime = await renderHook(() => useLocalRelayRuntimeControl({ runner: getSystemTasksRunner(),
        actionScope: { serverId, accountId: 'account' } }));
    await act(async () => {
        expect(await relay.getCurrent().configure({ config: relaySelection('lan', { url: 'https://relay.test' }) })).toBeNull();
        expect(await relay.getCurrent().disable()).toBeNull();
        await runtime.getCurrent().startRelay();
    });
    expect(bridge.specs).toEqual([]);
    expect(runtime.getCurrent().lastErrorMessage).toBeTruthy();
});

it('signed-in device Runtime without a Personal Home receipt obeys active Account policy', async () => {
    const { serverId } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false },
        'relay.runtime.status': { enabled: false }, 'relay.runtime.start': { enabled: false },
        'relay.access.status': { enabled: false }, 'relay.access.configure': { enabled: false } } });
    const { useLocalRelayRuntimeControl } = await import('../localControl/useLocalRelayRuntimeControl');
    const runtime = await renderHook(() => useLocalRelayRuntimeControl({ runner: getSystemTasksRunner() }));
    const reach = await renderHook(() => useRelayAccessControl({ runner: getSystemTasksRunner() }));
    await waitForHomeGovernance(() => expect(runtime.getCurrent().actionServerId).toBe(serverId));
    await waitForHomeGovernance(() => expect(reach.getCurrent().actionServerId).toBe(serverId));
    await act(async () => { await runtime.getCurrent().startRelay(); });
    await act(async () => {
        expect(await reach.getCurrent().configure({ config: relaySelection('lan', { url: 'https://relay.test' }) })).toBeNull();
    });
    expect(bridge.specs).toEqual([]);
    expect(runtime.getCurrent().lastErrorMessage).toBeTruthy();
});

it('signed-out device Runtime draft still starts at the native owner', async () => {
    await home.addHome({ name: 'Signed-out draft', serverUrl: 'https://signed-out-runtime.test', accountId: null });
    const { useLocalRelayRuntimeControl } = await import('../localControl/useLocalRelayRuntimeControl');
    const runtime = await renderHook(() => useLocalRelayRuntimeControl({ runner: getSystemTasksRunner() }));
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.status.v1')).toBe(true));
    await act(async () => { await runtime.getCurrent().startRelay(); });
    expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.start.v1')).toBe(true);
});

it('signed-in Runtime admission keeps configured approval pending then adopts the existing runner task exactly once', async () => {
    const { serverId } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false },
        'relay.runtime.start': { approvalRequiredSurfaces: ['ui'] } } });
    const { useLocalRelayRuntimeControl } = await import('../localControl/useLocalRelayRuntimeControl');
    const runtime = await renderHook(() => useLocalRelayRuntimeControl({ runner: getSystemTasksRunner(),
        actionScope: { serverId, accountId: 'account' } }));
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.status.v1')).toBe(true));
    let pending!: Promise<void>;
    await act(async () => { pending = runtime.getCurrent().startRelay(); });
    await waitForHomeGovernance(() => expect(runtime.getCurrent().approval.approvalPending).toBe(true));
    expect(runtime.getCurrent().isBusy).toBe(true);
    expect(bridge.specs.filter(spec => spec.kind === 'relay.runtime.start.v1')).toEqual([]);
    const artifactId = runtime.getCurrent().approval.approvalId!;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    await act(async () => {
        expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
            { surface: 'ui', serverId, expectedAccountId: 'account' })).toMatchObject({ ok: true });
    });
    // Deliver the Artifact projection in a separate React flush; its mounted
    // continuation settles the original pending operation, not the decision.
    await waitForHomeGovernance(() => expect(runtime.getCurrent().approval.approvalPending).toBe(false));
    await act(async () => { await pending; });
    expect(bridge.specs.filter(spec => spec.kind === 'relay.runtime.start.v1')).toHaveLength(1);
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.start.v1')]!;
    expect(runtime.getCurrent().activeTaskSnapshot).toMatchObject({ taskId, status: 'running', result: null });
    await act(async () => {
        await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
            { surface: 'ui', serverId, expectedAccountId: 'account' });
    });
    expect(bridge.specs.filter(spec => spec.kind === 'relay.runtime.start.v1')).toHaveLength(1);
    // A read joins this runner directly, without a second task lifecycle or task-id registry.
    const statusId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.status.v1')]!;
    expect(getSystemTasksRunner().getTaskSpec?.(statusId)).toMatchObject({ kind: 'relay.runtime.status.v1' });
});

it('opening the first Inbox approval retains the live Relay author and its native configuration exactly once', async () => {
    const { serverId } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false },
        'relay.access.configure': { approvalRequiredSurfaces: ['ui'] } } });
    storage.setState({ isDataReady: true });
    const [{ WorkspaceProvider }, { DestinationInstanceHost }, { resolveCompactAppDestinations, hrefForDestinationRef },
        { RelayAccessControlSection }, { createRelayAccessStatusTaskKind, createSystemTasksRunner }, { getRelayAccessProvider },
        { createDefaultActionExecutor }] = await Promise.all([
        import('@/components/appShell/workspace/WorkspaceProvider'),
        import('@/components/appShell/workspace/DestinationInstanceHost'),
        import('@/components/appShell/destinations/compactAppDestinationCatalog'),
        import('./RelayAccessControlSection'), import('@happier-dev/cli-common/systemTasks'),
        import('@happier-dev/cli-common/relayAccess'), import('@/sync/ops/actions/defaultActionExecutor'),
    ]);
    bridge.statusRunner = createSystemTasksRunner({ kinds: {
        'relay.access.status.v1': createRelayAccessStatusTaskKind({ readConfig: async () => null,
            getProvider: getRelayAccessProvider, createExecutionContext: () => ({ env: { NODE_ENV: 'test' }, upstreamUrl: null }) }),
    } });
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: true, workflows: false, friends: false,
    } });
    let mounts = 0;
    let retirements = 0;
    function RelayAuthor() {
        React.useEffect(() => { mounts += 1; return () => { retirements += 1; }; }, []);
        return <RelayAccessControlSection runner={getSystemTasksRunner()} actionScope={{ serverId, accountId: 'account' }} />;
    }
    // The real provider/adapter/router and destination host own retention. This
    // minimal outlet only substitutes Expo's native scene-loading boundary.
    const screen = await renderScreen(<WorkspaceProvider enabled catalog={catalog}>
        {navigation => <>
            {React.createElement('RelayWorkspaceState', { navigation })}
            {Object.values(navigation.state.tabs).map(tab => {
                const focused = Object.values(navigation.state.groups).some(group => group.activeTabId === tab.id);
                return <DestinationInstanceHost key={tab.id} tabId={tab.id} ref={tab.target}
                    pathname={hrefForDestinationRef(catalog, tab.target)?.split('?')[0] ?? '/'} focused={focused} visible={focused}
                    navigation={navigation.navigationForTab(tab.id)}>
                    {tab.target.kind === 'inbox' ? React.createElement('RelayApprovalReview', { artifactId: tab.target.params.id }) : <RelayAuthor />}
                </DestinationInstanceHost>;
            })}
        </>}
    </WorkspaceProvider>);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('settings.server.relayAccess.choice:lan')
        .some(node => node.props.disabled === false)).toBe(true));
    await screen.pressByTestIdAsync('settings.server.relayAccess.choice:lan');
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.server.relayAccess.lanUrl')).not.toBeNull());
    // A method whose declared fields are incomplete cannot be saved: Save waits for the URL.
    expect(screen.findAllByTestId('settings.server.relayAccess.save').every(node => node.props.disabled === true)).toBe(true);
    await act(async () => {
        screen.changeTextByTestId('settings.server.relayAccess.lanUrl', 'https://user:fixture-only-relay-material@relay.fixture.test/relay');
    });
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('settings.server.relayAccess.save').some(node => node.props.disabled === false)).toBe(true));
    // Save's live continuation intentionally waits for the human decision.
    // Fire the actual control without awaiting that decision in this test turn.
    await act(async () => { screen.pressByTestId('settings.server.relayAccess.save'); });
    const created = await waitForHomeGovernance(() => {
        const row = home.artifacts(serverId).list().find(row => {
            const body = home.artifacts(serverId).readPlainBody(row.id);
            return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
        });
        expect(row).toBeDefined();
        return row!;
    });
    const request = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(created.id) ?? 'null'));
    expect(request).toMatchObject({ actionId: 'relay.access.configure', status: 'open', approval: { flow: 'blocking' } });
    expect(JSON.stringify(request).includes('fixture-only-relay-material')).toBe(false);
    const { getSharedBlockingApprovalCoordinator } = await import('@happier-dev/protocol/actions/blockingApprovalCoordinator');
    await waitForHomeGovernance(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(created.id)).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect(screen.findByTestId('home-reach-relay-approval')).not.toBeNull();
    expect(bridge.specs.filter(spec => spec.kind === 'relay.access.configure.v1').length).toBe(0);
    const notice = screen.findAllByTestId('home-reach-relay-approval').find(node => typeof node.props.onOpenApproval === 'function');
    const reviewButton = notice?.findAll(node => typeof node.type === 'string' && typeof node.props.onPress === 'function').at(-1);
    await pressTestInstanceAsync(reviewButton, 'pending approval Review button');
    await waitForHomeGovernance(() => expect(screen.root.findAllByType('RelayApprovalReview').length).toBe(1));
    expect(mounts).toBe(1);
    expect(retirements).toBe(0);
    const artifactId = screen.root.findByType('RelayApprovalReview').props.artifactId as string;
    expect(artifactId).toBeTruthy();
    await act(async () => {
        expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
            { surface: 'ui', serverId, expectedAccountId: 'account' })).toMatchObject({ ok: true });
    });
    await waitForHomeGovernance(() => expect(bridge.specs.filter(spec => spec.kind === 'relay.access.configure.v1').length).toBe(1));
    const native = bridge.specs.find(spec => spec.kind === 'relay.access.configure.v1')!;
    const config = native.params?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected native relay config');
    expect(config).toEqual(relaySelection('lan', { url: 'https://user:fixture-only-relay-material@relay.fixture.test/relay' }));
    await act(async () => {
        await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'approve' },
            { surface: 'ui', serverId, expectedAccountId: 'account' });
    });
    expect(bridge.specs.filter(spec => spec.kind === 'relay.access.configure.v1').length).toBe(1);
    expect(retirements).toBe(0);
});

it.each(['reject', 'retire'] as const)('blocking native Relay input remains private and unissued when its human continuation is %s', async decision => {
    const { relay, serverId } = await openRelay({ v: 1, actions: {
        'relay.access.status': { enabled: false },
        'relay.access.configure': { approvalRequiredSurfaces: ['ui'] },
    } }, undefined, true);
    await waitForHomeGovernance(() => expect(relay.getCurrent().actionServerId).toBe(serverId));
    let pending!: Promise<string | null>;
    await act(async () => {
        pending = relay.getCurrent().configure({ config: relaySelection('lan', {
            url: 'https://user:fixture-only-blocking-material@relay.fixture.test/relay',
        }) });
    });
    await waitForHomeGovernance(() => expect(relay.getCurrent().approval.approvalPending).toBe(true));
    const artifactId = relay.getCurrent().approval.approvalId!;
    const body = home.artifacts(serverId).readPlainBody(artifactId)!;
    expect(body.includes('fixture-only-blocking-material')).toBe(false);
    const { getSharedBlockingApprovalCoordinator } = await import('@happier-dev/protocol/actions/blockingApprovalCoordinator');
    await waitForHomeGovernance(() => expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(1));
    await act(async () => {
        if (decision === 'retire') await home.switchAccount(serverId, 'replacement-account');
        else {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' },
                { surface: 'ui', serverId, expectedAccountId: 'account' })).toMatchObject({ ok: true });
        }
    });
    await expect(pending).resolves.toBeNull();
    expect(bridge.specs.filter(spec => spec.kind === 'relay.access.configure.v1').length).toBe(0);
    expect(getSharedBlockingApprovalCoordinator().getLiveWaiterCount(artifactId)).toBe(0);
});

it('native task cancellation is scoped to the admitted Account and requests cancellation without claiming termination', async () => {
    const { serverId } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false } } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const execute = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute;
    const context = { surface: 'ui' as const, authority: 'present_user' as const,
        actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: 'account' };
    const started = await execute('relay.runtime.start', {}, context);
    expect(started).toMatchObject({ ok: true, result: { status: 'task_started' } });
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.start.v1')]!;
    const otherHome = await home.addHome({ name: 'Other Account', serverUrl: 'https://other-task.test', accountId: 'other' });
    expect(await execute('relay.runtime.task.cancel', { taskId }, { surface: 'ui', serverId: otherHome, expectedAccountId: 'other' }))
        .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'system_task_scope_mismatch' } });
    expect(bridge.cancelled).toEqual([]);
    expect(await execute('relay.runtime.task.cancel', { taskId }, context))
        .toEqual({ ok: true, result: { status: 'cancellation_requested', taskId } });
    expect(bridge.cancelled).toEqual([taskId]);
    expect(getSystemTasksRunner().getSnapshot(taskId)).toMatchObject({ status: 'canceling', result: null });
    expect(await execute('relay.runtime.task.cancel', { taskId: 'unowned-task' }, context))
        .toMatchObject({ ok: true, result: { status: 'unavailable', reason: 'system_task_not_found' } });
});

it('ending an Action observer leaves its admitted native task running until explicit task cancellation', async () => {
    const { serverId } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false } },
        approvalWaivedSurfaces: { 'relay.runtime.start': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const execute = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute;
    const observer = new AbortController();
    const pending = execute('relay.runtime.start', {}, { surface: 'mcp', serverId, expectedAccountId: 'account', signal: observer.signal });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.start.v1')).toBe(true));
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.start.v1')]!;
    await waitForHomeGovernance(() => expect(bridge.listeners.has(taskId)).toBe(true));
    observer.abort();
    expect(await pending).toEqual({ ok: true, result: { status: 'outcome_unknown', taskId } });
    expect(bridge.cancelled).toEqual([]);
    expect(getSystemTasksRunner().getSnapshot(taskId)).toMatchObject({ status: 'running', result: null });
    expect(await execute('relay.runtime.task.cancel', { taskId }, { surface: 'ui', authority: 'present_user',
        actionCaller: { kind: 'host' }, serverId, expectedAccountId: 'account' }))
        .toEqual({ ok: true, result: { status: 'cancellation_requested', taskId } });
    expect(getSystemTasksRunner().getSnapshot(taskId)).toMatchObject({ status: 'canceling', result: null });
});

it('signed-in native file choices, reveal, opening and uninstall obey the same disabled Action policy', async () => {
    // The OS command bridge is the boundary; the desktop adapter and Action owner stay real.
    installDesktopCommandBoundary(async (command: string) => {
        bridge.desktopCalls.push(command); return '/tmp/picked-backup.tar';
    });
    await openRelay({ v: 1, actions: Object.fromEntries([
        'remote_hosts.relay.access.status', 'relay.runtime.open_path', 'relay.runtime.reveal_output',
        'relay.runtime.personal_home.choose_archive', 'relay.runtime.personal_home.choose_backup_destination',
        'relay.runtime.uninstall',
    ].map(id => [id, { enabled: false }])) });
    const { usePersonalHomeRuntimeOperations } = await import('../localControl/usePersonalHomeRuntimeOperations');
    const operations = await renderHook(() => usePersonalHomeRuntimeOperations({ profiles: [] }));
    await act(async () => {
        const owner = operations.getCurrent().operations;
        await expect(owner.openDataLocation?.('/tmp/home')).rejects.toThrow();
        await expect(owner.openLogs?.('/tmp/log')).rejects.toThrow();
        await expect(owner.revealBackupOutput?.('/tmp/backup')).rejects.toThrow();
        await expect(owner.selectBackupArchive?.()).rejects.toThrow();
        await expect(owner.selectBackupExportDestination?.()).rejects.toThrow();
        await expect(owner.uninstallRuntime?.()).rejects.toThrow();
    });
    expect(bridge.desktopCalls).toEqual([]);
    expect(bridge.specs).toEqual([]);
    vi.unstubAllGlobals();
});

it('policy denial prevents both actual relay Save and Disable from issuing a bridge task', async () => {
    const { relay } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.configure': { enabled: false } } });
    await act(async () => {
        expect(await relay.getCurrent().configure({ config: relaySelection('lan', { url: 'https://relay.test' }) })).toBeNull();
        expect(await relay.getCurrent().disable()).toBeNull();
    });
    expect(bridge.specs.filter(spec => spec.kind !== 'relay.access.status.v1')).toEqual([]);
});

it('native task progress logs use the same open-path Action policy as Runtime file ports', async () => {
    await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false }, 'relay.runtime.open_path': { enabled: false } } });
    installDesktopCommandBoundary(async (command: string) => {
        // Tauri's path SDK is an OS read boundary, not another path owner.
        if (command.startsWith('plugin:path|')) return '/fixture/.happier/logs';
        bridge.desktopCalls.push(command);
    });
    const { SystemTaskProgressCard } = await import('@/components/systemTasks/SystemTaskProgressCard');
    const screen = await renderScreen(<SystemTaskProgressCard snapshot={{ taskId: 'local-runtime-task', status: 'running',
        currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null }} />);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('system-task-progress-open-logs').some(node => node.props.disabled === false)).toBe(true));
    await act(async () => { await pressProgressLogs(screen); });
    expect(bridge.desktopCalls.length).toBe(0);
});

it('native task progress logs retain their root fallback only after a native path-open failure', async () => {
    await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false } } });
    const opened: string[] = [];
    installDesktopCommandBoundary(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin:path|resolve_directory') return '/fixture';
        if (command === 'plugin:path|join') return Array.isArray(args?.paths) && args.paths.at(-1) === 'logs' ? '/fixture/.happier/logs' : '/fixture/.happier';
        if (command === 'system_tasks_open_log_path') {
            opened.push(String(args?.path));
            if (args?.path === '/fixture/.happier/logs') throw new Error('fixture native directory absent');
        }
    });
    const { SystemTaskProgressCard } = await import('@/components/systemTasks/SystemTaskProgressCard');
    const screen = await renderScreen(<SystemTaskProgressCard snapshot={{ taskId: 'local-runtime-task', status: 'running',
        currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null }} />);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('system-task-progress-open-logs').some(node => node.props.disabled === false)).toBe(true));
    await act(async () => { await pressProgressLogs(screen); });
    expect(opened).toEqual(['/fixture/.happier/logs', '/fixture/.happier']);
});

it('rejecting native task log approval does not create a root-fallback approval or native effect', async () => {
    const { serverId } = await openRelay({ v: 1, actions: { 'remote_hosts.relay.access.status': { enabled: false },
        'relay.runtime.open_path': { approvalRequiredSurfaces: ['ui'] } } });
    installDesktopCommandBoundary(async (command: string) => {
        if (command.startsWith('plugin:path|')) return '/fixture/.happier/logs';
        bridge.desktopCalls.push(command);
    });
    const { SystemTaskProgressCard } = await import('@/components/systemTasks/SystemTaskProgressCard');
    const screen = await renderScreen(<SystemTaskProgressCard snapshot={{ taskId: 'local-runtime-task', status: 'running',
        currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null }} />);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('system-task-progress-open-logs').some(node => node.props.disabled === false)).toBe(true));
    let pending!: Promise<void>;
    await act(async () => { pending = pressProgressLogs(screen); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('system-task-logs-approval')).not.toBeNull());
    expect(home.artifacts(serverId).list().length).toBe(1);
    const artifactId = home.artifacts(serverId).list()[0].id;
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    await act(async () => {
        expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' },
            { surface: 'ui', serverId, expectedAccountId: 'account' })).toMatchObject({ ok: true });
    });
    await waitForHomeGovernance(() => expect(screen.findByTestId('system-task-logs-approval')).toBeNull());
    await act(async () => { await pending; });
    expect(home.artifacts(serverId).list().length).toBe(1);
    expect(bridge.desktopCalls.length).toBe(0);
});

it('signed-out native task log outcome unknown does not issue a second root open', async () => {
    await home.addHome({ name: 'Signed-out logs draft', serverUrl: 'https://logs-draft.fixture.test', accountId: null });
    const opened: string[] = [];
    installDesktopCommandBoundary(async (command: string, args?: Record<string, unknown>) => {
        if (command === 'plugin:path|resolve_directory') return '/fixture';
        if (command === 'plugin:path|join') return Array.isArray(args?.paths) && args.paths.at(-1) === 'logs' ? '/fixture/.happier/logs' : '/fixture/.happier';
        if (command === 'system_tasks_open_log_path') {
            opened.push(String(args?.path));
            const error = new Error('fixture native open acknowledgement lost');
            markRpcRequestDisposition(error, 'outcomeUnknown');
            throw error;
        }
    });
    const { SystemTaskProgressCard } = await import('@/components/systemTasks/SystemTaskProgressCard');
    const screen = await renderScreen(<SystemTaskProgressCard snapshot={{ taskId: 'draft-runtime-task', status: 'running',
        currentStepId: null, latestMessage: null, awaitingInput: false, cancelRequested: false, events: [], result: null }} />);
    await waitForHomeGovernance(() => expect(screen.findAllByTestId('system-task-progress-open-logs').some(node => node.props.disabled === false)).toBe(true));
    await act(async () => { await pressProgressLogs(screen); });
    expect(opened).toEqual(['/fixture/.happier/logs']);
});

it('saved-host onboarding completion keeps Relay access behind the bound Home Action policy', async () => {
    const { serverId, host, issued } = await openRelay({ v: 1, actions: {
        'remote_hosts.relay.configure': { enabled: false }, 'remote_hosts.relay.access.status': { enabled: false },
    } });
    const [{ createRootLayoutFeaturesResponse }, { primeServerFeaturesSnapshot }, { useOnboardingWizardController },
        { DropdownMenu }, { createPlainAccountEncryptionCurrentnessFixture }] = await Promise.all([
        import('@/dev/testkit/fixtures/featureFixtures'), import('@/sync/api/capabilities/serverFeaturesClient'),
        import('@/components/onboarding/surfaces/useOnboardingWizardController'),
        import('@/components/ui/forms/dropdown/DropdownMenu'), import('@/dev/testkit/fixtures/accountEncryptionCurrentness'),
    ]);
    // Retained-source cleanup normalizes settings history against the Home's current settings version.
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) });
    const features = createRootLayoutFeaturesResponse({ features: {
        remoteHosts: { management: { enabled: true }, secretMaterial: { enabled: false } },
    } });
    home.answer(serverId, '/v1/features', { body: features });
    home.answer(serverId, '/v1/features/authenticated', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const [{ createRelayAccessStatusTaskKind, createSystemTasksRunner }, { getRelayAccessProvider }] = await Promise.all([
        import('@happier-dev/cli-common/systemTasks'), import('@happier-dev/cli-common/relayAccess'),
    ]);
    bridge.statusRunner = createSystemTasksRunner({ kinds: {
        'relay.access.status.v1': createRelayAccessStatusTaskKind({ readConfig: async () => null,
            getProvider: getRelayAccessProvider, createExecutionContext: () => ({ env: { NODE_ENV: 'test' }, upstreamUrl: null }) }),
    } });
    let persistedRevision = 4;
    home.answer(serverId, '/v1/account/entity-rows/remote-hosts', { select: () => ({ body: {
        status: 'present', revision: persistedRevision, content: { t: 'plain', v: { v: 1, hosts: [host] } },
    } }) });
    home.answer(serverId, 'POST /v1/account/entity-rows/remote-hosts', { select: input => {
        expect(input).toMatchObject({ mutation: { expectedRevision: 4 } });
        persistedRevision = 5;
        return { body: { status: 'updated', revision: persistedRevision, cursor: persistedRevision } };
    } });
    const [{ refreshRemoteHostCatalog }, { getRemoteHostCatalogSnapshot }, { useFeatureDecision }] = await Promise.all([
        import('@/sync/engine/settings/remoteHostCatalogEngine'), import('@/sync/store/settings/remoteHostCatalogSnapshot'),
        import('@/hooks/server/useFeatureDecision'),
    ]);
    await home.selectHomes([serverId]);
    await refreshRemoteHostCatalog({ serverId, accountId: 'account' });
    await waitForHomeGovernance(() => expect(getRemoteHostCatalogSnapshot({ serverId, accountId: 'account' })?.catalog).toMatchObject({ status: 'ready' }));
    const management = await renderHook(() => useFeatureDecision('remoteHosts.management'));
    expect(management.getCurrent()).toMatchObject({ state: 'enabled' });
    const controller: { current: ReturnType<typeof useOnboardingWizardController> | null } = { current: null };
    function WizardBody() {
        controller.current = useOnboardingWizardController({ layout: 'portrait', isDesktopShell: true, initialStepId: 'relay_select',
            authEntryOptions: { serverAvailability: 'ready', authEntryUnavailable: false, serverUrlForCopy: issued.serverUrl,
                showAuthActions: false, retryServerCheck: () => {} } });
        return <>{controller.current.body}</>;
    }
    const screen = await renderScreen(<WizardBody />);
    await screen.pressByTestIdAsync('onboarding-wizard-relay:remoteComputer');
    await act(async () => { await controller.current?.onPrimary?.(); });
    expect(controller.current?.stepId).toBe('host_relay_remote');
    await waitForHomeGovernance(() => expect(screen.findByTestId('onboarding-wizard-remote-ssh-remote-host-picker')).not.toBeNull());
    await act(async () => { screen.findByType(DropdownMenu).props.onSelect(host.id); });
    expect(controller.current?.primaryDisabled).toBe(false);
    await act(async () => { await controller.current?.onPrimary?.(); });
    expect(controller.current?.primaryDisabled).toBe(false);
    await act(async () => { await controller.current?.onPrimary?.(); });
    const setupIndex = bridge.specs.findIndex(spec => spec.kind === 'remote.ssh.manageHost.v1'
        && typeof spec.params === 'object' && spec.params !== null && 'action' in spec.params
        && spec.params.action === 'personalHome.create');
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    const setupTaskId = bridge.taskIds[setupIndex];
    await waitForHomeGovernance(() => expect(bridge.listeners.has(setupTaskId)).toBe(true));
    await act(async () => { bridge.listeners.get(setupTaskId)?.onResult({ protocolVersion: 1, taskId: setupTaskId, ok: true,
        data: { machineId: 'completed-machine', relayRuntime: { relayUrl: issued.serverUrl } } }); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('onboarding-wizard-remote-ssh-complete-checklist')).not.toBeNull());
    await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain(issued.serverUrl));
    await act(async () => { controller.current?.goToStep('relay_access'); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('settings.server.relayAccess.choice:lan')).not.toBeNull());
    await screen.pressByTestIdAsync('settings.server.relayAccess.choice:lan');
    await waitForHomeGovernance(() => expect(controller.current?.primaryDisabled).toBe(false));
    await act(async () => { await controller.current?.onPrimary?.(); });
    await waitForHomeGovernance(() => expect(screen.findByTestId('onboarding-wizard-relay-access-prereqs-url')).not.toBeNull());
    await act(async () => { screen.changeTextByTestId('onboarding-wizard-relay-access-prereqs-url', 'https://published-relay.test'); });
    await act(async () => { await controller.current?.onPrimary?.(); });
    expect(bridge.specs.filter(spec => spec.kind.startsWith('relay.access.'))).toEqual([]);
    expect(screen.getTextContent()).toContain('action_disabled');
    expect(home.artifacts(serverId).list()).toEqual([]);
});

it('an unpersisted signed-out onboarding draft retains the native Relay access route', async () => {
    const serverId = await home.addHome({ name: 'Signed-out Home', serverUrl: 'https://draft-relay.test', accountId: null });
    storage.setState({ profileScope: null, settingsScope: null, settings: settingsParse({}) });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), true);
    const [{ RemoteSshChecklistStep }, { RelayAccessConfigFieldsStep }, { createRootLayoutFeaturesResponse },
        { primeServerFeaturesSnapshot }] = await Promise.all([
        import('@/components/onboarding/checklists/remoteSsh/RemoteSshChecklistStep'),
        import('@/components/onboarding/steps/relayAccess/RelayAccessConfigFieldsStep'),
        import('@/dev/testkit/fixtures/featureFixtures'), import('@/sync/api/capabilities/serverFeaturesClient'),
    ]);
    const features = createRootLayoutFeaturesResponse({ features: { remoteHosts: {
        management: { enabled: false }, secretMaterial: { enabled: false },
    } } });
    home.answer(serverId, '/v1/features', { body: features });
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    await home.selectHomes([serverId]);
    type Completion = Parameters<NonNullable<React.ComponentProps<typeof RemoteSshChecklistStep>['onCompleted']>>[0];
    type Primary = Parameters<NonNullable<React.ComponentProps<typeof RemoteSshChecklistStep>['onWizardPrimaryChange']>>[0];
    const callbacks: { completion: Completion | null; primary: Primary } = { completion: null, primary: null };
    const screen = await renderScreen(<RemoteSshChecklistStep testID="draft-setup" mode="remoteRelayHost"
        relayUrl="https://draft-relay.test" initialDraft={{ username: 'dev', host: 'draft.example', authMode: 'agent' }}
        onWizardPrimaryChange={next => { callbacks.primary = next; }} onCompleted={next => { callbacks.completion = next; }} />);
    await act(async () => { await callbacks.primary?.onPress(); });
    await act(async () => { await callbacks.primary?.onPress(); });
    const setupTaskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'remote.ssh.manageHost.v1')];
    expect(setupTaskId).toBeDefined();
    await waitForHomeGovernance(() => expect(bridge.listeners.has(setupTaskId)).toBe(true));
    await act(async () => { bridge.listeners.get(setupTaskId)?.onResult({ protocolVersion: 1, taskId: setupTaskId, ok: true,
        data: { relayRuntime: { relayUrl: 'https://draft-relay.test' } } }); });
    await waitForHomeGovernance(() => expect(callbacks.completion).not.toBeNull());
    // The actual completion producer supplies the draft's native material resolver.
    // Signed-out device credentials remain absent; no Account authority is fabricated.
    const completed = callbacks.completion;
    if (!completed) throw new Error('Draft completion was not published');
    const definition = (await import('@/components/onboarding/steps/relayAccess/relayAccessConfigStepCatalog')).relayAccessConfigStepCatalog.lan;
    await act(async () => { screen.update(<RelayAccessConfigFieldsStep definition={definition} testID="draft-access" upstreamUrl="https://draft-relay.test"
        target={completed.relayAccessTarget ?? undefined} remoteHost={completed.relayAccessRemoteHost}
        runWithTarget={completed.runWithRelayAccessTarget} onWizardPrimaryChange={next => { callbacks.primary = next; }} />); });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.access.status.v1')).toBe(true));
    const statusIndex = bridge.specs.findIndex(spec => spec.kind === 'relay.access.status.v1');
    await waitForHomeGovernance(() => expect(bridge.listeners.has(bridge.taskIds[statusIndex])).toBe(true));
    const statusTaskId = bridge.taskIds[statusIndex];
    await act(async () => { bridge.listeners.get(statusTaskId)?.onResult({ protocolVersion: 1, taskId: statusTaskId, ok: true,
        data: { configured: false, providerId: null, selection: null, status: { state: 'disabled', shareUrl: null, details: null } } }); });
    await act(async () => { screen.changeTextByTestId('draft-access-url', 'https://draft-published.test'); });
    expect(callbacks.primary?.disabled).toBe(false);
    await act(async () => { await callbacks.primary?.onPress(); });
    expect(bridge.specs.find(spec => spec.kind === 'relay.access.configure.v1')).toMatchObject({ params: {
        target: { kind: 'ssh', ssh: { target: 'dev@draft.example' } }, config: relaySelection('lan', { url: 'https://draft-published.test' }),
    } });
    expect(home.artifacts(serverId).list()).toEqual([]);
});

it('a non-UI client runtime Action waits on its own native runner and returns the terminal failure', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.restart': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const execute = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute;
    const context = { surface: 'mcp' as const, serverId, expectedAccountId: 'account' };
    let settled = false;
    const pending = execute('relay.runtime.restart', { runtimeTarget: { channel: 'preview', mode: 'user' } }, context)
        .then(outcome => { settled = true; return outcome; });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.restart.v1')).toBe(true));
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.restart.v1')];
    await waitForHomeGovernance(() => expect(bridge.listeners.has(taskId)).toBe(true));
    expect(settled).toBe(false);
    const terminal = { protocolVersion: 1 as const, taskId, ok: false as const, error: { code: 'restart_failed', message: 'Runtime could not start' } };
    bridge.listeners.get(taskId)?.onResult(terminal);
    expect(await pending).toEqual({ ok: true, result: { status: 'completed', taskId, result: terminal } });
    expect(getSystemTasksRunner().getTaskSpec?.(taskId)).toMatchObject({ kind: 'relay.runtime.restart.v1', params: { channel: 'preview', mode: 'user' } });
});

it('a native restart Action preserves a dispatched start with a lost acknowledgement', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.restart': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    bridge.startError = markRpcRequestDisposition(new Error('Native acknowledgement lost'), 'outcomeUnknown');
    const outcome = await createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.runtime.restart', {}, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.restart.v1')).toBe(true);
    expect(outcome).toEqual({ ok: true, result: { status: 'outcome_unknown' } });
});

it('an agent-started erase presents the native target for human consent and respects cancellation', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.personal_home.erase': ['mcp'] } });
    const [{ createDefaultActionExecutor }, { Modal }] = await Promise.all([
        import('@/sync/ops/actions/defaultActionExecutor'), import('@/modal'),
    ]);
    // The user-facing Modal presenter is a genuine UI boundary; native preview parsing remains real.
    const show = vi.spyOn(Modal, 'show').mockImplementation(config => {
        const cancel = config.props?.onCancel;
        if (typeof cancel === 'function') queueMicrotask(() => cancel());
        return 'erase-preview';
    });
    const pending = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.runtime.personal_home.erase', { purpose: { kind: 'personal-home', canonicalServerUrl: 'https://erase.test' } },
        { surface: 'mcp', serverId, expectedAccountId: 'account' });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(true));
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.personal_home.erase.v1')];
    await waitForHomeGovernance(() => expect(bridge.listeners.has(taskId)).toBe(true));
    bridge.listeners.get(taskId)?.onEvent({ protocolVersion: 1, taskId, type: 'prompt', tsMs: 1, stepId: 'erase', data: {
        kind: 'personal_home.confirm_erase.v1', canonicalServerUrl: 'https://erase.test', homeServerIdentityId: 'erase-home',
        paths: ['/owned/home'], estimatedBytes: 100, previewComplete: true, previewReason: null,
    } });
    try {
        expect(getSystemTasksRunner().getSnapshot(taskId)).toMatchObject({ status: 'running', awaitingInput: true });
        expect(getSystemTasksRunner().listPromptContinuations?.().map(task => task.taskId)).toContain(taskId);
        await waitForHomeGovernance(() => expect(show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ canonicalServerUrl: 'https://erase.test', homeServerIdentityId: 'erase-home', paths: ['/owned/home'] }),
        })));
        await waitForHomeGovernance(() => expect(bridge.responses).toContainEqual({ taskId, answer: { confirmed: false } }));
        expect(bridge.specs.filter(spec => spec.kind === 'daemon.service.relay.disconnect.v1')).toEqual([]);
    } finally {
        bridge.listeners.get(taskId)?.onResult({ protocolVersion: 1, taskId, ok: false, error: { code: 'not_confirmed', message: 'Erase refused' } });
        await pending;
        show.mockRestore();
    }
});

it('an agent-started erase refuses an incomplete native preview rather than leaving the task unanswered', async () => {
    const { serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.runtime.personal_home.erase': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const pending = createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.runtime.personal_home.erase', { purpose: { kind: 'personal-home', canonicalServerUrl: 'https://erase.test' } },
        { surface: 'mcp', serverId, expectedAccountId: 'account' });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.runtime.personal_home.erase.v1')).toBe(true));
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.runtime.personal_home.erase.v1')];
    await waitForHomeGovernance(() => expect(bridge.listeners.has(taskId)).toBe(true));
    bridge.listeners.get(taskId)?.onEvent({ protocolVersion: 1, taskId, type: 'prompt', tsMs: 1, stepId: 'erase', data: {
        kind: 'personal_home.confirm_erase.v1', canonicalServerUrl: 'https://erase.test', homeServerIdentityId: 'erase-home',
        paths: ['/owned/home'], estimatedBytes: 100, previewComplete: false, previewReason: 'inspection_failed',
    } });
    try {
        expect(getSystemTasksRunner().getSnapshot(taskId)).toMatchObject({ status: 'running', awaitingInput: true });
        expect(getSystemTasksRunner().listPromptContinuations?.().map(task => task.taskId)).toContain(taskId);
        await waitForHomeGovernance(() => expect(bridge.responses).toContainEqual({ taskId, answer: { confirmed: false } }));
    } finally {
        bridge.listeners.get(taskId)?.onResult({ protocolVersion: 1, taskId, ok: false, error: { code: 'not_confirmed', message: 'Erase refused' } });
        await pending;
    }
});

it('a non-UI remote relay configure Action observes its admitted native task to completion', async () => {
    const { serverId, host } = await openRelay({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.relay.configure': ['mcp'] } });
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const pending = createDefaultActionExecutor().execute('remote_hosts.relay.configure', {
        hostId: host.id, expectedRevision: 4,
        operation: { kind: 'configure', config: relaySelection('lan', { url: 'https://relay.test' }) },
    }, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.access.configure.v1')).toBe(true));
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.access.configure.v1')];
    await waitForHomeGovernance(() => expect(bridge.listeners.has(taskId)).toBe(true));
    const terminal = { protocolVersion: 1 as const, taskId, ok: false as const,
        error: { code: 'configure_failed', message: 'Relay configuration failed' } };
    bridge.listeners.get(taskId)?.onResult(terminal);
    expect(await pending).toEqual({ ok: true, result: { status: 'completed', taskId, result: terminal } });
});

it('an agent remote relay task retains human SSH trust and passphrase decisions through terminal settlement', async () => {
    const { serverId, host } = await openRelay({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.relay.configure': ['mcp'] } });
    const [{ createDefaultActionExecutor }, { Modal }] = await Promise.all([
        import('@/sync/ops/actions/defaultActionExecutor'), import('@/modal'),
    ]);
    const confirm = vi.spyOn(Modal, 'confirm').mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const prompt = vi.spyOn(Modal, 'prompt').mockResolvedValue('human-key-passphrase');
    const pending = createDefaultActionExecutor().execute('remote_hosts.relay.configure', {
        hostId: host.id, expectedRevision: 4,
        operation: { kind: 'configure', config: relaySelection('lan', { url: 'https://relay.test' }) },
    }, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    await waitForHomeGovernance(() => expect(bridge.specs.some(spec => spec.kind === 'relay.access.configure.v1')).toBe(true));
    const taskId = bridge.taskIds[bridge.specs.findIndex(spec => spec.kind === 'relay.access.configure.v1')];
    await waitForHomeGovernance(() => expect(bridge.listeners.has(taskId)).toBe(true));
    try {
        bridge.listeners.get(taskId)?.onEvent({ protocolVersion: 1, taskId, type: 'prompt', tsMs: 1, data: {
            kind: 'ssh.trustHost', host: 'private.example', fingerprint: 'SHA256:native-host-key',
        } });
        expect(getSystemTasksRunner().getSnapshot(taskId)).toMatchObject({ status: 'running', awaitingInput: true });
        expect(getSystemTasksRunner().listPromptContinuations?.().map(task => task.taskId)).toContain(taskId);
        await waitForHomeGovernance(() => expect(bridge.responses).toContainEqual({ taskId, answer: { trusted: true } }));
        expect(confirm.mock.calls[0]?.[1]).toContain('SHA256:native-host-key');
        bridge.listeners.get(taskId)?.onEvent({ protocolVersion: 1, taskId, type: 'prompt', tsMs: 2, data: {
            kind: 'ssh.privateKeyPassphrase', host: 'private.example',
        } });
        await waitForHomeGovernance(() => expect(bridge.responses).toContainEqual({ taskId, answer: { passphrase: 'human-key-passphrase' } }));
        expect(prompt).toHaveBeenCalledWith(expect.any(String), 'private.example', expect.objectContaining({ inputType: 'secure-text' }));
    } finally {
        const terminal = { protocolVersion: 1 as const, taskId, ok: false as const, error: { code: 'configure_failed', message: 'Native relay stopped' } };
        bridge.listeners.get(taskId)?.onResult(terminal);
        expect(await pending).toEqual({ ok: true, result: { status: 'completed', taskId, result: terminal } });
        confirm.mockRestore(); prompt.mockRestore();
    }
});

it('a terminal relay status Action observation consumes the real credential-free native producer result', async () => {
    const { serverId } = await openRelay({ v: 1 });
    const [{ createDefaultActionExecutor }, { createRelayAccessStatusTaskKind, createSystemTasksRunner },
        { getRelayAccessProvider }] = await Promise.all([
        import('@/sync/ops/actions/defaultActionExecutor'), import('@happier-dev/cli-common/systemTasks'),
        import('@happier-dev/cli-common/relayAccess'),
    ]);
    // Config persistence is the external boundary; the provider, status normalization,
    // native task producer, UI runner and Action result validation all remain real.
    bridge.statusRunner = createSystemTasksRunner({ kinds: {
        'relay.access.status.v1': createRelayAccessStatusTaskKind({
            readConfig: async () => (relaySelection('lan', { url: 'https://user:password@relay.example.test:8443/relay?token=relay-query-secret#relay-fragment-secret' })),
            getProvider: getRelayAccessProvider,
            createExecutionContext: () => ({ env: { NODE_ENV: 'test' }, upstreamUrl: null }),
        }),
    } });
    const outcome = await createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.access.status', {}, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    const taskId = bridge.taskIds.at(-1)!;
    const terminal = await bridge.statusRunner.wait({ taskId });
    expect(terminal).toEqual({ protocolVersion: 1, taskId, ok: true, data: {
        configured: true, providerId: 'lan',
        selection: relaySelection('lan', { url: 'https://relay.example.test:8443/relay' }), status: {
            state: 'enabled', shareUrl: 'https://relay.example.test:8443/relay', details: null,
        },
    } });
    expect(outcome).toEqual({ ok: true, result: { status: 'completed', taskId, result: terminal } });
    expect(JSON.stringify(outcome)).not.toContain('user:password');
    expect(JSON.stringify(outcome)).not.toContain('relay-query-secret');
    expect(JSON.stringify(outcome)).not.toContain('relay-fragment-secret');
});

it('preserves native operator refusal in a terminal Action and presents its localized remedy without re-polling', async () => {
    const { relay, serverId } = await openRelay({ v: 1, approvalWaivedSurfaces: { 'relay.access.disable': ['mcp'] } });
    await waitForHomeGovernance(() => expect(bridge.listeners.size).toBeGreaterThan(0));
    const [{ createDefaultActionExecutor }, { createRelayAccessStatusTaskKind, createRelayAccessDisableTaskKind, createSystemTasksRunner },
        { getRelayAccessProvider }, { TailscaleCommandError }, { t }] = await Promise.all([
        import('@/sync/ops/actions/defaultActionExecutor'), import('@happier-dev/cli-common/systemTasks'),
        import('@happier-dev/cli-common/relayAccess'), import('@happier-dev/cli-common/tailscale'), import('@/text'),
    ]);
    let nativeCommands = 0;
    let persistedConfig: unknown = relaySelection('tailscaleServe');
    const createExecutionContext = () => ({ env: {}, upstreamUrl: null,
        resolveCommandOnPath: () => '/fixture/tailscale',
        runCommand: async ({ command, args }: import('@happier-dev/cli-common/relayAccess').RelayAccessCommandRequest) => {
            nativeCommands += 1;
            throw new TailscaleCommandError('Native command refused', { command, args, exitCode: 1, stdout: '',
                stderr: "sending serve config: 401 Unauthorized: must be root, or be an operator and able to run 'sudo tailscale' to serve a path or Unix socket\n/private/operator/path token=private-token" });
        },
    });
    // Only native process execution and config storage are substituted. The
    // command classifier, provider, task runner, Action and UI presenter are real.
    bridge.statusRunner = createSystemTasksRunner({ kinds: {
        'relay.access.status.v1': createRelayAccessStatusTaskKind({
            readConfig: async () => (relaySelection('tailscaleServe')),
            getProvider: getRelayAccessProvider,
            createExecutionContext,
        }),
        'relay.access.disable.v1': createRelayAccessDisableTaskKind({
            readConfig: async () => (relaySelection('tailscaleServe')),
            writeConfig: async ({ config }) => { persistedConfig = config; },
            getProvider: getRelayAccessProvider,
            createExecutionContext,
        }),
    } });
    const outcome = await createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.access.status', {}, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    expect(outcome).toMatchObject({ ok: true, result: { status: 'completed', result: { ok: true, data: {
        status: { state: 'error', details: { code: 'tailscale_operator_authorization_refused', retryable: false } },
    } } } });
    expect(JSON.stringify(outcome)).not.toContain('/private/operator/path');
    expect(JSON.stringify(outcome)).not.toContain('private-token');
    await act(async () => { await relay.getCurrent().refreshStatus(); });
    await waitForHomeGovernance(() => expect(relay.getCurrent().lastErrorMessage)
        .toBe(t('settings.relayAccess.tailscaleOperatorAuthorizationRefused')));
    expect(nativeCommands).toBe(2);
    bridge.extraRunnerKinds.add('relay.access.disable.v1');
    const disabled = await createDefaultActionExecutor({ homeRuntimeRunner: getSystemTasksRunner() }).execute(
        'relay.access.disable', {}, { surface: 'mcp', serverId, expectedAccountId: 'account' });
    expect(disabled).toMatchObject({ ok: true, result: { status: 'completed', result: { ok: false,
        error: { code: 'tailscale_operator_authorization_refused' },
    } } });
    expect(persistedConfig).toEqual(relaySelection('tailscaleServe'));
    expect(JSON.stringify(disabled)).not.toContain('/private/operator/path');
    expect(JSON.stringify(disabled)).not.toContain('private-token');
    expect(nativeCommands).toBe(3);
});

it('an agent client open-path Action without an originating Machine opens the exact path only after approval', async () => {
    const { serverId } = await openRelay({ v: 1 });
    // OS command invocation is the genuine desktop boundary. Account admission,
    // approval creation/decision and Action policy remain the canonical owners.
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const observer = new AbortController();
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    const pending = createDefaultActionExecutor().execute('relay.runtime.open_path',
        { path: '/home/user/.happier/downloaded-app' },
        { surface: 'mcp', serverId, expectedAccountId: 'account', actionRequestId: 'open-path-human-decision', signal: observer.signal });
    try {
        const findApproval = () => home.artifacts(serverId).list().find(row => {
            const body = home.artifacts(serverId).readPlainBody(row.id);
            return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
        });
        await waitForHomeGovernance(() => expect(invoke.mock.calls.length > 0 || findApproval() !== undefined).toBe(true));
        expect(invoke).not.toHaveBeenCalled();
        const approval = findApproval()!;
        const request = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(approval.id) ?? 'null'));
        expect(request).toMatchObject({ actionId: 'relay.runtime.open_path',
            actionArgs: { path: '/home/user/.happier/downloaded-app' }, status: 'open' });
        expect(request.v === 2 && request.executionOriginV1.machineId).toBeUndefined();
        const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
        const decision = await renderHook(() => useApprovalDecisionHandler({ id: approval.id, header: null }, request, '', serverId));
        let accepted = false;
        await act(async () => { accepted = await decision.getCurrent()('approve'); });
        expect(accepted).toBe(true);
        expect(invoke.mock.calls).toEqual([['system_tasks_open_log_path', { path: '/home/user/.happier/downloaded-app' }]]);
        const retained = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(approval.id) ?? 'null'));
        expect(retained).toMatchObject({ status: 'executed', execution: { ok: true, effectAttempted: true,
            result: { status: 'completed' } } });
        await pending;
        expect(invoke.mock.calls).toEqual([['system_tasks_open_log_path', { path: '/home/user/.happier/downloaded-app' }]]);
    } finally {
        observer.abort();
        await pending;
        vi.unstubAllGlobals();
    }
});

it('the admitted daemon replay reaches the bound client and native OS without creating another approval', async () => {
    const { serverId } = await openRelay({ v: 1 }, { accountId: 'source-account', serverIdentityId: 'srv_client-source' });
    const invoke = vi.fn(async () => undefined);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke });
    const { createUiClientActionReverseHandler } = await import('@/sync/ops/actions/clientActionReverseDispatch');
    const receive = createUiClientActionReverseHandler({ serverId, accountId: 'source-account', isCurrent: () => true });
    // The genuine connected-client RPC transport is the only replaced boundary.
    // This is the projected replay context paired with the signed installed
    // daemon Session test, not an independently minted client authority.
    const admitted = {
        surface: 'agent' as const, authority: 'account_automation' as const,
        defaultSessionId: 'bob-session', defaultSessionMachineId: 'source-machine', actionRequestId: 'request-1',
        actionCaller: { kind: 'session' as const, sessionId: 'bob-session', starterDepth: 1, turnDepth: 2 },
        externalActionTarget: { kind: 'machine' as const, machineId: 'source-machine' },
    };
    const wires: unknown[] = [];
    // A Session-originated client Action is delivered to the App viewing that Session.
    const sessionMethod = sessionUiActionClientRpcMethod('bob-session');
    const dispatch = createClientActionReverseDispatcher(() => ({
        hasConnectedClientRpcHandler: method => method === sessionMethod,
        callConnectedClientRpc: async (method, payload, options) => {
            expect(method).toBe(sessionMethod);
            options.onIssued();
            wires.push(payload);
            return { ok: true, result: await receive(payload, { signal: options.signal ?? new AbortController().signal }) };
        },
    }));
    try {
        const result = await dispatch({ actionId: 'relay.runtime.open_path', input: { path: '/home/user/.happier/logs/runtime.log' }, context: admitted });
        expect(result).toEqual({ ok: true, result: { status: 'completed' } });
        expect(wires).toHaveLength(1);
        expect(UiActionDispatchRequestV1Schema.parse(wires[0]).context).toEqual(admitted);
        expect(invoke).toHaveBeenCalledWith('system_tasks_open_log_path', { path: '/home/user/.happier/logs/runtime.log' });
        expect(home.artifacts(serverId).list()).toEqual([]);
    } finally {
        vi.unstubAllGlobals();
    }
});

it('waived Save and Disable share the Action task owner and captured host/Home, ignoring staged focus', async () => {
    const { relay, host, serverId, issued } = await openRelay({ v: 1,
        approvalWaivedSurfaces: { 'remote_hosts.relay.configure': ['ui'] } });
    const focusedId = await home.addHome({ name: 'Staged Home', serverUrl: 'https://staged-relay-action.test', accountId: 'other', active: false });
    await act(async () => { await setActiveServerId(focusedId, { scope: 'device' }); });
    await act(async () => {
        expect(await relay.getCurrent().configure({ config: relaySelection('lan', { url: 'https://relay.test' }) })).not.toBeNull();
        expect(await relay.getCurrent().disable()).not.toBeNull();
    });
    expect(bridge.specs.find(spec => spec.kind === 'relay.access.configure.v1')).toMatchObject({ params: {
        upstreamUrl: issued.serverUrl, target: { kind: 'ssh', ssh: { target: host.ssh.target } },
        config: relaySelection('lan', { url: 'https://relay.test' }),
    } });
    expect(bridge.specs.find(spec => spec.kind === 'relay.access.disable.v1')).toMatchObject({ params: {
        target: { kind: 'ssh', ssh: { target: host.ssh.target } },
    } });
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').every(request => request.serverId === serverId)).toBe(true);
    expect(home.requestsFor('/v1/account/entity-rows/remote-hosts').length).toBeGreaterThan(0);
});

it.each(['configure', 'configureLan', 'configureLanCredentials', 'disable'] as const)('Account Ask first renders the safe %s intent and holds it until the live Inbox approval decision', async operation => {
    const { relay, serverId, host, issued } = await openRelay({ v: 1, actions: {
        'remote_hosts.relay.configure': { approvalRequiredSurfaces: ['ui'] },
    } });
    const operationKind = operation === 'disable' ? 'disable' : 'configure';
    const configId = operation === 'configureLan' || operation === 'configureLanCredentials' ? 'lan' : 'cloudflareNamed';
    const config = configId === 'lan'
        ? relaySelection('lan', { url: operation === 'configureLanCredentials'
            ? 'https://lan-user:lan-password@relay.example.test/relay?token=lan-query-secret#lan-fragment-secret'
            : 'http://localhost:3000' })
        : relaySelection('cloudflareNamed', { hostname: 'relay.example.test' }, cloudflareCredentialRefs);
    let pending!: Promise<string | null>;
    await act(async () => {
        pending = operationKind === 'configure'
            ? relay.getCurrent().configure({ config })
            : relay.getCurrent().disable();
    });
    const approval = await waitForHomeGovernance(() => {
        const row = home.artifacts(serverId).list().find(row => {
            const body = home.artifacts(serverId).readPlainBody(row.id);
            return body !== null && ApprovalRequestSchema.safeParse(JSON.parse(body)).success;
        });
        expect(row).toBeDefined();
        return row!;
    });
    const request = ApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(approval.id) ?? 'null'));
    expect(request).toMatchObject({ status: 'open', actionId: 'remote_hosts.relay.configure',
        approval: { flow: 'blocking', result: 'required' } });
    const { describeApprovalActionFields } = await import('@happier-dev/protocol/actions');
    const { ActionApprovalFieldsCard } = await import('@/components/approvals/ActionApprovalFieldsCard');
    const presentation = describeApprovalActionFields(request);
    const details = await renderScreen(<ActionApprovalFieldsCard presentation={presentation} serverId={serverId} />);
    const text = details.getTextContent();
    expect(text).toContain(host.id);
    expect(request.actionArgs).toMatchObject({ operation: { kind: operationKind } });
    expect(text).toContain(operationKind === 'configure' ? 'Configure relay' : 'Disable relay');
    expect(presentation.unrepresentable).toBeNull();
    if (operationKind === 'configure') {
        expect(request.actionArgs).toMatchObject({ operation: { config: { provider: { kind: 'builtin', id: configId } } } });
        if (configId === 'cloudflareNamed') expect(request.actionArgs).toMatchObject({ operation: { config: {
            credentialRefs: cloudflareCredentialRefs,
        } } });
        expect(text).toContain(operation === 'configureLanCredentials' ? 'https://relay.example.test/relay'
            : configId === 'lan' ? 'http://localhost:3000' : 'relay.example.test');
    } else {
        expect(text).not.toContain('cloudflareNamed');
        expect(text).not.toContain('relay.example.test');
    }
    for (const secret of ['lan-user', 'lan-password', 'lan-query-secret', 'lan-fragment-secret']) {
        expect(text).not.toContain(secret);
        expect(JSON.stringify(request)).not.toContain(secret);
    }
    expect(bridge.specs.filter(spec => spec.kind !== 'relay.access.status.v1')).toEqual([]);
    const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
    const decision = await renderHook(() => useApprovalDecisionHandler({ id: approval.id, header: null }, request, '', serverId));
    await act(async () => {
        expect(await decision.getCurrent()('approve')).toBe(true);
        expect(await pending).not.toBeNull();
    });
    const mutation = bridge.specs.find(spec => spec.kind === `relay.access.${operationKind}.v1`);
    expect(mutation).toMatchObject({ params: { target: { kind: 'ssh', ssh: { target: host.ssh.target } } } });
    if (operationKind === 'configure') expect(mutation).toMatchObject({ params: {
        upstreamUrl: issued.serverUrl, config,
    } });
});
