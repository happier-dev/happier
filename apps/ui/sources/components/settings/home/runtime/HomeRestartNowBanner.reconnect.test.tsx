import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture, homeSettingEntryFixture, homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { createHydratedPlainMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
const desktop = vi.hoisted(() => ({
    nextId: 0,
    starts: [] as string[],
    listeners: new Map<string, SystemTaskBridgeListenerSet>(),
    loseRestartAdmission: false,
}));
// Native system-task transport is the boundary; runner, local controller and restart flow stay real.
vi.mock('@/components/systemTasks/createTauriSystemTaskBridge', () => ({ createTauriSystemTaskBridge: () => ({
    async start(spec: { kind: string }) {
        desktop.starts.push(spec.kind);
        if (spec.kind === 'relay.runtime.restart.v1' && desktop.loseRestartAdmission) {
            throw markRpcRequestDisposition(new Error('Home connection lost'), 'outcomeUnknown');
        }
        return `desktop-${++desktop.nextId}:${spec.kind}`;
    },
    async subscribe(taskId: string, listeners: SystemTaskBridgeListenerSet) {
        desktop.listeners.set(taskId, listeners);
        if (!taskId.endsWith('relay.runtime.restart.v1')) queueMicrotask(() => listeners.onResult({
            protocolVersion: 1, taskId, ok: true,
            data: taskId.endsWith('relay.runtime.status.v1') ? {
                channel: 'stable', mode: 'user', installed: true, dataPresent: true, version: '0.3',
                relayUrl: 'http://127.0.0.1:3005', healthy: true,
                purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:3005' },
                anonymousSignupEnabled: false, service: { active: true, enabled: true },
            } : {},
        }));
        return () => { desktop.listeners.delete(taskId); };
    },
    async cancel() {},
    async respond() {},
}) }));
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});
installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        // Accept the person's transient review; Account approval and restart completion stay real.
        return createModalModuleMock({ confirmResult: true }).module;
    },
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

const loadModules = async () => {
    const store = await import('@/sync/domains/state/storage');
    const applied = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    const server = await import('@/sync/domains/server/serverRuntime');
    const settings = await import('@/hooks/home/useHomeSettings');
    const wakes = await import('@/sync/runtime/orchestration/homeAccountChange');
    const sections = await import('./HomeRuntimeSections');
    const buttons = await import('@/components/ui/buttons/RoundButton');
    const modal = await import('@/modal');
    const runtime = await import('../governance/HomeAdministrationRuntimeScreen');
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const items = await import('@/components/ui/lists/Item');
    const governanceEngine = await import('@/sync/engine/home/governance/homeGovernanceEngine');
    const governanceSnapshots = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
    return { store, applied, server, settings, wakes, sections, buttons, modal, runtime, profiles, items, governanceEngine, governanceSnapshots };
};
// Load the real runtime graph during collection, as the neighboring Home lifecycle suite does.
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
await loadSyncSingletonForTests();
const modules = await loadModules();
afterEach(async () => {
    await standardCleanup();
    modules.governanceEngine.resetHomeGovernanceEngineForTests();
    modules.governanceSnapshots.resetHomeGovernanceSnapshotsForTests();
    await connection?.dispose();
    connection = null;
    desktop.starts.length = 0;
    desktop.listeners.clear();
    desktop.loseRestartAdmission = false;
    vi.mocked(modules.modal.Modal.alert).mockClear();
    vi.mocked(modules.modal.Modal.alertAsync).mockClear();
    await home.reset();
    vi.unstubAllGlobals();
});

async function hostingHome() {
    vi.stubGlobal('isTauri', true);
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: createDesktopSecureStorageBoundary().invoke });
    const serverId = await home.addHome({ name: 'Restart Home', serverUrl: 'http://127.0.0.1:3005', accountId: 'account', serverIdentityId: 'srv_restart-home' });
    await modules.profiles.adoptPersonalHomeProfileAndComplete({
        source: 'desktop-personal-home',
        descriptor: { homeServerIdentityId: 'srv_restart-home', serverUrl: 'http://127.0.0.1:3005', canonicalServerUrl: 'http://127.0.0.1:3005' },
    });
    home.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture({ viewer: { accountId: 'account', homeRole: 'owner', status: 'active' } }) });
    waiveRestartApproval(serverId);
    await restoreHomeAccount(serverId, 'http://127.0.0.1:3005', { serverIdentityId: 'srv_restart-home' });
    modules.store.storage.getState().setSocketStatus('connected');
    return serverId;
}

