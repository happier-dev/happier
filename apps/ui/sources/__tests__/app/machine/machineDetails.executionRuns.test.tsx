import 'fake-indexeddb/auto';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonExecutionRunEntry } from '@happier-dev/protocol/daemon/executionRuns';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { flushHookEffects, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const { route, routerPush, routerNavigate, breadcrumb, originalSentryDsn } = vi.hoisted(() => {
    const originalSentryDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
    // Telemetry's external SDK is enabled for the refresh diagnostic assertion.
    process.env.EXPO_PUBLIC_SENTRY_DSN = 'https://fixture@example.test/1';
    return { route: { params: {} as Record<string, string> }, routerPush: vi.fn(), routerNavigate: vi.fn(), breadcrumb: vi.fn(), originalSentryDsn };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => route.params, router: { push: routerPush, navigate: routerNavigate },
}).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@sentry/react-native', () => ({ addBreadcrumb: breadcrumb }));

const { JSDOM } = await import('jsdom');
const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://machine-runs.test' });
function installBrowserBoundary() {
    for (const name of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'CustomEvent', 'navigator'] as const) {
        vi.stubGlobal(name, name === 'window' ? browser.window : browser.window[name]);
    }
}
installBrowserBoundary();
afterAll(() => {
    browser.window.close();
    if (originalSentryDsn === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
    else process.env.EXPO_PUBLIC_SENTRY_DSN = originalSentryDsn;
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let runs: readonly DaemonExecutionRunEntry[] = [];
let pendingRuns: Promise<unknown> | undefined;
let releaseRuns: (() => void) | undefined;
const rpcServerUrls: (string | undefined)[] = [];
const rpcRequests = installSessionActionRpcBoundary((request, { serverUrl }) => {
    rpcServerUrls[rpcRequests.length - 1] = serverUrl;
    if (request.method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST || request.method.endsWith(`:${RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST}`)) {
        return pendingRuns ?? { runs };
    }
    // This daemon serves run inventory, but no optional capability/plugin methods.
    // Let their real owners classify the protocol's unsupported-method result.
    throw Object.assign(new Error('Fixture daemon method is unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
});
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { Item } = await import('@/components/ui/lists/Item');
const { ItemGroup } = await import('@/components/ui/lists/ItemGroup');
const { getStorage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { sync } = await import('@/sync/sync');
const initialState = getStorage().getState();
const initialTelemetry = { initialized: globalThis.__HAPPIER_SENTRY_INIT__, optedOut: globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ };
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLocks: (() => void) | undefined;
let serverA = '';
let serverB = '';

function AccountBoundary({ children }: React.PropsWithChildren) {
    if (!connection) throw new Error('Machine Account is not restored');
    return <InjectedAuthProvider credentials={connection.credentials}><ModalProvider><AppPaneProvider>{children}</AppPaneProvider></ModalProvider></InjectedAuthProvider>;
}
function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, { wrapper: AccountBoundary, createNodeMock: element => Object.assign(
        document.createElement(element.type === 'TextInput' ? 'textarea' : 'div'), {
            setNativeProps() {}, setDropCaret() {}, measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
        }) });
}
type Screen = Awaited<ReturnType<typeof renderScreen>>;
function runRows(screen: Screen, runId: string) { return screen.findAll(row => row.props.run?.runId === runId); }
function runGroups(screen: Screen) { return screen.findAllByType(ItemGroup).filter(group => group.props.title === 'runs.title'); }
function finishedFilters(screen: Screen) { return screen.findAllByType(Item).filter(item => item.props.title === 'runs.showFinished'); }
function listRequests() { return rpcRequests.filter(request => request.method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST || request.method.endsWith(`:${RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST}`)); }
function machineRequests() { return homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/machines'); }
// Runs are part of the Overview's Project work (plan 10 MPG-8), shown in place once the machine has any.
async function renderRuns() {
    const screen = await renderScreen(<MachinePageScreen />);
    await waitForHomeGovernance(() => expect(listRequests().length).toBeGreaterThan(0));
    if (runs.length > 0) await waitForHomeGovernance(() => expect(runGroups(screen)).toHaveLength(1));
    else await flushHookEffects();
    return screen;
}
function groupTitles(screen: Screen) { return screen.findAllByType(ItemGroup).map(group => group.props.title); }
function createExecutionRun(overrides: Partial<DaemonExecutionRunEntry> & Pick<DaemonExecutionRunEntry, 'runId'>): DaemonExecutionRunEntry {
    return { happyHomeDir: '/tmp/happier-test-home', pid: 123, happySessionId: 'sess-1', callId: 'call-1', sidechainId: 'side-1',
        intent: 'review', backendTarget: { kind: 'backend', backendId: 'codex' }, runClass: 'bounded', ioMode: 'request_response',
        retentionPolicy: 'ephemeral', status: 'running', startedAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_000_000, ...overrides };
}
beforeEach(async () => {
    installBrowserBoundary();
    releaseLocks = installBrowserStorageLockBoundary();
    await homes.reset();
    getStorage().setState(initialState, true);
    runs = []; pendingRuns = undefined; releaseRuns = undefined; rpcRequests.length = 0; rpcServerUrls.length = 0;
    routerPush.mockClear(); routerNavigate.mockClear(); breadcrumb.mockClear();
    globalThis.__HAPPIER_SENTRY_INIT__ = true;
    globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ = false;
    serverB = await homes.addHome({ name: 'Machine B', serverUrl: 'https://machine-runs-b.test', accountId: 'account-b', currentAccount: true, active: false });
    serverA = await homes.addHome({ name: 'Machine A', serverUrl: 'https://machine-runs.test', accountId: 'account-a', currentAccount: true });
    for (const [serverId, accountId] of [[serverA, 'account-a'], [serverB, 'account-b']]) {
        homes.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: 'machine-1', accountId })] });
    }
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://machine-runs.test');
    if (!credentials) throw new Error('Machine Home credentials are missing');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-runs.test', accountId: 'account-a', credentials,
        additionalRequestOrigins: ['https://machine-runs-b.test'], request: homes.request });
    await sync.awaitBootstrapForegroundAcquisition();
    const machine = createMachineFixture({ activeAt: Date.now() });
    getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverA]: [machine], [serverB]: [machine] } });
    route.params = { id: 'machine-1' };
});
afterEach(async () => {
    standardCleanup();
    releaseRuns?.();
    await connection?.dispose(); connection = undefined;
    await homes.reset();
    releaseLocks?.(); releaseLocks = undefined;
    getStorage().setState(initialState, true);
    if (initialTelemetry.initialized === undefined) delete globalThis.__HAPPIER_SENTRY_INIT__;
    else globalThis.__HAPPIER_SENTRY_INIT__ = initialTelemetry.initialized;
    if (initialTelemetry.optedOut === undefined) delete globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__;
    else globalThis.__HAPPIER_CRASH_REPORTS_OPTOUT__ = initialTelemetry.optedOut;
});

