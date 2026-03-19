import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const openMachinePathBrowserModalMock = vi.hoisted(() => vi.fn<(params: unknown) => Promise<string | null>>(async () => '/Users/test/project'));
const multiTextInputSpy = vi.fn();
const itemSpy = vi.fn();
let sessionsState: Array<unknown> = [];
let machineTargetSessionsState: Record<string, unknown> = {};
let machinesState: Record<string, unknown> = {
    'machine-1': {
        id: 'machine-1',
        active: true,
        activeAt: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        seq: 0,
        metadata: { displayName: 'My Machine', host: 'host', platform: 'darwin', homeDir: '/Users/test' },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        revokedAt: null,
    },
};
let projectForSession: Record<string, { key?: { machineId?: string; path?: string } } | null> = {};

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: <T,>(options: { web?: T; default?: T }) => options.web ?? options.default },
    TurboModuleRegistry: { getEnforcing: () => ({}) },
    View: 'View',
    Text: 'Text',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    RefreshControl: 'RefreshControl',
    Pressable: 'Pressable',
    TextInput: 'TextInput',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useLocalSearchParams: () => ({ id: 'machine-1' }),
    useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

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
                textLink: '#06f',
                accent: { blue: '#06f' },
                surface: '#fff',
                surfaceHigh: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
                modal: { border: 'rgba(0, 0, 0, 0.1)' },
                status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' },
                permissionButton: { inactive: { background: '#ccc' } },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input({
                    colors: {
                        header: { tint: '#000' },
                        input: { background: '#fff', text: '#000' },
                        groupped: { background: '#fff', sectionTitle: '#000' },
                        divider: '#ddd',
                        button: { primary: { background: '#000', tint: '#fff' } },
                         text: '#000',
                         textSecondary: '#666',
                         textLink: '#06f',
                         accent: { blue: '#06f' },
                         surface: '#fff',
                         surfaceHigh: '#fff',
                         shadow: { color: '#000', opacity: 0.1 },
                         modal: { border: 'rgba(0, 0, 0, 0.1)' },
                         status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' },
                         permissionButton: { inactive: { background: '#ccc' } },
                     },
                 })
                 : input,
    },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        itemSpy(props);
        return React.createElement('Item', props);
    },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: any, _ref) => {
        multiTextInputSpy(props);
        return React.createElement('MultiTextInput', props);
    }),
}));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({ ExecutionRunRow: () => null }));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', props),
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (params: unknown) => openMachinePathBrowserModalMock(params),
}));

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() } }));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: vi.fn(async () => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    machineStopDaemon: vi.fn(async () => ({ message: 'noop' })),
    machineStopSession: vi.fn(async () => ({ ok: true })),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
    machineRevokeFromAccount: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/domains/state/storage', () => {
    const React = require('react');
    return {
        useSessions: () => sessionsState,
        useAllMachines: () => [],
        useMachine: () => ({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 0,
            metadata: { displayName: 'My Machine', host: 'host', platform: 'darwin', homeDir: '/Users/test' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
        }),
        storage: {
            getState: () => ({
                settings: {},
                sessions: machineTargetSessionsState,
                machines: machinesState,
                getProjectForSession: (sessionId: string) => projectForSession[sessionId] ?? null,
            }),
        },
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

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({ getActiveServerId: () => 'server-a' }));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({ setActiveServerAndSwitch: vi.fn(async () => true) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshMachinesThrottled: vi.fn(), refreshMachines: vi.fn(), retryNow: vi.fn() } }));
vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', async () => {
    const actual = await vi.importActual<any>('@/utils/sessions/sessionUtils');
    return {
        ...actual,
        getSessionName: () => '',
        getSessionSubtitle: () => '',
    };
});
vi.mock('@/utils/path/pathUtils', () => ({
    resolveAbsolutePath: (value: string, homeDir: string) => {
        const trimmed = value.trim();
        if (!trimmed) return '';
        if (trimmed.startsWith('~/')) return `${homeDir}/${trimmed.slice(2)}`;
        if (trimmed.startsWith('/')) return trimmed;
        return `${homeDir}/${trimmed}`;
    },
}));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));

describe('MachineDetailScreen path browser', () => {
    beforeEach(() => {
        openMachinePathBrowserModalMock.mockClear();
        multiTextInputSpy.mockClear();
        itemSpy.mockClear();
        sessionsState = [];
        machineTargetSessionsState = {};
        machinesState = {
            'machine-1': {
                id: 'machine-1',
                active: true,
                activeAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                seq: 0,
                metadata: { displayName: 'My Machine', host: 'host', platform: 'darwin', homeDir: '/Users/test' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            },
        };
        projectForSession = {};
    });

    it('opens the shared path browser with the current absolute path preselected and writes the chosen folder relative to the machine home', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
        });

        const pathInput = tree.root.findByType('MultiTextInput');
        await act(async () => {
            pathInput.props.onChangeText?.('~/workspace/demo');
        });

        const browseButton = tree.root.findByType('PathInputBrowseButton');
        await act(async () => {
            await browseButton.props.onPress();
        });

        expect(openMachinePathBrowserModalMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
            initialPath: '/Users/test/workspace/demo',
            title: 'machine.launchNewSessionInDirectory',
        });

        const latestMultiTextInputProps = multiTextInputSpy.mock.calls.at(-1)?.[0];
        expect(latestMultiTextInputProps?.value).toBe('~/project');
    });

    it('includes recent paths for sessions that rebound to this machine through the reachable target resolver', async () => {
        sessionsState = [
            {
                id: 'session-1',
                active: true,
                seq: 1,
                createdAt: 1,
                updatedAt: 20,
                metadata: {
                    machineId: 'machine-stale',
                    path: '/Users/test/workspace/rebound',
                    homeDir: '/Users/test',
                },
            },
        ];
        machineTargetSessionsState = {
            'session-1': {
                active: true,
                updatedAt: 20,
                metadata: {
                    machineId: 'machine-stale',
                    path: '/Users/test/workspace/rebound',
                    homeDir: '/Users/test',
                },
            },
        };
        machinesState = {
            ...machinesState,
            'machine-target': {
                id: 'machine-target',
                active: true,
                activeAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                seq: 1,
                metadata: { displayName: 'Rebound Machine', host: 'target-host', platform: 'darwin', homeDir: '/Users/test' },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            },
        };
        projectForSession = {
            'session-1': {
                key: {
                    machineId: 'machine-1',
                    path: '/Users/test/workspace/rebound',
                },
            },
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
        });

        expect(itemSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                title: '~/workspace/rebound',
            }),
        );
    });
});
