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
const runtimeRenderCounts = vi.hoisted(() => ({
    desktopPetOverlay: 0,
    petCompanion: 0,
    releaseNotes: 0,
}));

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

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
    PetAppShellCompanionMount: () => {
        runtimeRenderCounts.petCompanion += 1;
        return React.createElement('PetAppShellCompanionMount', {
            testID: 'pet-app-shell-companion-mount',
        });
    },
}));

vi.mock('@/components/pets/runtime/DesktopPetOverlayRuntimeMount', () => ({
    DesktopPetOverlayRuntimeMount: () => {
        runtimeRenderCounts.desktopPetOverlay += 1;
        return React.createElement('DesktopPetOverlayRuntimeMount', {
            testID: 'desktop-pet-overlay-runtime-mount',
        });
    },
}));

vi.mock('@/changelog/releaseNotes', () => ({
    ReleaseNotesAutoShowMount: () => {
        runtimeRenderCounts.releaseNotes += 1;
        return React.createElement('ReleaseNotesAutoShowMount', {
            testID: 'release-notes-auto-show-mount',
        });
    },
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
    runtimeRenderCounts.desktopPetOverlay = 0;
    runtimeRenderCounts.petCompanion = 0;
    runtimeRenderCounts.releaseNotes = 0;
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

    it('keeps authenticated app-shell runtimes stable across unchanged root layout updates', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        const renderCountsAfterMount = { ...runtimeRenderCounts };

        await screen.update(React.createElement(RootLayout));
        await flushHookEffects();

        expect(runtimeRenderCounts.desktopPetOverlay).toBe(renderCountsAfterMount.desktopPetOverlay);
        expect(runtimeRenderCounts.petCompanion).toBe(renderCountsAfterMount.petCompanion);
        expect(runtimeRenderCounts.releaseNotes).toBe(renderCountsAfterMount.releaseNotes);
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

    it('keeps normal stack headers for authenticated routes that are also public before sign-in', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderScreen(React.createElement(RootLayout));
        await flushHookEffects();

        const screens = screen.findAllByType(Stack.Screen);
        const screenOptionsByName = new Map(
            screens.map((node) => [node.props?.name, node.props?.options]),
        );

        expect(screenOptionsByName.get('terminal/connect')).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'terminal.connectTerminal',
        }));
        expect(screenOptionsByName.get('terminal/index')).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'terminal.connectTerminal',
        }));
        expect(screenOptionsByName.get('restore/index')).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'connect.restoreAccount',
        }));
        expect(screenOptionsByName.get('restore/manual')).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'navigation.restoreWithSecretKey',
        }));
        expect(screenOptionsByName.get('restore/lost-access')).toEqual(expect.objectContaining({
            headerShown: true,
            headerTitle: 'connect.lostAccessTitle',
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
