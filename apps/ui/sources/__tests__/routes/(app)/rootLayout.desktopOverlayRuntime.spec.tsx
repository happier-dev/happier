import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { initializeRootLayoutRuntimeForTests, renderRootLayoutRoute, installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const routeState = vi.hoisted(() => ({
    pathname: '/terminal/connect',
    segments: ['(app)', 'terminal', 'connect'],
}));

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

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
            pathname: () => routeState.pathname,
            segments: () => routeState.segments,
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

await initializeRootLayoutRuntimeForTests();
const { ActivityBadgeRuntime } = await import('@/activity/badges/ActivityBadgeRuntime');
const { AuthenticatedAppRuntimeMounts } = await import('@/components/appShell/runtime/AuthenticatedAppRuntimeMounts');

afterEach(() => {
    routeState.pathname = '/terminal/connect';
    routeState.segments = ['(app)', 'terminal', 'connect'];
    vi.restoreAllMocks();
    standardCleanup();
});

async function renderRootLayout() {
    const RootLayout = (await import('@/app/(app)/_layout')).default;
    const screen = await renderRootLayoutRoute(RootLayout);
    await flushHookEffects();
    return screen;
}

describe('RootLayout shell runtimes', () => {
    it('mounts the authenticated shell runtimes on an ordinary route', async () => {
        routeState.pathname = '/';
        routeState.segments = ['(app)'];
        const screen = await renderRootLayout();
        expect(screen.tree.root.findAllByType(AuthenticatedAppRuntimeMounts.type)).toHaveLength(1);
        expect(screen.tree.root.findAllByType(ActivityBadgeRuntime)).toHaveLength(1);
    });

    it('does not mount shell runtimes on plain web terminal-connect routes', async () => {
        const screen = await renderRootLayout();
        expect(screen.tree.root.findAllByType(AuthenticatedAppRuntimeMounts.type)).toHaveLength(0);
        expect(screen.tree.root.findAllByType(ActivityBadgeRuntime)).toHaveLength(0);
    });
});
