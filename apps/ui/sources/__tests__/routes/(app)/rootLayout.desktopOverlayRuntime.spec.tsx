import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createRootLayoutFeaturesResponse,
    flushHookEffects,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const desktopActivityOverlayRuntimeSpy = vi.fn(() => null);
const activityBadgeRuntimeSpy = vi.fn(() => null);

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: vi.fn(async () => {}) }),
}));
vi.mock('@/auth/routing/authRouting', () => ({
    isPublicRouteForUnauthenticated: () => true,
}));
vi.mock('@/utils/platform/platform', () => ({
    isRunningOnMac: () => false,
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
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/terminal/connect',
            segments: ['(app)', 'terminal', 'connect'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
    desktopActivityOverlayRuntime: async () => ({
        DesktopActivityOverlayRuntime: desktopActivityOverlayRuntimeSpy,
    }),
    activityBadgeRuntime: async () => ({
        ActivityBadgeRuntime: activityBadgeRuntimeSpy,
    }),
});

afterEach(() => {
    activityBadgeRuntimeSpy.mockClear();
    desktopActivityOverlayRuntimeSpy.mockClear();
    vi.restoreAllMocks();
    vi.resetModules();
    standardCleanup();
});

async function renderRootLayout() {
    const RootLayout = (await import('@/app/(app)/_layout')).default;
    await renderScreen(React.createElement(RootLayout));
    await flushHookEffects();
}

describe('RootLayout terminal connect shell runtimes', () => {
    it('does not mount shell runtimes on plain web terminal-connect routes', async () => {
        await renderRootLayout();

        expect(activityBadgeRuntimeSpy).not.toHaveBeenCalled();
        expect(desktopActivityOverlayRuntimeSpy).not.toHaveBeenCalled();
    });
});
