import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';

type FrameScheduler = (callback: FrameRequestCallback) => number;

describe('deferOnWeb', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('defers execution on web', async () => {
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'web',
                },
            });
        });

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();
        let deferredFrame: ((timestamp: number) => void) | null = null;
        const frameScheduler: FrameScheduler = (callback) => {
            deferredFrame = callback;
            return 1;
        };

        await withPopoverWebGlobals(async () => {
            deferOnWeb(action);

            expect(action).not.toHaveBeenCalled();
            expect(deferredFrame).not.toBeNull();
            const runDeferredFrame =
                deferredFrame ??
                ((_timestamp: number) => {
                    throw new Error('Expected deferred frame callback to be scheduled');
                });
            runDeferredFrame(0);
            expect(action).toHaveBeenCalledTimes(1);
        }, { frameScheduler });
    });

    it('still runs the action when the web frame is stalled and only the timeout fallback can fire', async () => {
        vi.useFakeTimers();
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'web',
                },
            });
        });

        const rafSpy = vi.fn(() => 1);
        vi.stubGlobal('requestAnimationFrame', rafSpy);

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();

        deferOnWeb(action);

        expect(action).not.toHaveBeenCalled();
        await vi.runOnlyPendingTimersAsync();
        expect(action).toHaveBeenCalledTimes(1);
        expect(rafSpy).toHaveBeenCalledTimes(1);

        vi.useRealTimers();
    });

    it('runs immediately off web', async () => {
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'ios',
                },
            });
        });

        const { deferOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();
        deferOnWeb(action);
        expect(action).toHaveBeenCalledTimes(1);
    });

    it('blurs the active element before navigating on web', async () => {
        const blurSpy = vi.fn();
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Platform: {
                    OS: 'web',
                },
            });
        });
        vi.stubGlobal('document', {
            activeElement: { blur: blurSpy },
        });

        const { navigateWithBlurOnWeb } = await import('./deferOnWeb');
        const action = vi.fn();

        navigateWithBlurOnWeb(action);

        expect(blurSpy).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledTimes(1);
    });
});