describe('MachineDetailScreen (execution runs section)', () => {
    it('conceals hidden Session names in mounted run groups and restores them after sharing', async () => {
        runs = [createExecutionRun({ runId: 'private-run' })];
        const row = createSessionListRenderableSessionFixture({ id: 'sess-1', metadata: {
            name: 'Private run project', path: '/private-project', host: 'host', machineId: 'machine-1',
        } });
        getStorage().setState({ sessionListRowsByServerId: { [serverA]: { [row.id]: row } } });
        getStorage().getState().applySettingsLocal({ sessionListHiddenTagIdsWhileRecording: { [serverA]: ['private'] } });
        getStorage().getState().setSessionTagAssignmentsOptimistic(serverA, row.id, ['private']);
        const { setScreenSharingPrivacyActive } = await import('@/desktop/capture/useNativeRecordingActive');
        const screen = await renderRuns();
        try {
            expect(screen.getTextContent()).toContain('Private run project');
            await act(async () => { setScreenSharingPrivacyActive(true); });
            expect(screen.getTextContent()).not.toContain('Private run project');
            expect(runRows(screen, 'private-run').length).toBeGreaterThan(0);
            await act(async () => { setScreenSharingPrivacyActive(false); });
            expect(screen.getTextContent()).toContain('Private run project');
        } finally { setScreenSharingPrivacyActive(false); await screen.unmount(); }
    });

    it('names run groups from their Home-qualified Session titles and follows renames', async () => {
        runs = [createExecutionRun({ runId: 'run-titled' }),
            createExecutionRun({ runId: 'run-missing', happySessionId: 'missing' })];
        const row = createSessionListRenderableSessionFixture({ id: 'sess-1', metadata: {
            name: 'Coastal parser notes', path: '/project', host: 'host', machineId: 'machine-1',
        } });
        getStorage().setState({ sessions: { 'sess-1': createSessionFixture({ id: 'sess-1', serverId: serverB,
            metadata: { name: 'Wrong Home', path: '/elsewhere', host: 'other' } }) },
            sessionListRowsByServerId: { [serverA]: { [row.id]: row } } });
        const screen = await renderRuns();
        const headers = () => screen.findAllByType(Item).filter(item => item.props.subtitle === 'runs.openSession');
        expect(headers().map(item => item.props.title)).toEqual(['session.untitled', 'Coastal parser notes']);
        await act(async () => { getStorage().setState({ sessionListRowsByServerId: { [serverA]: {
            [row.id]: { ...row, metadata: { ...row.metadata!, name: 'Renamed parser notes' } },
        } } }); });
        expect(headers().map(item => item.props.title)).toEqual(['session.untitled', 'Renamed parser notes']);
        await act(async () => { await headers()[1]!.props.onPress(); });
        expect(routerNavigate).toHaveBeenCalledWith(`/session/sess-1?serverId=${encodeURIComponent(serverA)}`, expect.anything());
    });
    it.each(['use', 'manage'] as const)('offers the Machine-wide run inventory only to Manage guests (%s)', async role => {
        const machine = createMachineFixture({ activeAt: Date.now(), isShared: true, access: {
            custodian: { accountId: 'machine-owner', displayName: 'Machine owner' }, role,
            resourceMode: 'plain', accessState: 'ready',
        } });
        homes.answer(serverA, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machine.id, accountId: 'machine-owner', machine })] });
        await sync.refreshMachines();
        runs = [createExecutionRun({ runId: 'owner-machine-run' })];
        const screen = await renderScreen(<MachinePageScreen />);
        await flushHookEffects({ cycles: 8 });
        if (role === 'use') {
            expect(listRequests()).toHaveLength(0);
            expect(runGroups(screen)).toHaveLength(0);
            expect(screen.findByTestId('machine-runs-error')).toBeNull();
        } else {
            await waitForHomeGovernance(() => expect(runGroups(screen)).toHaveLength(1));
            expect(listRequests().length).toBeGreaterThan(0);
            expect(runRows(screen, 'owner-machine-run').length).toBeGreaterThan(0);
            // Withdrawal takes effect at the next mounted read; restoring Manage restores the inventory.
            for (const nextRole of ['use', 'manage'] as const) {
                const nextMachine = { ...machine, access: { ...machine.access!, role: nextRole } };
                homes.answer(serverA, '/v1/machines', { body: [createPlainMachineRowFixture({ id: machine.id, accountId: 'machine-owner', machine: nextMachine })] });
                const priorReads = listRequests().length;
                await act(async () => { await sync.refreshMachines(); });
                await flushHookEffects({ cycles: 8 });
                if (nextRole === 'use') {
                    expect(runGroups(screen)).toHaveLength(0);
                    expect(listRequests()).toHaveLength(priorReads);
                } else {
                    await waitForHomeGovernance(() => expect(runGroups(screen)).toHaveLength(1));
                    expect(listRequests().length).toBeGreaterThan(priorReads);
                }
            }
        }
    });
    it('composes Project work in place on the Overview, after the vitals and before This machine', async () => {
        runs = [createExecutionRun({ runId: 'run-1' })];
        const screen = await renderRuns();
        await flushHookEffects();
        const titles = groupTitles(screen);
        const workAt = titles.indexOf('projectWorkers.workSection');
        expect(workAt).toBeGreaterThanOrEqual(0);
        expect(titles.indexOf('runs.title')).toBeGreaterThan(workAt);
        expect(titles.indexOf('machineDetailPage.thisMachineTitle')).toBeGreaterThan(titles.indexOf('runs.title'));
    });
    it('keeps the Runs section absent while the machine has none, and shows nothing while the first read is out', async () => {
        pendingRuns = new Promise(resolve => { releaseRuns = () => resolve({ runs: [] }); });
        const screen = await renderRuns();
        await flushHookEffects();
        expect(runGroups(screen)).toHaveLength(0);
        await act(async () => { releaseRuns?.(); });
        await flushHookEffects();
        expect(runGroups(screen)).toHaveLength(0);
        expect(listRequests().map(request => request.method)).toContain(`machine-1:${RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST}`);
        expect(getActiveServerSnapshot().serverId).toBe(serverA);
    });
    it('sends an old Project work link to the Overview', async () => {
        route.params = { id: 'machine-1', page: 'work' };
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const screen = await renderScreen(<MachineSubPageScreen />);
        await flushHookEffects();
        expect(screen.findByTestId('machine-sub-page-header-work')).toBeNull();
        const { Redirect } = await import('expo-router');
        const redirects = screen.findAllByType(Redirect);
        expect(redirects).toHaveLength(1);
        expect(String(redirects[0]!.props.href)).toContain('machine-1');
        expect(String(redirects[0]!.props.href)).not.toContain('work');
    });
    it('does not leave the runs section loading when the machine goes offline before they arrive', async () => {
        runs = [createExecutionRun({ runId: 'run-1' }), createExecutionRun({ runId: 'run-done', callId: 'call-2', sidechainId: 'side-2', status: 'succeeded', finishedAtMs: 1_700_000_000_000 })];
        const screen = await renderRuns();
        await flushHookEffects();
        expect(runGroups(screen)).toHaveLength(1);
        const filterDisabled = () => finishedFilters(screen)[0]!.props.rightElement.props.disabled;
        expect(filterDisabled()).toBe(false);
        pendingRuns = new Promise(resolve => { releaseRuns = () => resolve({ runs: [] }); });
        const scrollView = screen.findAll(node => Boolean(node.props.refreshControl))[0];
        await act(async () => { void scrollView!.props.refreshControl.props.onRefresh(); });
        await flushHookEffects();
        // The refresh keeps the runs it shows rather than swapping them for a loading line.
        expect(runRows(screen, 'run-1')).toHaveLength(1);
        expect(filterDisabled()).toBe(true);
        await act(async () => {
            const machine = createMachineFixture({ active: false, activeAt: 0 });
            getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverA]: [machine], [serverB]: [machine] } });
        });
        await flushHookEffects();
        expect(filterDisabled()).toBe(false);
        expect(runRows(screen, 'run-1')).toHaveLength(1);
    });
    it('wraps pull-to-refresh in refresh diagnostics', async () => {
        const screen = await renderRuns();
        await flushHookEffects();
        const scrollView = screen.findAll(node => Boolean(node.props.refreshControl))[0];
        expect(scrollView).toBeTruthy();
        await act(async () => { await scrollView!.props.refreshControl.props.onRefresh(); });
        expect(breadcrumb).toHaveBeenCalledWith(expect.objectContaining({ category: 'ui.refresh', data: expect.objectContaining({
            action: 'pull_to_refresh', screen: 'machine_detail', phase: 'start',
        }) }));
        expect(breadcrumb).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ phase: 'success' }) }));
    });
    it('uses the requested route server when loading execution runs', async () => {
        route.params = { id: 'machine-1', serverId: serverB };
        await renderRuns();
        await flushHookEffects();
        expect(getActiveServerSnapshot().serverId).toBe(serverB);
        const listedOn = rpcRequests.flatMap((request, index) => listRequests().includes(request) ? [rpcServerUrls[index]] : []);
        expect(listedOn.length).toBeGreaterThan(0);
        expect(new Set(listedOn)).toEqual(new Set(['https://machine-runs-b.test']));
        expect(machineRequests().some(request => request.serverId === serverB)).toBe(true);
    });
    it('opens every former inline section from This machine, inside the door the page is in', async () => {
        route.params = { id: 'machine-1' };
        const screen = await renderScreen(<MachinePageScreen />);
        await flushHookEffects();
        for (const page of ['sharing', 'agents', 'terminal', 'connection', 'installables', 'doctor', 'details']) {
            expect(screen.findByTestId(`machine-page-row-${page}`)).toBeTruthy();
        }
        expect(screen.findByTestId('machine-detail-stop-daemon')).toBeNull();
        expect(screen.findByTestId('machine-detail-remove')).toBeNull();
        expect(screen.findByTestId('machine-terminal-effective-host')).toBeNull();
        await screen.pressByTestIdAsync('machine-page-row-installables');
        expect(routerPush).toHaveBeenCalledWith(`/settings/machines/machine-1/installables?serverId=${encodeURIComponent(serverA)}`);
    });
    it('shows only running runs by default and includes finished when toggled', async () => {
        runs = [createExecutionRun({ runId: 'run-running' }), createExecutionRun({ runId: 'run-finished', callId: 'call-2', sidechainId: 'side-2', status: 'succeeded', finishedAtMs: 1_700_000_000_000 })];
        const screen = await renderRuns();
        await flushHookEffects();
        expect(runRows(screen, 'run-running')).toHaveLength(1);
        expect(runRows(screen, 'run-finished')).toHaveLength(0);
        const filter = finishedFilters(screen)[0];
        expect(filter).toBeTruthy();
        await act(async () => { filter!.props.rightElement.props.onValueChange(true); });
        await flushHookEffects();
        expect(runRows(screen, 'run-running')).toHaveLength(1);
        expect(runRows(screen, 'run-finished')).toHaveLength(1);
    });
    it('offers the finished-run filter only when finished runs exist', async () => {
        runs = [createExecutionRun({ runId: 'running' })];
        const running = await renderRuns();
        await flushHookEffects();
        expect(runRows(running, 'running')).toHaveLength(1);
        expect(finishedFilters(running)).toHaveLength(0);
    });
    it('offers a stop control for running runs', async () => {
        runs = [createExecutionRun({ runId: 'run-running' })];
        const screen = await renderRuns();
        await flushHookEffects();
        expect(runRows(screen, 'run-running')).toHaveLength(1);
        expect(runRows(screen, 'run-running')[0]?.props.rightAccessory?.props.onPress).toEqual(expect.any(Function));
    });
    it('navigates to run details when pressing an execution run row', async () => {
        runs = [createExecutionRun({ runId: 'run-1' })];
        const screen = await renderRuns();
        await flushHookEffects();
        expect(runRows(screen, 'run-1')).toHaveLength(1);
        await act(async () => { runRows(screen, 'run-1')[0]!.props.onPress(); });
        expect(routerPush).toHaveBeenCalledWith(`/session/sess-1/runs/run-1?serverId=${encodeURIComponent(serverA)}`);
    });
    it('opens detached daemon Run details while offering their own Run Stop', async () => {
        runs = [createExecutionRun({ runId: 'run-detached', happySessionId: null })];
        const screen = await renderRuns();
        await flushHookEffects();
        const rows = runRows(screen, 'run-detached');
        expect(rows).toHaveLength(1);
        expect(screen.findAllByType(Item).filter(item => item.props.subtitle === 'runs.openSession')).toHaveLength(0);
        expect(rows[0]?.props.onPress).toEqual(expect.any(Function));
        expect(rows[0]?.props.rightAccessory).toBeTruthy();
    });
});
