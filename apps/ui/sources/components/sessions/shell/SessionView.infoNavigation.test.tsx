import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
    (globalThis as any).location.href = 'http://localhost/session/s1/previous';
    (globalThis as any).location.pathname = '/session/s1/previous';
}));
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());

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
    header: { tint: '#000', background: '#fff' },
    status: { error: '#f00' },
    shadow: { color: '#000', opacity: 0.2 },
} as const;

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
                navigate: routerNavigateSpy,
                back: routerBackSpy,
                replace: vi.fn(),
                setParams: vi.fn(),
            },
        }).module,
    storage: async () => {
        const session: any = {
            id: 's1',
            seq: 1,
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/tmp' },
            agentState: {},
        };

        return {
            storage: {
                getState: () => ({
                    sessions: { s1: session },
                    settings: {},
                    sessionListViewDataByServerId: {},
                }),
            } as any,
            useSession: () => session,
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => localSettingsDefaults[key],
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                localSettingsDefaults[key],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => settingsDefaults[key],
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useMachine: () => null,
        };
    },
});

vi.mock('react-native-reanimated', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index.js', () => ({ __esModule: true, default: {} }));
vi.mock('react-native-reanimated/lib/module/index', () => ({ __esModule: true, default: {} }));
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
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
    ChatHeaderView: (props: any) => {
        chatHeaderPropsSpy(props);
        return React.createElement('ChatHeaderView', props, props.rightElement ?? null);
    },
}));
vi.mock('@/components/sessions/transcript/AgentContentView', () => ({
    AgentContentView: () => null,
}));
vi.mock('@/components/appShell/panes/AppPaneScopeHost', () => ({
    AppPaneScopeHost: (props: any) => React.createElement('AppPaneScopeHost', props, props.main ?? null),
}));
vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: () => null,
}));
vi.mock('@/components/sessions/actions/SessionHeaderActionMenu', () => ({
    SessionHeaderActionMenu: () => null,
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
vi.mock('@/hooks/session/files/useWarmRepositoryDirectoryCacheOnSessionOpen', () => ({
    useWarmRepositoryDirectoryCacheOnSessionOpen: () => {},
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
        refreshSessions: async () => {},
        onSessionVisible: () => () => {},
        ensureSidechainMessagesLoaded: async () => {},
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: { getMachineEncryption: () => null },
    },
}));
vi.mock('@/sync/ops', () => ({
    continueSessionWithReplay: vi.fn(),
    sessionAbort: vi.fn(),
    resumeSession: vi.fn(),
    sessionAttachmentsUploadFile: vi.fn(),
    sessionSwitch: vi.fn(),
}));
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: () => ({ execute: vi.fn() }),
}));
vi.mock('@/utils/system/versionUtils', () => ({
    isVersionSupported: () => true,
    MINIMUM_CLI_VERSION: '0.0.0',
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));
vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));
vi.mock('@/hooks/server/useSessionExecutionRunsSupported', () => ({
    useSessionExecutionRunsSupported: () => false,
}));
vi.mock('@/hooks/server/useExecutionRunsBackendsForSession', () => ({
    useExecutionRunsBackendsForSession: () => null,
}));
vi.mock('@/utils/sessions/sessionUtils', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/sessions/sessionUtils')>();
    return {
        ...actual,
        getSessionName: () => 'Session',
        getSessionSubtitle: () => 'Subtitle',
        getSessionAvatarId: () => 'avatar',
        listPendingPermissionRequests: () => [],
        listPendingUserActionRequests: () => [],
        useSessionStatus: () => ({
            isConnected: true,
            statusText: 'Connected',
            statusColor: '#0f0',
            statusDotColor: '#0f0',
            isPulsing: false,
        }),
        formatPathRelativeToHome: (path: string) => path,
    };
});
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
    <AppPaneProvider>{children ?? null}</AppPaneProvider>
);

describe('SessionView info navigation', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        routerNavigateSpy.mockReset();
        routerBackSpy.mockClear();
        chatHeaderPropsSpy.mockReset();
        Object.defineProperty(globalThis, 'location', {
            value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
            writable: true,
            configurable: true,
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('opens session info via singular navigate instead of stacking pushes', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof headerProps?.onAvatarPress).toBe('function');

        headerProps?.onAvatarPress?.();

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s1/info', expect.objectContaining({
            dangerouslySingular: expect.any(Function),
        }));

        const singular = routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular;
        expect(typeof singular).toBe('function');
        expect(singular()).toBe('session-info');
    });

    it('uses back navigation for the session header back affordance', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof headerProps?.onBackPress).toBe('function');

        headerProps?.onBackPress?.();

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalledTimes(1);
    });
});
