import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

const routerReplaceSpy = vi.fn();

const expoRouterMock = createExpoRouterMock({
    router: {
        replace: (...args: unknown[]) => routerReplaceSpy(...args),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: <T,>(options: { web?: T; default?: T }) => options.web ?? options.default,
        },
    });
});

describe('useWebInitialRouteReconcile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        routerReplaceSpy.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('reconciles from the root router pathname to a deeper browser pathname on initial web load', async () => {
        vi.stubGlobal('window', {
            location: {
                pathname: '/terminal/connect',
                search: '',
                hash: '',
            },
        });

        const { useWebInitialRouteReconcile } = await import('./useWebInitialRouteReconcile');

        await renderHook(() => useWebInitialRouteReconcile({ routerPathname: '/' }));
        await flushHookEffects({ cycles: 1, turns: 1, runAllTimers: true });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/terminal/connect');
    });

    it('captures the scoped browser address before layout effects can rewrite the URL', async () => {
        const location = {
            pathname: '/session/session-1',
            search: '?serverId=home-b',
            hash: '',
        };
        vi.stubGlobal('window', { location });

        const { useWebInitialRouteReconcile } = await import('./useWebInitialRouteReconcile');
        await renderHook(() => {
            useWebInitialRouteReconcile({ routerPathname: '/session/session-1', routerServerId: null });
            React.useLayoutEffect(() => {
                location.search = '';
            }, []);
        });
        await flushHookEffects({ cycles: 1, turns: 1, runAllTimers: true });

        expect(routerReplaceSpy).toHaveBeenCalledWith('/session/session-1?serverId=home-b');
    });

    it('leaves a same-session pane query change alone when browser and router still agree on the Home', async () => {
        const location = {
            pathname: '/session/session-1',
            search: '?serverId=home-b&right=files',
            hash: '',
        };
        vi.stubGlobal('window', { location });

        const { useWebInitialRouteReconcile } = await import('./useWebInitialRouteReconcile');
        await renderHook(() => useWebInitialRouteReconcile({
            routerPathname: '/session/session-1',
            routerServerId: 'home-b',
        }));

        location.search = '?serverId=home-b&right=git';
        await flushHookEffects({ cycles: 1, turns: 1, runAllTimers: true });

        expect(routerReplaceSpy).not.toHaveBeenCalled();
    });
});