async function restoreHomeAccount(serverId: string, serverUrl: string,
    options: Pick<Parameters<typeof restoreServerAccountForTest>[0], 'serverIdentityId' | 'configureSocket'> = {}) {
    const emptySessions = SessionListQueryResponseV1Schema.parse({
        sessions: [], nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
    });
    home.answer(serverId, '/v2/sessions', { body: emptySessions });
    home.answer(serverId, '/v2/sessions/query', { body: emptySessions });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
    if (!credentials) throw new Error('Restart Home credentials were not stored');
    connection = await restoreServerAccountForTest({ serverUrl, accountId: 'account',
        ...options, credentials, request: home.request,
    });
    return connection;
}

async function renderRuntime(serverId: string) {
    const screen = await renderScreen(<modules.runtime.HomeAdministrationRuntimeScreen serverId={serverId} />);
    await waitForHomeGovernance(() => {
        const ids = collectRenderedTestIds(screen.tree.toJSON());
        expect(ids.some(id => ['home-runtime-version', 'home-admin-unavailable', 'home-admin-signed-out', 'home-admin-unknown-home'].includes(id))).toBe(true);
    });
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-version');
    return screen;
}

function runtimeItem(screen: Awaited<ReturnType<typeof renderRuntime>>, testID: string) {
    const item = screen.tree.findAllByType(modules.items.Item).find(row => row.props.testID === testID);
    expect(item, testID).toBeDefined();
    return item!;
}

function waiveRestartApproval(serverId: string) {
    const settings = { ...modules.store.storage.getState().settings, actionsSettingsV1: { v: 1 as const, approvalWaivedSurfaces: {
        'home.runtime.restart': ['ui' as const],
        'relay.runtime.restart': ['ui' as const],
    } } };
    // This lifecycle suite models an Account that already allowed these restarts. The Action
    // consent suite exercises the default approval path; the real Account read remains intact.
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
    home.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 1 }) });
}

it.each(['home-runtime-pending-restart.action', 'settings.personalHomeRuntime.restart'])('hosting control %s shares busy completion and reconciles pending settings', async (controlId) => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    const screen = await renderRuntime(serverId);
    await waitForHomeGovernance(() => {
        expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(controlId);
        expect(runtimeItem(screen, 'settings.personalHomeRuntime.restart').props.disabled).toBe(false);
    });
    await screen.tree.pressByTestIdAsync(controlId);
    await waitForHomeGovernance(() => expect([...desktop.listeners.keys()].some(id => id.endsWith('relay.runtime.restart.v1'))).toBe(true));
    const restartTask = [...desktop.listeners.keys()].find(id => id.endsWith('relay.runtime.restart.v1'));
    expect(restartTask).toBeDefined();
    expect(runtimeItem(screen, 'settings.personalHomeRuntime.restart').props.disabled).toBe(true);
    expect(screen.tree.findByTestId('home-runtime-pending-restart.action')!.props.accessibilityState.disabled).toBe(true);
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1);
    const otherControl = controlId === 'settings.personalHomeRuntime.restart' ? 'home-runtime-pending-restart.action' : 'settings.personalHomeRuntime.restart';
    await screen.tree.pressByTestIdAsync(otherControl);
    expect(desktop.starts.filter(kind => kind === 'relay.runtime.restart.v1')).toHaveLength(1);

    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    home.answer(serverId, SETTINGS_GET, { body: projection(false), respondAfter: readGate });
    await act(async () => desktop.listeners.get(restartTask!)!.onResult({ protocolVersion: 1, taskId: restartTask, ok: true, data: { healthy: true } }));
    await waitForHomeGovernance(() => expect(home.requestsFor(SETTINGS_GET)).toHaveLength(2));
    expect(runtimeItem(screen, 'settings.personalHomeRuntime.restart').props.disabled).toBe(true);
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-unknown');
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain('homeGovernance.runtime.pendingRestart');
    await act(async () => releaseRead());
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-pending-restart'));
    expect(runtimeItem(screen, 'settings.personalHomeRuntime.restart').props.disabled).toBe(false);
});

