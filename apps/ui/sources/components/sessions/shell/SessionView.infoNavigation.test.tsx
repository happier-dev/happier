import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createThemeFixture } from '@/dev/testkit/fixtures/themeFixtures';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { localSettingsDefaults, type LocalSettings } from '@/sync/domains/settings/localSettings';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';

import { installSessionShellCommonModuleMocks } from './sessionShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('@/agents/backendCatalog/getResolvedBackendCatalogEntries', () => ({
    getResolvedBackendCatalogEntries: () => [],
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
    (globalThis as any).location.href = 'http://localhost/session/s1/previous';
    (globalThis as any).location.pathname = '/session/s1/previous';
}));
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const capturedOpenSessionSpy = vi.hoisted(() => vi.fn<(sid: string) => void>());
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string) => string | null>((sessionId: string) =>
        sessionId === 's1' ? 'server-cache' : null
    ),
);

let workspaceLabelsV1: Record<string, string> = {};

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
            theme: createThemeFixture(),
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
        const { createStorageModuleStub, createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
        const session: any = {
            id: 's1',
            seq: 1,
            serverId: 'server-2',
            presence: 'online',
            active: true,
            accessLevel: 'edit',
            metadata: { machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/Users/test' },
            agentState: {},
        };

        return createStorageModuleStub({
            storage: createStorageStoreMock({
                sessions: { s1: session },
                settings: settingsDefaults,
                sessionListIndexByServerId: {
                    'server-1': [
                        {
                            type: 'session',
                            sessionId: 's1',
                            serverId: 'server-1',
                            serverName: 'Server 1',
                        },
                    ],
                },
            }),
            useSession: () => session,
            useIsDataReady: () => true,
            useRealtimeStatus: () => ({ current: { status: 'connected' } as any }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionPendingMessages: () => ({ messages: [], discarded: [], isLoaded: true }),
            useSessionSubagentSourceMessages: () => [],
            useOpenApprovalArtifactsForSession: () => [],
            useEnabledAutomationsCountForSession: () => 0,
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useLocalSetting: <K extends keyof LocalSettings>(key: K) => localSettingsDefaults[key],
            useLocalSettingMutable: <K extends keyof LocalSettings>(key: K) => [
                localSettingsDefaults[key],
                vi.fn<(value: LocalSettings[K]) => void>(),
            ],
            useSetting: <K extends keyof Settings>(key: K) => {
                if (key === 'workspaceLabelsV1') return workspaceLabelsV1 as Settings[K];
                return settingsDefaults[key];
            },
            useSettings: () => ({ ...settingsDefaults, experiments: true, featureToggles: {} }),
            useAutomations: () => [],
            useMachine: () => null,
            useAllMachines: () => [{ id: 'm1', metadata: {} }],
        });
    },
});

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache')
    >();
    return {
        ...actual,
        resolveServerIdForSessionIdFromLocalCache: (sessionId: string) =>
            resolveServerIdForSessionIdFromLocalCacheSpy(sessionId),
    };
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
vi.mock('@/components/sessions/model/inactiveSessionUi', () => ({
    getInactiveSessionUiState: () => ({ noticeKind: 'none', inactiveStatusTextKey: null, shouldShowInput: true }),
}));
vi.mock('@/components/sessions/model/resolveSessionMachineReachability', () => ({
    resolveSessionMachineReachability: () => true,
}));
vi.mock(
    '@/components/sessions/model/useSessionMachineReachability',
    async (importOriginal) => {
        const {
            createReachableSessionMachineReachability,
            createSessionMachineReachabilityModuleMock,
        } = await import('@/dev/testkit/mocks/sessionMachineReachability');
        return createSessionMachineReachabilityModuleMock({
            importOriginal,
            overrides: {
                useSessionMachineReachability: createReachableSessionMachineReachability,
                useSessionReachableMachineTarget: () => ({ machineId: 'm1', basePath: '/tmp' }),
            },
        });
    },
);
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
    markSessionVisible: () => {},
    markSessionHidden: () => {},
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
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
            continueSessionWithReplay: vi.fn(),
            sessionAbort: vi.fn(),
            resumeSession: vi.fn(),
            sessionAttachmentsUploadFile: vi.fn(),
            sessionSwitch: vi.fn(),
        },
    });
});
vi.mock('@/sync/ops/actions/defaultActionExecutor', () => ({
    createDefaultActionExecutor: (params: any) => {
        capturedOpenSessionSpy.mockImplementation((sid: string) => params.openSession(sid));
        return { execute: vi.fn() };
    },
}));
vi.mock('@/sync/domains/server/serverRuntime', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/server/serverRuntime')>();
    return {
        ...actual,
        getActiveServerSnapshot: () => ({ serverId: 'server-1' }),
    };
});
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
        capturedOpenSessionSpy.mockReset();
        workspaceLabelsV1 = {};
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReset();
        resolveServerIdForSessionIdFromLocalCacheSpy.mockImplementation((sessionId: string) =>
            sessionId === 's1' ? 'server-cache' : null
        );
        Object.defineProperty(globalThis, 'location', {
            value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
            writable: true,
            configurable: true,
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('opens session info via singular navigate using the explicit route server id for a route-owned session', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof headerProps?.onAvatarPress).toBe('function');

        headerProps?.onAvatarPress?.();

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-2', expect.objectContaining({
            dangerouslySingular: expect.any(Function),
        }));

        const singular = routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular;
        expect(typeof singular).toBe('function');
        expect(singular()).toBe('session-info');
    });

    it('opens session info via singular navigate using the route server id when cache resolution is unavailable', async () => {
        resolveServerIdForSessionIdFromLocalCacheSpy.mockReturnValue(null);
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof headerProps?.onAvatarPress).toBe('function');

        headerProps?.onAvatarPress?.();

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-2', expect.objectContaining({
            dangerouslySingular: expect.any(Function),
        }));
    });

    it('opens session info via singular navigate using the cached owning server id when the route is missing server scope', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(typeof headerProps?.onAvatarPress).toBe('function');

        headerProps?.onAvatarPress?.();

        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-cache', expect.objectContaining({
            dangerouslySingular: expect.any(Function),
        }));
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

    it('requests start-side truncation for the session header path subtitle', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        expect(chatHeaderPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            subtitle: 'tmp',
            subtitleEllipsizeMode: 'tail',
        }));
    });

    it('keeps the header top inset when only content safe-area padding is external', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" safeAreaTopMode="external" headerSafeAreaTopMode="internal" />,
            { wrapper: AppPaneProviderWrapper },
        );

        expect(chatHeaderPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
            includeTopInset: true,
        }));
    });

    it('falls back to the session path subtitle when no matching workspace label key is available', async () => {
        workspaceLabelsV1 = {
            wl_07600b8c: 'Renamed Workspace',
        };
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(headerProps?.subtitle).toBe('tmp');
        expect(headerProps?.subtitleEllipsizeMode).toBe('tail');
    });

    it('opens child sessions with the current session owner when child cache resolution is unavailable', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );

        capturedOpenSessionSpy('child-session-1');

        expect(routerPushSpy).toHaveBeenCalledWith('/session/child-session-1?serverId=server-2');
    });
});
