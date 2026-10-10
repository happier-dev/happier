import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DaemonExecutionRunEntry } from '@happier-dev/protocol';

import {
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createPassThroughComponent, createPassThroughModule } from '@/dev/testkit/mocks/components';
import { createExpoVectorIconsMock } from '@/dev/testkit/mocks/icons';
import {
    createExpoRouterMock,
    createStackOptionsCapture,
} from '@/dev/testkit/mocks/router';
import { installRouteRootCommonModuleMocks } from '../routeRootTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type MachineExecutionRunsListArgs = [string, Record<string, unknown>?];

const machineExecutionRunsListSpy = vi.fn(async (..._args: MachineExecutionRunsListArgs): Promise<{
    ok: true;
    runs: DaemonExecutionRunEntry[];
}> => ({
    ok: true,
    runs: [],
}));
const machineStopSessionSpy = vi.fn(async (..._args: [string, string, { serverId: string }]) => ({ ok: true as const }));
const routerPushSpy = vi.fn();
const routerBackSpy = vi.fn();
const routerReplaceSpy = vi.fn();
const routerNavigateSpy = vi.fn();
const sessionExecutionRunStopSpy = vi.fn(async (..._args: [string, { runId: string }, { serverId: string }]) => ({ ok: true as const }));
const stackOptionsCapture = createStackOptionsCapture();
const machineListState = vi.hoisted(() => ({
    byServerId: {} as Record<string, any[]>,
    statusByServerId: {} as Record<string, 'idle' | 'loading' | 'ready' | 'error' | 'signedOut'>,
}));
const routerMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
        back: routerBackSpy,
        replace: routerReplaceSpy,
        setParams: vi.fn(),
    },
    stackOptionsCapture,
});

installRouteRootCommonModuleMocks({
    modal: async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock();
    },
    router: () => ({
        ...routerMock.module,
        useRouter: () => ({
            ...routerMock.state.router,
            navigate: routerNavigateSpy,
        }),
    }),
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                surface: '#111',
                surfaceHigh: '#222',
                divider: '#333',
                text: '#eee',
                textSecondary: '#aaa',
                header: { tint: '#eee' },
                status: { error: '#f00' },
                shadow: { color: '#000', opacity: 0.2 },
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        const machines = [
            {
                id: 'machine-1',
                active: true,
                createdAt: 1,
                updatedAt: 1,
                activeAt: Date.now(),
                metadata: { host: 'a.local', happyCliVersion: '1.0.0', happyHomeDir: '/tmp', homeDir: '/tmp' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 1,
                seq: 0,
            },
        ];
        machineListState.byServerId = { 'srv_server-a': machines as any };
        machineListState.statusByServerId = { 'srv_server-a': 'idle' as const };
        return createStorageModuleStub({
            useMachineListByServerId: () => machineListState.byServerId,
            useMachineListStatusByServerId: () => machineListState.statusByServerId,
            useSetting: () => false,
        });
    },
});

vi.mock('@expo/vector-icons', () => createExpoVectorIconsMock());

vi.mock('@/components/ui/lists/Item', () => createPassThroughModule(['Item']));

vi.mock('@/components/ui/lists/ItemGroup', () => createPassThroughModule(['ItemGroup']));

vi.mock('@/components/ui/lists/ItemList', () => createPassThroughModule(['ItemList']));

vi.mock('@/components/ui/layout/ConstrainedScreenContent', () => ({
    ConstrainedScreenContent: createPassThroughComponent('ConstrainedScreenContent'),
}));

vi.mock('@/components/sessions/runs/ExecutionRunRow', () => createPassThroughModule(['ExecutionRunRow']));

vi.mock('@/sync/ops/machineExecutionRuns', () => ({
    machineExecutionRunsList: (...args: MachineExecutionRunsListArgs) => machineExecutionRunsListSpy(...args),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: (...args: [string, { runId: string }, { serverId: string }]) => sessionExecutionRunStopSpy(...args),
}));

vi.mock('@/sync/ops/machines', () => ({
    machineStopSession: (...args: [string, string, { serverId: string }]) => machineStopSessionSpy(...args),
}));

vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcFailure: () => false,
}));

vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));

