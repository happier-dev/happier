import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

function createMachineRecord() {
    return {
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
    };
}

const mockState = vi.hoisted(() => ({
    itemSpy: vi.fn(),
    machinesState: { 'machine-1': createMachineRecord() } as Record<string, unknown>,
    machineTargetSessionsState: {} as Record<string, unknown>,
    multiTextInputSpy: vi.fn(),
    openMachinePathBrowserModalMock: vi.fn<(params: unknown) => Promise<string | null>>(async () => '/Users/test/project'),
    projectForSession: {} as Record<string, { key?: { machineId?: string; path?: string } } | null>,
    sessionsState: [] as Array<unknown>,
}));

installMachineDetailsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessions: () => mockState.sessionsState,
            useAllMachines: () => [],
            useMachine: () => createMachineRecord(),
            storage: {
                getState: () => ({
                    settings: {},
                    sessions: mockState.machineTargetSessionsState,
                    machines: mockState.machinesState,
                    getProjectForSession: (sessionId: string) => mockState.projectForSession[sessionId] ?? null,
                }),
            },
            useSetting: () => false,
            useSettingMutable: () => [null, vi.fn()],
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        mockState.itemSpy(props);
        return React.createElement('Item', props);
    },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: any, _ref) => {
        mockState.multiTextInputSpy(props);
        return React.createElement('MultiTextInput', props);
    }),
}));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({ ExecutionRunRow: () => null }));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', {
        testID: props.testID ?? 'path-browser-trigger',
        onPress: props.onPress,
        disabled: props.disabled,
    }),
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (params: unknown) => mockState.openMachinePathBrowserModalMock(params),
}));

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

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => true,
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({ getActiveServerId: () => 'server-a' }));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({ setActiveServerAndSwitch: vi.fn(async () => true) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshMachinesThrottled: vi.fn(), refreshMachines: vi.fn(), retryNow: vi.fn() } }));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>, options?: { onError?: (error: unknown) => void }) => {
        void promise.catch((error) => {
            options?.onError?.(error);
        });
    },
}));
vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: () => false,
    tryShowDaemonUnavailableAlertForRpcFailure: () => false,
}));
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
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({ cli: { detectKey: 'codex' } }),
    isAgentId: () => true,
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => {
        const project = mockState.projectForSession[sessionId];
        return project?.key == null
            ? null
            : {
                machineId: project.key.machineId ?? null,
                path: project.key.path ?? null,
            };
    },
}));

describe('MachineDetailScreen path browser', () => {
    beforeEach(() => {
        mockState.openMachinePathBrowserModalMock.mockClear();
        mockState.multiTextInputSpy.mockClear();
        mockState.itemSpy.mockClear();
        mockState.sessionsState = [];
        mockState.machineTargetSessionsState = {};
        mockState.machinesState = {
            'machine-1': createMachineRecord(),
        };
        mockState.projectForSession = {};
    });

    it('opens the shared path browser with the current absolute path preselected and writes the chosen folder relative to the machine home', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const pathInput = mockState.multiTextInputSpy.mock.calls.at(-1)?.[0];
        expect(pathInput).toBeTruthy();
        await act(async () => {
            pathInput?.onChangeText?.('~/workspace/demo');
        });

        expect(mockState.openMachinePathBrowserModalMock).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('path-browser-trigger');

        expect(mockState.openMachinePathBrowserModalMock).toHaveBeenCalledWith({
            machineId: 'machine-1',
            serverId: 'server-a',
            initialPath: '/Users/test/workspace/demo',
            title: 'machine.launchNewSessionInDirectory',
        });

        const latestMultiTextInputProps = mockState.multiTextInputSpy.mock.calls.at(-1)?.[0];
        expect(latestMultiTextInputProps?.value).toBe('~/project');
    });

    it('includes recent paths for sessions that rebound to this machine through the reachable target resolver', async () => {
        mockState.sessionsState = [
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
        mockState.machineTargetSessionsState = {
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
        mockState.machinesState = {
            ...mockState.machinesState,
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
        mockState.projectForSession = {
            'session-1': {
                key: {
                    machineId: 'machine-1',
                    path: '/Users/test/workspace/rebound',
                },
            },
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        expect(mockState.itemSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                title: '~/workspace/rebound',
            }),
        );
    });
});
