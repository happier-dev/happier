import React from 'react';
import renderer from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const setSessionsListStorageFilterSpy = vi.hoisted(() => vi.fn());

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
}));
const navigationState = vi.hoisted(() => ({
    pathname: '/',
}));

const externalSessionsFeatureState = vi.hoisted(() => ({
    enabled: false,
}));

const mainAppTabStateMock = vi.hoisted(() => ({
    shouldThrow: false,
    activeTab: 'sessions' as 'sessions' | 'projects' | 'inbox' | 'friends' | 'settings',
}));

const localSettingsState = vi.hoisted(() => ({
    sessionsListStorageFilter: 'all' as 'all' | 'persisted' | 'direct',
}));
const gettingStartedState = vi.hoisted(() => ({
    kind: 'create_session' as 'create_session' | 'connect_machine' | 'start_daemon' | 'select_session' | 'loading',
}));
const platformState = vi.hoisted(() => ({
    isTablet: true,
}));

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushSpy },
            pathname: () => navigationState.pathname,
        });
        return expoRouterMock.module;
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useFriendRequests: () => [],
            useSocketStatus: () => ({ status: 'connected' }),
            useRealtimeStatus: () => ({ status: 'idle' }),
            useLocalSettingMutable: (name: string) => {
                if (name === 'navigationSurfacePlacementsV1') return actual.useLocalSettingMutable(name);
                if (name === 'sessionsListStorageFilter') {
                    return [localSettingsState.sessionsListStorageFilter, setSessionsListStorageFilterSpy] as const;
                }
                throw new Error(`Unexpected local setting: ${name}`);
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/responsive', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/utils/platform/responsive')>()),
    useIsTablet: () => platformState.isTablet,
}));

vi.mock('@/hooks/server/useFriendsEnabled', () => ({
    useFriendsEnabled: () => true,
}));

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ ready: true }),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: true }),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => (
        featureId === 'sessions.direct'
            ? {
                state: externalSessionsFeatureState.enabled ? 'enabled' : 'disabled',
                blockerCode: externalSessionsFeatureState.enabled ? 'none' : 'feature_disabled',
                blockedBy: externalSessionsFeatureState.enabled ? null : 'local_policy',
                diagnostics: [],
                evaluatedAt: 0,
                featureId: 'sessions.direct',
                scope: { scopeKind: 'main_selection' },
            }
            : null
    ),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/inbox/useInboxAvailable', () => ({
    useInboxAvailable: () => mainAppTabStateMock.activeTab === 'inbox',
}));

vi.mock('@/components/sessions/model/useSessionListStorageKind', () => ({
    useSessionListStorageKind: () => ({
        externalSessionsEnabled: externalSessionsFeatureState.enabled,
        storageKind: externalSessionsFeatureState.enabled
            ? localSettingsState.sessionsListStorageFilter
            : 'persisted',
        setStorageKind: setSessionsListStorageFilterSpy,
    }),
}));

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', () => ({
    useMainAppTabState: () => {
        if (mainAppTabStateMock.shouldThrow) {
            throw new Error('useMainAppTabState must be used within MainAppTabStateProvider');
        }
        return {
            activeTab: mainAppTabStateMock.activeTab,
            setActiveTab: async () => {},
            isLoading: false,
        };
    },
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/useSessionGettingStartedGuidanceBaseModel', () => ({
    useSessionGettingStartedGuidanceBaseModel: () => ({
        kind: gettingStartedState.kind,
        targetLabel: 'leeroy-mbp',
        serverUrl: 'http://example.test',
        serverName: 'server-1',
        showServerSetup: false,
    }),
}));
vi.mock('@/components/sessions/shell/SessionsListEmptyState', () => ({
    SessionsListEmptyState: 'SessionsListEmptyState',
}));

vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: 'SessionsList',
}));

vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: 'RoundButton',
}));

// The app shell mounts the Universal Search runtime above the sidebar.
vi.mock('@/components/appShell/search/UniversalSearchRuntimeContext', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/search/UniversalSearchRuntimeContext')>()),
    useUniversalSearchRuntime: () => ({ open: vi.fn(), buildCommands: vi.fn() }),
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

vi.mock('@/components/navigation/mobile/chrome/bars/MainAppTabBar', () => ({
    MainAppTabBar: 'MainAppTabBar',
}));

vi.mock('@/components/navigation/shell/InboxView', () => ({
    InboxView: 'InboxView',
}));

vi.mock('@/components/navigation/shell/FriendsView', () => ({
    FriendsView: 'FriendsView',
}));

vi.mock('@/components/projects/ProjectsListView', () => ({
    ProjectsListView: 'ProjectsListView',
}));

vi.mock('@/components/sessions/shell/SessionsListWrapper', () => ({
    SessionsListWrapper: 'SessionsListWrapper',
}));

vi.mock('@/components/sessions/shell/ExternalSessionsEmptyState', () => ({
    ExternalSessionsEmptyState: 'ExternalSessionsEmptyState',
}));

vi.mock('@/components/sessions/shell/SessionsListPaneContent', () => ({
    SessionsListPaneContent: 'SessionsListPaneContent',
}));

vi.mock('@/components/navigation/Header', () => ({
    Header: 'Header',
}));

vi.mock('@/components/ui/navigation/HeaderLogo', () => ({
    HeaderLogo: 'HeaderLogo',
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    isUsingCustomServer: () => false,
}));

vi.mock('@/track', () => ({
    trackFriendsSearch: () => {},
}));

vi.mock('@/components/navigation/ConnectionStatusControl', () => ({
    ConnectionStatusControl: 'ConnectionStatusControl',
}));

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string) {
    return tree.find((node) => (node.type as unknown) === 'Pressable' && node.props.accessibilityLabel === label);
}

