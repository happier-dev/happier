import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const navigatorState = vi.hoisted(() => ({
    screenOptions: null as null | Record<string, unknown>,
    navigationContainerLinking: null as null | Record<string, unknown>,
    registeredChrome: null as null | {
        switchSurface: (surface: 'chat' | 'browse' | 'git' | 'tabs' | 'terminal') => void;
    },
    localSettingReads: [] as string[],
    persistedSurfaces: [] as Array<Readonly<{ sessionId: string; surface: string }>>,
}));

vi.mock('@react-navigation/native', () => ({
    NavigationContainer: ({ children, linking }: { children?: React.ReactNode; linking?: Record<string, unknown> }) => {
        navigatorState.navigationContainerLinking = linking ?? null;
        return React.createElement('NavigationContainer', { linking }, children);
    },
    NavigationIndependentTree: ({ children }: { children?: React.ReactNode }) =>
        React.createElement('NavigationIndependentTree', null, children),
}));

vi.mock('@react-navigation/bottom-tabs', () => ({
    createBottomTabNavigator: () => ({
        Navigator: ({ children, screenOptions, tabBar }: {
            children?: React.ReactNode;
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
            const routes = ['chat', 'browse', 'git', 'tabs', 'terminal'].map((name) => ({ key: name, name }));
            return React.createElement('BottomTabNavigator', { screenOptions }, [
                React.createElement(React.Fragment, { key: 'screens' }, children),
                React.createElement(React.Fragment, { key: 'tab-bar' }, tabBar?.({
                    state: { index: 0, routes },
                    navigation: {
                        emit: () => ({ defaultPrevented: false }),
                        navigate: () => {},
                    },
                })),
            ]);
        },
        Screen: ({ children, name }: { children?: (props: { navigation: { navigate: () => void } }) => React.ReactNode; name: string }) =>
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
    SessionCockpitSurfaceNavigationProvider: ({ children }: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, children),
}));

vi.mock('./SessionCockpitChromeRegistry', () => ({
    useSessionCockpitChromeRegister: () => (model: {
        switchSurface: (surface: 'chat' | 'browse' | 'git' | 'tabs' | 'terminal') => void;
    }) => {
        navigatorState.registeredChrome = model;
        return () => {};
    },
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

describe('SessionCockpitTabNavigator keyboard behavior', () => {
    beforeEach(() => {
        navigatorState.registeredChrome = null;
        navigatorState.localSettingReads = [];
        navigatorState.persistedSurfaces = [];
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

        navigatorState.registeredChrome?.switchSurface('git');

        expect(navigatorState.localSettingReads).not.toContain('sessionLastMobileSurfaceBySessionId');
        expect(navigatorState.persistedSurfaces).toEqual([{ sessionId: 's1', surface: 'git' }]);
    });
});
