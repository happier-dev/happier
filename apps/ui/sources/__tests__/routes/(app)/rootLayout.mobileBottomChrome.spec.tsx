import React from 'react';
import { MobileBottomChromeHost } from '@/components/navigation/mobile/chrome/MobileBottomChromeHost';
import { AuthenticatedAppRuntimeMounts } from '@/components/appShell/runtime/AuthenticatedAppRuntimeMounts';
import { DesktopMainWindowRuntimes } from '@/desktop/DesktopMainWindowRuntimes';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';


import { initializeRootLayoutRuntimeForTests, renderRootLayoutRoute, installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const hoistedState = vi.hoisted(() => ({
    desktopHost: false,
}));
const desktopSecureStorage = createDesktopSecureStorageBoundary();
async function desktopInvoke(command: string, args?: Readonly<Record<string, unknown>>) {
    if (command.startsWith('desktop_secure_storage_')) return desktopSecureStorage.invoke(command, args);
    if (command === 'desktop_set_window_mode' || command === 'desktop_set_tray_state') return null;
    if (command === 'desktop_get_window_chrome_policy') return { strategy: 'none' };
    throw new Error(`Unexpected native command: ${command}`);
}
vi.mock('@tauri-apps/api/event', async importOriginal => ({ ...await importOriginal<typeof import('@tauri-apps/api/event')>(), listen: vi.fn(async () => () => {}) }));

installRootLayoutRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
        const Stack = Object.assign(
            () => React.createElement('Stack'),
            { Screen: routerMock.Stack.Screen },
        );
        return {
            ...routerMock,
            Stack,
        };
    },
});

await initializeRootLayoutRuntimeForTests();
beforeEach(() => {
    vi.stubGlobal('__TAURI_INTERNALS__', undefined);
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, get: () => hoistedState.desktopHost ? { invoke: desktopInvoke } : undefined });
});

afterEach(() => {
    vi.unstubAllGlobals();
    hoistedState.desktopHost = false;
    desktopSecureStorage.values.clear();
});

describe('RootLayout mobile bottom chrome wiring', () => {
    it('renders the mobile bottom chrome host after the stack so only its capsule wins pointer hit-testing', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderRootLayoutRoute(RootLayout);

        const stack = screen.tree.findByType('Stack' as never);
        const mobileChrome = screen.tree.findByType(MobileBottomChromeHost.type);
        screen.tree.findByType(AuthenticatedAppRuntimeMounts.type);

        // The Stack mock is intentionally a leaf. If chrome regresses inside Stack,
        // it will not render and the findByType above fails rather than producing
        // the same misleading Stack → MobileBottomChromeHost preorder.
        expect(stack.findAllByType(MobileBottomChromeHost.type)).toHaveLength(0);
        expect(screen.tree.findAll((node) => (
            node.type === AuthenticatedAppRuntimeMounts.type
            || String(node.type) === 'Stack'
            || node === mobileChrome
        )).map((node) => node.type)).toEqual([
            AuthenticatedAppRuntimeMounts.type,
            'Stack',
            MobileBottomChromeHost.type,
        ]);
    });

    it('keeps app-owned runtimes out of dedicated desktop overlay presenters', async () => {
        hoistedState.desktopHost = true;
        vi.stubGlobal('window', { location: { href: 'https://app.example.test/desktop/activity-overlay' } });
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderRootLayoutRoute(RootLayout);

        expect(screen.tree.findAllByType(AuthenticatedAppRuntimeMounts.type)).toHaveLength(0);
        expect(screen.tree.findAllByType('Stack' as never)).toHaveLength(1);
    });

    it('keeps the desktop main window\'s tray and Quit handoff mounted in the main window, never in an overlay window (R13C-F3)', async () => {
        hoistedState.desktopHost = true;
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderRootLayoutRoute(RootLayout);
        expect(screen.tree.findAllByType(DesktopMainWindowRuntimes)).toHaveLength(1);

        await screen.unmount();
        hoistedState.desktopHost = true;
        vi.stubGlobal('window', { location: { href: 'https://app.example.test/desktop/activity-overlay' } });
        const OverlayLayout = (await import('@/app/(app)/_layout')).default;
        const overlay = await renderRootLayoutRoute(OverlayLayout);
        expect(overlay.tree.findAllByType(DesktopMainWindowRuntimes)).toHaveLength(0);
    });
});