describe('MainView sidebar actions', () => {
    let MainView: React.ComponentType<{ variant: 'phone' | 'sidebar' }>;

    beforeEach(() => {
        routerPushSpy.mockReset();
        setSessionsListStorageFilterSpy.mockReset();
        sessionListState.data = [];
        externalSessionsFeatureState.enabled = false;
        localSettingsState.sessionsListStorageFilter = 'all';
        gettingStartedState.kind = 'create_session';
        mainAppTabStateMock.shouldThrow = false;
        mainAppTabStateMock.activeTab = 'sessions';
        navigationState.pathname = '/';
        platformState.isTablet = true;
    });

    beforeAll(async () => {
        MainView = (await import('./MainView')).MainView;
    }, 180_000);

    it('floats the one glass "+" over the sidebar session list and opens a new-session draft', async () => {
        const screen = await renderScreen(<MainView variant="sidebar" />);

        // The phone's "+" owner in its sidebar placement (its own testID); the wide bar is gone.
        expect(screen.findAllByTestId('sidebar-start-new-session').length).toBeGreaterThan(0);
        expect(screen.findAllByTestId('tabbar-start-new-session')).toHaveLength(0);
        screen.pressByTestId('sidebar-start-new-session');

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
        expect(() => findPressableByLabel(screen.tree as renderer.ReactTestRenderer, 'Open automations')).toThrow();
    });

    it('folds the phone Sessions bar into the list\'s nav row, leaving new sessions to the tab bar\'s glass "+"', async () => {
        platformState.isTablet = false;
        mainAppTabStateMock.activeTab = 'sessions';

        const tree = (await renderScreen(<MainView variant="phone" />)).tree;

        // No separate brand bar above My work (lab `clviews:recentP`): the list draws the shell's line.
        expect(tree.findAllByType('Header')).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'main-header-home-logo' })).toHaveLength(0);
        const { PhoneTabNavRowProvider } = await import('./phoneTabNavRow');
        const navRow = tree.root.findByType(PhoneTabNavRowProvider);
        const leading = await renderScreen(<>{navRow.props.leading}</>);
        expect(leading.findByType('ConnectionStatusControl').props.variant).toBe('header');
        const trailing = await renderScreen(<>{navRow.props.trailing}</>);
        expect(trailing.findAllByProps({ testID: 'main-header-start-new-session' })).toHaveLength(0);
        expect(trailing.findAllByProps({ testID: 'main-header-action-operations' }).length).toBeGreaterThan(0);
        // More lives on the tab bar, on every tab; the header no longer carries a second way in.
        expect(trailing.findAllByProps({ testID: 'phone-launcher-button' })).toHaveLength(0);
        expect(navRow.findByType('SessionsListWrapper' as never)).toBeDefined();
    });

    // Every phone tab opens on one head: the Home line and the glyphs, with the tab's own large title below.
    it.each(['projects', 'inbox'] as const)('gives the %s tab the same nav row as Sessions, without a second bar or logo', async (tab) => {
        platformState.isTablet = false;
        mainAppTabStateMock.activeTab = tab;

        const tree = (await renderScreen(<MainView variant="phone" />)).tree;

        expect(tree.findAllByType('Header')).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'main-header-home-logo' })).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'main-tab-nav-row' }).length).toBeGreaterThan(0);
        expect(tree.root.findAllByProps({ testID: 'main-header-settings-avatar' }).length).toBeGreaterThan(0);
    });

    it('pins the retained phone sessions surface to the root pathname across route changes', async () => {
        platformState.isTablet = false;
        mainAppTabStateMock.activeTab = 'sessions';
        navigationState.pathname = '/session/session-1';

        const tree = (await renderScreen(<MainView variant="phone" />)).tree;

        const sessionsList = tree.findByType('SessionsListWrapper' as any);
        expect(sessionsList.props.pathname).toBe('/');
    });

    it('renders the sessions list pane content in the sidebar instead of the legacy guidance card', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        const pane = tree!.findByType('SessionsListPaneContent');
        expect(pane.props.surfaceOwnership).toMatchObject({
            ownerKey: 'sidebar',
            visible: true,
            interactive: true,
            dataActive: true,
        });
        expect(() => tree!.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('keeps the sidebar sessions surface visible but non-interactive behind the new-session route', async () => {
        navigationState.pathname = '/new';

        const tree = (await renderScreen(<MainView variant="sidebar" />)).tree;
        const pane = tree.findByType('SessionsListPaneContent');

        expect(pane.props.surfaceOwnership).toMatchObject({
            ownerKey: 'sidebar',
            visible: true,
            interactive: false,
            dataActive: true,
        });
    });

    it('does not read the main app tab provider when rendering the sidebar variant', async () => {
        mainAppTabStateMock.shouldThrow = true;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('SessionsListPaneContent')).not.toThrow();
    });

    it('keeps using the sessions list pane content for reconnect states in the sidebar', async () => {
        gettingStartedState.kind = 'connect_machine';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('SessionsListPaneContent')).not.toThrow();
        expect(() => tree!.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('renders the unified external browse action without the retired storage tabs', async () => {
        externalSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageFilter = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByProps({ testID: 'external-sessions-browse-button' })).not.toThrow();
        expect(() => tree!.findByProps({ testID: 'sessions-list-storage-tab:direct' })).toThrow();
    });

    it('keeps the external browse action visible when the unified list shows all sessions', async () => {
        externalSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageFilter = 'all';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByProps({ testID: 'external-sessions-browse-button' })).not.toThrow();
    });
});
