import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const machineExecutionRunsListSpy = vi.fn(async () => ({ ok: true, runs: [] as any[] }));
const itemGroupSpy = vi.fn();
const itemSpy = vi.fn();
const switchSpy = vi.fn();
const stopRunSpy = vi.fn<(..._args: any[]) => Promise<any>>(async (..._args: any[]) => ({ ok: true }));
const stopSessionSpy = vi.fn<(..._args: any[]) => Promise<any>>(async (..._args: any[]) => ({ ok: true }));
const executionRunRowSpy = vi.fn();
const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => {
    type PlatformSelectOptions<T> = { web?: T; default?: T };
    return {
        Platform: { OS: 'web', select: <T,>(options: PlatformSelectOptions<T>) => options.web ?? options.default },
        TurboModuleRegistry: { getEnforcing: () => ({}) },
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator',
        RefreshControl: 'RefreshControl',
        Pressable: 'Pressable',
        TextInput: 'TextInput',
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-router', () => {
    const Stack: { Screen: () => null } = { Screen: () => null };
    return {
        Stack,
        useLocalSearchParams: () => ({ id: 'machine-1' }),
        useRouter: () => routerMock,
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                input: { background: '#fff', text: '#000' },
                groupped: { background: '#fff', sectionTitle: '#000' },
                divider: '#ddd',
                button: { primary: { background: '#000', tint: '#fff' } },
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                surfaceHigh: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
                status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' },
                permissionButton: { inactive: { background: '#ccc' } },
            }
        }
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { input: { background: '#fff', text: '#000' }, groupped: { background: '#fff', sectionTitle: '#000' }, divider: '#ddd', button: { primary: { background: '#000', tint: '#fff' } }, text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#fff', shadow: { color: '#000', opacity: 0.1 }, status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' }, permissionButton: { inactive: { background: '#ccc' } }, header: { tint: '#000' } } }) },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        itemSpy(props);
        return React.createElement(React.Fragment, null, props.rightElement ?? null);
    }
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ title, children }: any) => {
        itemGroupSpy({ title });
        return React.createElement(React.Fragment, null, children);
    }
}));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({ MultiTextInput: () => null }));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: any) => {
        switchSpy(props);
        return null;
    }
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({
    ExecutionRunRow: (props: any) => {
        executionRunRowSpy(props);
        return null;
    },
}));

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() } }));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: vi.fn(async () => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    machineStopDaemon: vi.fn(async () => ({ message: 'noop' })),
    machineStopSession: (...args: any[]) => stopSessionSpy(...args),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: machineExecutionRunsListSpy,
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: (...args: any[]) => stopRunSpy(...args),
}));

vi.mock('@/sync/domains/state/storage', () => {
    const React = require('react');
    return {
        useSessions: () => [],
        useMachine: () => ({
            id: 'machine-1',
            activeAt: Date.now(),
            metadata: { platform: 'darwin', windowsRemoteSessionConsole: 'visible' },
            metadataVersion: 1,
            daemonStateVersion: 1,
        }),
        useSetting: (name: string) => {
            React.useMemo(() => 0, [name]);
            return false;
        },
        useSettingMutable: (name: string) => {
            React.useMemo(() => 0, [name]);
            return [null, vi.fn()];
        },
        useSettings: () => {
            React.useMemo(() => 0, []);
            return {};
        },
    };
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => { } }));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-a',
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(),
        refreshMachines: vi.fn(),
        retryNow: vi.fn(),
    },
}));

vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/capabilities/installableDepsRegistry', () => ({ getInstallableDepRegistryEntries: () => [] }));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: vi.fn(async () => true),
}));

