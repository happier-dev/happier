import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsMock = vi.fn();

let settingsState: Record<string, unknown> = {};
let localSettingsState: Record<string, unknown> = {};
let activeServerSnapshot = {
    serverId: 'server1',
    serverUrl: 'http://localhost:3000',
    generation: 1,
};
let activeServerSubscriber: ((snapshot: typeof activeServerSnapshot) => void) | null = null;

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

vi.mock('react-native-reanimated', () => ({}));

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
        pathname: () => '/settings/providers/codex',
        router: {
            push: vi.fn(),
            back: vi.fn(),
            replace: vi.fn(),
            setParams: vi.fn(),
        },
    }).module,
    useLocalSearchParams: () => ({ providerId: 'codex' }),
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSettings: (() => settingsState) as any,
            useAllMachines: (() => machinesState) as any,
            useMachineListByServerId: (() => machineListByServerIdState) as any,
            useMachine: (() => null) as any,
            useSetting: ((key: string) => {
                if (key === 'serverSelectionGroups') return {};
                if (key === 'serverSelectionActiveTargetKind') return 'server';
                if (key === 'serverSelectionActiveTargetId') return 'server1';
                if (key === 'contextSelectionsV1') return settingsState.contextSelectionsV1;
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
                if (key === 'editorFocusModeEnabled') return false;
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
        },
    });
});

vi.mock('@/sync/store/settingsWriters', () => ({
    useApplySettings: () => applySettingsMock,
}));

vi.mock('@/hooks/auth/useCLIDetection', () => ({
    useCLIDetection: () => cliDetectionState,
}));

vi.mock('@/hooks/machine/useCapabilityInstallability', () => ({
    useCapabilityInstallability: () => ({ kind: 'installable' }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/ui/useGlobalKeyboard', () => ({
    useGlobalKeyboard: () => {},
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

vi.mock('@/components/settings/providers/authentication/useProviderAuthenticationState', () => ({
    useProviderAuthenticationState: () => ({
        canLaunchLogin: true,
        machineId: null,
        machineHomeDir: null,
        loginLaunch: null,
        authStatus: null,
        canCheckNow: true,
        loginActionKind: 'login',
        docsUrl: null,
    }),
}));

vi.mock('@/components/settings/providers/authentication/scheduleProviderAuthenticationRefreshes', () => ({
    scheduleProviderAuthenticationRefreshes: () => () => {},
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerSnapshot,
    subscribeActiveServer: (listener: (snapshot: typeof activeServerSnapshot) => void) => {
        activeServerSubscriber = listener;
        return () => {
            if (activeServerSubscriber === listener) {
                activeServerSubscriber = null;
            }
        };
    },
}));

vi.mock('@/utils/platform/tauri', () => ({
    isTauriDesktop: () => true,
}));

vi.mock('@/voice/session/VoiceSessionRuntime', () => ({
    VoiceSessionRuntime: () => React.createElement('VoiceSessionRuntimeMock'),
}));

vi.mock('@/realtime/RealtimeVoiceSession', () => ({
    RealtimeVoiceSession: () => React.createElement('RealtimeVoiceSessionMock'),
}));

vi.mock('react-native-safe-area-context', () => ({
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

vi.mock('@/sync/runtime/appVariant', () => ({
    resolveVisibleAppEnvironmentBadge: () => null,
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

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => React.createElement('VoiceSurface'),
}));

vi.mock('@/components/navigation/shell/MainView', () => ({
    MainView: () => React.createElement('MainView', { testID: 'main-view' }),
}));

describe('ProviderSettingsScreen desktop render', () => {
    beforeEach(() => {
        applySettingsMock.mockReset();
        cliDetectionState.refresh.mockReset();
        settingsState = {
            backendEnabledByTargetKey: {},
            sessionDefaultPermissionModeByTargetKey: {},
            backendCliSourcePreferenceById: {},
            contextSelectionsV1: undefined,
        };
        localSettingsState = {
            appPaneScopesV1: undefined,
        };
        activeServerSnapshot = {
            serverId: 'server1',
            serverUrl: 'http://localhost:3000',
            generation: 1,
        };
        activeServerSubscriber = null;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('renders the codex provider route with the real provider-settings chrome', async () => {
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { default: ProviderSettingsScreen } = await import('@/app/(app)/settings/providers/[providerId]');

        const screen = await renderScreen(
            <AppPaneProvider>
                <ProviderSettingsScreen />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('settings-provider-field-codexBackendMode')).toBeTruthy();
    });

    it('renders the codex provider route inside the desktop settings shell without crashing', async () => {
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');
        const { default: ProviderSettingsScreen } = await import('@/app/(app)/settings/providers/[providerId]');

        const screen = await renderScreen(
            <AppPaneProvider>
                <SettingsShell>
                    <ProviderSettingsScreen />
                </SettingsShell>
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-field-codexBackendMode')).toBeTruthy();
    });

    it('renders the codex provider route inside the desktop app-shell provider stack without triggering crash recovery', async () => {
        const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
        const { AppPaneModalProvider } = await import('@/components/appShell/providers/AppPaneModalProvider');
        const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
        const { RealtimeProvider } = await import('@/realtime/RealtimeProvider.web');
        const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');
        const { default: ProviderSettingsScreen } = await import('@/app/(app)/settings/providers/[providerId]');

        const screen = await renderScreen(
            <AppCrashRecoveryBoundary onRestart={() => {}}>
                <AppPaneModalProvider>
                    <CommandPaletteProvider>
                        <RealtimeProvider>
                            <SettingsShell>
                                <ProviderSettingsScreen />
                            </SettingsShell>
                        </RealtimeProvider>
                    </CommandPaletteProvider>
                </AppPaneModalProvider>
            </AppCrashRecoveryBoundary>,
        );

        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-field-codexBackendMode')).toBeTruthy();
    });

    it('renders the codex provider route alongside the authenticated desktop sidebar shell without triggering crash recovery', async () => {
        const { AppCrashRecoveryBoundary } = await import('@/components/appShell/AppCrashRecoveryBoundary');
        const { AppPaneModalProvider } = await import('@/components/appShell/providers/AppPaneModalProvider');
        const { CommandPaletteProvider } = await import('@/components/appShell/commandPalette/CommandPaletteProvider');
        const { RealtimeProvider } = await import('@/realtime/RealtimeProvider.web');
        const { SidebarNavigator } = await import('@/components/navigation/shell/SidebarNavigator');
        const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');
        const { default: ProviderSettingsScreen } = await import('@/app/(app)/settings/providers/[providerId]');

        const screen = await renderScreen(
            <AppCrashRecoveryBoundary onRestart={() => {}}>
                <AppPaneModalProvider>
                    <CommandPaletteProvider>
                        <RealtimeProvider>
                            <>
                                <SidebarNavigator />
                                <SettingsShell>
                                    <ProviderSettingsScreen />
                                </SettingsShell>
                            </>
                        </RealtimeProvider>
                    </CommandPaletteProvider>
                </AppPaneModalProvider>
            </AppCrashRecoveryBoundary>,
        );

        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(screen.findByTestId('main-view')).toBeTruthy();
        expect(screen.findByTestId('settings-provider-field-codexBackendMode')).toBeTruthy();
    });
});
