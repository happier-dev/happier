import * as React from 'react';
import { createReactNavigationNativeMock } from '@/dev/testkit/mocks/reactNavigation';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderCanonicalScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import 'fake-indexeddb/auto';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
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
// The remote source mirror intentionally omits build-generated app artifact bytes.
// This shell suite has no installed-plugin fixture, so its package boundary is
// truthfully an empty bundled inventory rather than requiring a generator run.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: Object.freeze([]),
}));
vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => Object.freeze({
        kind: 'appExact' as const,
        fetch: vi.fn(async () => null),
    }),
}));
vi.mock('@/sync/domains/plugins/availability/reader', () => ({
    createPluginAccountAvailabilityReader: vi.fn(() => null),
    createPluginAccountAvailabilityReaderStore: vi.fn(() => ({
        get: vi.fn(() => null),
        subscribe: vi.fn(() => () => {}),
    })),
    projectPluginAccountAvailabilityMaterializationIdentity: vi.fn(() => null),
}));

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());
const routerBackSpy = vi.hoisted(() => vi.fn(() => {
    (globalThis as any).location.href = 'http://localhost/session/s1/previous';
    (globalThis as any).location.pathname = '/session/s1/previous';
}));
const chatHeaderPropsSpy = vi.hoisted(() => vi.fn());
const capturedOpenSessionSpy = vi.hoisted(() => vi.fn<(sid: string) => void>());
const companionHostPropsSpy = vi.hoisted(() => vi.fn());
const boardControllerState = vi.hoisted(() => ({ unavailable: false }));

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
    storage: async importOriginal => importOriginal(),
});


vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module/index.js', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('react-native-reanimated/lib/module/index', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});
vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));
vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('react-native-safe-area-context', () => ({
    initialWindowMetrics: {
        frame: { x: 0, y: 0, width: 0, height: 0 },
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@react-navigation/native', () => ({
    ...createReactNavigationNativeMock(),
    useFocusEffect: () => {},
    useIsFocused: () => true,
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
vi.mock('@/components/ui/code/editor/CodeEditor', () => ({ CodeEditor: () => null }));
vi.mock('@/components/sessions/companion/SessionCompanionHost', () => ({
    SessionCompanionHost: (props: Record<string, unknown>) => {
        companionHostPropsSpy(props);
        return React.createElement('SessionCompanionHost', props);
    },
}));
vi.mock('@/components/sessions/board/SessionBoardControllerProvider', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/sessions/board/SessionBoardControllerProvider')>();
    const { SessionBoardContinuityProvider } = await import('@/components/sessions/board/SessionBoardContinuity');
    const { projectSessionBoard, createSessionBoardActionsPort } = await import('@/sync/domains/session/board');
    const { SessionBoardLayoutV1Schema, SessionSurfaceItemV1Schema } = await import('@happier-dev/protocol/sessions/board');
    const snapshot = projectSessionBoard({
        layout: { revision: 'ssr1:layout', outcome: { status: 'ready', value: SessionBoardLayoutV1Schema.parse({
            v: 1, tabs: [{ id: 'overview', title: 'Overview', items: [{ itemId: 'widget-7', width: 'medium' }] }],
        }) } },
        items: new Map([['widget-7', { revision: 'ssr1:widget-7', outcome: { status: 'ready' as const, value: SessionSurfaceItemV1Schema.parse({
            v: 1, title: 'Widget', frame: 'card', height: { mode: 'auto', fallback: 'regular' },
            source: { kind: 'declarative', document: { version: 1, root: { kind: 'markdown', text: 'Widget' } } },
        }) } }]]),
        capabilities: { readTranscript: true, editSessionRecords: true },
        freshness: 'fresh', reachability: 'reachable', loading: 'idle', incomplete: false,
    });
    return { ...actual, SessionBoardControllerProvider: (props: React.ComponentProps<typeof actual.SessionBoardControllerProvider>) => {
        if (boardControllerState.unavailable || !props.serverId) return <>{props.children}</>;
        const address = { serverId: props.serverId, sessionId: props.sessionId };
        const binding = { status: 'ready' as const, snapshot };
        const actions = createSessionBoardActionsPort(address);
        return <SessionBoardContinuityProvider {...address}><actual.SessionBoardControllerOwner
            address={address} input={{ ...address, binding, actions }} binding={binding} actions={actions}
            pluginRuntime={{ serverId: address.serverId, machineId: 'm1', pluginUiProjection: null,
                pluginBrowserProjection: null, phase: 'unavailable', interactionEnabled: false, platform: 'web' }}
            callerHostedHtmlRuntime={null}
        >{props.children}</actual.SessionBoardControllerOwner></SessionBoardContinuityProvider>;
    } };
});
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
vi.mock('@/components/sessions/panes/url/useSessionPaneUrlSync', () => ({
    useSessionPaneUrlSync: () => {},
}));
vi.mock('@/sync/domains/session/activeViewingSession', () => ({
    setActiveViewingSessionId: () => {},
    clearActiveViewingSessionId: () => {},
    markSessionVisible: () => {},
    markSessionHidden: () => {},
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
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>) => void promise,
}));

installDisconnectedServerSocketBoundary();
vi.doUnmock('@/sync/domains/state/storage');
vi.doUnmock('@/hooks/session/useDraft');
vi.doUnmock('@/agents/registry/registryUiBehavior');
const { storage } = await import('@/sync/domains/state/storage');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let previousStorage: ReturnType<typeof storage.getState>;
let pane: ReturnType<typeof useAppPaneScope>;
function PaneProbe() {
    pane = useAppPaneScope(createSessionPaneScopeId('s1', account.home.id));
    return null;
}
const AppPaneProviderWrapper = ({ children }: { children?: React.ReactNode }) => (
    <InjectedAuthProvider credentials={account.credentials}><AppPaneProvider><PaneProbe />{children ?? null}</AppPaneProvider></InjectedAuthProvider>
);
async function renderScreen(...args: Parameters<typeof renderCanonicalScreen>) {
    return renderCanonicalScreen(...args);
}
function applySessionHome(serverId = account.home.id) {
    storage.getState().applySessions([createSessionFixture({ id: 's1', serverId, active: true, metadata: {
        machineId: 'm1', flavor: 'codex', version: '0.0.0', path: '/tmp', homeDir: '/Users/test',
    }, agentState: {} })]);
}
async function restoreHome(serverUrl: string) {
    await loadSyncSingletonForTests();
    return restoreServerAccountForTest({ serverUrl, request: async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
        if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
        if (path === '/v2/sessions/s1/pending') return Response.json({ pending: [] });
        if (path === '/v1/sessions/s1/messages') return Response.json({ messages: [], hasMore: false, nextBeforeSeq: null });
        return new Response('{}', { status: 404 });
    } });
}

const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

describe('SessionView info navigation', () => {
    beforeEach(async () => {
        previousStorage = storage.getState();
        account = await restoreHome('https://server-2');
        applySessionHome();
        storage.setState({ isDataReady: true });
        routerPushSpy.mockReset();
        routerNavigateSpy.mockReset();
        routerBackSpy.mockClear();
        chatHeaderPropsSpy.mockReset();
        capturedOpenSessionSpy.mockReset();
        companionHostPropsSpy.mockReset();
        boardControllerState.unavailable = false;
        Object.defineProperty(globalThis, 'location', {
            value: { href: 'http://localhost/session/s1', pathname: '/session/s1' },
            writable: true,
            configurable: true,
        });
    });

    afterEach(async () => {
        await standardCleanup();
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        scmStatusSync.stop('s1', account.home.id);
        await account.dispose();
        storage.setState(previousStorage, true);
    });

    it('opens session info via singular navigate using the explicit route server id for a route-owned session', async () => {
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );

        screen.root.findByProps({ accessibilityLabel: 'sessionInfo.title' }).props.onPress();

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-2', expect.objectContaining({
            dangerouslySingular: expect.any(Function),
        }));

        const singular = routerNavigateSpy.mock.calls[0]?.[1]?.dangerouslySingular;
        expect(typeof singular).toBe('function');
        expect(singular()).toBe('session-info');
    });

    it('keeps the mounted Summary available before Board inventory is ready and routes it through the exact Home', async () => {
        boardControllerState.unavailable = true;
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(<SessionView id="s1" routeServerId="server-2" />, { wrapper: AppPaneProviderWrapper });

        const companionProps = companionHostPropsSpy.mock.calls.at(-1)?.[0] as Readonly<{
            address: { serverId: string; sessionId: string };
            boardBinding: unknown | null;
            pluginRuntime?: unknown;
            summaryDestinations: { sessionInfo: () => void };
        }> | undefined;
        expect(companionProps).toMatchObject({
            address: { serverId: 'server-2', sessionId: 's1' },
            boardBinding: null,
        });
        expect(companionProps).not.toHaveProperty('pluginRuntime');

        companionProps?.summaryDestinations.sessionInfo();

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-2');
        expect(routerPushSpy).not.toHaveBeenCalledWith('/session/s1/info?serverId=server-cache');
        await screen.unmount();
    });

    it('keeps every nested current-Session destination on the exact route Home when bare-id cache admission is ambiguous', async () => {
        // Two real cached addresses cannot admit a bare id, while the explicit
        // route retains its already Home-qualified Session identity.
        storage.setState({ ordinarySessionListMembershipByServerId: { 'server-other-home': ['s1'] } });
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(<SessionView id="s1" routeServerId="server-2" />, { wrapper: AppPaneProviderWrapper });

        const companionProps = companionHostPropsSpy.mock.calls.at(-1)?.[0] as Readonly<{
            summaryDestinations: Readonly<{
                sessionInfo: () => void;
                workTab: () => void;
                usage: () => void;
            }>;
        }> | undefined;
        expect(companionProps).toBeDefined();

        await act(async () => {
            companionProps?.summaryDestinations.sessionInfo();
            companionProps?.summaryDestinations.workTab();
            companionProps?.summaryDestinations.usage();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-2');
        expect(pane.scopeState?.right).toMatchObject({ isOpen: true, activeTabId: 'agents' });
        expect(routerPushSpy).toHaveBeenCalledWith('/session/s1/usage?serverId=server-2');
        expect(routerPushSpy.mock.calls.map((call) => String(call[0]))
            .filter((href) => href.includes('server-other-home'))).toEqual([]);
        await screen.unmount();
    });

    it('opens the exact Companion widget in the existing Board details owner', async () => {
        const { SessionView } = await import('./SessionView');
        await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );
        const companionProps = companionHostPropsSpy.mock.calls.at(-1)?.[0] as Readonly<{
            onRevealBoardItem: (itemId: string) => void;
        }>;

        await act(async () => { companionProps.onRevealBoardItem('widget-7'); });

        expect(pane.scopeState?.details.tabs).toEqual(expect.arrayContaining([expect.objectContaining({
            key: 'board:widget-7', isPinned: true,
            resource: { kind: 'board', focusTarget: { kind: 'item', itemId: 'widget-7' } },
        })]));
    });

    it('opens session info via singular navigate using the route server id when bare-id cache admission is ambiguous', async () => {
        storage.setState({ ordinarySessionListMembershipByServerId: { 'server-other-home': ['s1'] } });
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" routeServerId="server-2" />,
            { wrapper: AppPaneProviderWrapper },
        );

        screen.root.findByProps({ accessibilityLabel: 'sessionInfo.title' }).props.onPress();

        expect(routerPushSpy).not.toHaveBeenCalled();
        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith('/session/s1/info?serverId=server-2', expect.objectContaining({
            dangerouslySingular: expect.any(Function),
        }));
    });

    it('opens session info via singular navigate using the cached owning server id when the route is missing server scope', async () => {
        await account.dispose();
        account = await restoreHome('https://server-cache');
        applySessionHome();
        storage.setState({ isDataReady: true });
        const { SessionView } = await import('./SessionView');

        const screen = await renderScreen(
            <SessionView id="s1" />,
            { wrapper: AppPaneProviderWrapper },
        );

        screen.root.findByProps({ accessibilityLabel: 'sessionInfo.title' }).props.onPress();

        expect(routerNavigateSpy).toHaveBeenCalledTimes(1);
        expect(routerNavigateSpy).toHaveBeenCalledWith(`/session/s1/info?serverId=${account.home.id}`, expect.objectContaining({
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