describe('MachineDetailScreen (execution runs section)', () => {
    it('loads daemon execution runs for online machines', async () => {
        machineExecutionRunsListSpy.mockClear();
        itemGroupSpy.mockClear();
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
        });

        expect(machineExecutionRunsListSpy).toHaveBeenCalledWith('machine-1', { serverId: 'server-a' });
    });

    it('renders an execution runs group when enabled', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [{
                happyHomeDir: '/tmp/happier-test-home',
                pid: 123,
                happySessionId: 'sess-1',
                runId: 'run-1',
                callId: 'call-1',
                sidechainId: 'side-1',
                intent: 'review',
                backendId: 'claude',
                runClass: 'bounded',
                ioMode: 'request_response',
                retentionPolicy: 'ephemeral',
                status: 'running',
                startedAtMs: Date.now(),
                updatedAtMs: Date.now(),
            }],
        });
        itemGroupSpy.mockClear();
        itemSpy.mockClear();
        switchSpy.mockClear();
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(itemGroupSpy).toHaveBeenCalledWith(expect.objectContaining({ title: 'runs.title' }));
    });

    it('shows only running runs by default and includes finished when toggled', async () => {
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                {
                    happyHomeDir: '/tmp/happier-test-home',
                    pid: 123,
                    happySessionId: 'sess-1',
                    runId: 'run-running',
                    callId: 'call-1',
                    sidechainId: 'side-1',
                    intent: 'review',
                    backendId: 'claude',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    retentionPolicy: 'ephemeral',
                    status: 'running',
                    startedAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                },
                {
                    happyHomeDir: '/tmp/happier-test-home',
                    pid: 123,
                    happySessionId: 'sess-1',
                    runId: 'run-finished',
                    callId: 'call-2',
                    sidechainId: 'side-2',
                    intent: 'review',
                    backendId: 'claude',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    retentionPolicy: 'ephemeral',
                    status: 'succeeded',
                    startedAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                    finishedAtMs: Date.now(),
                },
            ],
        });

        switchSpy.mockClear();
        executionRunRowSpy.mockClear();
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
            await Promise.resolve();
        });

        // Default: finished runs are filtered out.
        const initialRunIds = executionRunRowSpy.mock.calls.map((c) => String(c?.[0]?.run?.runId ?? '')).filter(Boolean);
        expect(initialRunIds).toContain('run-running');
        expect(initialRunIds).not.toContain('run-finished');

        const toggle = switchSpy.mock.calls.at(-1)?.[0];
        expect(typeof toggle?.onValueChange).toBe('function');

        executionRunRowSpy.mockClear();
        await act(async () => {
            toggle.onValueChange(true);
            await Promise.resolve();
            await Promise.resolve();
        });

        const afterRunIds = executionRunRowSpy.mock.calls.map((c) => String(c?.[0]?.run?.runId ?? '')).filter(Boolean);
        expect(afterRunIds).toContain('run-running');
        expect(afterRunIds).toContain('run-finished');
    });

    it('offers a stop control for running runs', async () => {
        stopRunSpy.mockClear();
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [
                {
                    happyHomeDir: '/tmp/happier-test-home',
                    pid: 123,
                    happySessionId: 'sess-1',
                    runId: 'run-running',
                    callId: 'call-1',
                    sidechainId: 'side-1',
                    intent: 'review',
                    backendId: 'claude',
                    runClass: 'bounded',
                    ioMode: 'request_response',
                    retentionPolicy: 'ephemeral',
                    status: 'running',
                    startedAtMs: Date.now(),
                    updatedAtMs: Date.now(),
                },
            ],
        });

        executionRunRowSpy.mockClear();
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executionRunRowSpy).toHaveBeenCalled();
        const rowProps = executionRunRowSpy.mock.calls[0]?.[0];
        expect(rowProps?.rightAccessory).toBeDefined();

        await act(async () => {
            rowProps.rightAccessory.props.onPress?.();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(stopRunSpy).toHaveBeenCalledWith('sess-1', { runId: 'run-running' }, { serverId: 'server-a' });
    });

    it('navigates to run details when pressing an execution run row', async () => {
        routerMock.push.mockClear();
        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [{
                happyHomeDir: '/tmp/happier-test-home',
                pid: 123,
                happySessionId: 'sess-1',
                runId: 'run-1',
                callId: 'call-1',
                sidechainId: 'side-1',
                intent: 'review',
                backendId: 'claude',
                runClass: 'bounded',
                ioMode: 'request_response',
                retentionPolicy: 'ephemeral',
                status: 'running',
                startedAtMs: Date.now(),
                updatedAtMs: Date.now(),
            }],
        });
        executionRunRowSpy.mockClear();

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(executionRunRowSpy).toHaveBeenCalled();
        const rowProps = executionRunRowSpy.mock.calls[0]?.[0];
        expect(rowProps).toEqual(expect.objectContaining({ run: expect.objectContaining({ runId: 'run-1' }) }));

        await act(async () => {
            rowProps.onPress();
        });

        expect(routerMock.push).toHaveBeenCalledWith('/session/sess-1/runs/run-1');
    });

    it('can stop a run and falls back to stopping the whole session process when session RPC stop is unavailable', async () => {
        const { Modal } = await import('@/modal');
        (Modal.confirm as any).mockResolvedValueOnce(true);

        machineExecutionRunsListSpy.mockResolvedValueOnce({
            ok: true,
            runs: [{
                happyHomeDir: '/tmp/happier-test-home',
                pid: 123,
                happySessionId: 'sess-1',
                runId: 'run-running',
                callId: 'call-1',
                sidechainId: 'side-1',
                intent: 'review',
                backendId: 'claude',
                runClass: 'bounded',
                ioMode: 'request_response',
                retentionPolicy: 'ephemeral',
                status: 'running',
                startedAtMs: Date.now(),
                updatedAtMs: Date.now(),
            }],
        });

        stopRunSpy.mockResolvedValueOnce({ ok: false, error: 'Unsupported response from session RPC' });
        stopSessionSpy.mockResolvedValueOnce({ ok: true });

        executionRunRowSpy.mockClear();
        stopRunSpy.mockClear();
        stopSessionSpy.mockClear();

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
            await Promise.resolve();
        });

        const rowProps = executionRunRowSpy.mock.calls[0]?.[0];
        expect(rowProps).toBeTruthy();
        const accessory = rowProps.rightAccessory;
        expect(accessory?.props?.onPress).toBeTruthy();

        await act(async () => {
            await accessory.props.onPress();
            await Promise.resolve();
        });

        expect(stopRunSpy).toHaveBeenCalled();
        expect(stopSessionSpy).toHaveBeenCalledWith('machine-1', 'sess-1', { serverId: 'server-a' });
    });
});
