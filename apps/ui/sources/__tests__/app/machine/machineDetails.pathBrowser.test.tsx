import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
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
    activeServerIdRef: { current: 'server-a' },
    itemSpy: vi.fn(),
    machinesState: { 'machine-1': createMachineRecord() } as Record<string, unknown>,
    machineTargetSessionsState: {} as Record<string, unknown>,
    machineControlTargetBySession: {} as Record<string, { machineId: string; basePath: string }>,
    modalAlertSpy: vi.fn(),
    multiTextInputSpy: vi.fn(),
    machineSpawnNewSessionMock: vi.fn(async (_params: unknown) => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    sessionSpawnNewActionMock: vi.fn<(input: unknown, context: unknown) => Promise<unknown>>(async (_input, _context) => ({
        ok: true as const,
        result: {
            type: 'success' as const,
            disposition: 'created' as const,
            sessionId: 'session-new',
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' as const },
        },
    })),
    openMachinePathBrowserModalMock: vi.fn<(params: unknown) => Promise<string | null>>(async () => '/Users/test/project'),
    projectForSession: {} as Record<string, { key?: { machineId?: string; rootPath?: string } } | null>,
    routeParamsRef: { current: { id: 'machine-1' } as Record<string, string> },
    settingsState: {} as Record<string, unknown>,
    sessionsState: [] as Array<unknown>,
}));
type MachineContributionRegistryProjectionDescribeFn =
    typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;
const {
    machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
    machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
        async () => ({ supported: false, reason: 'not-supported' }),
    ),
}));

installMachineDetailsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { alert: mockState.modalAlertSpy },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
            params: () => mockState.routeParamsRef.current,
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessions: () => mockState.sessionsState,
            useAllMachines: () => [],
            useMachine: () => mockState.machinesState[String(mockState.routeParamsRef.current.id ?? '')] ?? null,
            storage: {
                getState: () => ({
                    settings: mockState.settingsState,
                    sessions: mockState.machineTargetSessionsState,
                    machines: mockState.machinesState,
                    getProjectForSession: (sessionId: string) => mockState.projectForSession[sessionId] ?? null,
                }),
            },
            useSetting: () => false,
            useSettingMutable: () => [null, vi.fn()],
            useSettings: () => mockState.settingsState,
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
    machineSpawnNewSession: (...args: Parameters<typeof mockState.machineSpawnNewSessionMock>) => mockState.machineSpawnNewSessionMock(...args),
    machineStopDaemon: vi.fn(async () => ({ message: 'noop' })),
    machineStopSession: vi.fn(async () => ({ ok: true })),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
    machineRevokeFromAccount: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', () => ({
    createFrontDoorActionExecute: () => async (_actionId: unknown, input: unknown, context: unknown) =>
        mockState.sessionSpawnNewActionMock(input, context),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
        machineContributionRegistryProjectionDescribe(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => true,
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
    getActiveServerId: () => mockState.activeServerIdRef.current,
}));
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
        if (trimmed === '~') return homeDir;
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
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => {
        const controlTarget = mockState.machineControlTargetBySession[sessionId];
        if (controlTarget) return controlTarget;
        const project = mockState.projectForSession[sessionId];
        return project?.key == null
            ? null
            : {
                machineId: project.key.machineId ?? null,
                basePath: project.key.rootPath ?? null,
            };
    },
    readMachineControlTargetForSession: (sessionId: string) => {
        const controlTarget = mockState.machineControlTargetBySession[sessionId];
        if (controlTarget) return { ...controlTarget, confidence: 'reachable' };
        const project = mockState.projectForSession[sessionId];
        return project?.key == null
            ? null
            : {
                machineId: project.key.machineId ?? null,
                basePath: project.key.rootPath ?? null,
                confidence: 'reachable',
            };
    },
    readDisplayMachineIdForSession: ({ sessionId, metadata }: { sessionId: string; metadata?: any }) => {
        const project = mockState.projectForSession[sessionId];
        return project?.key?.machineId ?? metadata?.machineId ?? null;
    },
    readDisplayPathForSession: ({ sessionId, metadata }: { sessionId: string; metadata?: any }) => {
        const project = mockState.projectForSession[sessionId];
        return project?.key?.rootPath ?? metadata?.path ?? '';
    },
}));

