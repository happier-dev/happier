import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-reanimated', () => ({}));

const routerReplaceSpy = vi.fn();
let localSearchParams: Record<string, unknown> = {};

vi.mock('expo-router', () => ({
    router: { replace: routerReplaceSpy },
    useLocalSearchParams: () => localSearchParams,
}));

afterEach(() => {
    localSearchParams = {};
    routerReplaceSpy.mockReset();
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('Legacy /account route', () => {
    it('redirects to the canonical account settings route', async () => {
        const Screen = (await import('./account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });

            expect(routerReplaceSpy).toHaveBeenCalledWith('/settings/account');
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });

    it('preserves server override query when redirecting', async () => {
        localSearchParams = { server: 'http://localhost:3014' };
        const Screen = (await import('./account')).default;

        let tree: ReturnType<typeof renderer.create> | undefined;
        try {
            await act(async () => {
                tree = renderer.create(<Screen />);
            });

            expect(routerReplaceSpy).toHaveBeenCalledWith({
                pathname: '/settings/account',
                params: { server: 'http://localhost:3014' },
            });
        } finally {
            act(() => {
                tree?.unmount();
            });
        }
    });
});
