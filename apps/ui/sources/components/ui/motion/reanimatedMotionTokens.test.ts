import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'web' }));

// Platform and Reanimated are the native/web animation boundary. Keep the
// token selection real, with distinguishable named and custom easing values.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return platform.os; } } });
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const mock = createReanimatedModuleMock();
    return {
        ...mock,
        Easing: {
            ...mock.Easing,
            ease: (t: number) => t * t,
            bezier: (x1: number, y1: number, x2: number, y2: number) => ({
                factory: () => (t: number) => x1 + y1 + x2 + y2 + t,
            }),
        },
    };
});

describe('Reanimated layout motion', () => {
    beforeEach(() => { vi.resetModules(); });

    it('uses a named easing accepted by the web layout-animation parser', async () => {
        platform.os = 'web';
        const { Easing } = await import('react-native-reanimated');
        const { reanimatedMotionTokens } = await import('./reanimatedMotionTokens');
        expect(reanimatedMotionTokens.layoutEasing.standard).toBe(Easing.ease);
    });

    it.each(['ios', 'android'])('preserves the standard native curve on %s', async (os) => {
        platform.os = os;
        const { reanimatedMotionTokens } = await import('./reanimatedMotionTokens');
        expect(reanimatedMotionTokens.layoutEasing.standard(0.5)).toBe(
            reanimatedMotionTokens.easing.standard.factory()(0.5),
        );
    });
});