describe('Runs screen', () => {
    let Screen: React.ComponentType<any>;

    function createExecutionRun(overrides: Partial<DaemonExecutionRunEntry> & Pick<DaemonExecutionRunEntry, 'runId'>): DaemonExecutionRunEntry {
        const { runId, ...rest } = overrides;
        return {
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
        };
    }

    beforeEach(async () => {
        const machine = {
            id: 'machine-1',
            active: true,
            createdAt: 1,
            updatedAt: 1,
            activeAt: Date.now(),
            metadata: { host: 'a.local', happyCliVersion: '1.0.0', happyHomeDir: '/tmp', homeDir: '/tmp' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 1,
            seq: 0,
        };
        machineListState.byServerId = { 'srv_server-a': [machine] };
        machineListState.statusByServerId = { 'srv_server-a': 'idle' };
        routerMock.state.params = {};
        // `router.setParams` overrides live on the module-level mock; clear them between cases.
        routerMock.resetParams();
        Screen = (await import('@/app/(app)/runs')).default;
        machineExecutionRunsListSpy.mockReset();
        machineExecutionRunsListSpy.mockResolvedValue({ ok: true, runs: [] });
        machineStopSessionSpy.mockClear();
        routerPushSpy.mockClear();
        routerBackSpy.mockClear();
        routerReplaceSpy.mockClear();
        routerNavigateSpy.mockClear();
        sessionExecutionRunStopSpy.mockClear();
        stackOptionsCapture.reset();
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderRunsScreen() {
        // Seed the real all-profile inventory owner. Runs no longer consumes the
        // concurrent-map-only storage stub used by these older row/action cases.
        const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        for (const serverId of Object.keys(machineListState.byServerId)) {
            const serverUrl = `https://${serverId}.runs.test`;
            const profile = await adoptHomeProfile({ descriptor: {
                v: 1, homeServerIdentityId: serverId, canonicalServerUrl: serverUrl, revision: 1,
                endpoints: [{ kind: 'https', url: serverUrl }],
            }, source: 'qr', descriptorAuthority: 'current_connection_observation' });
            if (serverId === 'srv_server-a') await setActiveServerId(profile.id);
        }
        getStorage().setState({ isDataReady: true, machines: {}, machineListByServerId: machineListState.byServerId,
            machineListStatusByServerId: Object.fromEntries(Object.entries(machineListState.statusByServerId)
                .map(([id, status]) => [id, status === 'ready' ? 'idle' : status])),
            profile: { ...getStorage().getState().profile, id: 'runs-account' } });
        const screen = await renderScreen(<Screen />);
        await flushHookEffects({ cycles: 2 });
        return screen;
    }

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
        machineExecutionRunsListSpy.mockResolvedValue({
            ok: true,
            runs: [
                createExecutionRun({ runId: 'run-live' }),
                createExecutionRun({ runId: 'run-done', status: 'succeeded' }),
            ],
        });
        const screen = await renderRunsScreen();
        const runIds = () => screen.findAllByType('ExecutionRunRow' as any).map((row) => row.props.run.runId);

        expect(runIds()).toEqual(['run-live']);
        await act(async () => {
            screen.pressByTestId('runs.filter:all');
        });
        expect(runIds()).toEqual(['run-live', 'run-done']);
    });

    it('says there are no machines when the signed-in Homes have none', async () => {
        machineListState.byServerId = { 'srv_server-a': [] };
        const screen = await renderRunsScreen();

        expect(screen.findAllByType('Item' as any).map((item) => item.props.title)).toContain('runs.noMachinesAvailable');
    });

    it('renders runs inside the constrained route content wrapper', async () => {
        const screen = await renderRunsScreen();

        expect(screen.findByType('ConstrainedScreenContent' as any)).toBeTruthy();
    });

    it('lists daemon execution runs for machines in the server-scoped machine cache', async () => {
        await renderRunsScreen();

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'srv_server-a' });
    });

    it('keeps daemon Run rows isolated when two Homes expose the same machine id', async () => {
        const duplicateMachine = {
            ...machineListState.byServerId['srv_server-a']![0],
            metadata: { ...machineListState.byServerId['srv_server-a']![0]!.metadata, host: 'duplicate.local' },
        };
        machineListState.byServerId = {
            'srv_server-a': machineListState.byServerId['srv_server-a']!,
            'srv_server-b': [duplicateMachine],
        };
        machineListState.statusByServerId = { 'srv_server-a': 'idle', 'srv_server-b': 'idle' };
        machineExecutionRunsListSpy.mockImplementation(async (_machineId, options) => ({
            ok: true,
            runs: [createExecutionRun({
                runId: options?.serverId === 'srv_server-a' ? 'run-home-a' : 'run-home-b',
            })],
        }));

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType('ExecutionRunRow' as any);

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
            ...machineListState.byServerId['srv_server-a']![0],
            metadata: { ...machineListState.byServerId['srv_server-a']![0]!.metadata, host: 'duplicate.local' },
        };
        machineListState.byServerId = {
            'srv_server-a': machineListState.byServerId['srv_server-a']!,
            'srv_server-b': [duplicateMachine],
        };
        machineListState.statusByServerId = { 'srv_server-a': 'idle', 'srv_server-b': 'idle' };
        routerMock.state.router.setParams({ serverId: 'srv_server-b', machineId: 'machine-1', runId: 'same-run' });
        machineExecutionRunsListSpy.mockResolvedValue({
            ok: true,
            runs: [createExecutionRun({ runId: 'same-run', happySessionId: null, status: 'succeeded' })],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType('ExecutionRunRow' as any);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.run.runId).toBe('same-run');
        expect(machineExecutionRunsListSpy).toHaveBeenCalledTimes(1);
        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'srv_server-b' });
    });

    it('keeps Session-associated daemon runs navigable and stoppable', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-associated' })],
        });

        const screen = await renderRunsScreen();
        const row = screen.findByType('ExecutionRunRow' as any);

        expect(row.props.subtitle).toContain('runs.sessionTitle');
        expect(row.props.onPress).toEqual(expect.any(Function));
        expect(row.props.rightAccessory).toBeTruthy();
        row.props.onPress();
        expect(routerPushSpy).toHaveBeenCalledWith('/session/sess-1/runs/run-associated?serverId=srv_server-a');

        await act(async () => {
            await row.props.rightAccessory.props.onPress();
        });
        await flushHookEffects({ cycles: 2 });

        expect(sessionExecutionRunStopSpy).toHaveBeenCalledWith('sess-1', { runId: 'run-associated' }, { serverId: 'srv_server-a' });
    });

    it('keeps detached daemon runs factual without a Session route or Session stop controls', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [createExecutionRun({ runId: 'run-detached', happySessionId: null })],
        });

        const screen = await renderRunsScreen();
        const row = screen.findByType('ExecutionRunRow' as any);

        expect(row.props.run.happySessionId).toBeNull();
        expect(row.props.subtitle).not.toContain('runs.sessionTitle');
        expect(row.props.onPress).toBeUndefined();
        expect(row.props.rightAccessory).toBeNull();
        expect(sessionExecutionRunStopSpy).not.toHaveBeenCalled();
        expect(machineStopSessionSpy).not.toHaveBeenCalled();
    });

    it('selects an exact detached execution Run from fully qualified route intent, including a finished Run', async () => {
        routerMock.state.router.setParams({ serverId: 'srv_server-a', machineId: 'machine-1', runId: 'run/detached 1' });
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                createExecutionRun({ runId: 'other-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType('ExecutionRunRow' as any);

        expect(rows).toHaveLength(1);
        expect(rows[0]?.props.run.runId).toBe('run/detached 1');
        expect(rows[0]?.props.selected).toBe(true);
    });

    it('does not treat a bare machine and Run id as an exact cross-Home target', async () => {
        routerMock.state.router.setParams({ machineId: 'machine-1', runId: 'run/detached 1' });
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                createExecutionRun({ runId: 'running-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType('ExecutionRunRow' as any);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['running-run']);
        expect(rows[0]?.props.selected).toBe(false);
    });

    it('does not trim malformed opaque route identities into an exact target', async () => {
        routerMock.state.router.setParams({ serverId: ' srv_server-a ', machineId: 'machine-1', runId: 'run/detached 1' });
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                createExecutionRun({ runId: 'running-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType('ExecutionRunRow' as any);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['running-run']);
        expect(rows[0]?.props.selected).toBe(false);
    });

    it('does not select a Run from an ambiguous repeated route identity', async () => {
        routerMock.state.router.setParams({ serverId: 'srv_server-a', machineId: 'machine-1', runId: ['run/detached 1', 'run/detached 1'] });
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                createExecutionRun({ runId: 'running-run' }),
                createExecutionRun({ runId: 'run/detached 1', happySessionId: null, status: 'succeeded' }),
            ],
        });

        const screen = await renderRunsScreen();
        const rows = screen.findAllByType('ExecutionRunRow' as any);

        expect(rows.map((row) => row.props.run.runId)).toEqual(['running-run']);
        expect(rows[0]?.props.selected).toBe(false);
    });
});
