import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { markRpcRequestDisposition } from '@happier-dev/sync-client';
import type { SystemTaskBridgeListenerSet } from '@/components/systemTasks/types';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture, homeSettingEntryFixture, homeSettingsProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { collectRenderedTestIds } from '@/dev/testkit/render/collectRenderedTestIds';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const machineRpc = vi.hoisted(() => vi.fn<(input: { method: string; payload: unknown }) => Promise<unknown>>());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope: machineRpc }));
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
                relayUrl: 'https://restart-home.test', healthy: true,
                purpose: { kind: 'personal-home', canonicalServerUrl: 'https://restart-home.test' },
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
installSettingsViewCommonModuleMocks({ storage: 'real' });
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);

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
    return { store, applied, server, settings, wakes, sections, buttons, modal, runtime, profiles };
};
let modules: Awaited<ReturnType<typeof loadModules>>;
beforeAll(async () => {
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    modules = await loadModules();
});
afterEach(async () => {
    await standardCleanup();
    modules.applied.publishAppliedActiveServerRuntimeAvailability(false);
    modules.store.storage.getState().setSocketStatus('disconnected');
    machineRpc.mockReset();
    desktop.starts.length = 0;
    desktop.listeners.clear();
    desktop.loseRestartAdmission = false;
    vi.unstubAllGlobals();
    await home.reset();
});

async function hostingHome() {
    vi.stubGlobal('isTauri', true);
    const serverId = await home.addHome({ name: 'Restart Home', serverUrl: 'https://restart-home.test', accountId: 'account', serverIdentityId: 'srv_restart-home' });
    await modules.profiles.adoptPersonalHomeProfileAndComplete({
        source: 'desktop-personal-home',
        descriptor: { homeServerIdentityId: 'srv_restart-home', canonicalServerUrl: 'https://restart-home.test' },
    });
    home.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture({ viewer: { accountId: 'account', homeRole: 'owner', status: 'active' } }) });
    modules.applied.publishAppliedActiveServerSnapshot(modules.server.getActiveServerSnapshot(), true);
    modules.store.storage.setState({ profileScope: { serverId, accountId: 'account' }, settingsScope: { serverId, accountId: 'account' } });
    modules.store.storage.getState().setSocketStatus('connected');
    waiveRestartApproval(serverId);
    return serverId;
}

function waiveRestartApproval(serverId: string) {
    const settings = { ...modules.store.storage.getState().settings, actionsSettingsV1: { v: 1 as const, approvalWaivedSurfaces: {
        'home.runtime.restart': ['ui' as const],
        'relay.runtime.restart': ['ui' as const],
    } } };
    // This lifecycle suite models an Account that already allowed these restarts. The Action
    // consent suite exercises the default approval path; the real Account read remains intact.
    home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings }, version: 1 } });
}

it.each(['home-runtime-pending-restart.action', 'settings.personalHomeRuntime.restart'])('hosting control %s shares busy completion and reconciles pending settings', async (controlId) => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    const screen = await renderScreen(<modules.runtime.HomeAdministrationRuntimeScreen serverId={serverId} />);
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain(controlId));
    await screen.tree.pressByTestIdAsync(controlId);
    await waitForHomeGovernance(() => expect(desktop.listeners.size > 0).toBe(true));
    const restartTask = [...desktop.listeners.keys()].find(id => id.endsWith('relay.runtime.restart.v1'));
    expect(restartTask).toBeDefined();
    expect(screen.tree.findByTestId('settings.personalHomeRuntime.restart').props.disabled).toBe(true);
    expect(screen.tree.findByTestId('home-runtime-pending-restart.action').props.disabled).toBe(true);
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1);
    const otherControl = controlId === 'settings.personalHomeRuntime.restart' ? 'home-runtime-pending-restart.action' : 'settings.personalHomeRuntime.restart';
    await screen.tree.pressByTestIdAsync(otherControl);
    expect(desktop.starts.filter(kind => kind === 'relay.runtime.restart.v1')).toHaveLength(1);

    let releaseRead!: () => void;
    const readGate = new Promise<void>(resolve => { releaseRead = resolve; });
    home.answer(serverId, SETTINGS_GET, { body: projection(false), respondAfter: readGate });
    await act(async () => desktop.listeners.get(restartTask!)!.onResult({ protocolVersion: 1, taskId: restartTask, ok: true, data: { healthy: true } }));
    await waitForHomeGovernance(() => expect(home.requestsFor(SETTINGS_GET)).toHaveLength(2));
    expect(screen.tree.findByTestId('settings.personalHomeRuntime.restart').props.disabled).toBe(true);
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-unknown');
    expect(JSON.stringify(screen.tree.toJSON())).not.toContain('homeGovernance.runtime.pendingRestart');
    await act(async () => releaseRead());
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-pending-restart'));
    expect(screen.tree.findByTestId('settings.personalHomeRuntime.restart').props.disabled).toBe(false);
});

