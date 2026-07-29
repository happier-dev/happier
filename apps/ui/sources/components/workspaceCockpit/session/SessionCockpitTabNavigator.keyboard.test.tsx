import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';

const navigatorState = vi.hoisted(() => ({
    screenOptions: null as null | Record<string, unknown>,
    navigationContainerLinking: null as null | Record<string, unknown>,
    registeredChrome: null as null | {
        activeSurface: string;
        switchSurface: (surface: string) => void;
    },
    localSettingReads: [] as string[],
    persistedSurfaces: [] as Array<Readonly<{ sessionId: string; surface: string }>>,
    pluginProjection: null as null | Record<string, unknown>,
    scopedProjectionCalls: [] as Array<Readonly<{ machineId?: string | null; serverId?: string | null }>>,
    activeRouteName: 'chat',
}));

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

vi.mock('@react-navigation/native', () => ({
    NavigationContainer: ({ children, linking }: { children?: React.ReactNode; linking?: Record<string, unknown> }) => {
        navigatorState.navigationContainerLinking = linking ?? null;
        return React.createElement('NavigationContainer', { linking }, children);
    },
    NavigationIndependentTree: ({ children }: { children?: React.ReactNode }) =>
        React.createElement('NavigationIndependentTree', null, children),
    useIsFocused: () => React.useSyncExternalStore(
        navigationFocusState.subscribe,
        navigationFocusState.getSnapshot,
        navigationFocusState.getSnapshot,
    ),
}));

vi.mock('@react-navigation/bottom-tabs', () => ({
    createBottomTabNavigator: () => ({
        Navigator: ({ children, initialRouteName, screenOptions, tabBar }: {
            children?: React.ReactNode;
            initialRouteName?: string;
            screenOptions?: Record<string, unknown>;
            tabBar?: (props: {
                state: { index: number; routes: Array<{ key: string; name: string }> };
                navigation: {
                    emit: () => { defaultPrevented: boolean };
                    navigate: (name: string) => void;
                };
            }) => React.ReactNode;
        }) => {
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
            React.useEffect(() => {
                if (!routes.some((route) => route.name === activeName)) {
                    setActiveName(routes[0]?.name ?? 'chat');
                }
            }, [activeName, routeNamesKey, routes]);
            const activeIndex = Math.max(0, routes.findIndex((route) => route.name === activeName));
            navigatorState.activeRouteName = routes[activeIndex]?.name ?? 'chat';
            navigatorState.registeredChrome = navigatorState.registeredChrome
                ? { ...navigatorState.registeredChrome, activeSurface: routes[activeIndex]?.name ?? 'chat' }
                : navigatorState.registeredChrome;
            return React.createElement('BottomTabNavigator', { screenOptions }, [
                React.createElement(React.Fragment, { key: 'screens' }, children),
                React.createElement(React.Fragment, { key: 'tab-bar' }, tabBar?.({
                    state: { index: activeIndex, routes },
                    navigation: {
                        emit: () => ({ defaultPrevented: false }),
                        navigate: (name) => {
                            setActiveName(String(name));
                        },
                    },
                })),
            ]);
        },
        Screen: ({ children, name }: { children?: (props: { navigation: { navigate: (name: string) => void } }) => React.ReactNode; name: string }) =>
            React.createElement('BottomTabScreen', { name }, typeof children === 'function'
                ? children({ navigation: { navigate: () => {} } })
                : children),
    }),
}));

vi.mock('./SessionCockpitSurfaceScreen', () => ({
    SessionCockpitSurfaceScreen: (props: Record<string, unknown>) =>
        React.createElement('SessionCockpitSurfaceScreen', props),
}));

vi.mock('./SessionCockpitSurfaceNavigation', () => ({
    SessionCockpitSurfaceNavigationProvider: ({
        children,
        value,
    }: {
        children?: React.ReactNode;
        value: { switchSurface: (surface: string) => void };
    }) => {
        const child = React.Children.toArray(children).find(React.isValidElement);
        const surface = child
            ? String((child.props as { surface?: unknown }).surface ?? '')
            : '';
        if (surface === navigatorState.activeRouteName) {
            navigatorState.registeredChrome = {
                activeSurface: surface,
                switchSurface: value.switchSurface,
            };
        }
        return React.createElement(React.Fragment, null, children);
    },
}));

vi.mock('./SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegister: () => (model: {
        activeSurface: string;
        switchSurface: (surface: string) => void;
    }) => {
        navigatorState.registeredChrome = model;
        return () => {};
    },
}));