it('Runtime shows initial settings failure with Retry rather than interpreting it as no pending changes', async () => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { status: 503, body: { error: 'home_unavailable' } });
    const screen = await renderRuntime(serverId);
    await waitForHomeGovernance(() => expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1));
    await act(async () => {});
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-retry');
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-unknown');
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    await screen.tree.pressByTestIdAsync('home-runtime-settings-retry');
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-pending-restart'));
    expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-settings-unknown');
});

it('keeps Home search pending until the person accepts its native review', async () => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { body: projection(false) });
    home.answer(serverId, '/v1/home/search/rebuild', { body: { ok: true } });
    await home.requireUiApproval(serverId, 'home.search.rebuild');
    let answerReview!: (accepted: boolean) => void;
    vi.mocked(modules.modal.Modal.confirm).mockImplementationOnce(() => new Promise<boolean>(resolve => { answerReview = resolve; }));
    const screen = await renderRuntime(serverId);
    await waitForHomeGovernance(() => expect(runtimeItem(screen, 'settings.personalHomeRuntime.repairSearch').props.disabled).toBe(false));
    await screen.tree.pressByTestIdAsync('settings.personalHomeRuntime.repairSearch');
    await waitForHomeGovernance(() => expect(answerReview).toBeDefined());
    expect(home.requestsFor('/v1/home/search/rebuild')).toHaveLength(0);
    expect(home.requestsFor('/v1/artifacts')).toHaveLength(0);
    expect(modules.modal.Modal.alert).not.toHaveBeenCalled();
    await act(async () => answerReview(true));
    await waitForHomeGovernance(() => expect(home.requestsFor('/v1/home/search/rebuild')).toHaveLength(1));
});

it('Runtime marks post-reconnect settings unknown after a typed read failure and Retry adopts the fresh projection', async () => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    const screen = await renderRuntime(serverId);
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-pending-restart.action'));
    desktop.loseRestartAdmission = true;
    await screen.tree.pressByTestIdAsync('home-runtime-pending-restart.action');
    expect(JSON.stringify(screen.tree.toJSON())).toContain('homeGovernance.runtime.waitingForHome');
    home.answer(serverId, SETTINGS_GET, { status: 503, body: { error: 'home_unavailable' } });
    await act(async () => modules.wakes.publishHomeAccountChange(modules.profiles.resolveServerProfileScopeIdForIdentifier(serverId), undefined, { source: 'connected' }));
    await waitForHomeGovernance(() => expect(JSON.stringify(screen.tree.toJSON())).not.toContain('homeGovernance.runtime.waitingForHome'));
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-unknown');
    expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-pending-restart');
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain('homeGovernance.runtime.waitingForHome');
    home.answer(serverId, SETTINGS_GET, { body: projection(false) });
    await screen.tree.pressByTestIdAsync('home-runtime-settings-retry');
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-settings-unknown'));
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(3);
    expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-pending-restart');
    expect(desktop.starts.filter(kind => kind === 'relay.runtime.restart.v1')).toHaveLength(1);
});

const SETTINGS_GET = '/v1/home/settings/get';
function projection(pending: boolean) {
    return homeSettingsProjectionFixture({ revision: pending ? 3 : 4, entries: [homeSettingEntryFixture('METRICS_PORT', {
        value: 9091, apply: 'restart', applied: { value: pending ? 9090 : 9091, pending },
    })] });
}

function RestartScreen(props: Readonly<{ serverId: string; surface: 'banner' | 'runtime' | 'both' }>) {
    const { useHomeSettings } = modules.settings;
    const { HomeRestartNowBanner, HomeRuntimeSection, HomeRuntimeRestartSections, countPendingRestartChanges } = modules.sections;
    const scope = { serverId: props.serverId, accountId: 'account' };
    const reads = useHomeSettings(scope, true);
    const context = { scope, homeName: 'Restart Home', projection: homeGovernanceProjectionFixture(),
        mutationsAvailable: true, approvalPending: false, refresh: () => {},
        requestApproval: () => { throw new Error('Lifecycle fixture waived restart approval'); } };
    const executor = { kind: 'connected_machine', machineId: 'host', hostName: 'Home host' } as const;
    if (props.surface === 'both') return <HomeRuntimeRestartSections context={context} executor={executor}
        release={{ version: '0.3', flavor: 'light' }} pendingCount={countPendingRestartChanges(reads.settings)} onRestarted={reads.reload} />;
    return <>
        {props.surface !== 'runtime' ? <HomeRestartNowBanner context={context} executor={executor} pendingCount={countPendingRestartChanges(reads.settings)} onRestarted={reads.reload} /> : null}
        {props.surface !== 'banner' ? <HomeRuntimeSection context={context} executor={executor} release={{ version: '0.3', flavor: 'light' }} onRestarted={reads.reload} /> : null}
    </>;
}

