import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    mockWindowDimensions: { width: 1200, height: 900 },
}));

installNavigationShellCommonModuleMocks({
    reactNative: installReactNativeWebMock({
        View: (props: any) => React.createElement('View', props, props.children),
        Pressable: (props: any) => React.createElement('Pressable', props, props.children),
        Dimensions: {
            get: () => ({
                width: hoistedState.mockWindowDimensions.width,
                height: hoistedState.mockWindowDimensions.height,
                scale: 1,
                fontScale: 1,
            }),
        },
        useWindowDimensions: () => ({
            width: hoistedState.mockWindowDimensions.width,
            height: hoistedState.mockWindowDimensions.height,
        }),
        Platform: {
            OS: 'web',
            select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
        },
        PanResponder: {
            create: () => ({ panHandlers: {} }),
        },
        InteractionManager: {
            runAfterInteractions: (fn: () => void) => fn(),
        },
    }),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: () => '/',
            segments: () => ['(app)'],
        }).module;
    },
    storage: installPartialStorageModuleMock({
        useLocalSetting: (key: string) => {
            if (key === 'sidebarCollapsed') return false;
            if (key === 'sidebarWidthPx') return 320;
            if (key === 'sidebarWidthBasisPx') return 1200;
            return null;
        },
        useLocalSettingMutable: (key: string) => {
            if (key === 'sidebarCollapsed') return [false, vi.fn()] as const;
            if (key === 'sidebarWidthPx') return [320, vi.fn()] as const;
            if (key === 'sidebarWidthBasisPx') return [1200, vi.fn()] as const;
            return [null, vi.fn()] as const;
        },
    }),
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock('./SidebarView', () => ({
    SidebarView: () => React.createElement('SidebarView', { testID: 'sidebar-view' }),
}));

vi.mock('./CollapsedSidebarView', () => ({
    CollapsedSidebarView: () => React.createElement('CollapsedSidebarView', { testID: 'collapsed-sidebar-view' }),
}));

vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));

afterEach(() => {
    standardCleanup();
    vi.resetModules();
    vi.doUnmock('expo-router/drawer');
});

describe('SidebarNavigator desktop drawer render stability', () => {
    it('renders the authenticated permanent drawer shell on web without crashing', async () => {
        const { SidebarNavigator } = await import('./SidebarNavigator');

        const screen = await renderScreen(<SidebarNavigator />);

        expect(screen.findByTestId('sidebar-view')).toBeTruthy();
    });

    it('renders when the drawer module resolves through a default-only interop shape', async () => {
        const DefaultOnlyDrawer = Object.assign(
            function Drawer(props: { children?: React.ReactNode; drawerContent?: ((props: Record<string, unknown>) => React.ReactNode) | undefined }) {
                return React.createElement(
                    React.Fragment,
                    null,
                    props.drawerContent ? props.drawerContent({}) : null,
                    props.children ?? null,
                );
            },
            { Screen: 'DrawerScreen' as any },
        );

        vi.doMock('expo-router/drawer', () => ({
            default: DefaultOnlyDrawer,
        }));

        const { SidebarNavigator } = await import('./SidebarNavigator');
        const screen = await renderScreen(<SidebarNavigator />);

        expect(screen.findByTestId('sidebar-view')).toBeTruthy();
    });

    it('renders when the drawer module resolves through a named-only interop shape', async () => {
        const NamedOnlyDrawer = Object.assign(
            function Drawer(props: { children?: React.ReactNode; drawerContent?: ((props: Record<string, unknown>) => React.ReactNode) | undefined }) {
                return React.createElement(
                    React.Fragment,
                    null,
                    props.drawerContent ? props.drawerContent({}) : null,
                    props.children ?? null,
                );
            },
            { Screen: 'DrawerScreen' as any },
        );

        vi.doMock('expo-router/drawer', () => ({
            Drawer: NamedOnlyDrawer,
        }));

        const { SidebarNavigator } = await import('./SidebarNavigator');
        const screen = await renderScreen(<SidebarNavigator />);

        expect(screen.findByTestId('sidebar-view')).toBeTruthy();
    });
});
