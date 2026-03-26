import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS;
});

describe('runAfterInteractionsWithFallback', () => {
    it('defers on web (next tick) and is cancelable', async () => {
        vi.doMock('react-native', async () => {
            const stub = await import('@/dev/reactNativeStub');
            return {
                ...stub,
                Platform: { ...stub.Platform, OS: 'web' },
                InteractionManager: { runAfterInteractions: vi.fn() },
            };
        });

        vi.useFakeTimers();

        const fn = vi.fn();
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');
        const cancel = runAfterInteractionsWithFallback(fn);

        expect(fn).toHaveBeenCalledTimes(0);

        cancel();
        vi.runAllTimers();
        expect(fn).toHaveBeenCalledTimes(0);

        const cancel2 = runAfterInteractionsWithFallback(fn);
        expect(fn).toHaveBeenCalledTimes(0);
        vi.runAllTimers();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(() => cancel2()).not.toThrow();
    });

    it('defers on native and is cancelable', async () => {
        const cancelSpy = vi.fn();
        const scheduled: Array<() => void> = [];

        vi.doMock('react-native', async () => {
            const stub = await import('@/dev/reactNativeStub');
            return {
                ...stub,
                Platform: { ...stub.Platform, OS: 'ios' },
                InteractionManager: {
                    runAfterInteractions: (cb: () => void) => {
                        scheduled.push(cb);
                        return { cancel: cancelSpy };
                    },
                },
            };
        });

        const fn = vi.fn();
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');
        const cancel = runAfterInteractionsWithFallback(fn);

        expect(fn).toHaveBeenCalledTimes(0);
        expect(scheduled).toHaveLength(1);

        cancel();
        expect(cancelSpy).toHaveBeenCalledTimes(1);

        scheduled[0]!();
        expect(fn).toHaveBeenCalledTimes(0);
    });

    it('runs via fallback when InteractionManager never invokes the callback', async () => {
        process.env.EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS = '10';
        const scheduledTimeouts: Array<{ callback: () => void; delay: number | undefined }> = [];
        vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) => {
            scheduledTimeouts.push({ callback, delay });
            return 0 as any;
        }) as typeof setTimeout);

        vi.doMock('react-native', async () => {
            const stub = await import('@/dev/reactNativeStub');
            return {
                ...stub,
                Platform: { ...stub.Platform, OS: 'ios' },
                InteractionManager: {
                    runAfterInteractions: () => ({ cancel: vi.fn() }),
                },
            };
        });

        const fn = vi.fn();
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');
        runAfterInteractionsWithFallback(fn);

        expect(scheduledTimeouts).toHaveLength(1);
        expect(scheduledTimeouts[0]!.delay).toBe(10);
        expect(fn).toHaveBeenCalledTimes(0);
        scheduledTimeouts[0]!.callback();
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
