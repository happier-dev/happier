import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Some deps resolve `react-native-reanimated` into ESM entrypoints that use extensionless imports
// (not Node-safe). Stub both the package id and its resolved module entrypoint.
vi.mock('react-native-reanimated', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index.js', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index', () => ({ __esModule: true, default: {} }));

const themeColors = {
    text: '#000',
    textSecondary: '#666',
    textLink: '#00f',
    surface: '#fff',
    surfaceHigh: '#f5f5f5',
    surfaceSelected: '#eef4ff',
    divider: '#ddd',
    border: '#ddd',
    indigo: '#5856D6',
    radio: { active: '#007AFF' },
    accent: {
        blue: '#007AFF',
        green: '#34C759',
        orange: '#FF9500',
        yellow: '#FFCC00',
        red: '#FF3B30',
        indigo: '#5856D6',
        purple: '#AF52DE',
    },
    modal: { border: '#ddd' },
    input: { background: '#f5f5f5' },
    header: { tint: '#000' },
    status: { error: '#f00' },
    shadow: { color: '#000', opacity: 0.2 },
} as const;

const routerPushSpy = vi.fn();
let endpointConnectivityStatus: 'idle' | 'offline' | 'connecting' | 'online' | 'auth_failed' | 'shutting_down' = 'online';
let syncErrorState: {
    message: string;
    retryable: boolean;
    kind: 'auth' | 'config' | 'network' | 'server' | 'unknown';
    at: number;
    serverId?: string;
} | null = null;
let sessionState: any = {
    id: 's1',
    seq: 1,
    presence: 'online',
    active: true,
    accessLevel: 'edit',
    metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
    agentState: {},
};

installSessionShellCommonModuleMocks({
    reactNative: async () =>
        createReactNativeWebMock({
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            Platform: {
                OS: 'web',
                select: (spec: Record<string, unknown>) =>
                    spec && Object.prototype.hasOwnProperty.call(spec, 'web')
                        ? (spec as any).web
                        : (spec as any).default,
            },
            useWindowDimensions: () => ({ width: 1200, height: 800 }),
        }),
    unistyles: async () =>
        createUnistylesMock({
            theme: themeColors,
            runtime: {
                hairlineWidth: 1,
            },
        }),
    text: async () =>
        createTextModuleMock({
            translate: (key: string) => key,
        }),
    router: async () =>
        createExpoRouterMock({
            pathname: '/session/s1',
            router: {
                push: routerPushSpy,
                back: vi.fn(),
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module,
    storage: async () => {
        return {
            storage: {
                getState: () => ({
                    sessions: sessionState ? { s1: sessionState } : {},
                    settings: {},
                    sessionListViewDataByServerId: {},
                }),
            } as any,
            useSession: () => sessionState,
            useIsDataReady: () => false,
            useRealtimeStatus: () => 'connected',
            useEndpointConnectivity: () => ({
                status: endpointConnectivityStatus,
                reason: null,
                attempt: 0,
                nextRetryAt: null,
                lastConnectedAt: null,
                lastDisconnectedAt: null,
                lastErrorMessage: null,
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionMessagesVersion: () => 0,
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useSyncError: () => syncErrorState,
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => localSettingsDefaults[key],
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                localSettingsDefaults[key],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => settingsDefaults[key],
            useSettingMutable: <K extends keyof Settings>(key: K) => [
                settingsDefaults[key],
                vi.fn<(value: Settings[K]) => void>(),
            ],
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useAllMachines: () => [],
            useMachine: () => null,
        };
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
    useIsFocused: () => true,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: (props: any) => React.createElement(React.Fragment, null, props.rightElement ?? null),
}));
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: (props: any) => React.createElement('AgentContentView', props, props.input ?? null),
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => React.createElement('View', { testID: 'session-composer-input' }),
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => React.createElement('View', { testID: 'session-header-action-menu-trigger' }),
}));
vi.mock('@/components/sessions/transcript/ChatList', () => ({
    ChatList: () => null,
}));
vi.mock('@/components/sessions/pending/PendingMessagesDragReorderList', () => ({
    PendingMessagesDragReorderList: () => null,
}));
vi.mock('@/components/ui/empty/EmptyMessages', () => ({
    EmptyMessages: () => null,
}));
vi.mock('@/components/ui/forms/Deferred', () => ({
    Deferred: (props: any) => React.createElement(React.Fragment, null, props.children),
}));
vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: () => null,
}));
vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/utils/platform/responsive', () => ({
    getDeviceType: () => 'tablet',
    useDeviceType: () => 'tablet',
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => true,
}));
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: () => ({ clearDraft: vi.fn() }),
}));
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock('@/components/sessions/model/useSessionMachineReachability', () => ({
    useSessionMachineReachability: () => ({ machineReachable: true, machineOnline: true }),
}));
vi.mock('@/components/appShell/panes/useRegisterSessionPaneDriver', () => ({
    useRegisterSessionPaneDriver: () => 'session:s1',
}));
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openRight: vi.fn(),
        setRightTab: vi.fn(),
        closeRight: vi.fn(),
        openDetailsTab: vi.fn(),
        closeDetails: vi.fn(),
        pinDetailsTab: vi.fn(),
        closeDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        setRightTabState: vi.fn(),
        scopeState: null,
    }),
}));
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: () => {},
}));
vi.mock('@/sync/domains/session/activeViewingSession', () => ({
    setActiveViewingSessionId: () => {},
    clearActiveViewingSessionId: () => {},
}));
vi.mock('@/sync/sync', () => ({
    sync: {
        markSessionViewed: async () => {},
        fetchPendingMessages: async () => {},
        publishSessionPermissionModeToMetadata: async () => {},
        publishSessionAcpSessionModeOverrideToMetadata: async () => {},
        publishSessionAcpConfigOptionOverrideToMetadata: async () => {},
        publishSessionModelOverrideToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => {},
        onSessionViewportChange: () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        wakeSessionAfterSend: async () => null,
        submitMessage: async () => {},
    },
}));

