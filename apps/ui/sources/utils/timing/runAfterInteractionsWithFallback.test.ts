import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS;
});

describe('runAfterInteractionsWithFallback', () => {
    it('runs immediately on web', async () => {
        vi.doMock('react-native', async () => {
            const stub = await import('@/dev/reactNativeStub');
            return {
                ...stub,
                Platform: { ...stub.Platform, OS: 'web' },
                InteractionManager: { runAfterInteractions: vi.fn() },
            };
        });

        const fn = vi.fn();
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');
        const cancel = runAfterInteractionsWithFallback(fn);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(() => cancel()).not.toThrow();
    });

    it('defers on native and is cancelable', async () => {
        vi.useFakeTimers();
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
        vi.useFakeTimers();
        process.env.EXPO_PUBLIC_HAPPIER_RUN_AFTER_INTERACTIONS_FALLBACK_MS = '10';

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

        expect(fn).toHaveBeenCalledTimes(0);
        vi.advanceTimersByTime(9);
        expect(fn).toHaveBeenCalledTimes(0);
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
