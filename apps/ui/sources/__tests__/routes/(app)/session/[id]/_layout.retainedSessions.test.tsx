import * as React from 'react';
import { act } from 'react-test-renderer';
import { BaseNavigationContainer, CommonActions, createNavigationContainerRef, createNavigatorFactory, StackRouter, useNavigationBuilder, useRoute } from '@react-navigation/core';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionRouteHomesFixture, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

// A phone's native stack: the one Session screen keeps its route key while another Session opens in it
// (Expo's singular navigation moves the route's params). The real layout and index route run under a real
// React Navigation stack; Expo's Slot renders the index route, as Expo does for the Session view leaf.
installSessionRouteCommonModuleMocks({
    reactNative: async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }),
    text: async () => vi.importActual('@/text'),
    modal: async () => vi.importActual('@/modal'),
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        const core = await vi.importActual<typeof import('@react-navigation/core')>('@react-navigation/core');
        return { ...createReactNavigationNativeMock(), NavigationContext: core.NavigationContext, useIsFocused: core.useIsFocused,
            useRoute: core.useRoute, useNavigationState: core.useNavigationState };
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return { ...createExpoRouterMock().module,
            useLocalSearchParams: () => useRoute().params ?? {},
            usePathname: () => `/session/${String((useRoute().params as { id?: string } | undefined)?.id)}`,
            useRouter: () => ({ replace: () => {} }),
            Slot: () => React.createElement(sessionRoute.Index!),
        };
    },
});

// The Session view needs the whole sync runtime; this route contract is about which Session views the screen
// mounts and keeps, so the body is a probe that reads its own destination params and visibility.
const bodies = vi.hoisted(() => ({ mounts: [] as string[], visibleBy: new Map<string, boolean>() }));
vi.mock('@/components/sessions/shell/SessionDestinationBody', async () => {
    const { useDestinationParams, useDestinationVisibility } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    return {
        SessionDestinationBody: function SessionBodyProbe() {
            const { id } = useDestinationParams<{ id?: string }>();
            const visible = useDestinationVisibility();
            React.useEffect(() => { bodies.mounts.push(String(id)); }, []);
            bodies.visibleBy.set(String(id), visible);
            return React.createElement('SessionBody', { id, visible });
        },
    };
});

const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
afterAll(() => network.dispose());
const sessionRoute = vi.hoisted(() => ({ Index: null as React.ComponentType | null }));
sessionRoute.Index = (await import('@/app/(app)/session/[id]/index')).default;
const Layout = (await import('@/app/(app)/session/[id]/_layout')).default;
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const homesFixture = createSessionRouteHomesFixture();
afterEach(() => { standardCleanup(); homesFixture.restore(); bodies.mounts = []; bodies.visibleBy.clear(); });

function Navigator(props: Readonly<{ children: React.ReactNode }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children: props.children });
    return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>;
}
const Root = createNavigatorFactory(Navigator)();

const tab = (id: string, sessionId: string) => ({ id, target: { kind: 'session', params: { id: sessionId, serverId: 'home-b' } }, pinned: false, preview: false });
/** The phone's workspace: it lists the open tabs, while the native stack presents them. */
const phoneWorkspace = {
    active: false,
    phone: { catalog: [], onTab: true, openHref: () => false, activateTab: () => {}, closeTab: () => {} },
    state: {
        v: 1 as const,
        tabs: { 'tab-1': tab('tab-1', 'session-1'), 'tab-2': tab('tab-2', 'session-2') },
        groups: { 'group:1': { id: 'group:1', tabIds: ['tab-1', 'tab-2'], activeTabId: 'tab-1', mru: ['tab-1', 'tab-2'] } },
        root: { id: 'group:1', kind: 'leaf' as const, leafKind: 'workspace-group' as const, payload: { groupId: 'group:1' } },
        focusedGroupId: 'group:1', maximizedGroupId: null, fallbackTitlesByTabId: {}, tabPairs: [], recentlyClosed: [],
    },
    canGoBack: false, canGoForward: false, openHref: () => false,
    activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
    navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
    registerBackStep: () => () => {}, back: () => {}, forward: () => {},
};

it('switching back to a recently opened Session on the phone stack mounts no Session view again', async () => {
    homesFixture.seed(['home-b']);
    const navigation = createNavigationContainerRef();
    await renderScreen(<InjectedAuthProvider credentials={null}><WorkspaceNavigationProvider value={phoneWorkspace}>
        <BaseNavigationContainer ref={navigation} initialState={{ routes: [{ name: 'Session', params: { id: 'session-1', serverId: 'home-b' } }] }}>
            <Root.Navigator><Root.Screen name="Session" component={Layout} /></Root.Navigator>
        </BaseNavigationContainer>
    </WorkspaceNavigationProvider></InjectedAuthProvider>);
    const open = async (sessionId: string) => {
        const route = navigation.getCurrentRoute()!;
        await act(async () => { navigation.dispatch({ ...CommonActions.setParams({ id: sessionId, serverId: 'home-b' }), source: route.key }); });
    };

    await open('session-2');
    await open('session-1');

    // Each Session view is built once; going back to session-1 shows its retained view, and session-2 stays
    // mounted but hidden, as a listed tab.
    expect({ mounts: bodies.mounts, visible: Object.fromEntries(bodies.visibleBy) })
        .toEqual({ mounts: ['session-1', 'session-2'], visible: { 'session-1': true, 'session-2': false } });
});
