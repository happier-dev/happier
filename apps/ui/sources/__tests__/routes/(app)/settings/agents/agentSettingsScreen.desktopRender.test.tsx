import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import PluginAgentSettingsScreen from '@/app/(app)/settings/agents/[agentId]';
import { AppCrashRecoveryBoundary } from '@/components/appShell/AppCrashRecoveryBoundary';
import { CommandPaletteProvider } from '@/components/appShell/commandPalette/CommandPaletteProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { AppPaneModalProvider } from '@/components/appShell/providers/AppPaneModalProvider';
import { SidebarNavigator } from '@/components/navigation/shell/SidebarNavigator';
import { SettingsShell } from '@/components/settings/shell/SettingsShell';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { RealtimeProvider } from '@/realtime/RealtimeProvider.web';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsMock = vi.fn();
const administrationTargetState = vi.hoisted(() => ({
    selectedTarget: {
        serverIdentityId: 'server1',
        machineId: 'm1',
    },
    executionTarget: {
        target: {
            serverIdentityId: 'server1',
            machineId: 'm1',
        },
        serverId: 'server1',
        machine: {
            id: 'm1',
            metadata: { displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' },
            daemonStateVersion: 0,
        },
    },
}));

let settingsState: Record<string, unknown> = {};
let localSettingsState: Record<string, unknown> = {};
const activeServerState = vi.hoisted(() => ({
    current: {
        serverId: 'server1',
        serverUrl: 'http://localhost:3000',
        generation: 1,
    },
    subscriber: null as ((snapshot: {
        serverId: string;
        serverUrl: string;
        generation: number;
    }) => void) | null,
}));

const machinesState = [
    { id: 'm1', revokedAt: null, metadata: { displayName: 'Machine One', host: 'm1', homeDir: '/Users/m1' } },
];

const machineListByServerIdState = {
    server1: [
        { id: 'm1', revokedAt: null },
    ],
};

const cliDetectionState = {
    available: { codex: true },
    login: { codex: false } as Record<string, boolean | null>,
    authStatus: { codex: null } as Record<string, unknown>,
    resolvedPath: { codex: '/usr/local/bin/codex' } as Record<string, string | null>,
    resolutionSource: { codex: 'system' } as Record<string, 'override' | 'system' | 'managed' | null>,
    tmux: null,
    isDetecting: false,
    timestamp: 1,
    refresh: vi.fn(),
};
let previousWindow: unknown;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: any) => (options && typeof options === 'object' ? (options.web ?? options.default) : options),
        },
        useWindowDimensions: () => ({
            width: 1440,
            height: 900,
            scale: 2,
            fontScale: 1,
        }),
        Dimensions: {
            get: () => ({
                width: 1440,
                height: 900,
                scale: 2,
                fontScale: 1,
            }),
        },
        NativeModules: {},
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: () => '/settings/agents/codex',
        router: {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    }).module,
    useLocalSearchParams: () => ({
        agentId: 'codex',
        pluginId: 'happier.agent.codex',
    }),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        logout: vi.fn(),
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createLiveStorageStoreMock, createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    // The app-shell providers (command palette) read the Account settings slice from the store itself.
    const store = createLiveStorageStoreMock(() => ({ settings: { ...settingsParse({}), ...settingsState } as never }));
    return createStorageModuleStub({
        storage: store,
        getStorage: () => store,
        useSettings: (() => settingsState) as any,
        useAllMachines: (() => machinesState) as any,
        useMachineListByServerId: (() => machineListByServerIdState) as any,
        useMachine: (() => null) as any,
        useSetting: ((key: string) => {
            if (key === 'serverSelectionGroups') return {};
            if (key === 'serverSelectionActiveTargetKind') return 'server';
            if (key === 'serverSelectionActiveTargetId') return 'server1';
            if (key === 'contextSelectionsV1') return settingsState.contextSelectionsV1;
            if (key === 'externalSessionsSettingsV1') {
                return settingsState.externalSessionsSettingsV1;
            }
            return undefined;
        }) as any,
        useSettingMutable: ((key: string) => [
            settingsState[key],
            (next: unknown) => {
                settingsState[key] = next;
            },
        ]) as any,
        useLocalSetting: ((key: string) => {
            if (key === 'uiMultiPanePanelsEnabled') return true;
            if (key === 'sidebarCollapsed') return false;
            if (key === 'sidebarWidthPx') return 320;
            if (key === 'sidebarWidthBasisPx') return 1440;
            if (key === 'rightPaneWidthPx') return 360;
            if (key === 'rightPaneWidthBasisPx') return 1200;
            if (key === 'detailsPaneWidthPx') return 420;
            if (key === 'detailsPaneWidthBasisPx') return 1200;
            if (key === 'bottomPaneHeightPx') return 320;
            if (key === 'bottomPaneHeightBasisPx') return 900;
            if (key === 'appPaneScopesV1') return localSettingsState.appPaneScopesV1;
            return localSettingsState[key];
        }) as any,
        useLocalSettingMutable: ((key: string) => {
            const currentValue =
                key === 'sidebarCollapsed'
                    ? false
                    : key === 'sidebarWidthPx'
                        ? 320
                        : key === 'sidebarWidthBasisPx'
                            ? 1440
                            : localSettingsState[key];
            return [
                currentValue,
                (next: unknown) => {
                    localSettingsState[key] = next;
                },
            ] as const;
        }) as any,
    });
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useAccountSettingsScope: () => ({ serverId: 'server1', accountId: 'account-1' }),
    useApplySettings: () => applySettingsMock,
    useApplyLocalSettings: () => vi.fn(),
}));