describe('MachineDetailScreen path browser', () => {
    beforeEach(() => {
        vi.resetModules();
        mockState.activeServerIdRef.current = 'server-a';
        mockState.machineSpawnNewSessionMock.mockClear();
        mockState.modalAlertSpy.mockReset();
        mockState.sessionSpawnNewActionMock.mockReset();
        mockState.sessionSpawnNewActionMock.mockResolvedValue({
            ok: true,
            result: {
                type: 'success',
                disposition: 'created',
                sessionId: 'session-new',
                executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
                organizationPlacement: { folderId: null, tagIds: [] },
                initialInput: { status: 'notRequested' },
            },
        });
        mockState.openMachinePathBrowserModalMock.mockClear();
        mockState.multiTextInputSpy.mockClear();
        mockState.itemSpy.mockClear();
        mockState.routeParamsRef.current = { id: 'machine-1' };
        mockState.sessionsState = [];
        mockState.machineTargetSessionsState = {};
        mockState.machineControlTargetBySession = {};
        mockState.machinesState = {
            'machine-1': createMachineRecord(),
        };
        mockState.projectForSession = {};
        mockState.settingsState = {};
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    });

    it('opens the shared path browser with the current absolute path preselected and writes the chosen folder relative to the machine home', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        const screen = await renderScreen(React.createElement(MachineDetailScreen));
        await flushHookEffects({ cycles: 1, turns: 2 });

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
                    rootPath: '/Users/test/workspace/rebound',
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

    it('shows the machine workspace path instead of the agent sandbox path in recents', async () => {
        mockState.sessionsState = [
            {
                id: 'session-mapped',
                active: false,
                seq: 1,
                createdAt: 1,
                updatedAt: 20,
                metadata: {
                    machineId: 'machine-1',
                    path: '/home/coder/project',
                    homeDir: '/home/coder',
                },
            },
        ];
        mockState.machineControlTargetBySession = {
            'session-mapped': {
                machineId: 'machine-1',
                basePath: '/Users/test/workspace/project',
            },
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        expect(mockState.itemSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                title: '~/workspace/project',
            }),
        );
    });

    it('creates through the strict V2 Action instead of the private machine spawn helper', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        await act(async () => {
            await Promise.resolve();
        });

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]).toBeTruthy();

        await act(async () => {
            await startButtons[0].props.onPress();
        });

        expect(mockState.sessionSpawnNewActionMock).toHaveBeenCalledWith(expect.objectContaining({
            creationKey: expect.any(String),
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            directory: '/Users/test',
        }), { surface: 'ui' });
        expect(mockState.machineSpawnNewSessionMock).not.toHaveBeenCalled();
    });

    it('shows typed update guidance when the selected machine has an older CLI', async () => {
        mockState.sessionSpawnNewActionMock.mockResolvedValue({
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        });
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]).toBeTruthy();

        await act(async () => {
            await startButtons[0].props.onPress();
        });

        expect(mockState.modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'newSession.actionMethodUnavailable',
        );
        expect(mockState.machineSpawnNewSessionMock).not.toHaveBeenCalled();
    });

    it('does not let machine detail supply a custom custody fingerprint', async () => {
        mockState.sessionSpawnNewActionMock.mockResolvedValue({
            ok: true,
            result: {
                type: 'pending',
                retryWithSameCreationKey: true,
                outcome: 'unknown',
            },
        });
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]).toBeTruthy();

        await act(async () => {
            await startButtons[0].props.onPress();
            await startButtons[0].props.onPress();
        });

        expect(mockState.modalAlertSpy).toHaveBeenCalledWith(
            'common.error',
            'newSession.launchStillPendingBody',
        );
        expect(mockState.sessionSpawnNewActionMock).toHaveBeenCalledTimes(2);
        const [firstInput] = mockState.sessionSpawnNewActionMock.mock.calls[0] ?? [];
        const [retryInput] = mockState.sessionSpawnNewActionMock.mock.calls[1] ?? [];
        expect(firstInput).not.toHaveProperty('spawnAttemptKey');
        expect(retryInput).not.toHaveProperty('spawnAttemptKey');
        expect(retryInput).toEqual(expect.objectContaining({
            creationKey: (firstInput as { creationKey?: unknown })?.creationKey,
        }));
    });

    it('lets a structurally ready machine without synthetic spawn readiness reach the spawn operation', async () => {
        mockState.machinesState['machine-1'] = {
            ...createMachineRecord(),
            active: true,
            activeAt: Date.now(),
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const pathInput = mockState.multiTextInputSpy.mock.calls.at(-1)?.[0];
        await act(async () => {
            pathInput?.onChangeText?.('/Users/test/project');
        });

        const browseButton = screen.findByTestId('path-browser-trigger');
        expect(browseButton?.props.disabled).toBe(false);

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]?.props.disabled).toBe(false);

        await act(async () => {
            await startButtons[0]?.props.onPress();
        });

        expect(mockState.sessionSpawnNewActionMock).toHaveBeenCalledWith(expect.objectContaining({
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
        }), { surface: 'ui' });
    });

    it('falls back to the preferred built-in target when the stored configured backend is stale', async () => {
        mockState.settingsState = {
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'stale-review-bot', configuredBackendId: 'stale-review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: { 'agent:codex': true },
            acpCatalogSettingsV1: {
                v: 2,
                backends: [{ id: 'review-bot', name: 'review-bot', title: 'Review Bot' }],
            },
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]).toBeTruthy();

        await act(async () => {
            await startButtons[0].props.onPress();
        });

        expect(mockState.sessionSpawnNewActionMock).toHaveBeenCalledWith(expect.objectContaining({
            agentTarget: expect.objectContaining({ kind: 'agent' }),
        }), { surface: 'ui' });
    });

    it('falls back to the preferred built-in target when lastUsedAgent is legacy customAcp even when merged projection lists discovered plugin backends', async () => {
        mockState.settingsState = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
        };
        machineContributionRegistryProjectionDescribe.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                agentsById: {
                    'acme.review.provider': {
                        id: 'acme.review.provider',
                        title: 'Acme Review Provider',
                        channel: 'plugin',
                        isBuiltIn: false,
                        settingsBackendId: 'acme.review.backend',
                    },
                },
                backendsById: {
                    'acme.review.backend': {
                        id: 'acme.review.backend',
                        backendId: 'acme.review.backend',
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Backend',
                    },
                },
            },
        });

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]).toBeTruthy();

        await act(async () => {
            await startButtons[0].props.onPress();
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'server-a',
            timeoutMs: 10_000,
        }));
        expect(mockState.sessionSpawnNewActionMock).toHaveBeenCalledWith(expect.objectContaining({
            agentTarget: expect.objectContaining({ kind: 'agent' }),
        }), { surface: 'ui' });
    });

    it('uses the requested route server when spawning a new session', async () => {
        mockState.routeParamsRef.current = { id: 'machine-1', serverId: 'server-b' };
        mockState.activeServerIdRef.current = 'server-a';

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
        const screen = await renderScreen(React.createElement(MachineDetailScreen));

        const startButtons = screen.findAll((node) =>
            String(node.type) === 'Pressable'
            && typeof node.props?.onPress === 'function'
            && typeof node.props?.disabled === 'boolean',
        );

        expect(startButtons[0]).toBeTruthy();

        await act(async () => {
            await startButtons[0].props.onPress();
        });

        expect(mockState.sessionSpawnNewActionMock).toHaveBeenCalledWith(expect.objectContaining({
            executionTarget: { serverId: 'server-b', machineId: 'machine-1' },
        }), { surface: 'ui' });
    });
});