vi.mock('@/components/plugins/projection/useScopedPluginUiProjection', () => ({
    useScopedPluginUiProjection: (args: { machineId?: string | null; serverId?: string | null }) => {
        navigatorState.scopedProjectionCalls.push(args);
        return {
            pluginUiProjection: navigatorState.pluginProjection,
            machineId: args.machineId ?? null,
            serverId: args.serverId ?? null,
            platform: 'web',
        };
    },
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({
        pluginUiProjection: navigatorState.pluginProjection,
        machineId: 'machine-session',
        basePath: '/repo',
    }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: (_sessionId: string, fallbackServerId?: string | null) =>
        fallbackServerId ?? 'server-session',
}));

vi.mock('@/components/appShell/panes/hooks/useDetailsTabCount', () => ({
    useDetailsTabCount: () => 0,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => {
            navigatorState.localSettingReads.push(key);
            return null;
        },
        useLocalSettingMutable: () => [null, () => {}],
        usePersistSessionLastMobileSurface: () => (sessionId: string, surface: string) => {
            navigatorState.persistedSurfaces.push({ sessionId, surface });
        },
    });
});

function createPluginProjection() {
    const placement = {
        id: 'pluginUi:review:surfacePlacement:review-panel',
        pluginId: 'review',
        contributionKind: 'surfacePlacement',
        descriptorId: 'review-panel',
        placement: 'session.rightSidebarTab',
        target: { kind: 'session' },
        renderer: { kind: 'host', rendererId: 'review.panel' },
        display: { developerFallback: 'Review' },
        availability: { state: 'available', reason: 'available', diagnostics: [] },
        order: 70,
        rightSidebar: {
            tabId: 'review',
            scope: 'session',
            order: 70,
            mobile: { enabled: true, surface: 'pluginTab' },
            disabledPolicy: 'disable',
        },
    };
    return Object.freeze({
        generation: 4,
        translationsByPluginId: Object.freeze({}),
        structuredMessagesByKind: Object.freeze({}),
        sessionHeaderActionsById: Object.freeze({}),
        hostedWebById: Object.freeze({}),
        reactNativeBundlesById: Object.freeze({}),
        surfacePlacementsById: Object.freeze({ [placement.id]: placement }),
        surfacePlacementsByPlacement: Object.freeze({ 'session.rightSidebarTab': Object.freeze([placement]) }),
        uiArtifactsById: Object.freeze({}),
        digestsByPluginId: Object.freeze({}),
        unknownEntriesById: Object.freeze({}),
    });
}

describe('SessionCockpitTabNavigator keyboard behavior', () => {
    beforeEach(() => {
        standardCleanup();
        navigatorState.registeredChrome = null;
        navigatorState.localSettingReads = [];
        navigatorState.persistedSurfaces = [];
        navigatorState.pluginProjection = null;
        navigatorState.scopedProjectionCalls = [];
        navigatorState.activeRouteName = 'chat';
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
        expect(navigatorState.screenOptions?.tabBarHideOnKeyboard).toBe(false);
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
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable
            />,
        );

        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('git');
        });

        expect(navigatorState.localSettingReads).not.toContain('sessionLastMobileSurfaceBySessionId');
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'git' }]);
    });

    it('registers Navigation, Browser and Services as ordinary mobile cockpit screens', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        const screen = await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="services"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );

        expect(
            screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name),
        ).toEqual(['chat', 'browse', 'git', 'tabs', 'navigation', 'browser', 'services']);

        await act(async () => {
            navigatorState.registeredChrome?.switchSurface('browser');
        });

        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'browser' }]);
    });

    it('registers validated plugin right-sidebar mobile tabs as host-owned screens', async () => {
        navigatorState.pluginProjection = createPluginProjection();
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');

        const screen = await renderScreen(
            <SessionCockpitTabNavigator
                initialSurface="plugin:review:review"
                scopeId="session:s1"
                sessionId="s1"
                terminalTabAvailable={false}
            />,
        );

        expect(
            screen.tree.findAllByType('BottomTabScreen' as never).map((node) => node.props.name),
        ).toEqual(['chat', 'browse', 'git', 'tabs', 'navigation', 'browser', 'services', 'plugin:review:review']);
        expect(navigatorState.scopedProjectionCalls.at(-1)).toEqual({
            machineId: 'machine-session',
            serverId: 'server-session',
        });

        navigatorState.registeredChrome?.switchSurface('plugin:review:review');

        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'plugin:review:review' }]);
    });

    it('restores a requested plugin mobile surface after the plugin projection loads', async () => {
        const { SessionCockpitTabNavigator } = await import('./SessionCockpitTabNavigator');
        const renderNavigator = (projectionLoaded = false) => (
            <SessionCockpitTabNavigator
                initialSurface="plugin:review:review"
                routeServerId={projectionLoaded ? 'server-1' : undefined}
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

        expect(navigatorState.registeredChrome?.activeSurface).toBe('plugin:review:review');
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'plugin:review:review' }]);
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