vi.mock('@/hooks/machine/useCapabilityInstallability', () => ({
    useCapabilityInstallability: () => ({ kind: 'installable' }),
}));

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({
        phase: 'ready',
        inputs: {
            mergedProviderProjectionById: {
                codex: {
                    agentId: 'codex',
                    qualifiedId: 'codex',
                    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                    title: 'Codex',
                    subtitle: 'Codex',
                    channel: 'stable',
                    isBuiltIn: true,
                    settingsBackendId: 'codex',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                    cli: {
                        executable: { binaryName: 'codex', sourcePreference: 'system-first' },
                        install: { manual: { kind: 'none' } },
                        auth: { support: 'none', loginLaunches: [] },
                    },
                },
            },
            mergedBackendProjectionById: {
                codex: {
                    backendId: 'codex',
                    agentId: 'codex',
                    catalogAgentId: 'codex',
                    iconAgentId: 'codex',
                    capabilities: { session: { supported: true } },
                },
            },
            pluginProjectionById: {},
            pluginProjectionV2: null,
        },
    }),
}));

vi.mock('@/sync/domains/machines/administration/useTargetSelection', () => ({
    useMachineAdministrationTargetSelection: () => ({
        selectedTarget: administrationTargetState.selectedTarget,
        selectedTargetServerMatchesActiveAccount: true,
        resolveExecutionTarget: () => administrationTargetState.executionTarget,
        pickerRows: [],
        candidates: [],
        selectTarget: vi.fn(),
        clearTarget: vi.fn(),
    }),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>();
    const { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } = await import(
        '@/dev/testkit/fixtures/pluginProviderDaemonProjection'
    );
    const projection = {
        ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
        installedPackagesById: {
            'happier.agent.codex': {
                id: 'happier.agent.codex',
                displayName: 'Codex',
                version: '1.0.0',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.codex' },
            },
        },
        agentsById: {
            codex: {
                id: 'codex',
                identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
                title: 'Codex',
                subtitle: 'Codex Agent',
                channel: 'stable',
                isBuiltIn: true,
                catalogAgentId: 'codex',
                iconAgentId: 'codex',
                providerOwnedEnvironmentKeys: [],
                cli: {
                    executable: {
                        binaryName: 'codex',
                        sourcePreference: 'system-first',
                    },
                    install: {
                        managed: null,
                        manual: { kind: 'none' },
                        docsUrl: null,
                    },
                    auth: {
                        support: 'unsupported',
                        loginLaunches: [],
                    },
                },
            },
        },
        backendsById: {},
    };
    return {
        ...actual,
        machineContributionRegistryProjectionDescribe: async () => ({
            supported: true,
            projection,
        }),
        getMachineContributionRegistryProjectionRevision: () => 0,
        subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
        machinePluginSettingsGet: async () => ({ supported: false, reason: 'not-supported' }),
        machinePluginSettingsSet: async () => ({ supported: false, reason: 'not-supported' }),
        watchMachinePluginSettingsChanges: () => ({ dispose: () => {} }),
        machinePluginSecretStatus: async () => ({ supported: false, reason: 'not-supported' }),
        machinePluginSecretSet: async () => ({ supported: false, reason: 'not-supported' }),
        machinePluginSecretDelete: async () => ({ supported: false, reason: 'not-supported' }),
    };
});

vi.mock('@/components/settings/machines/MachineAdministrationTargetSelector', () => ({
    MachineAdministrationTargetSelector: (props: Record<string, unknown>) => (
        React.createElement('MachineAdministrationTargetSelector', props)
    ),
}));

vi.mock('@/components/settings/plugins/detail/PluginDetailGenericSettingsSection', () => ({
    PluginDetailGenericSettingsSection: () => null,
}));

vi.mock('@/components/settings/externalSessions/AgentDetailExternalSessionsSection', () => ({
    AgentDetailExternalSessionsSection: () => null,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: Record<string, unknown>) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({
    useNavigateToSession: () => vi.fn(),
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/platform/responsive')>();
    return {
        ...actual,
        useIsTablet: () => true,
        useHeaderHeight: () => 56,
    };
});

vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));


vi.mock('@/components/settings/agents/authentication/scheduleAgentAuthenticationRefreshes', () => ({
    scheduleAgentAuthenticationRefreshes: () => () => {},
}));

/** The one active-server fixture both server modules answer from. */
function subscribeActiveServerFixture(listener: (snapshot: typeof activeServerState.current) => void): () => void {
    activeServerState.subscriber = listener;
    return () => {
        if (activeServerState.subscriber === listener) {
            activeServerState.subscriber = null;
        }
    };
}

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerState.current,
    subscribeActiveServer: subscribeActiveServerFixture,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfilesGeneration: () => 0,
    subscribeServerProfiles: () => () => undefined,
    getActiveServerSnapshot: () => activeServerState.current,
    subscribeActiveServer: subscribeActiveServerFixture,
    loadHomeViewState: () => null,
    subscribeHomeViewState: () => () => undefined,
    listServerProfiles: () => [{
        id: 'server1',
        serverUrl: 'http://localhost:3000',
        webappUrl: 'http://localhost:8081',
        name: 'server1',
    }],
    getServerProfileById: (serverId: string) => (
        serverId === 'server1'
            ? { id: 'server1', serverIdentityId: 'server1' }
            : null
    ),
    resolveServerProfileScopeIdForIdentifier: (serverId: string) => serverId,
    areServerProfileIdentifiersEquivalent: (left: string | null | undefined, right: string | null | undefined) => left === right,
}));

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => true,
    desktopHostKind: () => 'tauri',
}));

