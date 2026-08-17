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
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
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
        const machineListByServerId = { 'server-a': machines as any };
        const machineListStatusByServerId = { 'server-a': 'idle' as const };
        return createPartialStorageModuleMock(importOriginal, {
            useMachineListByServerId: () => machineListByServerId,
            useMachineListStatusByServerId: () => machineListStatusByServerId,
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
        Screen = (await import('@/app/(app)/runs')).default;
        machineExecutionRunsListSpy.mockClear();
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

    it('configures a header title and right-side icon actions', async () => {
        await renderRunsScreen();

        const headerRightScreen = await renderHeaderRight();
        expect(headerRightScreen.findByProps({ accessibilityLabel: 'runs.a11y.refresh' })).toBeTruthy();
        expect(headerRightScreen.findByProps({ accessibilityLabel: 'runs.a11y.toggleFinished' })).toBeTruthy();
    });

    it('renders runs inside the constrained route content wrapper', async () => {
        const screen = await renderRunsScreen();

        expect(screen.findByType('ConstrainedScreenContent' as any)).toBeTruthy();
    });

    it('lists daemon execution runs for machines in the server-scoped machine cache', async () => {
        await renderRunsScreen();

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
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
        expect(routerPushSpy).toHaveBeenCalledWith('/session/sess-1/runs/run-associated');

        await act(async () => {
            await row.props.rightAccessory.props.onPress();
        });
        await flushHookEffects({ cycles: 2 });

        expect(sessionExecutionRunStopSpy).toHaveBeenCalledWith('sess-1', { runId: 'run-associated' }, { serverId: 'server-a' });
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
});
