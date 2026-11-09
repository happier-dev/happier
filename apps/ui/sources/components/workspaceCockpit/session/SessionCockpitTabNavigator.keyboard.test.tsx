import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { flushHookEffects, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { storage } from '@/sync/domains/state/storageStore';
import { sessionLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { replacePersistentUiStateForTest } from '@/dev/testkit/harness/persistentUiState';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { buildRealmQualifiedMobileSurfaceStorageKey } from '@/sync/domains/settings/mobileSurfacePersistence';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { switchConnectionToActiveServer } from '@/sync/runtime/orchestration/connectionManager';
import type { PluginUiSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import {
    resolveSessionCockpitMobileCatalog,
    resolveSessionCockpitMobileNavigatorSurfaces,
} from './sessionCockpitMobileCatalog';
import type { SessionMobileSurface } from './sessionCockpitState';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { SessionViewerDestinationScope } from '@/components/sessions/viewer/SessionViewerDestinationScope';
import { SessionViewerControllerProvider } from '@/components/sessions/viewer/SessionViewerControllerProvider';
import { useOptionalSessionViewerController, type SessionViewerController } from '@/components/sessions/viewer/SessionViewerController';

const navigatorState = vi.hoisted(() => ({
    screenOptions: null as null | Record<string, unknown>,
    backBehavior: null as string | null,
    navigationContainerLinking: null as null | Record<string, unknown>,
    navigationContainerTheme: null as null | { dark?: boolean },
    navigationContainerOnStateChange: null as null | ((state: {
        index: number;
        routes: Array<{ key: string; name: string }>;
    }) => void),
    goBack: null as null | (() => void),
    registeredChrome: null as null | {
        activeSurface: string;
        switchSurface: (surface: SessionMobileSurface) => void;
    },
    navigationContainerRenderCount: 0,
    persistedSurfaces: [] as Array<Readonly<{ sessionId: string; surface: string }>>,
    persistedSurfaceRealms: [] as Array<Readonly<{
        sessionId: string;
        surface: string;
        serverId: string | null | undefined;
    }>>,
    persistedSurfaceAccountRealms: [] as Array<Readonly<{
        sessionId: string;
        surface: string;
        accountId: string | null;
    }>>,
    pluginProjection: null as null | Record<string, unknown>,
    boardOwnerRenderIdentities: [] as symbol[],
    boardOwnerProps: [] as Array<Readonly<{ sessionId: string; serverId?: string | null }>>,
    boardOwnerPluginRuntimes: [] as object[],
    canonicalPluginRuntime: null as object | null,
    canonicalPluginRuntimeAddresses: [] as Array<Readonly<{ serverId: string; sessionId: string }> | null>,
    activeBoardOwnerObservations: [] as Array<Readonly<{
        surface: string;
        controller: object;
        drafts: Map<string, string>;
        snapshot: object;
    }>>,
    activeRouteName: 'chat',
    sideActions: null as null | { current: null | { tabs: readonly string[]; selectTab: (tab: string) => void } },
}));

const BoardOwnerContext = React.createContext<Readonly<{
    controller: object;
    drafts: Map<string, string>;
    snapshot: object;
}> | null>(null);

const BottomTabNavigationContext = React.createContext<{
    navigate: (name: string) => void;
}>({ navigate: () => {} });

const navigationFocusState = vi.hoisted(() => {
    let focused = true;
    const listeners = new Set<() => void>();

    return {
        getSnapshot: () => focused,
        setFocused: (nextFocused: boolean) => {
            focused = nextFocused;
            for (const listener of listeners) {
                listener();
            }
        },
        subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
});

const initialStorageState = storage.getState();
let stopObservingPersistence: (() => void) | null = null;

function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, { wrapper: ({ children }: React.PropsWithChildren) => <AppPaneProvider>{children}</AppPaneProvider> });
}

async function activatePersistenceRealm(serverId: string, accountId: string) {
    const server = await upsertServerProfile({ serverUrl: `https://${serverId}`, name: serverId });
    if (server.id !== serverId) throw new Error('Navigator fixture requires its exact Home profile');
    await setActiveServerId(server.id);
    await switchConnectionToActiveServer();
    storage.setState({ profileScope: { serverId, accountId } });
}

async function primeBoardFeature(enabled: boolean) {
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
    const { tryWriteServerEnabledBitInPlace} = await import('@happier-dev/protocol/features/serverEnabledBit');
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.board', enabled)) {
        throw new Error('The sessions.board bit could not be written by its own writer');
    }
    primeServerFeaturesSnapshot({ serverId: 'server-session', snapshot: { status: 'ready', features } });
}

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return {
        ...createReactNavigationNativeMock(),
        NavigationContainer: ({
            children,
            linking,
            onStateChange,
            theme,
        }: {
            children?: React.ReactNode;
            linking?: Record<string, unknown>;
            theme?: { dark?: boolean };
            onStateChange?: (state: { index: number; routes: Array<{ key: string; name: string }> }) => void;
        }) => {
            navigatorState.navigationContainerRenderCount += 1;
            navigatorState.navigationContainerLinking = linking ?? null;
            navigatorState.navigationContainerTheme = theme ?? null;
            navigatorState.navigationContainerOnStateChange = onStateChange ?? null;
            return React.createElement('NavigationContainer', { linking, onStateChange }, children);
        },
        NavigationIndependentTree: ({ children }: { children?: React.ReactNode }) =>
            React.createElement('NavigationIndependentTree', null, children),
        useIsFocused: () => React.useSyncExternalStore(
            navigationFocusState.subscribe,
            navigationFocusState.getSnapshot,
            navigationFocusState.getSnapshot,
        ),
    };
});

