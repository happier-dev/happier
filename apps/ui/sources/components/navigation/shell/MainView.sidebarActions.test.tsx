import React from 'react';
import renderer from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const setSessionsListStorageTabSpy = vi.hoisted(() => vi.fn());

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
    sessionsListStorageTab: 'persisted' as 'persisted' | 'direct',
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
            get pathname() {
                return navigationState.pathname;
            },
        });
        return expoRouterMock.module;
    },
    storage: async (importOriginal) => {
        const { createPartialStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createPartialStorageModuleMock(importOriginal, {
            useFriendRequests: () => [],
            useSocketStatus: () => ({ status: 'connected' }),
            useRealtimeStatus: () => ({ status: 'idle' }),
            useLocalSettingMutable: (name: string) => {
                if (name === 'sessionsListStorageTab') {
                    return [localSettingsState.sessionsListStorageTab, setSessionsListStorageTabSpy] as const;
                }
                throw new Error(`Unexpected local setting: ${name}`);
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/responsive', () => ({
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

vi.mock('@/components/ui/buttons/FABWide', () => ({
    FABWide: 'FABWide',
}));

vi.mock('@/components/navigation/mobile/chrome/bars/MainAppTabBar', () => ({
    MainAppTabBar: 'MainAppTabBar',
}));

vi.mock('@/components/navigation/shell/InboxView', () => ({
    InboxView: 'InboxView',
}));

vi.mock('@/components/settings/shell/SettingsViewWrapper', () => ({
    SettingsViewWrapper: 'SettingsViewWrapper',
}));

vi.mock('@/components/projects/ProjectsListView', () => ({
    ProjectsListView: 'ProjectsListView',
}));

vi.mock('@/components/sessions/shell/SessionsListWrapper', () => ({
    SessionsListWrapper: 'SessionsListWrapper',
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

vi.mock('@/components/voice/surface/VoiceSurface', () => ({
    VoiceSurface: 'VoiceSurface',
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
        setSessionsListStorageTabSpy.mockReset();
        sessionListState.data = [];
        externalSessionsFeatureState.enabled = false;
        localSettingsState.sessionsListStorageTab = 'persisted';
        gettingStartedState.kind = 'create_session';
        mainAppTabStateMock.shouldThrow = false;
        mainAppTabStateMock.activeTab = 'sessions';
        navigationState.pathname = '/';
        platformState.isTablet = true;
    });

    beforeAll(async () => {
        MainView = (await import('./MainView')).MainView;
    }, 30_000);

    it('renders the wide start-new-session CTA in the sidebar instead of header action buttons', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('FABWide')).not.toThrow();
        expect(() => findPressableByLabel(tree!, 'New session')).toThrow();
        expect(() => findPressableByLabel(tree!, 'Open automations')).toThrow();
    });

    it('keeps the phone sessions header new-session action', async () => {
        platformState.isTablet = false;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="phone" />)).tree;

        const header = tree!.findByType('Header');
        const headerRight = header.props.headerRight();
        expect(headerRight).toBeTruthy();

        const renderedHeaderRight = await renderScreen(headerRight);
        expect(() => renderedHeaderRight.findByProps({ testID: 'main-header-start-new-session' })).not.toThrow();
        expect(renderedHeaderRight.findAllByType('FABWide')).toHaveLength(0);
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

    it('renders direct session storage tabs in the sidebar empty state when direct sessions are enabled', async () => {
        externalSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageTab = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByProps({ testID: 'sessions-list-storage-tab:direct' })).not.toThrow();
    });

    it('renders the browse direct sessions action in the sidebar empty state when the direct tab is active', async () => {
        externalSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageTab = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByProps({ testID: 'direct-sessions-browse-button' })).not.toThrow();
    });
});
