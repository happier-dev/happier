import React from 'react';
import renderer from 'react-test-renderer';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.hoisted(() => vi.fn());
const routerReplaceSpy = vi.hoisted(() => vi.fn());
const setSessionsListStorageTabSpy = vi.hoisted(() => vi.fn());

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
}));
const emptyStateState = vi.hoisted(() => ({
    hasHiddenInactiveSessions: false,
}));

const directSessionsFeatureState = vi.hoisted(() => ({
    enabled: false,
}));

const localSettingsState = vi.hoisted(() => ({
    sessionsListStorageTab: 'persisted' as 'persisted' | 'direct',
}));
const platformState = vi.hoisted(() => ({
    isTablet: true,
}));
const tabState = vi.hoisted(() => ({
    activeTab: 'sessions' as 'sessions' | 'inbox' | 'friends' | 'settings',
    setActiveTab: vi.fn(async () => {}),
}));

installNavigationShellCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushSpy, replace: routerReplaceSpy },
            pathname: '/',
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

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => sessionListState.data,
    useHasHiddenInactiveSessions: () => emptyStateState.hasHiddenInactiveSessions,
    countVisibleSessionListSessions: (data: Array<{ type?: string }> | null) => (
        data?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0
    ),
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
                state: directSessionsFeatureState.enabled ? 'enabled' : 'disabled',
                blockerCode: directSessionsFeatureState.enabled ? 'none' : 'feature_disabled',
                blockedBy: directSessionsFeatureState.enabled ? null : 'local_policy',
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

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => ({
        activeTab: tabState.activeTab,
        setActiveTab: tabState.setActiveTab,
        isLoading: false,
    }),
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/HiddenInactiveSessionsEmptyState', () => ({
    HiddenInactiveSessionsEmptyState: 'HiddenInactiveSessionsEmptyState',
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

vi.mock('@/components/ui/navigation/TabBar', () => ({
    TabBar: 'TabBar',
}));

vi.mock('@/components/navigation/shell/InboxView', () => ({
    InboxView: 'InboxView',
}));

vi.mock('@/components/sessions/shell/SessionsListWrapper', () => ({
    SessionsListWrapper: 'SessionsListWrapper',
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
        routerReplaceSpy.mockReset();
        tabState.activeTab = 'sessions';
        tabState.setActiveTab.mockClear();
        setSessionsListStorageTabSpy.mockReset();
        sessionListState.data = [];
        emptyStateState.hasHiddenInactiveSessions = false;
        directSessionsFeatureState.enabled = false;
        localSettingsState.sessionsListStorageTab = 'persisted';
        platformState.isTablet = true;
    });

    beforeAll(async () => {
        const mainViewModule = await import('./MainView');
        MainView = mainViewModule.MainView;
    }, 120_000);

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
        expect(tree!.findAllByType('TabBar')).toHaveLength(0);
    });

    it('does not duplicate getting started guidance when primary pane is visible (home route)', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('does not replay a stale settings tab state when the root sessions route remounts', async () => {
        platformState.isTablet = false;
        tabState.activeTab = 'settings';

        const screen = await renderScreen(<MainView variant="phone" />);
        const header = screen.tree.findByType('Header');
        const renderedHeaderRight = await renderScreen(header.props.headerRight());

        expect(tabState.setActiveTab).toHaveBeenCalledWith('sessions');
        expect(routerReplaceSpy).not.toHaveBeenCalledWith('/settings');
        expect(() => renderedHeaderRight.findByProps({ testID: 'main-header-start-new-session' })).not.toThrow();
    });

    it('renders direct session storage tabs in the sidebar empty state when direct sessions are enabled', async () => {
        directSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageTab = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByProps({ testID: 'sessions-list-storage-tab:direct' })).not.toThrow();
    });

    it('renders the browse direct sessions action in the sidebar empty state when the direct tab is active', async () => {
        directSessionsFeatureState.enabled = true;
        localSettingsState.sessionsListStorageTab = 'direct';

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByProps({ testID: 'direct-sessions-browse-button' })).not.toThrow();
    });

    it('shows the hidden inactive sessions notice when hide inactive sessions empties the sidebar', async () => {
        emptyStateState.hasHiddenInactiveSessions = true;

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('HiddenInactiveSessionsEmptyState')).not.toThrow();
        expect(() => tree!.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('treats header-only sidebar data as empty when hidden inactive sessions removed all session rows', async () => {
        emptyStateState.hasHiddenInactiveSessions = true;
        sessionListState.data = [{ type: 'header', title: 'Today' }];

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('HiddenInactiveSessionsEmptyState')).not.toThrow();
        expect(() => tree!.findByType('SessionsList')).toThrow();
    });
});
