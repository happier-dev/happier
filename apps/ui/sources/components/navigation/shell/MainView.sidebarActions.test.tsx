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
const sessionListHookState = vi.hoisted(() => ({
    useVisibleSessionListViewDataCalls: 0,
    useVisibleSessionListPaneStateCalls: 0,
    useHasHiddenInactiveSessionsCalls: 0,
    visibleSessionListViewDataOptions: [] as Array<{
        activeSessionId?: string | null;
        sessionListSurfaceDataActive?: boolean;
    } | undefined>,
    visibleSessionListPaneStateOptions: [] as Array<{
        activeSessionId?: string | null;
        sessionListSurfaceDataActive?: boolean;
    } | undefined>,
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
const routerState = vi.hoisted(() => ({
    pathname: '/',
    listeners: new Set<() => void>(),
}));
const tabState = vi.hoisted(() => ({
    activeTab: 'sessions' as 'sessions' | 'inbox' | 'friends' | 'settings',
    setActiveTab: vi.fn(async () => {}),
}));
const navigationFocusState = vi.hoisted(() => ({
    isFocused: true,
}));
const sessionsListWrapperLifecycleState = vi.hoisted(() => ({
    mounts: 0,
    unmounts: 0,
}));

installNavigationShellCommonModuleMocks({
    router: async () => {
        const ReactModule = await import('react');
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const expoRouterMock = createExpoRouterMock({
            router: { push: routerPushSpy, replace: routerReplaceSpy },
            pathname: () => routerState.pathname,
        });
        return {
            ...expoRouterMock.module,
            usePathname: () => ReactModule.useSyncExternalStore(
                (listener) => {
                    routerState.listeners.add(listener);
                    return () => {
                        routerState.listeners.delete(listener);
                    };
                },
                () => routerState.pathname,
                () => routerState.pathname,
            ),
        };
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
    useVisibleSessionListViewData: (_storageKind?: string, options?: {
        activeSessionId?: string | null;
        sessionListSurfaceDataActive?: boolean;
    }) => {
        sessionListHookState.useVisibleSessionListViewDataCalls += 1;
        sessionListHookState.visibleSessionListViewDataOptions.push(options);
        return sessionListState.data;
    },
    useHasHiddenInactiveSessions: () => {
        sessionListHookState.useHasHiddenInactiveSessionsCalls += 1;
        return emptyStateState.hasHiddenInactiveSessions;
    },
    useVisibleSessionListPaneState: (_storageKind?: string, options?: {
        activeSessionId?: string | null;
        sessionListSurfaceDataActive?: boolean;
    }) => {
        sessionListHookState.useVisibleSessionListPaneStateCalls += 1;
        sessionListHookState.visibleSessionListPaneStateOptions.push(options);
        return {
            sessionListViewData: sessionListState.data,
            visibleSessionCount: sessionListState.data?.reduce((count, item) => count + (item.type === 'session' ? 1 : 0), 0) ?? 0,
            hasHiddenInactiveSessions: emptyStateState.hasHiddenInactiveSessions,
        };
    },
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

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        useIsFocused: () => navigationFocusState.isFocused,
    };
});

vi.mock('@/components/sessions/guidance/SessionGettingStartedGuidance', () => ({
    SessionGettingStartedGuidance: 'SessionGettingStartedGuidance',
}));
vi.mock('@/components/sessions/guidance/HiddenInactiveSessionsEmptyState', () => ({
    HiddenInactiveSessionsEmptyState: 'HiddenInactiveSessionsEmptyState',
}));

vi.mock('@/components/sessions/shell/SessionsList', () => ({
    SessionsList: () => {
        sessionListHookState.useVisibleSessionListViewDataCalls += 1;
        return null;
    },
    SessionsListContent: 'SessionsListContent',
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

vi.mock('@/components/sessions/shell/SessionsListWrapper', async () => {
    const ReactModule = await import('react');
    const MockSessionsListWrapper = (props: Readonly<{ pathname?: string }>) => {
        ReactModule.useEffect(() => {
            sessionsListWrapperLifecycleState.mounts += 1;
            return () => {
                sessionsListWrapperLifecycleState.unmounts += 1;
            };
        }, []);
        return ReactModule.createElement('SessionsListWrapper', props);
    };
    return {
        SessionsListWrapper: MockSessionsListWrapper,
    };
});

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
        sessionListHookState.useVisibleSessionListViewDataCalls = 0;
        sessionListHookState.useVisibleSessionListPaneStateCalls = 0;
        sessionListHookState.useHasHiddenInactiveSessionsCalls = 0;
        sessionListHookState.visibleSessionListViewDataOptions = [];
        sessionListHookState.visibleSessionListPaneStateOptions = [];
        emptyStateState.hasHiddenInactiveSessions = false;
        directSessionsFeatureState.enabled = false;
        localSettingsState.sessionsListStorageTab = 'persisted';
        platformState.isTablet = true;
        routerState.pathname = '/';
        routerState.listeners.clear();
        navigationFocusState.isFocused = true;
        sessionsListWrapperLifecycleState.mounts = 0;
        sessionsListWrapperLifecycleState.unmounts = 0;
    });

    beforeAll(async () => {
        const mainViewModule = await import('./MainView');
        MainView = mainViewModule.MainView;
    }, 120_000);

    it('renders the wide start-new-session CTA in the sidebar instead of header action buttons', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        const fab = tree!.findByType('FABWide');
        fab.props.onPress({ nativeEvent: { ctrlKey: true } });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
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
        renderedHeaderRight.findByProps({ testID: 'main-header-start-new-session' }).props.onPress({ nativeEvent: { ctrlKey: true } });
        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                draftId: expect.any(String),
                draftOrigin: 'ordinary',
            },
        });
        expect(renderedHeaderRight.findAllByType('FABWide')).toHaveLength(0);
        expect(tree!.findAllByType('TabBar')).toHaveLength(0);
    });

    it('does not subscribe to sidebar session-list derivations in phone mode', async () => {
        platformState.isTablet = false;
        sessionListState.data = [{
            type: 'session',
            session: { id: 'session-1' },
        }];

        await renderScreen(<MainView variant="phone" />);

        expect(sessionListHookState.useVisibleSessionListViewDataCalls).toBe(0);
    });

    it('keeps the phone session list painted behind a foreground session route', async () => {
        platformState.isTablet = false;
        routerState.pathname = '/session/session-2';
        sessionListState.data = [{
            type: 'session',
            session: { id: 'session-2' },
        }];

        const screen = await renderScreen(<MainView variant="phone" />);

        expect(screen.tree.toJSON()).not.toBeNull();
    });

    it('preserves the mounted phone sessions list across session-detail route changes', async () => {
        platformState.isTablet = false;
        routerState.pathname = '/';

        const screen = await renderScreen(<MainView variant="phone" />);

        expect(sessionsListWrapperLifecycleState.mounts).toBe(1);
        expect(sessionsListWrapperLifecycleState.unmounts).toBe(0);
        expect(screen.tree.findByType('SessionsListWrapper').props.pathname).toBe('/');

        await React.act(async () => {
            routerState.pathname = '/session/session-2';
            for (const listener of Array.from(routerState.listeners)) {
                listener();
            }
        });

        expect(sessionsListWrapperLifecycleState.mounts).toBe(1);
        expect(sessionsListWrapperLifecycleState.unmounts).toBe(0);
        const wrappers = screen.tree.findAllByType('SessionsListWrapper');
        expect(wrappers).toHaveLength(1);
        expect(wrappers[0]?.props.pathname).toBe('/');
    });

    it('keeps the phone session list painted when its route is retained but unfocused', async () => {
        platformState.isTablet = false;
        navigationFocusState.isFocused = false;
        routerState.pathname = '/';
        sessionListState.data = [{
            type: 'session',
            session: { id: 'session-1' },
        }];

        const screen = await renderScreen(<MainView variant="phone" />);

        expect(screen.tree.toJSON()).not.toBeNull();
    });

    it('does not duplicate getting started guidance when primary pane is visible (home route)', async () => {
        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<MainView variant="sidebar" />)).tree;

        expect(() => tree!.findByType('SessionGettingStartedGuidance')).toThrow();
    });

    it('uses one sidebar pane-state owner instead of split list and hidden-state hooks', async () => {
        sessionListState.data = [{
            type: 'session',
            session: { id: 's-1' },
        }];

        const screen = await renderScreen(<MainView variant="sidebar" />);

        expect(sessionListHookState.useVisibleSessionListPaneStateCalls).toBe(1);
        expect(sessionListHookState.useVisibleSessionListViewDataCalls).toBe(0);
        expect(sessionListHookState.useHasHiddenInactiveSessionsCalls).toBe(0);
        const list = screen.tree.findByType('SessionsListContent');
        expect(list.props.data).toBe(sessionListState.data);
        expect(list.props.storageKind).toBe('persisted');
    });

    it('passes the active route session into the sidebar session list data hook', async () => {
        routerState.pathname = '/session/session-2';
        sessionListState.data = [{
            type: 'session',
            session: { id: 'session-2' },
        }];

        await renderScreen(<MainView variant="sidebar" />);

        expect(sessionListHookState.visibleSessionListPaneStateOptions).toEqual([
            { activeSessionId: 'session-2', sessionListSurfaceDataActive: true },
        ]);
    });

    it('keeps the sidebar sessions surface data-active while a foreground session route is open', async () => {
        routerState.pathname = '/session/session-2';
        sessionListState.data = [{
            type: 'session',
            session: { id: 'session-2' },
        }];

        const screen = await renderScreen(<MainView variant="sidebar" />);
        const list = screen.tree.findByType('SessionsListContent');

        expect(sessionListHookState.visibleSessionListPaneStateOptions).toEqual([
            { activeSessionId: 'session-2', sessionListSurfaceDataActive: true },
        ]);
        expect(list.props.surfaceOwnership).toMatchObject({
            ownerKey: 'sidebar',
            visible: true,
            interactive: true,
            dataActive: true,
        });
    });

    it('keeps the sidebar sessions surface visible but non-interactive behind the new-session modal route', async () => {
        routerState.pathname = '/new';
        sessionListState.data = [{
            type: 'session',
            session: { id: 'session-1' },
        }];

        const screen = await renderScreen(<MainView variant="sidebar" />);
        const list = screen.tree.findByType('SessionsListContent');

        expect(sessionListHookState.visibleSessionListPaneStateOptions).toEqual([
            { activeSessionId: null, sessionListSurfaceDataActive: true },
        ]);
        expect(list.props.surfaceOwnership).toMatchObject({
            ownerKey: 'sidebar',
            visible: true,
            interactive: false,
            dataActive: true,
        });
    });

    it('renders the sessions route directly without replaying stale settings tab state', async () => {
        platformState.isTablet = false;
        tabState.activeTab = 'settings';

        const screen = await renderScreen(<MainView variant="phone" />);
        const header = screen.tree.findByType('Header');
        const renderedHeaderRight = await renderScreen(header.props.headerRight());

        expect(tabState.setActiveTab).not.toHaveBeenCalled();
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
