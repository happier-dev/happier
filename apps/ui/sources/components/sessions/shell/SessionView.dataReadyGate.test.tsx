import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
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

const gestureHandlerState = vi.hoisted(() => ({
    gestures: [] as Array<{
        kind: string;
        config: Record<string, unknown>;
        handlers: {
            onEnd?: (event: { translationY: number; velocityY: number }) => void;
        };
    }>,
}));
const settingMutators = vi.hoisted(() => ({
    setMobileWorkspaceExperience: vi.fn(),
}));
const chatListPropsSpy = vi.hoisted(() => vi.fn());
const deviceTypeState = vi.hoisted(() => ({
    value: 'tablet' as 'phone' | 'tablet' | 'desktop',
}));
const safeAreaState = vi.hoisted(() => ({
    bottom: 0,
}));

vi.mock('react-native-gesture-handler', () => {
    function createGesture(kind: string) {
        const gesture = {
            kind,
            config: {} as Record<string, unknown>,
            handlers: {} as {
                onEnd?: (event: { translationY: number; velocityY: number }) => void;
            },
            minDistance(value: number) {
                gesture.config.minDistance = value;
                return gesture;
            },
            activeOffsetY(value: readonly [number, number]) {
                gesture.config.activeOffsetY = value;
                return gesture;
            },
            onEnd(handler: (event: { translationY: number; velocityY: number }) => void) {
                gesture.handlers.onEnd = handler;
                return gesture;
            },
        };
        gestureHandlerState.gestures.push(gesture);
        return gesture;
    }

    return {
        Gesture: {
            Pan: () => createGesture('pan'),
        },
        GestureDetector: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
            React.createElement('GestureDetector', props, props.children),
    };
});

vi.mock('react-native-worklets', () => ({
    scheduleOnRN: (fn: (...args: unknown[]) => void, ...args: unknown[]) => fn(...args),
}));

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
let isDataReadyState = false;
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
    storage: async () =>
        createStorageModuleStub({
            storage: Object.assign(
                (
                    selector?: (value: {
                        sessions: Record<string, unknown>;
                        settings: Record<string, unknown>;
                        sessionListViewDataByServerId: Record<string, unknown>;
                    }) => unknown,
                ) => {
                    const snapshot = {
                        sessions: sessionState ? { s1: sessionState } : {},
                        sessionMessages: {},
                        settings: {},
                        sessionListViewDataByServerId: {},
                    };
                    return typeof selector === 'function' ? selector(snapshot) : snapshot;
                },
                {
                    getState: () => ({
                        sessions: sessionState ? { s1: sessionState } : {},
                        sessionMessages: {},
                        settings: {},
                        sessionListViewDataByServerId: {},
                    }),
                    getInitialState: () => ({
                        sessions: sessionState ? { s1: sessionState } : {},
                        sessionMessages: {},
                        settings: {},
                        sessionListViewDataByServerId: {},
                    }),
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                },
            ),
            useSession: () => sessionState,
            useIsDataReady: () => isDataReadyState,
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
            useSessionSubagentSourceMessages: () => [],
            useSessionRpcAvailabilityState: () => ({
                sessionExists: true,
                sessionRpcAvailable: true,
            }),
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useSyncError: () => syncErrorState,
            useArtifacts: () => [],
            useOpenApprovalArtifactsForSession: () => [],
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => localSettingsDefaults[key],
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                localSettingsDefaults[key],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => settingsDefaults[key],
            useSettingMutable: <K extends keyof Settings>(key: K) => [
                settingsDefaults[key],
                key === 'mobileWorkspaceExperienceV1'
                    ? ((value: Settings[K]) => {
                        settingMutators.setMobileWorkspaceExperience(value);
                    })
                    : vi.fn<(value: Settings[K]) => void>(),
            ],
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useProfile: () => null,
            useAutomations: () => [],
            useSessionAutomationsEnabledCount: () => 0,
            useAllMachines: () => [],
            useMachine: () => null,
        }),
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: safeAreaState.bottom, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
    useIsFocused: () => true,
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 't', secret: 's' } }),
}));

