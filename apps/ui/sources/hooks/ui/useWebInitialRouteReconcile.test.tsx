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
});