// The cockpit's navigator is the library's tab navigator plus its hosted Chat scene; this harness drives the
// library fake below for both.
vi.mock('./sessionCockpitTabs', async () => ({
    createSessionCockpitTabNavigator: (await import('@react-navigation/bottom-tabs')).createBottomTabNavigator,
}));

vi.mock('@react-navigation/bottom-tabs', () => ({
    createBottomTabNavigator: () => ({
        Navigator: ({ children, initialRouteName, backBehavior, screenOptions, tabBar }: {
            children?: React.ReactNode;
            initialRouteName?: string;
            backBehavior?: string;
            screenOptions?: Record<string, unknown>;
            tabBar?: (props: {
                state: { index: number; routes: Array<{ key: string; name: string }>; history: Array<{ type: 'route'; key: string }> };
                navigation: {
                    emit: () => { defaultPrevented: boolean };
                    navigate: (name: string) => void;
                    reset: (state: { index: number; routes: Array<{ key: string; name: string }>; history?: Array<{ type: 'route'; key: string }> }) => void;
                };
            }) => React.ReactNode;
        }) => {
            navigatorState.backBehavior = backBehavior ?? null;
            navigatorState.screenOptions = screenOptions ?? null;
            const routes = React.Children.toArray(children)
                .filter(React.isValidElement)
                .map((child) => String((child.props as { name: string }).name))
                .map((name) => ({ key: name, name }));
            const routeNamesKey = routes.map((route) => route.name).join('\u0000');
            const initialName = typeof initialRouteName === 'string'
                && routes.some((route) => route.name === initialRouteName)
                ? initialRouteName
                : routes[0]?.name ?? 'chat';
            const [activeName, setActiveName] = React.useState(initialName);
            const historyRef = React.useRef<string[]>([initialName]);
            const emittedActiveNameRef = React.useRef(initialName);
            React.useEffect(() => {
                if (!routes.some((route) => route.name === activeName)) {
                    setActiveName(routes[0]?.name ?? 'chat');
                }
            }, [activeName, routeNamesKey, routes]);
            const activeIndex = Math.max(0, routes.findIndex((route) => route.name === activeName));
            const navigate = React.useCallback((name: string) => {
                if (!routes.some((route) => route.name === name)) return;
                setActiveName((current) => {
                    if (current === name) return current;
                    historyRef.current = [...historyRef.current, name];
                    return name;
                });
            }, [routeNamesKey]);
            const goBack = React.useCallback(() => {
                setActiveName((current) => {
                    if (historyRef.current.length <= 1) return current;
                    historyRef.current = historyRef.current.slice(0, -1);
                    return historyRef.current.at(-1) ?? current;
                });
            }, []);
            navigatorState.goBack = goBack;
            React.useEffect(() => {
                if (emittedActiveNameRef.current === activeName) {
                    return;
                }
                emittedActiveNameRef.current = activeName;
                navigatorState.navigationContainerOnStateChange?.({ index: activeIndex, routes });
            }, [activeIndex, activeName, routeNamesKey, routes]);
            navigatorState.activeRouteName = routes[activeIndex]?.name ?? 'chat';
            navigatorState.registeredChrome = navigatorState.registeredChrome
                ? { ...navigatorState.registeredChrome, activeSurface: routes[activeIndex]?.name ?? 'chat' }
                : navigatorState.registeredChrome;
            return React.createElement(
                BottomTabNavigationContext.Provider,
                { value: { navigate } },
                React.createElement('BottomTabNavigator', { screenOptions }, [
                    React.createElement(React.Fragment, { key: 'screens' }, children),
                    React.createElement(React.Fragment, { key: 'tab-bar' }, tabBar?.({
                        state: { index: activeIndex, routes, history: historyRef.current.map(key => ({ type: 'route' as const, key })) },
                        navigation: {
                            emit: () => ({ defaultPrevented: false }),
                            navigate,
                            reset: (state) => {
                                historyRef.current = (state.history ?? []).map(entry => (
                                    state.routes.find(route => route.key === entry.key)?.name ?? 'chat'
                                ));
                                setActiveName(state.routes[state.index]?.name ?? 'chat');
                            },
                        },
                    })),
                ]),
            );
        },
        Screen: ({ children, name }: { children?: (props: { navigation: { navigate: (name: string) => void } }) => React.ReactNode; name: string }) => {
            const navigation = React.useContext(BottomTabNavigationContext);
            return (
            React.createElement('BottomTabScreen', { name }, typeof children === 'function'
                ? children({ navigation })
                : children)
            );
        },
    }),
}));