it.each([
    { phase: 'start', surface: 'banner', pendingAfterRestart: false, secondary: false, restartControl: 'banner' },
    { phase: 'wait', surface: 'banner', pendingAfterRestart: true, secondary: false, restartControl: 'banner' },
    { phase: 'wait_pending', surface: 'runtime', pendingAfterRestart: false, secondary: false, restartControl: 'runtime' },
    { phase: 'wait', surface: 'banner', pendingAfterRestart: false, secondary: true, restartControl: 'banner' },
    { phase: 'wait_pending', surface: 'both', pendingAfterRestart: false, secondary: false, restartControl: 'banner' },
    { phase: 'wait_pending', surface: 'both', pendingAfterRestart: false, secondary: false, restartControl: 'runtime' },
] as const)('keeps $surface truthful after $phase via $restartControl and refetches settings once on Home reconnect (secondary: $secondary)', async ({ phase, surface, pendingAfterRestart, secondary, restartControl }) => {
    const savedServerId = await home.addHome({ name: 'Restart Home', serverUrl: 'https://restart-home.test', accountId: 'account', currentAccount: true });
    waiveRestartApproval(savedServerId);
    home.answer(savedServerId, SETTINGS_GET, { body: projection(true) });
    const machineRow = createPlainMachineRowFixture({ id: 'host', accountId: 'account' });
    home.answer(savedServerId, '/v1/machines', { body: [machineRow] });
    home.answer(savedServerId, '/v1/machines/host', { body: { machine: machineRow } });
    let resolveWait!: (value: unknown) => void;
    const wait = new Promise<unknown>(resolve => { resolveWait = resolve; });
    const daemonRequests: Array<Readonly<{ method: string; payload: unknown }>> = [];
    const restored = await restoreHomeAccount(savedServerId, 'https://restart-home.test', {
        configureSocket(socket) {
            socket.connect = vi.fn<typeof socket.connect>(() => {
                socket.connected = true;
                for (const listener of socket.listeners('connect')) listener();
                return socket;
            });
            socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
            // Only the external Socket ACK is simulated; routing, scope, admission and task RPC stay real.
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                if (!request || typeof request !== 'object' || !('method' in request)
                    || typeof request.method !== 'string' || !('params' in request)) throw new Error('Malformed daemon RPC request');
                const method = request.method.slice(request.method.indexOf(':') + 1);
                daemonRequests.push({ method, payload: request.params });
                if (method === RPC_METHODS.CAPABILITIES_DETECT) return { ok: true, result: { protocolVersion: 1, results: {
                    'tool.systemTasks': { ok: true, checkedAt: 1, data: { available: true, kinds: ['relay.runtime.restart.v1'], methods: ['start', 'wait'] } },
                } } };
                const payload = request.params;
                if (!payload || typeof payload !== 'object' || !('method' in payload)) throw new Error('Malformed system-task RPC request');
                if (payload.method === 'start' && phase !== 'start') return { ok: true, result: { ok: true, result: { taskId: 'restart' } } };
                if (payload.method === 'wait' && phase === 'wait_pending') return { ok: true, result: await wait };
                throw markRpcRequestDisposition(new Error('socket has been disconnected'), 'outcomeUnknown');
            });
        },
    });
    const serverId = restored.serverId;
    modules.store.storage.getState().applyMachines([createHydratedPlainMachineFixture({ id: 'host', accountId: 'account', machine: { activeAt: Date.now() } })], true,
        { sourceServerId: serverId, sourceAccountId: 'account' });
    modules.store.storage.getState().markMachineListSettled(serverId);
    const screen = await renderScreen(<RestartScreen serverId={serverId} surface={surface} />);
    await waitForHomeGovernance(() => expect(home.requestsFor(SETTINGS_GET), JSON.stringify(screen.tree.toJSON())).toHaveLength(1));
    if (surface !== 'runtime') await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-pending-restart.action'));
    await screen.tree.pressByTestIdAsync(restartControl === 'banner' ? 'home-runtime-pending-restart.action' : 'home-runtime-restart');
    await waitForHomeGovernance(() => expect(daemonRequests.some(call => (call.payload as { method?: string }).method === (phase === 'start' ? 'start' : 'wait')), JSON.stringify({
        requests: home.requests.map(({ method, path }) => ({ method, path })),
        confirmations: vi.mocked(modules.modal.Modal.confirm).mock.calls.length,
        reviews: vi.mocked(modules.modal.Modal.show).mock.calls.map(([config]) => config.chrome?.testID),
        alerts: vi.mocked(modules.modal.Modal.alertAsync).mock.calls,
        daemonRequests,
    })).toBe(true));
    expect(JSON.stringify(screen.tree.toJSON())).toContain('homeGovernance.runtime.waitingForHome');
    expect(modules.modal.Modal.alertAsync).not.toHaveBeenCalled();
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1);
    expect(screen.tree.findAllByType(modules.buttons.RoundButton).map((button) => button.props.loading)).toEqual(surface === 'both' ? [true, true] : [true]);
    expect(screen.tree.findAllByType(modules.buttons.RoundButton).every((button) => button.props.disabled === true)).toBe(true);
    await screen.tree.pressByTestIdAsync(surface === 'runtime' || (surface === 'both' && restartControl === 'banner') ? 'home-runtime-restart' : 'home-runtime-pending-restart.action');
    expect(daemonRequests.filter(call => (call.payload as { method?: string }).method === 'start')).toHaveLength(1);

    await act(async () => modules.wakes.publishHomeAccountChange(serverId, ['unrelated-session'], { source: 'socket', changeKinds: ['session'] }));
    await act(async () => modules.wakes.publishHomeAccountChange('other-home', undefined, { source: 'connected' }));
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1);

    const appliedHome = modules.server.getActiveServerSnapshot();
    await act(async () => {
        modules.applied.publishAppliedActiveServerSnapshot({ ...appliedHome, serverId: 'other-home' }, true);
        modules.store.storage.getState().setSocketStatus('disconnected');
    });
    await act(async () => modules.store.storage.getState().setSocketStatus('connected'));
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1);

    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    home.answer(serverId, SETTINGS_GET, { body: projection(pendingAfterRestart), respondAfter: readGate });
    if (secondary) {
        await act(async () => modules.wakes.publishHomeAccountChange(serverId, undefined, { source: 'connected' }));
    } else {
        await act(async () => {
            modules.store.storage.getState().setSocketStatus('disconnected');
            modules.applied.publishAppliedActiveServerSnapshot(appliedHome, true);
        });
        await act(async () => modules.store.storage.getState().setSocketStatus('connected'));
    }
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(2);
    expect(screen.tree.findAllByType(modules.buttons.RoundButton).map((button) => button.props.loading)).toEqual(surface === 'both' ? [true, true] : [true]);
    await act(async () => releaseRead());
    await waitForHomeGovernance(() => expect(JSON.stringify(screen.tree.toJSON())).not.toContain('homeGovernance.runtime.waitingForHome'));
    if (surface !== 'runtime') expect(collectRenderedTestIds(screen.tree.toJSON()).includes('home-runtime-pending-restart')).toBe(pendingAfterRestart);
    if (phase === 'wait_pending') {
        await act(async () => resolveWait({ ok: true, result: { protocolVersion: 1, taskId: 'restart', ok: true, data: { healthy: true } } }));
    }
    await act(async () => modules.store.storage.getState().setSocketStatus('disconnected'));
    await act(async () => modules.store.storage.getState().setSocketStatus('connected'));
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(2);
    expect(modules.modal.Modal.alertAsync).not.toHaveBeenCalled();
    expect(daemonRequests.filter(call => (call.payload as { method?: string }).method === 'start')).toHaveLength(1);
});
