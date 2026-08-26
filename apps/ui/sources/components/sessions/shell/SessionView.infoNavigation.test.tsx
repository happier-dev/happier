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

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
    (globalThis as any).location.href = 'http://localhost/session/s1/previous';
    (globalThis as any).location.pathname = '/session/s1/previous';
}));
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const capturedOpenSessionSpy = vi.hoisted(() => vi.fn<(sid: string) => void>());
const ensureSidechainMessagesLoadedSpy = vi.hoisted(() => vi.fn(async () => 'loaded'));
const ensureSidechainsLoadedCalls = vi.hoisted(() => [] as any[]);
const resolveServerIdForSessionIdFromLocalCacheSpy = vi.hoisted(() =>
    vi.fn<(sessionId: string) => string | null>((sessionId: string) =>
        sessionId === 's1' ? 'server-cache' : null
    ),
);

let workspaceLabelsV1: Record<string, string> = {};
let sessionOrganizationProjection: any = null;
let subagentSourceMessages: readonly any[] = [];

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
                sessionListViewDataByServerId: {
                    'server-1': [
                        {
                            type: 'session',
                            session,
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
            useSessionSubagentSourceMessages: () => subagentSourceMessages,
            useSessionConnectedServiceAccountSwitchEvents: () => [],
            useSessionReviewCommentsDrafts: () => [],
            useWorkspaceReviewCommentsDrafts: () => [],
            useSessionUsage: () => null,
            useSessionOrganizationProjection: () => sessionOrganizationProjection,
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
            useSessionAutomationsEnabledCount: () => 0,
            useOpenApprovalArtifactsForSession: () => [],
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

const createReanimatedMock = () => {
    const Animated = {
        View: 'Animated.View',
        createAnimatedComponent: (component: unknown) => component,
    };
    return {
        __esModule: true,
        default: Animated,
        ...Animated,
        useAnimatedProps: (factory: () => unknown) => factory(),
        useAnimatedStyle: (factory: () => unknown) => factory(),
        useSharedValue: (initial: unknown) => ({ value: initial }),
    };
};

vi.mock('react-native-reanimated', () => createReanimatedMock());
vi.mock('react-native-reanimated/lib/module', () => createReanimatedMock());
vi.mock('react-native-reanimated/lib/module/index.js', () => createReanimatedMock());
vi.mock('react-native-reanimated/lib/module/index', () => createReanimatedMock());
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
    getCurrentAuth: () => ({ credentials: { token: 't', secret: 's' } }),
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
    // `useSessionSurfaceActivation` reads the reset version through `useSyncExternalStore`. Without
    // these the whole suite throws on render, so every assertion below was unreachable.
    subscribeActiveViewingSessionReset: () => () => {},
    getActiveViewingSessionResetVersion: () => 0,
    registerSessionVisibleSurface: () => () => {},
}));
vi.mock('@/sync/sync', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/sync')>(),
    syncSwitchServer: vi.fn(async () => {}),
    sync: {
        markSessionViewed: async () => {},
        fetchPendingMessages: async () => {},
        publishSessionPermissionModeToMetadata: async () => {},
        refreshSessions: async () => {},
        onSessionVisible: () => () => {},
        markSessionLiveTailIntent: () => {},
        ensureSidechainMessagesLoaded: ensureSidechainMessagesLoadedSpy,
        sendMessage: async () => {},
        enqueuePendingMessage: async () => {},
        submitMessage: async () => {},
        encryption: { getMachineEncryption: () => null },
    },
}));
vi.mock('@/hooks/session/useEnsureSidechainsLoaded', () => ({
    useEnsureSidechainsLoaded: (params: any) => {
        ensureSidechainsLoadedCalls.push(params);
    },
}));
vi.mock('@/sync/ops', async (importOriginal) => {
    const { createSyncOpsModuleMock } = await import('@/dev/testkit/mocks/syncOps');
    return createSyncOpsModuleMock({
        importOriginal,
        overrides: {
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
vi.mock('@/sync/domains/server/activeServerSwitch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/activeServerSwitch')>(),
    setActiveServerAndSwitch: vi.fn(async () => {}),
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

/**
 * The session-info navigation is reached through the header's info control, which the header
 * receives inside `rightElement`. It used to hang off the avatar; the navigation contract asserted
 * below is the same one, read through the control that now owns it.
 */
function readOpenSessionInfoHandler(): (() => void) | undefined {
    const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
    return (headerProps?.rightElement as { props?: { onOpenSessionInfo?: () => void } } | undefined)
        ?.props?.onOpenSessionInfo;
}

describe('SessionView info navigation', () => {
    beforeEach(() => {
        routerPushSpy.mockReset();
        routerNavigateSpy.mockReset();
        routerBackSpy.mockClear();
        chatHeaderPropsSpy.mockReset();
        capturedOpenSessionSpy.mockReset();
        ensureSidechainMessagesLoadedSpy.mockClear();
        ensureSidechainsLoadedCalls.length = 0;
        workspaceLabelsV1 = {};
        sessionOrganizationProjection = {
            schemaVersion: 1,
            version: 1,
            pinnedSessionIds: [],
            pinsBySessionId: {},
            foldersById: {},
            folderAssignmentsBySessionId: {},
            tagsById: {},
            tagAssignmentsBySessionId: {},
            attentionStandingsBySessionId: {},
            orderEntriesByScopeKey: {},
            labelsByLabelKey: {},
        };
        subagentSourceMessages = [];
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

        const openSessionInfo = readOpenSessionInfoHandler();
        expect(typeof openSessionInfo).toBe('function');

        openSessionInfo?.();

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

        const openSessionInfo = readOpenSessionInfoHandler();
        expect(typeof openSessionInfo).toBe('function');

        openSessionInfo?.();

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

        const openSessionInfo = readOpenSessionInfoHandler();
        expect(typeof openSessionInfo).toBe('function');

        openSessionInfo?.();

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
            subtitleEllipsizeMode: 'head',
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

    it('uses the server-backed renamed workspace label for the session header subtitle', async () => {
        workspaceLabelsV1 = {
            wl_07600b8c: 'Legacy Workspace',
        };
        sessionOrganizationProjection = {
            ...sessionOrganizationProjection,
            labelsByLabelKey: {
                'server-cache:workspace:wl_07600b8c': {
                    labelKind: 'workspace',
                    scopeKey: 'wl_07600b8c',
                    display: { t: 'plain', v: { label: 'Renamed Workspace' } },
                    archivedAt: null,
                    createdAt: 1,
                    updatedAt: 2,
                },
            },
        };
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        const headerProps = chatHeaderPropsSpy.mock.calls.at(-1)?.[0];
        expect(headerProps?.subtitle).toBe('Renamed Workspace');
        expect(headerProps?.subtitleEllipsizeMode).not.toBe('head');
    });

    it('opens child sessions with the current session owner when child cache resolution is unavailable', async () => {
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );

        capturedOpenSessionSpy('child-session-1');

        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/child-session-1?serverId=server-2', expect.any(Object));
    });

    it('does not eagerly hydrate discovered subagent sidechains from the session shell or header', async () => {
        subagentSourceMessages = [{
            kind: 'tool-call',
            id: 'tool-call-1',
            localId: null,
            createdAt: 1,
            tool: {
                id: 'toolu_sidechain_1',
                name: 'Task',
                state: 'running',
                input: { description: 'Inspect this workspace' },
                createdAt: 1,
                startedAt: 1,
                completedAt: null,
                description: 'Inspect this workspace',
                result: null,
            },
            children: [],
        }];
        const { SessionView } = await import('./SessionView');

        await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );
        expect(ensureSidechainsLoadedCalls).not.toContainEqual(expect.objectContaining({
            enabled: true,
            sessionId: 's1',
            sidechainIds: ['toolu_sidechain_1'],
        }));
    });
});