vi.mock('./SessionCockpitSurfaceScreen', async () => {
    const { useSessionCockpitSurfaceNavigation } = await import('./SessionCockpitSurfaceNavigation');
    const { RightSidebarActionsContext } = await import('@/components/appShell/rightSidebar/rightSidebarActions');
    return {
    SessionCockpitSurfaceScreen: (props: Record<string, unknown>) => {
        const navigation = useSessionCockpitSurfaceNavigation();
        const sideActions = React.useContext(RightSidebarActionsContext);
        if (String(props.surface ?? '') === navigatorState.activeRouteName) navigatorState.sideActions = sideActions;
        const owner = React.useContext(BoardOwnerContext);
        const surface = String(props.surface ?? '');
        if (navigation && surface === navigatorState.activeRouteName) {
            navigatorState.registeredChrome = { activeSurface: surface, switchSurface: navigation.switchSurface };
        }
        if (owner && surface === navigatorState.activeRouteName) {
            navigatorState.activeBoardOwnerObservations.push({ surface, ...owner });
        }
        return React.createElement('SessionCockpitSurfaceScreen', props);
    },
    };
});

vi.mock('@/components/sessions/board/SessionBoardControllerProvider', () => ({
    SessionBoardControllerProvider: ({
        children,
        sessionId,
        serverId,
        pluginRuntime,
    }: React.PropsWithChildren<Readonly<{
        sessionId: string;
        serverId?: string | null;
        pluginRuntime?: object;
    }>>) => {
        const identity = React.useRef(Symbol('session-board-shell-owner')).current;
        const owner = React.useRef(Object.freeze({
            controller: {},
            drafts: new Map<string, string>(),
            snapshot: {},
        })).current;
        navigatorState.boardOwnerRenderIdentities.push(identity);
        navigatorState.boardOwnerProps.push({ sessionId, serverId });
        if (pluginRuntime) navigatorState.boardOwnerPluginRuntimes.push(pluginRuntime);
        return React.createElement(
            BoardOwnerContext.Provider,
            { value: owner },
            React.createElement('SessionBoardControllerProvider', { sessionId, serverId }, children),
        );
    },
}));

vi.mock('@/components/sessions/plugins/useSessionPluginRuntime', () => ({
    useSessionPluginRuntime: ({ address }: { address: { serverId: string; sessionId: string } | null }) => {
        navigatorState.canonicalPluginRuntimeAddresses.push(address);
        const runtime = Object.freeze({
            pluginUiProjection: navigatorState.pluginProjection,
            pluginBrowserProjection: null,
            phase: navigatorState.pluginProjection ? 'ready' : 'loading',
            interactionEnabled: Boolean(navigatorState.pluginProjection),
            machineId: address ? 'machine-session' : null,
            serverId: address?.serverId ?? null,
            platform: 'web',
        });
        navigatorState.canonicalPluginRuntime = runtime;
        return runtime;
    },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (_sessionId: string, fallbackServerId?: string | null) =>
        fallbackServerId ?? 'server-session',
}));

const REVIEW_PLUGIN_ID = 'acme.review';