const sessionViewModulePromise = import('./SessionView');

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('SessionView (data ready gating)', () => {
    afterEach(() => {
        routerPushSpy.mockClear();
        endpointConnectivityStatus = 'online';
        syncErrorState = null;
        sessionState = {
            id: 's1',
            seq: 1,
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };
        standardCleanup();
    });

    it('renders the session shell when the session exists even if global data readiness is false', async () => {
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
        expect(screen.findAllByTestId('session-header-action-menu-trigger')).toHaveLength(1);
    });

    it('can render chat content without the legacy web bottom spacer when cockpit owns bottom chrome', async () => {
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" chatBottomSpacing="none" />
            </AppPaneProvider>,
        );

        const chatContentContainers = screen.tree.findAllByType('View' as never).filter((node) => {
            const style = flattenStyle(node.props.style);
            return style.flexBasis === 0 && style.flexGrow === 1;
        });
        expect(chatContentContainers).toHaveLength(1);
        expect(Number(flattenStyle(chatContentContainers[0]?.props.style).paddingBottom ?? 0)).toBe(0);
    });

    it('surfaces auth sync errors as a restore-account action instead of generic retry', async () => {
        syncErrorState = {
            message: 'Authentication required',
            retryable: false,
            kind: 'auth',
            at: 123,
        };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-auth-sync-error')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-restore')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-retry')).toBeNull();

        await pressTestInstanceAsync(
            screen.findByTestId('session-auth-sync-error-restore'),
            'session auth sync error restore action',
        );

        expect(routerPushSpy).toHaveBeenCalledWith('/restore');
    });

    it('ignores auth sync errors that belong to a different scoped server', async () => {
        syncErrorState = {
            message: 'Authentication required',
            retryable: false,
            kind: 'auth',
            at: 123,
            serverId: 'server-b',
        };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" routeServerId="server-a" />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
        expect(screen.findByTestId('session-auth-sync-error')).toBeNull();
    });

    it('surfaces endpoint auth_failed as a restore-account action even when syncError is clear', async () => {
        endpointConnectivityStatus = 'auth_failed';
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-composer-input')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-restore')).toBeTruthy();
    });

    it('shows the auth recovery surface instead of the deleted shell when auth fails and the session is missing', async () => {
        endpointConnectivityStatus = 'auth_failed';
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-auth-required-fallback')).toBeTruthy();
        expect(screen.findByTestId('session-auth-sync-error-restore')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });
});
