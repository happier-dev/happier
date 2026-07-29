import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { installReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';

import { installNavigationShellCommonModuleMocks } from './navigationShellTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    mockPathname: '/' as string,
    mockSegments: ['(app)'] as string[],
    mockWindowDimensions: { width: 1200, height: 900 },
    journeyActive: false,
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
            pathname: () => hoistedState.mockPathname,
            segments: () => hoistedState.mockSegments,
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

vi.mock('@/components/onboarding/tour/state/journeySession', () => ({
    useOnboardingJourneySessionActive: () => hoistedState.journeyActive,
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

function installDrawerRenderingMock(): void {
    const RenderingDrawer = Object.assign(
        function Drawer(props: {
            children?: React.ReactNode;
            drawerContent?: ((props: Record<string, unknown>) => React.ReactNode) | undefined;
        }) {
            return React.createElement(
                React.Fragment,
                null,
                props.drawerContent ? props.drawerContent({}) : null,
                props.children ?? null,
            );
        },
        { Screen: 'DrawerScreen' as any },
    );
    vi.doMock('expo-router/drawer', () => ({ default: RenderingDrawer }));
}

afterEach(() => {
    hoistedState.journeyActive = false;
    standardCleanup();
    vi.resetModules();
    vi.doUnmock('expo-router/drawer');
});

describe('SidebarNavigator onboarding journey gate', () => {
    it('renders the permanent drawer sidebar for an authed user when no journey is active', async () => {
        hoistedState.journeyActive = false;
        installDrawerRenderingMock();

        const { SidebarNavigator } = await import('./SidebarNavigator');
        const screen = await renderScreen(<SidebarNavigator />);

        expect(screen.findByTestId('sidebar-view')).toBeTruthy();
    });

    it('suppresses the permanent drawer sidebar while the onboarding journey session is active', async () => {
        hoistedState.journeyActive = true;
        installDrawerRenderingMock();

        const { SidebarNavigator } = await import('./SidebarNavigator');
        const screen = await renderScreen(<SidebarNavigator />);

        expect(screen.findByTestId('sidebar-view')).toBeNull();
        expect(screen.findByTestId('collapsed-sidebar-view')).toBeNull();
    });
});