it('Runtime shows initial settings failure with Retry rather than interpreting it as no pending changes', async () => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { status: 503, body: { error: 'home_unavailable' } });
    const screen = await renderScreen(<modules.runtime.HomeAdministrationRuntimeScreen serverId={serverId} />);
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-retry'));
    expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-unknown');
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    await screen.tree.pressByTestIdAsync('home-runtime-settings-retry');
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-pending-restart'));
    expect(collectRenderedTestIds(screen.tree.toJSON())).not.toContain('home-runtime-settings-unknown');
});

it('keeps a Home search approval reachable on Runtime without claiming completion', async () => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { body: projection(false) });
    await home.requireUiApproval(serverId, 'home.search.rebuild');
    const screen = await renderScreen(<modules.runtime.HomeAdministrationRuntimeScreen serverId={serverId} />);
    await waitForHomeGovernance(() => expect(screen.tree.findByTestId('settings.personalHomeRuntime.repairSearch').props.disabled).toBe(false));
    await screen.tree.pressByTestIdAsync('settings.personalHomeRuntime.repairSearch');
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-search-approval'));
    expect(modules.modal.Modal.alert).not.toHaveBeenCalled();
});

it('Runtime marks post-reconnect settings unknown after a typed read failure and Retry adopts the fresh projection', async () => {
    const serverId = await hostingHome();
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    const screen = await renderScreen(<modules.runtime.HomeAdministrationRuntimeScreen serverId={serverId} />);
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-pending-restart.action'));
    desktop.loseRestartAdmission = true;
    await screen.tree.pressByTestIdAsync('home-runtime-pending-restart.action');
    expect(JSON.stringify(screen.tree.toJSON())).toContain('homeGovernance.runtime.waitingForHome');
    home.answer(serverId, SETTINGS_GET, { status: 503, body: { error: 'home_unavailable' } });
    await act(async () => modules.wakes.publishHomeAccountChange(serverId, undefined, { source: 'connected' }));
    await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-settings-unknown'));
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
    const serverId = await home.addHome({ name: 'Restart Home', serverUrl: 'https://restart-home.test', accountId: 'account' });
    modules.applied.publishAppliedActiveServerSnapshot(modules.server.getActiveServerSnapshot(), true);
    modules.store.storage.setState({ profileScope: { serverId, accountId: 'account' }, settingsScope: { serverId, accountId: 'account' } });
    modules.store.storage.getState().setSocketStatus('connected');
    waiveRestartApproval(serverId);
    home.answer(serverId, SETTINGS_GET, { body: projection(true) });
    let resolveWait!: (value: unknown) => void;
    const wait = new Promise<unknown>(resolve => { resolveWait = resolve; });
    machineRpc.mockImplementation(async ({ method, payload }) => {
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: {
            'tool.systemTasks': { ok: true, checkedAt: 1, data: { available: true, kinds: ['relay.runtime.restart.v1'], methods: ['start', 'wait'] } },
        } };
        const taskMethod = (payload as { method: string }).method;
        if (taskMethod === 'start' && phase !== 'start') return { ok: true, result: { taskId: 'restart' } };
        if (taskMethod === 'wait' && phase === 'wait_pending') return wait;
        throw markRpcRequestDisposition(new Error('socket has been disconnected'), 'outcomeUnknown');
    });
    const screen = await renderScreen(<RestartScreen serverId={serverId} surface={surface} />);
    expect(home.requestsFor(SETTINGS_GET), JSON.stringify(screen.tree.toJSON())).toHaveLength(1);
    if (surface !== 'runtime') await waitForHomeGovernance(() => expect(collectRenderedTestIds(screen.tree.toJSON())).toContain('home-runtime-pending-restart.action'));
    await screen.tree.pressByTestIdAsync(restartControl === 'banner' ? 'home-runtime-pending-restart.action' : 'home-runtime-restart');
    await waitForHomeGovernance(() => expect(machineRpc.mock.calls.some(([call]) => (call.payload as { method?: string }).method === (phase === 'start' ? 'start' : 'wait'))).toBe(true));
    expect(JSON.stringify(screen.tree.toJSON())).toContain('homeGovernance.runtime.waitingForHome');
    expect(modules.modal.Modal.alertAsync).not.toHaveBeenCalled();
    expect(home.requestsFor(SETTINGS_GET)).toHaveLength(1);
    expect(screen.tree.findAllByType(modules.buttons.RoundButton).map((button) => button.props.loading)).toEqual(surface === 'both' ? [true, true] : [true]);
    expect(screen.tree.findAllByType(modules.buttons.RoundButton).every((button) => button.props.disabled === true)).toBe(true);
    await screen.tree.pressByTestIdAsync(surface === 'runtime' || (surface === 'both' && restartControl === 'banner') ? 'home-runtime-restart' : 'home-runtime-pending-restart.action');
    expect(machineRpc.mock.calls.filter(([call]) => (call.payload as { method?: string }).method === 'start')).toHaveLength(1);

    await act(async () => modules.wakes.publishHomeAccountChange(serverId));
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
    expect(machineRpc.mock.calls.filter(([call]) => (call.payload as { method?: string }).method === 'start')).toHaveLength(1);
});
