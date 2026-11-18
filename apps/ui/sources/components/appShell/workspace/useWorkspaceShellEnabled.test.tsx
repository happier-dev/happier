import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';

const boundary = vi.hoisted(() => ({ authenticated: true, pathname: '/settings/server/add', width: 1440 }));
// Authentication and viewport/route input are the platform boundaries; presentation stays real.
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: boundary.authenticated }) }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => boundary.pathname,
        segments: () => ['(app)', ...boundary.pathname.split('/').filter(Boolean)] }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' },
        Dimensions: { get: () => ({ width: boundary.width, height: 900, scale: 1, fontScale: 1 }),
            addEventListener: () => ({ remove() {} }) } });
});

const { useWorkspacePresentation, useWorkspaceShellEnabled } = await import('./useWorkspaceShellEnabled');

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    boundary.authenticated = true; boundary.pathname = '/settings/server/add'; boundary.width = 1440;
});

describe('workspace route presentation owner', () => {
    it.each([
        ['/desktop/window', 'destination', false],
        ['/desktop/app-window', 'shell', true],
        ['/desktop/capture', null, false],
    ] as const)('uses the desktop boot role for %s without borrowing responsive chrome', async (pathname, presentation, shell) => {
        boundary.pathname = pathname;
        boundary.width = 390;
        vi.stubGlobal('window', { location: { href: `http://localhost:8081${pathname}` }, __TAURI_INTERNALS__: { invoke: vi.fn() } });
        const hook = await renderHook(() => ({ presentation: useWorkspacePresentation(), shell: useWorkspaceShellEnabled() }));
        expect(hook.getCurrent()).toEqual({ presentation, shell });
    });
    it.each(['/settings/server', '/settings/server/add', '/settings/server/home-a', '/settings/server/device', '/settings/server/groups/group-a'])(
        'presents authenticated %s in the shell and preserves signed-out shellless access', async pathname => {
            boundary.pathname = pathname;
            const hook = await renderHook(() => ({ presentation: useWorkspacePresentation(), shell: useWorkspaceShellEnabled() }));
            expect(hook.getCurrent()).toEqual({ presentation: 'shell', shell: true });
            boundary.authenticated = false;
            await hook.rerender();
            expect(hook.getCurrent()).toEqual({ presentation: null, shell: false });
        });

    it('uses phone presentation for signed-in Homes on a narrow viewport', async () => {
        boundary.width = 390;
        const hook = await renderHook(useWorkspacePresentation);
        expect(hook.getCurrent()).toBe('phone');
    });

    it.each(['/join/invitation', '/restore/manual', '/terminal/connect', '/share/public-link'])(
        'retains standalone public entry presentation for %s', async pathname => {
            boundary.pathname = pathname;
            const hook = await renderHook(useWorkspacePresentation);
            expect(hook.getCurrent()).toBe('entry');
        });
});
