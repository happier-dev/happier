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

// The phone's three home-route tabs, switched the way the tab bar does (one active tab at a time).
const tabState = vi.hoisted(() => ({ activeTab: 'sessions' as 'sessions' | 'projects' | 'inbox', listeners: new Set<() => void>() }));
const tabMounts = vi.hoisted(() => ({ sessions: 0, projects: 0, inbox: 0 }));
const inboxStore = vi.hoisted(() => {
    let value = 0;
    const listeners = new Set<() => void>();
    return {
        read: () => value,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        set: (next: number) => { value = next; for (const listener of [...listeners]) listener(); },
    };
});


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



vi.mock('@/components/sessions/shell/search/useSessionListViewFilterController', () => ({
    useSessionListViewFilterController: () => ({ sourceAvailable: false, displayFilters: { source: 'all' } }),
}));

vi.mock('@/hooks/inbox/useInboxAvailable', () => ({
    useInboxAvailable: () => true,
}));

vi.mock('@/utils/platform/responsive', async importOriginal => ({
    ...await importOriginal<typeof import('@/utils/platform/responsive')>(),
    useIsTablet: () => false,
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



vi.mock('@/components/navigation/shell/InboxView', async () => {
    const React = await import('react');
    return { InboxView: function InboxView() {
        React.useState(() => { tabMounts.inbox += 1; return null; });
        // A live store subscription in a hidden tab body (rows, badges and summaries all have one).
        const value = React.useSyncExternalStore(inboxStore.subscribe, inboxStore.read);
        return React.createElement('InboxView', { value });
    } };
});

vi.mock('@/components/navigation/shell/FriendsView', () => ({
    FriendsView: 'FriendsView',
}));

vi.mock('@/components/projects/ProjectsListView', async () => {
    const React = await import('react');
    return { ProjectsListView: function ProjectsListView() {
        React.useState(() => { tabMounts.projects += 1; return null; });
        return React.createElement('ProjectsListView');
    } };
});

vi.mock('@/components/sessions/shell/SessionsListWrapper', async () => {
    const React = await import('react');
    return { SessionsListWrapper: function SessionsListWrapper() {
        React.useState(() => { tabMounts.sessions += 1; return null; });
        return React.createElement('SessionsListWrapper');
    } };
});

vi.mock('@/components/navigation/Header', async importOriginal => ({
    ...await importOriginal<typeof import('@/components/navigation/Header')>(),
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

vi.mock('@/components/navigation/mobile/chrome/MainAppTabStateProvider', async () => {
    const React = await import('react');
    const subscribe = (listener: () => void) => { tabState.listeners.add(listener); return () => { tabState.listeners.delete(listener); }; };
    return {
        useMainAppTabState: () => ({
            activeTab: React.useSyncExternalStore(subscribe, () => tabState.activeTab),
            setActiveTab: async () => {},
            isLoading: false,
        }),
    };
});

const { MainView } = await import('./MainView');

// P03-PROFILE-ROUND-2 #4: on a phone every return to the Sessions tab rebuilt it (and the Home it shows on an
// empty Account) from nothing, ~3 s of JS per return on Android. A visited tab stays mounted, suspended while hidden.
describe('MainView (phone home-route tabs)', () => {
    beforeEach(() => {
        sessionListState.data = [];
        buildPolicyState.decision = 'neutral';
        tabState.activeTab = 'sessions';
        tabMounts.sessions = 0; tabMounts.projects = 0; tabMounts.inbox = 0;
        inboxStore.set(0);
    });

    // Three tabs: a third tab's first mount beside two suspended tabs must settle (it once cascaded and never drained).
    it('mounts each visited tab once across repeated tab switches', { timeout: 30000 }, async () => {
        await renderScreen(<MainView variant="phone" />);
        for (const tab of ['inbox', 'sessions', 'projects', 'sessions', 'inbox', 'sessions'] as const) {
            await renderer.act(async () => {
                tabState.activeTab = tab;
                for (const listener of [...tabState.listeners]) listener();
            });
        }
        expect(tabMounts).toEqual({ sessions: 1, projects: 1, inbox: 1 });
    });

    // P03-ANDROID-FIX: a frozen (thrown-thenable) hidden tab re-attempted its body on every store update outside
    // an Offscreen render, and React 19.2 spawned a fresh retry render for it each time; with an update landing
    // during each retry (Android deep-link resume) that became ~120 empty commits/s. A hidden tab does no work.
    it('commits nothing while a hidden tab body store updates', { timeout: 30000 }, async () => {
        let commits = 0;
        await renderScreen(<React.Profiler id="main" onRender={() => { commits += 1; }}><MainView variant="phone" /></React.Profiler>);
        for (const tab of ['inbox', 'sessions'] as const) {
            await renderer.act(async () => {
                tabState.activeTab = tab;
                for (const listener of [...tabState.listeners]) listener();
            });
        }
        commits = 0;
        for (let value = 1; value <= 3; value++) {
            await renderer.act(async () => { inboxStore.set(value); });
        }
        expect(commits).toBe(0);
        await renderer.act(async () => {
            tabState.activeTab = 'inbox';
            for (const listener of [...tabState.listeners]) listener();
        });
        expect(tabMounts.inbox).toBe(1);
    });
});