vi.mock('@/voice/session/VoiceSessionRuntime', () => ({
    VoiceSessionRuntime: () => React.createElement('VoiceSessionRuntimeMock'),
}));


vi.mock('react-native-safe-area-context', async (importOriginal) => ({
    ...await importOriginal<typeof import('react-native-safe-area-context')>(),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/hooks/inbox/useInboxHasContent', () => ({
    useInboxHasContent: () => false,
}));

vi.mock('@/hooks/inbox/useInboxAvailable', () => ({
    useInboxAvailable: () => true,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => false,
}));

vi.mock('@/config', () => ({
    config: { variant: 'prod' },
}));

vi.mock('@/sync/domains/server/serverContext', () => ({
    isStackContext: () => false,
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    isUsingCustomServer: () => false,
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: () => React.createElement('ConnectionStatusControl'),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => ({
    ItemRowActions: () => React.createElement('ItemRowActions'),
}));

vi.mock('@/components/ui/lists/virtualized', () => ({
    VirtualizedList: 'VirtualizedList',
    VirtualizedSectionList: 'VirtualizedSectionList',
}));

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => React.createElement('VoiceSurface'),
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => React.createElement('MainView', { testID: 'main-view' }),
}));

describe('PluginAgentSettingsScreen desktop render', () => {
    beforeEach(() => {
        previousWindow = (globalThis as { window?: unknown }).window;
        (globalThis as { window?: unknown }).window = new EventTarget();
        applySettingsMock.mockReset();
        cliDetectionState.refresh.mockReset();
        settingsState = {
            backendEnabledByTargetKey: {},
            sessionDefaultPermissionModeByTargetKey: {},
            backendCliSourcePreferenceByTargetKey: {},
            connectedAccountPurposeBindingsV1: { v: 1, bindings: [] },
            contextSelectionsV1: undefined,
        };
        localSettingsState = {
            appPaneScopesV1: undefined,
        };
        activeServerState.current = {
            serverId: 'server1',
            serverUrl: 'http://localhost:3000',
            generation: 1,
        };
        activeServerState.subscriber = null;
    });

    afterEach(() => {
        if (previousWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
        } else {
            (globalThis as { window?: unknown }).window = previousWindow;
        }
        previousWindow = undefined;
        standardCleanup();
    });

    it('renders the codex provider route with the canonical machine and CLI chrome', async () => {
        const screen = await renderScreen(
            <AppPaneProvider>
                <PluginAgentSettingsScreen />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-detected-cli')).toBeTruthy();
    });

    it('writes the provider-scoped default permission through the canonical target-key setting', async () => {
        const screen = await renderScreen(
            <AppPaneProvider>
                <PluginAgentSettingsScreen />
            </AppPaneProvider>,
        );

        const permissionChoice = screen.find((node) => (
            node.props?.title === 'settingsSession.permissions.defaultPermissionModeTitle'
            && Array.isArray(node.props?.options)
            && typeof node.props?.onChange === 'function'
        ));

        await act(async () => {
            permissionChoice.props.onChange('read-only');
        });

        expect(applySettingsMock).toHaveBeenCalledWith({
            sessionDefaultPermissionModeByTargetKey: {
                'agent:happier.agent.codex/codex': 'read-only',
            },
        });
    });

    it('renders the codex provider route inside the desktop settings shell without crashing', async () => {
        const screen = await renderScreen(
            <AppPaneProvider>
                <SettingsShell>
                    <PluginAgentSettingsScreen />
                </SettingsShell>
            </AppPaneProvider>,
        );
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy();
    });

    it('renders the codex provider route inside the desktop app-shell provider stack without triggering crash recovery', async () => {
        const screen = await renderScreen(
            <AppCrashRecoveryBoundary onRestart={() => {}}>
                <AppPaneModalProvider>
                    <CommandPaletteProvider>
                        <RealtimeProvider>
                            <SettingsShell>
                                <PluginAgentSettingsScreen />
                            </SettingsShell>
                        </RealtimeProvider>
                    </CommandPaletteProvider>
                </AppPaneModalProvider>
            </AppCrashRecoveryBoundary>,
        );
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy();
    });

    it('renders the codex provider route alongside the authenticated desktop sidebar shell without triggering crash recovery', async () => {
        const screen = await renderScreen(
            <AppCrashRecoveryBoundary onRestart={() => {}}>
                <AppPaneModalProvider>
                    <CommandPaletteProvider>
                        <RealtimeProvider>
                            <>
                                <SidebarNavigator />
                                <SettingsShell>
                                    <PluginAgentSettingsScreen />
                                </SettingsShell>
                            </>
                        </RealtimeProvider>
                    </CommandPaletteProvider>
                </AppPaneModalProvider>
            </AppCrashRecoveryBoundary>,
        );
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('main-view')).toBeTruthy();
        expect(screen.findByTestId('settings.agents.detail.header')).toBeTruthy();
    });
});
