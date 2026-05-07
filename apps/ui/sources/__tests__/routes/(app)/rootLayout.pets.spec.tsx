import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Stack } from 'expo-router';

import {
    createRootLayoutFeaturesResponse,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

const desktopPetOverlayWindowContextState = vi.hoisted(() => ({
    current: false,
}));
const authState = vi.hoisted(() => ({
    isAuthenticated: true,
    refreshFromActiveServer: vi.fn(async () => {}),
}));

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));

vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
}));

vi.mock('@/utils/platform/tauri', () => ({
    invokeTauri: vi.fn(async () => null),
    isTauriDesktop: () => false,
}));

vi.mock('@/sync/domains/pending/pendingTerminalConnect', () => ({
    getPendingTerminalConnect: () => null,
}));

vi.mock('@/sync/domains/pending/pendingNotificationNav', () => ({
    getPendingNotificationNav: () => null,
    clearPendingNotificationNav: vi.fn(),
    setPendingNotificationNav: vi.fn(),
}));

vi.mock('@/sync/domains/pending/pendingNotificationAction', () => ({
    getPendingNotificationAction: () => null,
    clearPendingNotificationAction: vi.fn(),
    setPendingNotificationAction: vi.fn(),
}));

vi.mock('@/sync/api/capabilities/getReadyServerFeatures', () => ({
    getReadyServerFeatures: async () => createRootLayoutFeaturesResponse(),
}));

vi.mock('@/components/pets/runtime/PetAppShellCompanionMount', () => ({
    PetAppShellCompanionMount: () => React.createElement('PetAppShellCompanionMount', {
        testID: 'pet-app-shell-companion-mount',
    }),
}));

vi.mock('@/components/pets/runtime/DesktopPetOverlayRuntimeMount', () => ({
    DesktopPetOverlayRuntimeMount: () => React.createElement('DesktopPetOverlayRuntimeMount', {
        testID: 'desktop-pet-overlay-runtime-mount',
    }),
}));

vi.mock('@/components/pets/desktop/runtime/isDesktopPetOverlayWindowContext', () => ({
    isDesktopPetOverlayWindowContext: () => desktopPetOverlayWindowContextState.current,
}));

installRootLayoutRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(choices: { web?: T; default?: T }) => choices?.web ?? choices?.default,
            },
            AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

afterEach(() => {
    authState.isAuthenticated = true;
    authState.refreshFromActiveServer.mockClear();
    desktopPetOverlayWindowContextState.current = false;
    vi.restoreAllMocks();
    vi.resetModules();
    standardCleanup();
});

describe('App RootLayout pets', () => {
    it('mounts the authenticated app-shell pet runtime containers', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        expect(screen.findAllByTestId('pet-app-shell-companion-mount')).toHaveLength(1);
        expect(screen.findAllByTestId('desktop-pet-overlay-runtime-mount')).toHaveLength(1);
    });

    it('does not mount pet runtimes on unauthenticated public routes', async () => {
        authState.isAuthenticated = false;
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        expect(screen.findAllByTestId('pet-app-shell-companion-mount')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-pet-overlay-runtime-mount')).toHaveLength(0);
        expect(screen.findAllByType(Stack.Screen).map((node) => node.props?.name)).toContain('index');
    });

    it('registers the desktop pet overlay route without app stack chrome', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        const desktopPetOverlayScreen = screen
            .findAllByType(Stack.Screen)
            .find((node) => node.props?.name === 'desktop/pet-overlay');

        expect(desktopPetOverlayScreen?.props?.options).toEqual(expect.objectContaining({
            headerShown: false,
        }));
    });

    it('renders only the desktop pet overlay route inside the native overlay window context', async () => {
        desktopPetOverlayWindowContextState.current = true;
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        expect(screen.findAllByTestId('pet-app-shell-companion-mount')).toHaveLength(0);
        expect(screen.findAllByTestId('desktop-pet-overlay-runtime-mount')).toHaveLength(0);
        expect(screen.findAllByType(Stack.Screen).map((node) => node.props?.name)).toEqual([
            'desktop/pet-overlay',
        ]);
    });
});
