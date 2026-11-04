import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DaemonExecutionRunEntrySchema, DaemonExecutionRunListResponseSchema, ExecutionRunStopRequestSchema, type DaemonExecutionRunEntry } from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { MachinePublishedMetadataV1Schema } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createExpoRouterMock, createStackOptionsCapture } from '@/dev/testkit/mocks/router';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const HOME_A = 'srv_server-a';
const HOME_B = 'srv_server-b';
const ACCOUNT = 'runs-account';
const homeUrls: Record<string, string> = { [HOME_A]: 'https://runs-a.test', [HOME_B]: 'https://runs-b.test' };
const routerPushSpy = vi.fn();
const stackOptionsCapture = createStackOptionsCapture();
const routerMock = createExpoRouterMock({ router: { push: routerPushSpy }, stackOptionsCapture });
installRouteRootCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module,
    router: () => routerMock.module,
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

// These responders are the external daemon/Session Socket boundary, not domain-function mocks.
const daemonListRpc = vi.fn(async (..._args: [string, Record<string, unknown>?]): Promise<{ runs: DaemonExecutionRunEntry[] }> => ({ runs: [] }));
const sessionStopRpc = vi.fn(async (..._args: [string, { runId: string }, { serverId: string }]) => ({ ok: true as const }));
const machineStopRpc = vi.fn(async (..._args: [string, string, { serverId: string }]) => ({ ok: true as const }));
const detachedStopRpc = vi.fn(async (..._args: [string, { runId: string }, { serverId: string }]) => ({ ok: true as const }));
const daemonListSignals: AbortSignal[] = [];
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installSessionActionRpcBoundary(async (request, context) => {
    const serverId = Object.keys(homeUrls).find(id => homeUrls[id] === context.serverUrl?.replace(/\/+$/, ''));
    if (!serverId) throw new Error('Unexpected execution Run Home');
    const separator = request.method.indexOf(':');
    const targetId = request.method.slice(0, separator);
    const method = request.method.slice(separator + 1);
    if (method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST) {
        daemonListSignals.push(context.signal);
        expect(request.params).toEqual({});
        return DaemonExecutionRunListResponseSchema.parse(await daemonListRpc(targetId, { serverId }));
    }
    if (method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
        const parsed = ExecutionRunStopRequestSchema.parse(request.params);
        if (targetId === 'machine-1') return detachedStopRpc(targetId, parsed, { serverId });
        return sessionStopRpc(targetId, parsed, { serverId });
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) return {
        protocolVersion: 1, results: { 'tool.executionRuns': { ok: true, checkedAt: 1,
            data: { protocolVersion: 2, features: { detachedScope: true, startAndWait: true } } } },
    };
    if (method === RPC_METHODS.STOP_SESSION) {
        if (!request.params || typeof request.params !== 'object' || !('sessionId' in request.params)
            || typeof request.params.sessionId !== 'string') throw new Error('Malformed daemon Session-stop request');
        return machineStopRpc(targetId, request.params.sessionId, { serverId });
    }
    // Optional daemon probes retain the real unsupported-method classification.
    throw Object.assign(new Error('Fixture daemon method is unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
});
await loadSyncSingletonForTests();
const disposeActionLoader = await installRealActionExecutorModuleLoader();
const { default: Screen } = await import('@/app/(app)/runs');
const { ExecutionRunRow } = await import('@/components/sessions/runs/ExecutionRunRow');
const { Item } = await import('@/components/ui/lists/Item');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { storage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { sync } = await import('@/sync/sync');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let homeProfileIds: Record<string, string> = {};
const machineListState: { byServerId: Record<string, Machine[]> } = { byServerId: {} };
let scopesReady = false;
function serveMachineInventory(serverId: string, machines: readonly Machine[]) {
    const rows = machines.map(machine => ({ ...createPlainMachineRowFixture({ id: machine.id, accountId: ACCOUNT }),
        active: machine.active, activeAt: machine.activeAt, metadataVersion: machine.metadataVersion,
        metadata: encodePlainMachineStoredContent(MachinePublishedMetadataV1Schema.parse(machine.metadata)),
    }));
    const profileId = homeProfileIds[serverId]!;
    homes.answer(profileId, '/v1/machines', { body: rows });
    // Runs supplies the captured Account id, so its real RPC owner uses the
    // scoped transport and freshly opens this exact Machine before issuance.
    for (const machine of rows) homes.answer(profileId, `/v1/machines/${machine.id}`, { body: { machine } });
}
function AccountBoundary({ children }: React.PropsWithChildren) {
    const bindings = useServerCredentialAccountScopeBindings([HOME_A, HOME_B]);
    scopesReady = [HOME_A, HOME_B].every(serverId => bindings.get(serverId)?.isCurrent() === true);
    if (!connection) throw new Error('Runs Account is not restored');
    return <InjectedAuthProvider credentials={connection.credentials}>{children}</InjectedAuthProvider>;
}
afterAll(() => disposeActionLoader());

describe('Runs screen', () => {
    function createExecutionRun(overrides: Partial<DaemonExecutionRunEntry> & Pick<DaemonExecutionRunEntry, 'runId'>): DaemonExecutionRunEntry {
        const { runId, ...rest } = overrides;
        return DaemonExecutionRunEntrySchema.parse({
            happyHomeDir: '/tmp/happier-test-home',
            pid: 123,
            happySessionId: 'sess-1',
            runId,
            callId: 'call-1',
            sidechainId: 'side-1',
            intent: 'review',
            backendTarget: { kind: 'backend', backendId: 'codex' },
            runClass: 'bounded',
            ioMode: 'request_response',
            retentionPolicy: 'ephemeral',
            status: 'running',
            startedAtMs: 1_700_000_000_000,
            updatedAtMs: 1_700_000_000_000,
            ...rest,
        });
    }

    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://runs.test' });
        await loadSyncSingletonForTests();
        await homes.reset();
        storage.setState(initialState, true);
        clearMachineRequestReachabilityForTest();
        routerMock.state.params = {};
        routerMock.resetParams();
        routerPushSpy.mockClear();
        stackOptionsCapture.reset();
        daemonListRpc.mockReset();
        daemonListSignals.length = 0;
        daemonListRpc.mockResolvedValue({ runs: [] });
        sessionStopRpc.mockClear();
        machineStopRpc.mockClear();
        detachedStopRpc.mockReset();
        detachedStopRpc.mockResolvedValue({ ok: true });
        scopesReady = false;
        const machine = createMachineFixture({ activeAt: Date.now(), metadata: {
            host: 'a.local', platform: 'darwin', happyCliVersion: '1.0.0', happyHomeDir: '/tmp', homeDir: '/tmp',
        } });
        machineListState.byServerId = { [HOME_A]: [machine], [HOME_B]: [] };
        homeProfileIds = {};
        for (const serverId of [HOME_B, HOME_A]) {
            homeProfileIds[serverId] = await homes.addHome({ name: serverId, serverUrl: homeUrls[serverId]!,
                serverIdentityId: serverId, accountId: ACCOUNT, currentAccount: true, active: serverId === HOME_A });
            serveMachineInventory(serverId, machineListState.byServerId[serverId]!);
        }
        const credentials = await TokenStorage.getCredentialsForServerUrl(homeUrls[HOME_A]!);
        if (!credentials) throw new Error('Runs Home credentials are missing');
        connection = await restoreServerAccountForTest({ serverUrl: homeUrls[HOME_A]!, serverIdentityId: HOME_A,
            accountId: ACCOUNT, credentials, additionalRequestOrigins: [homeUrls[HOME_B]!], request: createSessionReadBatchFetchBoundary(homes.request) });
        await sync.awaitBootstrapForegroundAcquisition();
        installSessionActionFixture({ homes, storage, serverId: homeProfileIds[HOME_A]!,
            session: { id: 'sess-1', serverId: HOME_A, metadata: { path: '/repo', host: 'a.local', machineId: 'machine-1' } } });
    });

    afterEach(async () => {
        try {
            standardCleanup();
            await connection?.dispose();
            connection = undefined;
            await homes.reset();
            clearMachineRequestReachabilityForTest();
            storage.setState(initialState, true);
        } finally {
            browser?.restore(); browser = undefined;
        }
    });

    async function renderRunsScreen(waitForLoaded = true) {
        // Home census and the canonical inventory producer agree, including empty Homes.
        for (const serverId of [HOME_A, HOME_B]) {
            const machines = machineListState.byServerId[serverId] ?? [];
            serveMachineInventory(serverId, machines);
            storage.getState().applyMachines(machines, true, { sourceServerId: serverId, sourceAccountId: ACCOUNT });
            storage.getState().markMachineListSettled(serverId);
        }
        const screen = await renderScreen(<Screen />, { wrapper: AccountBoundary, createNodeMock: element => Object.assign(
            document.createElement(element.type === 'TextInput' ? 'textarea' : 'div'), {
                setNativeProps() {},
                measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
            }) });
        await waitForHomeGovernance(() => expect(scopesReady).toBe(true));
        await flushHookEffects({ cycles: 2 });
        if (waitForLoaded) await waitForHomeGovernance(() => expect(screen.findAllByType(Item).some(item => item.props.title === 'common.loading')).toBe(false));
        return screen;
    }

    it('keeps the exact native Run read alive across Machine presence and metadata publications', async () => {
        routerMock.state.router.setParams({ serverId: HOME_A, machineId: 'machine-1', runId: 'run-live' });
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        daemonListRpc.mockImplementation(async () => {
            await pending;
            return { runs: [createExecutionRun({ runId: 'run-live', happySessionId: null })] };
        });
        const screen = await renderRunsScreen(false);
        try {
            await waitForHomeGovernance(() => expect(daemonListSignals.length).toBeGreaterThan(0));
            const originalRead = daemonListSignals[0]!;
            const machine = machineListState.byServerId[HOME_A]![0]!;
            await act(async () => {
                storage.getState().applyMachines([{ ...machine, activeAt: machine.activeAt + 1,
                    metadataVersion: machine.metadataVersion + 1,
                    metadata: { ...machine.metadata!, displayName: 'Renamed machine' },
                }], true, { sourceServerId: HOME_A, sourceAccountId: ACCOUNT });
            });
            await flushHookEffects({ cycles: 2 });
            expect(originalRead.aborted).toBe(false);
            await act(async () => { release(); });
            await waitForHomeGovernance(() => expect(screen.findAllByType(ExecutionRunRow)).toHaveLength(1));
            const row = screen.findByType(ExecutionRunRow);
            expect(row.props.selected).toBe(true);
            expect(row.props.run.runId).toBe('run-live');
            expect(row.props.rightAccessory).toBeTruthy();
            expect(screen.findAllByType(Item).some(item => item.props.title === 'common.loading')).toBe(false);
        } finally {
            await act(async () => {
                release();
                await flushHookEffects({ cycles: 2 });
            });
        }
    });

    async function renderHeaderRight() {
        const options = stackOptionsCapture.getResolved();
        expect(options?.headerTitle).toBe('runs.title');
        expect(typeof options?.headerRight).toBe('function');
        return renderScreen(React.createElement(options!.headerRight as React.ComponentType));
    }

    it('configures a header title with a refresh action', async () => {
        await renderRunsScreen();

        const headerRightScreen = await renderHeaderRight();
        expect(headerRightScreen.findByProps({ accessibilityLabel: 'runs.a11y.refresh' })).toBeTruthy();
    });

    it('shows running runs by default and every run once the page filter is set to all', async () => {
        daemonListRpc.mockResolvedValue({
            runs: [
                createExecutionRun({ runId: 'run-live' }),
                createExecutionRun({ runId: 'run-done', status: 'succeeded' }),
            ],
        });
        const screen = await renderRunsScreen();
        const runIds = () => screen.findAllByType(ExecutionRunRow).map((row) => row.props.run.runId);

        expect(runIds()).toEqual(['run-live']);
        await act(async () => {
            screen.pressByTestId('runs.filter:all');
        });
        expect(runIds()).toEqual(['run-live', 'run-done']);
    });

    it('says there are no machines when the signed-in Homes have none, and offers to add one', async () => {
        machineListState.byServerId = { 'srv_server-a': [] };
        const screen = await renderRunsScreen();

        expect(screen.getTextContent()).toContain('runs.noMachinesAvailable');
        expect(screen.findAllByTestId('runs.no-machines.add').length).toBeGreaterThan(0);
    });

    it('keeps daemon Run rows isolated when two Homes expose the same machine id', async () => {
        const duplicateMachine = {
            ...machineListState.byServerId['srv_server-a']![0]!,
            metadata: { ...machineListState.byServerId['srv_server-a']![0]!.metadata!, host: 'duplicate.local' },
        };
        machineListState.byServerId = {
            'srv_server-a': machineListState.byServerId['srv_server-a']!,
            'srv_server-b': [duplicateMachine],
        };
        daemonListRpc.mockImplementation(async (_machineId, options) => ({
            runs: [createExecutionRun({
                runId: options?.serverId === 'srv_server-a' ? 'run-home-a' : 'run-home-b',
            })],
        }));

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType(ExecutionRunRow);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['run-home-a', 'run-home-b']);
        rows[0]!.props.onPress();
        rows[1]!.props.onPress();
        expect(routerPushSpy.mock.calls.map(([href]) => href)).toEqual([
            '/session/sess-1/runs/run-home-a?serverId=srv_server-a',
            '/session/sess-1/runs/run-home-b?serverId=srv_server-b',
        ]);
    });

    it('limits a scoped detached-Run route intent to its exact Home', async () => {
        const duplicateMachine = {
            ...machineListState.byServerId['srv_server-a']![0]!,
            metadata: { ...machineListState.byServerId['srv_server-a']![0]!.metadata!, host: 'duplicate.local' },
        };
        machineListState.byServerId = {
            'srv_server-a': machineListState.byServerId['srv_server-a']!,
            'srv_server-b': [duplicateMachine],
        };
        routerMock.state.router.setParams({ serverId: 'srv_server-b', machineId: 'machine-1', runId: 'same-run' });
        daemonListRpc.mockResolvedValue({
            runs: [createExecutionRun({ runId: 'same-run', happySessionId: null, status: 'succeeded' })],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType(ExecutionRunRow);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.run.runId).toBe('same-run');
        expect(daemonListRpc.mock.calls.every(([machineId, options]) => machineId === 'machine-1' && options?.serverId === HOME_B)).toBe(true);
        expect(daemonListRpc).toHaveBeenCalledWith('machine-1', { serverId: 'srv_server-b' });
    });

    it('keeps Session-associated daemon runs navigable and stoppable', async () => {
        daemonListRpc.mockResolvedValue({
            runs: [createExecutionRun({ runId: 'run-associated' })],
        });

        const screen = await renderRunsScreen();
        const row = screen.findByType(ExecutionRunRow);

        expect(row.props.subtitle).toContain('runs.sessionTitle');
        expect(row.props.onPress).toEqual(expect.any(Function));
        expect(row.props.rightAccessory).toBeTruthy();
        row.props.onPress();
        expect(routerPushSpy).toHaveBeenCalledWith('/session/sess-1/runs/run-associated?serverId=srv_server-a');

        const stopButton = row.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'runs.stop.stopRunA11y')[0];
        await pressTestInstanceAsync(stopButton);
        await flushHookEffects({ cycles: 2 });

        expect(sessionStopRpc).toHaveBeenCalledWith('sess-1', { runId: 'run-associated' }, { serverId: 'srv_server-a' });
    });

    it('stops a detached daemon run through its exact Machine without inventing a Session', async () => {
        daemonListRpc.mockResolvedValue({
            runs: [createExecutionRun({ runId: 'run-detached', happySessionId: null })],
        });

        const screen = await renderRunsScreen();
        const row = screen.findByType(ExecutionRunRow);

        expect(row.props.run.happySessionId).toBeNull();
        expect(row.props.subtitle).not.toContain('runs.sessionTitle');
        expect(row.props.onPress).toBeUndefined();
        expect(row.props.rightAccessory).toBeTruthy();
        const stopButton = row.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'runs.stop.stopRunA11y')[0];
        await pressTestInstanceAsync(stopButton);
        await flushHookEffects({ cycles: 2 });
        expect(detachedStopRpc).toHaveBeenCalledWith('machine-1', { runId: 'run-detached' }, { serverId: HOME_A });
        expect(sessionStopRpc).not.toHaveBeenCalled();
        expect(machineStopRpc).not.toHaveBeenCalled();
    });

    it('loads the exact background route after a prior Machine request failed', async () => {
        recordMachineRequestFailed({ serverId: HOME_A, accountId: ACCOUNT, machineId: 'machine-1' });
        routerMock.state.router.setParams({ serverId: HOME_A, machineId: 'machine-1', runId: 'background-idle' });
        daemonListRpc.mockResolvedValue({ runs: [createExecutionRun({ runId: 'background-idle', happySessionId: null,
            runClass: 'long_lived', retentionPolicy: 'resumable' })] });
        const screen = await renderRunsScreen();
        expect(screen.findAllByType(ExecutionRunRow).map(row => row.props.run.runId)).toEqual(['background-idle']);
        expect(daemonListRpc).toHaveBeenCalledWith('machine-1', { serverId: HOME_A });
    });

    it('shows a failed list transport as an error rather than an empty run inventory', async () => {
        daemonListRpc.mockRejectedValue(Object.assign(new Error('Fixture list route is not registered'), {
            rpcErrorCode: 'RPC_METHOD_NOT_AVAILABLE',
        }));
        const screen = await renderRunsScreen();
        expect(screen.findAllByType(Item).map(item => item.props.title)).toContain('common.error');
        expect(screen.findAllByType(Item).map(item => item.props.title)).not.toContain('runs.empty');
    });

    it('never falls back to stopping a Session when detached Run Stop fails after issuance', async () => {
        daemonListRpc.mockResolvedValue({ runs: [createExecutionRun({ runId: 'run-detached', happySessionId: null })] });
        detachedStopRpc.mockRejectedValue(Object.assign(new Error('Detached Stop refused'), { rpcErrorCode: 'RPC_FORBIDDEN' }));
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alertAsync).mockClear();
        const screen = await renderRunsScreen();
        const row = screen.findByType(ExecutionRunRow);
        const stopButton = row.findAll(node => typeof node.type === 'string' && node.props.accessibilityLabel === 'runs.stop.stopRunA11y')[0];
        await pressTestInstanceAsync(stopButton);
        expect(detachedStopRpc).toHaveBeenCalled();
        expect(Modal.alertAsync).not.toHaveBeenCalled();
        expect(sessionStopRpc).not.toHaveBeenCalled();
        expect(machineStopRpc).not.toHaveBeenCalled();
    });

    it('selects an exact detached execution Run from fully qualified route intent, including a finished Run', async () => {
        routerMock.state.router.setParams({ serverId: 'srv_server-a', machineId: 'machine-1', runId: 'run/detached 1' });
        daemonListRpc.mockResolvedValue({
            runs: [
                createExecutionRun({ runId: 'other-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType(ExecutionRunRow);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.run.runId).toBe('run/detached 1');
        expect(rows[0]?.props.selected).toBe(true);
    });

    it('does not treat a bare machine and Run id as an exact cross-Home target', async () => {
        routerMock.state.router.setParams({ machineId: 'machine-1', runId: 'run/detached 1' });
        daemonListRpc.mockResolvedValue({
            runs: [
                createExecutionRun({ runId: 'running-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType(ExecutionRunRow);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['running-run']);
        expect(rows[0]?.props.selected).toBe(false);
    });

    it('does not trim malformed opaque route identities into an exact target', async () => {
        routerMock.state.router.setParams({ serverId: ' srv_server-a ', machineId: 'machine-1', runId: 'run/detached 1' });
        daemonListRpc.mockResolvedValue({
            runs: [
                createExecutionRun({ runId: 'running-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType(ExecutionRunRow);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['running-run']);
        expect(rows[0]?.props.selected).toBe(false);
    });

    it('does not select a Run from an ambiguous repeated route identity', async () => {
        routerMock.state.router.setParams({ serverId: 'srv_server-a', machineId: 'machine-1', runId: ['run/detached 1', 'run/detached 1'] });
        daemonListRpc.mockResolvedValue({
            runs: [
                createExecutionRun({ runId: 'running-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType(ExecutionRunRow);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['running-run']);
        expect(rows[0]?.props.selected).toBe(false);
    });
});