function createPluginProjection() {
    const binding = normalizePluginUiDestinationBindingV1({
        pluginId: REVIEW_PLUGIN_ID,
        destinationId: 'review-panel',
        rendererId: 'review-panel',
        container: 'rightSidebarTab',
        target: { kind: 'session', sessionIdPath: '/session/id' },
    });
    if (!binding) {
        throw new Error('test fixture must use an admitted V2 destination binding');
    }
    const placement = {
        id: `surfacePlacement:${REVIEW_PLUGIN_ID}:review-panel`,
        pluginId: REVIEW_PLUGIN_ID,
        occurrenceId: 'acme-review-occurrence',
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        binding,
        target: binding.target,
        renderer: { kind: 'host', rendererId: 'review.panel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        headerActions: [],
    } satisfies PluginUiSurfacePlacementProjection;
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        unknownEntriesById: Object.freeze({}),
    });
}

function createSettledEmptyPluginProjection() {
    const projection = createPluginProjection();
    return Object.freeze({
        ...projection,
        generation: 5,
        surfacePlacementsById: Object.freeze({}),
    });
}

describe('SessionCockpitTabNavigator keyboard behavior', () => {
    it.each([true, false])('lands on Chat only when the destination viewer is presented at phone cockpit mount (%s)', async (presented) => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const home = getServerProfileById('server-session');
        if (!home) throw new Error('Navigator fixture Home is missing');
        await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
            token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-a' })).toString('base64url')}.signature`,
        });
        const observed: { viewer: SessionViewerController | null } = { viewer: null };
        function ViewerProbe() { observed.viewer = useOptionalSessionViewerController(); return null; }
        function Tree(props: Readonly<{ cockpit: boolean }>) {
            return <SessionViewerDestinationScope sessionId="s1" serverId={home!.id}>
                <SessionViewerControllerProvider sessionId="s1" serverId={home!.id} phone canPresentSource={() => true} openDocked={() => {}}>
                    <ViewerProbe />
                </SessionViewerControllerProvider>
                {props.cockpit ? <SessionCockpitTabNavigator initialSurface="browser" routeServerId={home!.id}
                    scopeId="session:s1" sessionId="s1" terminalTabAvailable /> : null}
            </SessionViewerDestinationScope>;
        }
        const screen = await renderScreen(<Tree cockpit={false} />);
        try {
            if (presented) await act(async () => { observed.viewer!.port.apply({ kind: 'viewer.open', source: 'computer' }); });
            await screen.update(<Tree cockpit />);
            expect(navigatorState.activeRouteName).toBe(presented ? 'chat' : 'browser');
            // Later presentation changes must not route the person away from their chosen surface.
            await act(async () => { observed.viewer!.port.apply(presented ? { kind: 'viewer.close' } : { kind: 'viewer.open', source: 'computer' }); });
            expect(navigatorState.activeRouteName).toBe(presented ? 'chat' : 'browser');
        } finally {
            await screen.unmount();
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        }
    });

    afterEach(() => {
        standardCleanup();
        stopObservingPersistence?.();
        stopObservingPersistence = null;
        storage.setState(initialStorageState);
    });

    beforeEach(async () => {
        standardCleanup();
        stopObservingPersistence?.();
        await loadSyncSingletonForTests();
        storage.setState({
            ...initialStorageState,
            localSettings: { ...localSettingsDefaults },
            sessionListIndexByServerId: {
                'server-session': [{ type: 'session', sessionId: 's1', serverId: 'server-session', serverName: 'Test Home' }],
            },
        });
        await activatePersistenceRealm('server-session', 'account-a');
        await primeBoardFeature(false);
        replacePersistentUiStateForTest(sessionLastMobileSurfaceState, {});
        let previousSurfaces = sessionLastMobileSurfaceState.readAll();
        stopObservingPersistence = sessionLastMobileSurfaceState.subscribe(() => {
            const previous = previousSurfaces;
            previousSurfaces = sessionLastMobileSurfaceState.readAll();
            const scope = storage.getState().profileScope;
            if (!scope) return;
            const key = buildRealmQualifiedMobileSurfaceStorageKey('session', scope, 's1');
            if (!key) return;
            const surface = sessionLastMobileSurfaceState.read(key);
            if (!surface || surface === previous[key]) return;
            navigatorState.persistedSurfaces.push({ sessionId: 's1', surface });
            navigatorState.persistedSurfaceRealms.push({ sessionId: 's1', surface, serverId: scope.serverId });
            navigatorState.persistedSurfaceAccountRealms.push({ sessionId: 's1', surface, accountId: scope.accountId });
        });
        navigatorState.backBehavior = null;
        navigatorState.navigationContainerOnStateChange = null;
        navigatorState.goBack = null;
        navigatorState.registeredChrome = null;
        navigatorState.navigationContainerRenderCount = 0;
        navigatorState.persistedSurfaces = [];
        navigatorState.persistedSurfaceRealms = [];
        navigatorState.persistedSurfaceAccountRealms = [];
        navigatorState.pluginProjection = null;
        navigatorState.boardOwnerRenderIdentities = [];
        navigatorState.boardOwnerProps = [];
        navigatorState.boardOwnerPluginRuntimes = [];
        navigatorState.canonicalPluginRuntime = null;
        navigatorState.canonicalPluginRuntimeAddresses = [];
        navigatorState.activeBoardOwnerObservations = [];
        navigatorState.activeRouteName = 'chat';
        navigatorState.sideActions = null;
        navigationFocusState.setFocused(true);
    });

    it('keeps the hidden tab navigator bridge independent from URL linking and keyboard suppression', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        expect(navigatorState.navigationContainerLinking).toEqual({ enabled: false, prefixes: [] });
        expect(navigatorState.backBehavior).toBe('history');
        expect(navigatorState.screenOptions?.tabBarHideOnKeyboard).toBe(false);
    });

    it('retains surface commands when only transcript presentation changes', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const screen = await renderScreen(<SessionCockpitTabNavigator initialSurface="chat" scopeId="session:s1" sessionId="s1" terminalTabAvailable />);
        const before = navigatorState.registeredChrome?.switchSurface;
        expect(before).toBeTypeOf('function');
        await screen.update(<SessionCockpitTabNavigator initialSurface="chat" scopeId="session:s1" sessionId="s1" terminalTabAvailable jumpToSeq={1} />);
        expect(navigatorState.registeredChrome?.switchSurface).toBe(before);
        await act(async () => { navigatorState.registeredChrome?.switchSurface('browser'); });
        expect(navigatorState.activeRouteName).toBe('browser');
    });

    it('paints its scenes with the app navigation theme instead of the nested container default', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const { DarkTheme, ThemeProvider } = await import('@react-navigation/native');

        await renderScreen(
            <ThemeProvider value={DarkTheme}>
                <SessionCockpitTabNavigator
                    initialSurface="chat"
                    scopeId="session:s1"
                    sessionId="s1"
                    terminalTabAvailable
                />
            </ThemeProvider>,
        );

        expect(navigatorState.navigationContainerTheme).toBe(DarkTheme);
    });

    it('passes the canonical exact-address plugin runtime to the shared Board owner', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        expect(navigatorState.boardOwnerPluginRuntimes.at(-1))
            .toBe(navigatorState.canonicalPluginRuntime);
    });

    it('keeps nested navigation container and navigator options stable across rerenders', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = (terminalTabAvailable: boolean) => (
            <SessionCockpitTabNavigator
                initialSurface="chat"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={terminalTabAvailable}
            />
        );

        const screen = await renderScreen(renderNavigator(true));
        const firstLinking = navigatorState.navigationContainerLinking;
        const firstScreenOptions = navigatorState.screenOptions;

        await screen.update(renderNavigator(false));

        expect(navigatorState.navigationContainerLinking).toBe(firstLinking);
        expect(navigatorState.screenOptions).toBe(firstScreenOptions);
    });

    it('persists tab switches without subscribing the navigator to the whole persisted surface map', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'git' }]);
        const rendersAfterSwitch = navigatorState.navigationContainerRenderCount;
        await act(async () => {
            sessionLastMobileSurfaceState.set('unrelated', 'browser');
        });
        expect(navigatorState.navigationContainerRenderCount).toBe(rendersAfterSwitch);
    });

    it('keeps one exact-Session Board controller, drafts, and snapshot through Chat → Board → Companion → Board', async () => {
        await primeBoardFeature(true);
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );
        const initialOwner = navigatorState.boardOwnerRenderIdentities.at(-1);

        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('board');
        });
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('companion');
        });
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('board');
        });

        expect(new Set(navigatorState.boardOwnerRenderIdentities)).toEqual(new Set([initialOwner]));
        expect(navigatorState.boardOwnerProps.at(-1)).toEqual({
            sessionId: 's1',
            serverId: 'server-session',
        });
        const observations = navigatorState.activeBoardOwnerObservations
            .filter((observation) => ['chat', 'board', 'companion'].includes(observation.surface));
        expect(observations.map((observation) => observation.surface)).toEqual(expect.arrayContaining([
            'chat',
            'board',
            'companion',
        ]));
        const first = observations[0];
        expect(first).toBeDefined();
        expect(observations.every((observation) => observation.controller === first?.controller)).toBe(true);
        expect(observations.every((observation) => observation.drafts === first?.drafts)).toBe(true);
        expect(observations.every((observation) => observation.snapshot === first?.snapshot)).toBe(true);
    });

    it('does not dedupe the same surface across a new session persistence realm', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = (routeServerId: string) => (
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId={routeServerId}
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />
        );

        await activatePersistenceRealm('server-one', 'account-a');
        const screen = await renderScreen(renderNavigator('server-one'));
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        await act(async () => {
            await activatePersistenceRealm('server-two', 'account-a');
        });
        await screen.update(renderNavigator('server-two'));
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        expect(navigatorState.persistedSurfaceRealms).toEqual([
            { sessionId: 's1', surface: 'git', serverId: 'server-one' },
            { sessionId: 's1', surface: 'git', serverId: 'server-two' },
        ]);
    });

    it('does not dedupe a same-surface switch after the active Account realm changes', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = () => (
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />
        );

        await renderScreen(renderNavigator());
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        await act(async () => {
            storage.setState({ profileScope: { serverId: 'server-session', accountId: 'account-b' } });
        });
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        expect(navigatorState.persistedSurfaceAccountRealms).toEqual([
            { sessionId: 's1', surface: 'git', accountId: 'account-a' },
            { sessionId: 's1', surface: 'git', accountId: 'account-b' },
        ]);
    });

    it('does not carry a retained plugin screen into a replacement Account realm', async () => {
        navigatorState.pluginProjection = createPluginProjection();
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const pluginSurface = `plugin:${REVIEW_PLUGIN_ID}:review-panel` as const;
        const renderNavigator = (initialSurface: SessionMobileSurface) => (
            <SessionCockpitTabNavigator
                initialSurface={initialSurface}
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />
        );

        const screen = await renderScreen(renderNavigator(pluginSurface));
        expect(screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name)).toContain(pluginSurface);

        navigatorState.pluginProjection = createSettledEmptyPluginProjection();
        await act(async () => {
            storage.setState({ profileScope: { serverId: 'server-session', accountId: 'account-b' } });
        });
        await screen.update(renderNavigator('chat'));

        expect(screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name)).not.toContain(pluginSurface);
        expect(navigatorState.activeRouteName).toBe('chat');
    });

    it('retries a same-surface switch when the Account realm becomes resolved', async () => {
        storage.setState({ profileScope: null });
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = () => (
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />
        );

        await renderScreen(renderNavigator());
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });
        expect(navigatorState.persistedSurfaceAccountRealms).toEqual([]);
        await act(async () => {
            storage.setState({ profileScope: { serverId: 'server-session', accountId: 'account-a' } });
        });
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        expect(navigatorState.persistedSurfaceAccountRealms).toEqual([
            { sessionId: 's1', surface: 'git', accountId: 'account-a' },
        ]);
    });

    it('commits an actual history Back transition to the active surface and qualified persistence owner', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });
        expect(navigatorState.activeRouteName).toBe('git');

        await act(async () => {
            navigatorState.goBack?.();
        });

        expect(navigatorState.activeRouteName).toBe('chat');
        expect(navigatorState.registeredChrome?.activeSurface).toBe('chat');
        expect(navigatorState.persistedSurfaces).toEqual([
            { sessionId: 's1', surface: 'git' },
            { sessionId: 's1', surface: 'chat' },
        ]);
    });

    it('restores the phone surface and Back history after classic temporarily presents Chat', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const body = (experience: 'classic' | 'cockpit') => <SessionCockpitTabNavigator
            experience={experience} initialSurface="chat" routeServerId="server-session"
            scopeId="session:s1" sessionId="s1" terminalTabAvailable />;
        const screen = await renderScreen(body('cockpit'));
        await act(async () => { navigatorState.registeredChrome?.switchSurface('browse'); });
        await act(async () => { navigatorState.registeredChrome?.switchSurface('git'); });
        expect(navigatorState.activeRouteName).toBe('git');
        const persisted = [...navigatorState.persistedSurfaces];
        await screen.update(body('classic'));
        expect(navigatorState.activeRouteName).toBe('chat');
        expect(navigatorState.persistedSurfaces).toEqual(persisted);
        await screen.update(body('cockpit'));
        expect(navigatorState.activeRouteName).toBe('git');
        await act(async () => { navigatorState.goBack?.(); });
        expect(navigatorState.activeRouteName).toBe('browse');
        expect(navigatorState.persistedSurfaces.at(-1)).toEqual({ sessionId: 's1', surface: 'browse' });
    });

    it.each([
        { startOnPhone: false, closeDetails: false },
        { startOnPhone: true, closeDetails: false },
        { startOnPhone: true, closeDetails: true },
    ])('presents open Details ahead of retained Skills when returning to phone ($startOnPhone, closed=$closeDetails)', async ({ startOnPhone, closeDetails }) => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        const { createBotTemplateEditorDetailsTab } = await import('@/components/sessions/bots/templates/botTemplateEditorDestination');
        let pane!: ReturnType<typeof useAppPaneScope>;
        function PaneProbe() { pane = useAppPaneScope('session:s1'); return null; }
        const body = (experience: 'classic' | 'cockpit') => <>
            <PaneProbe />
            <SessionCockpitTabNavigator experience={experience} initialSurface="skills" routeServerId="server-session"
                scopeId="session:s1" sessionId="s1" terminalTabAvailable />
        </>;
        const screen = await renderScreen(body(startOnPhone ? 'cockpit' : 'classic'));
        if (startOnPhone) {
            expect(navigatorState.activeRouteName).toBe('skills');
            await screen.update(body('classic'));
        }
        await act(async () => {
            pane.openRight({ tabId: 'skills' });
            pane.openDetailsTab(createBotTemplateEditorDetailsTab({ serverId: 'server-session', artifactId: 'draft-b' }),
                { start: true, intent: 'pinned' });
            if (closeDetails) pane.closeDetails();
        });
        expect(pane.scopeState?.right.activeTabId).toBe('skills');
        expect(pane.scopeState?.details.isOpen).toBe(!closeDetails);
        await screen.update(body('cockpit'));
        expect(navigatorState.activeRouteName).toBe(closeDetails ? 'skills' : 'tabs');
    });

    it('follows the selected nested navigation route rather than a stale parent route', async () => {
        const { resolveSessionCockpitSurfaceFromNavigationState } = await import('./SessionCockpitTabNavigator');

        expect(resolveSessionCockpitSurfaceFromNavigationState({
            index: 0,
            routes: [{
                key: 'cockpit',
                name: 'session-cockpit',
                state: {
                    index: 1,
                    routes: [
                        { key: 'chat', name: 'chat' },
                        { key: 'git', name: 'git' },
                    ],
                },
            }],
        })).toBe('git');
    });

    it('registers Navigation, Browser and Services as ordinary mobile cockpit screens', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        const screen = await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="services"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );

        const screens = screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name);
        expect(screens).toEqual(expect.arrayContaining(['navigation', 'browser', 'services', 'companion', 'agents']));
        expect(screens).not.toContain('board');
        expect(screens).not.toContain('terminal');

        for (const surface of ['navigation', 'browser', 'services'] as const) {
            await act(async () => {
                navigatorState.registeredChrome?.switchSurface(surface);
            });
            expect(navigatorState.activeRouteName).toBe(surface);
            expect(navigatorState.registeredChrome?.activeSurface).toBe(surface);
        }

        expect(navigatorState.persistedSurfaces).toEqual([
            { sessionId: 's1', surface: 'navigation' },
            { sessionId: 's1', surface: 'browser' },
            { sessionId: 's1', surface: 'services' },
        ]);
    });

    it('gives a phone scene the Session chooser, so an ended preview\'s Go to Services opens the Services scene', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="browser"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );

        expect(navigatorState.activeRouteName).toBe('browser');
        // Read at render by the Browser card (it decides whether Go to Services is offered).
        expect(navigatorState.sideActions?.current?.tabs).toContain('services');
        await act(async () => {
            navigatorState.sideActions?.current?.selectTab('services');
        });
        expect(navigatorState.activeRouteName).toBe('services');
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'services' }]);
    });

    it('registers validated plugin right-sidebar mobile tabs as host-owned screens', async () => {
        const pluginProjection = createPluginProjection();
        navigatorState.pluginProjection = pluginProjection;
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        const screen = await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="chat"
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );

        expect(
            screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name),
        ).toContain(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        await act(async () => {
            navigatorState.registeredChrome?.switchSurface(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        });

        expect(navigatorState.activeRouteName).toBe(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        expect(navigatorState.registeredChrome?.activeSurface).toBe(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: `plugin:${REVIEW_PLUGIN_ID}:review-panel` }]);
    });

    it('registers the navigator from the same canonical catalog and only appends a screen-retained tombstone', async () => {
        const pluginProjection = createPluginProjection();
        navigatorState.pluginProjection = pluginProjection;
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const screen = await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface={`plugin:${REVIEW_PLUGIN_ID}:review-panel`}
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );

        const catalog = resolveSessionCockpitMobileCatalog({
            terminalTabAvailable: false,
            pluginPlacements: Object.values(pluginProjection.surfacePlacementsById),
        });
        expect(
            screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name),
        ).toEqual(resolveSessionCockpitMobileNavigatorSurfaces({
            catalog,
            retainedPluginSurface: `plugin:${REVIEW_PLUGIN_ID}:review-panel`,
        }));
    });

    it('restores a requested plugin mobile surface after the plugin projection loads', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = (projectionLoaded = false) => (
            <SessionCockpitTabNavigator
                initialSurface={`plugin:${REVIEW_PLUGIN_ID}:review-panel`}
                routeServerId={projectionLoaded ? 'server-session' : undefined}
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />
        );

        const screen = await renderScreen(renderNavigator());

        expect(navigatorState.registeredChrome?.activeSurface).toBe('chat');

        navigatorState.pluginProjection = createPluginProjection();
        await screen.update(renderNavigator(true));
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(navigatorState.registeredChrome?.activeSurface).toBe(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: `plugin:${REVIEW_PLUGIN_ID}:review-panel` }]);
    });

    it('retains the selected qualified plugin route as a tombstone after its projection disappears', async () => {
        navigatorState.pluginProjection = createPluginProjection();
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = () => (
            <SessionCockpitTabNavigator
                initialSurface={`plugin:${REVIEW_PLUGIN_ID}:review-panel`}
                routeServerId="server-session"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />
        );
        const screen = await renderScreen(renderNavigator());

        navigatorState.pluginProjection = null;
        await screen.update(renderNavigator());

        expect(
            screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name),
        ).toContain(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        expect(navigatorState.activeRouteName).toBe(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
    });

    it('restores a persisted plugin route as its tombstone when a settled projection no longer contains it', async () => {
        navigatorState.pluginProjection = createSettledEmptyPluginProjection();
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        const screen = await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface={`plugin:${REVIEW_PLUGIN_ID}:review-panel`}
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );
        await flushHookEffects({ cycles: 3, turns: 2 });

        expect(
            screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name),
        ).toContain(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
        expect(navigatorState.activeRouteName).toBe(`plugin:${REVIEW_PLUGIN_ID}:review-panel`);
    });

    it('keeps a retained inactive chat scene mounted while excluding its descendants, then restores activity on focus', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
        navigationFocusState.setFocused(false);

        try {
            const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
            const screen = await renderScreen(
                <SessionCockpitTabNavigator
                    initialSurface="chat"
                    scopeId="session:s1"
                    sessionId="s1"
                    terminalTabAvailable={false}
                />,
            );

            const inactiveChatScene = screen.findByTestId('session-cockpit-scene:chat');
            expect(inactiveChatScene).not.toBeNull();
            expect(screen.findAllByType('SessionCockpitSurfaceScreen').filter((node) => node.props.surface === 'chat')).toHaveLength(1);
            expect(inactiveChatScene?.props).toEqual(expect.objectContaining({
                inert: true,
                'aria-hidden': true,
                pointerEvents: 'none',
            }));

            await act(async () => {
                navigationFocusState.setFocused(true);
            });
            expect(screen.findByTestId('session-cockpit-scene:chat')?.props).toEqual(expect.objectContaining({
                inert: undefined,
                'aria-hidden': undefined,
                pointerEvents: 'auto',
            }));
            expect(screen.findAllByType('SessionCockpitSurfaceScreen').filter((node) => node.props.surface === 'chat')).toHaveLength(1);
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });

    it('hides inactive native scene descendants from accessibility and pointer interaction', async () => {
        const { Platform } = await import('react-native');
        const originalPlatform = Platform.OS;
        Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' });
        navigationFocusState.setFocused(false);

        try {
            const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
            const screen = await renderScreen(
                <SessionCockpitTabNavigator
                    initialSurface="chat"
                    scopeId="session:s1"
                    sessionId="s1"
                    terminalTabAvailable={false}
                />,
            );

            expect(screen.findByTestId('session-cockpit-scene:chat')?.props).toEqual(expect.objectContaining({
                inert: undefined,
                'aria-hidden': undefined,
                accessibilityElementsHidden: true,
                importantForAccessibility: 'no-hide-descendants',
                pointerEvents: 'none',
            }));

            await act(async () => {
                navigationFocusState.setFocused(true);
            });
            expect(screen.findByTestId('session-cockpit-scene:chat')?.props).toEqual(expect.objectContaining({
                accessibilityElementsHidden: false,
                importantForAccessibility: 'auto',
                pointerEvents: 'auto',
            }));
        } finally {
            Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
        }
    });
});
