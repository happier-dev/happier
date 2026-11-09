import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const sessionListState = vi.hoisted(() => ({
    data: [] as any[] | null,
}));

const buildPolicyState = vi.hoisted(() => ({
    decision: 'neutral' as 'allow' | 'deny' | 'neutral',
}));


vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

installNavigationShellCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
            View: 'View',
            Text: 'Text',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: async () => {} },
            pathname: '/',
        });
        return expoRouterMock.module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useFriendRequests: () => [],
            useSocketStatus: () => ({ status: 'connected' }),
            useRealtimeStatus: () => ({ status: 'idle' }),
            useSetting: (key: string) => {
                if (key === 'serverSelectionGroups') return [];
                if (key === 'serverSelectionActiveTargetKind') return 'main_selection';
                if (key === 'serverSelectionActiveTargetId') return '';
                return null;
            },
            useSettings: () => ({}),
        });
    },
});

vi.mock('@/hooks/session/useVisibleSessionListViewData', () => ({
    useVisibleSessionListViewData: () => sessionListState.data,
    useHasHiddenInactiveSessions: () => false,
    countVisibleSessionListSessions: (data: Array<{ type?: string }> | null) => (
        data?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0
    ),
}));

vi.mock('@/components/sessions/shell/search/useSessionListViewFilterController', () => ({
    useSessionListViewFilterController: () => ({ sourceAvailable: false, displayFilters: { source: 'all' } }),
}));

vi.mock('@/hooks/inbox/useInboxAvailable', () => ({
    useInboxAvailable: () => false,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useIsTablet: () => true,
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

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({
        state: 'disabled',
        blockerCode: 'feature_disabled',
        blockedBy: 'local_policy',
        diagnostics: [],
        evaluatedAt: 0,
        featureId: 'sessions.direct',
        scope: { scopeKind: 'main_selection' },
    }),
}));

vi.mock('@/hooks/ui/useTabState', () => ({
    useTabState: () => ({
        activeTab: 'sessions',
        setActiveTab: async () => {},
        isLoading: false,
    }),
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('@/sync/domains/features/featureBuildPolicy', () => ({
    getFeatureBuildPolicyDecision: () => buildPolicyState.decision,
}));

// The home hub owns the empty pane (and its getting-started fallback); its own suite covers it.
vi.mock('@/components/hub/HomeHub', () => ({
    HomeHub: 'HomeHub',
}));

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));

vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: 'SessionsList',
}));

vi.mock('@/components/sessions/shell/SessionsListStorageChrome', () => ({
    SessionsListStorageChrome: 'SessionsListStorageChrome',
}));

vi.mock('@/components/sessions/shell/SessionsListPaneContent', () => ({
    SessionsListPaneContent: 'SessionsListPaneContent',
}));

vi.mock('@/components/sessions/shell/ExternalSessionsEmptyState', () => ({
    ExternalSessionsEmptyState: 'ExternalSessionsEmptyState',
}));

vi.mock('@/components/ui/navigation/TabBar', () => ({
    TabBar: 'TabBar',
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

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', () => ({
    useMainAppTabState: () => ({
        activeTab: 'sessions',
    }),
}));

describe('MainView (tablet primary pane)', () => {
    beforeEach(() => {
        sessionListState.data = [];
        buildPolicyState.decision = 'neutral';
    });

    it('shows the home hub instead of a blank view', async () => {
        const { MainView } = await import('./MainView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="phone" />)).tree;

        expect(() => tree!.findByType('HomeHub' as never)).not.toThrow();
    });

    it('shows a fallback view when getting started guidance is denied by build policy', async () => {
        buildPolicyState.decision = 'deny';
        const { MainView } = await import('./MainView');

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="phone" />)).tree;

        expect(() => tree!.findByProps({ testID: 'mainview-tablet-primary-pane-fallback' })).not.toThrow();
    });
});