vi.mock('@/components/sessions/transcript/ChatHeaderView', () => ({
    ChatHeaderView: (props: any) => React.createElement(
        React.Fragment,
        null,
        React.createElement('Text', { testID: 'session-header-title' }, props.title ?? ''),
        props.rightElement ?? null,
    ),
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
    ChatList: (props: any) => {
        chatListPropsSpy(props);
        return React.createElement('ChatList', props);
    },
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
    useDeviceType: () => deviceTypeState.value,
    useHeaderHeight: () => 0,
    useIsLandscape: () => false,
    useIsTablet: () => true,
}));
vi.mock('@/hooks/session/useDraft', () => ({
    useDraft: () => ({ clearDraft: vi.fn(), setDraftValue: vi.fn() }),
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
    markSessionVisible: () => {},
    markSessionHidden: () => {},
    // The surface-activation hook subscribes to viewing resets. These gating tests
    // never reset, so a no-op unsubscribe and a fixed version are faithful.
    subscribeActiveViewingSessionReset: () => () => {},
    getActiveViewingSessionResetVersion: () => 0,
    registerSessionVisibleSurface: () => () => {},
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
        markSessionLiveTailIntent: () => {},
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
        isDataReadyState = false;
        sessionState = {
            id: 's1',
            seq: 1,
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };
        settingMutators.setMobileWorkspaceExperience.mockReset();
        gestureHandlerState.gestures = [];
        deviceTypeState.value = 'tablet';
        safeAreaState.bottom = 0;
        standardCleanup();
        chatListPropsSpy.mockReset();
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

    it('does not pass route hydration blocking state into an already loaded same-server session', async () => {
        isDataReadyState = true;
        sessionState = {
            ...sessionState,
            serverId: 'server-target',
        };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeServerId="server-target"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', serverId: 'server-target', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-route-loading')).toHaveLength(0);
        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(1);
        const latestChatListProps = chatListPropsSpy.mock.calls.at(-1)?.[0];
        expect(latestChatListProps?.routeHydrationPending).not.toBe(true);
    });

    it('renders loading instead of deleted copy when route hydration is still pending after global data readiness', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeletedDescription');
    });

    it('does not render cached same-id session content from a different route server while hydration is pending', async () => {
        isDataReadyState = true;
        sessionState = {
            ...sessionState,
            serverId: 'server-stale',
        };
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeServerId="server-target"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', serverId: 'server-target', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-route-loading')).toHaveLength(1);
        expect(screen.findAllByTestId('session-composer-input')).toHaveLength(0);
        expect(screen.findAllByTestId('session-header-action-menu-trigger')).toHaveLength(0);
    });

    it('renders retrying route hydration separately from cold loading', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'retrying', sessionId: 's1', cause: 'server_unavailable' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-route-loading')).toHaveLength(0);
        expect(screen.findAllByTestId('session-route-retrying')).toHaveLength(1);
        expect(screen.getTextContent()).toContain('newSession.notConnectedToServer');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('renders terminal missing copy only after route hydration resolves missing', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'missing', sessionId: 's1', cause: 'not_found' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.getTextContent()).toContain('errors.sessionDeleted');
        expect(screen.getTextContent()).toContain('errors.sessionDeletedDescription');
    });

    it('keeps the header neutral while route hydration is still pending', async () => {
        isDataReadyState = true;
        sessionState = null;
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView
                    id="s1"
                    routeHydrationState={{ kind: 'loading', sessionId: 's1', reason: 'store-miss' }}
                />
            </AppPaneProvider>,
        );

        expect(screen.findByTestId('session-header-title')?.props.children).toBe('');
        expect(screen.getTextContent()).not.toContain('errors.sessionDeleted');
    });

    it('can render chat content without the legacy web bottom spacer when cockpit owns bottom chrome', async () => {
        safeAreaState.bottom = 34;
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

        const agentContentView = screen.tree.findByType('AgentContentView' as never);
        expect(agentContentView.props.safeAreaBottom).toBe(0);
    });

    it('does not expose a gesture handle that can unintentionally open cockpit mode from the composer', async () => {
        deviceTypeState.value = 'phone';
        const { SessionView } = await sessionViewModulePromise;

        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionView id="s1" />
            </AppPaneProvider>,
        );

        expect(screen.findAllByTestId('session-cockpit-open-swipe-handle')).toHaveLength(0);
        const gesture = gestureHandlerState.gestures.find((candidate) => candidate.kind === 'pan');
        expect(gesture).toBeUndefined();

        gesture?.handlers.onEnd?.({ translationY: -48, velocityY: -120 });

        expect(settingMutators.setMobileWorkspaceExperience).not.toHaveBeenCalledWith('cockpit');
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
        sessionState = {
            ...sessionState,
            serverId: 'server-a',
        };
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
