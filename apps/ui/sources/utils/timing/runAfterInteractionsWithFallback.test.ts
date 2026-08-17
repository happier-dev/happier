import { describe, expect, it, vi, afterEach } from 'vitest';

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
});

/**
 * Mirrors what React Native 0.83.5 actually ships for `InteractionManager`:
 * `Libraries/Interaction/InteractionManager.js` exports the deprecated stub
 * unconditionally, and its `runAfterInteractions` defers the task through
 * `setImmediate`, which `Libraries/Core/setUpTimers.js` shims onto
 * `global.queueMicrotask` (`Libraries/Core/Timers/immediateShim.js`).
 *
 * So the real deferral is a microtask, and `cancel()` really does drop the
 * task (`clearImmediate`). Modelling that faithfully is the whole point: a
 * hand-rolled "collect the callbacks and never run them" double certifies
 * scheduling semantics this platform does not have.
 */
function mockReactNativeWithShippedInteractionManager(os: 'ios' | 'android' | 'web'): void {
    vi.doMock('react-native', async () => {
        const stub = await import('@/dev/reactNativeStub');
        const cancelledImmediates = new Set<number>();
        let nextImmediateId = 1;
        return {
            ...stub,
            Platform: { ...stub.Platform, OS: os },
            InteractionManager: {
                runAfterInteractions(task: () => void) {
                    const immediateId = nextImmediateId++;
                    queueMicrotask(() => {
                        if (cancelledImmediates.has(immediateId)) return;
                        task();
                    });
                    return {
                        then: () => Promise.resolve(),
                        cancel() {
                            cancelledImmediates.add(immediateId);
                        },
                    };
                },
            },
        };
    });
}

async function drainMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function runMacrotask(): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

describe('runAfterInteractionsWithFallback on native', () => {
    it('runs inside the current JS task at the microtask checkpoint, ahead of any macrotask', async () => {
        mockReactNativeWithShippedInteractionManager('ios');
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const order: string[] = [];
        setTimeout(() => order.push('macrotask'), 0);
        runAfterInteractionsWithFallback(() => order.push('deferred'));

        expect(order).toEqual([]);

        await drainMicrotasks();
        expect(order).toEqual(['deferred']);

        await runMacrotask();
        expect(order).toEqual(['deferred', 'macrotask']);
    });

    it('schedules no timer: there is no timeout fallback to race the interaction task', async () => {
        mockReactNativeWithShippedInteractionManager('ios');
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const fn = vi.fn();
        runAfterInteractionsWithFallback(fn);

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        await drainMicrotasks();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('ignores the deprecated fallbackDelayMs option instead of arming a timer', async () => {
        mockReactNativeWithShippedInteractionManager('ios');
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        const fn = vi.fn();
        runAfterInteractionsWithFallback(fn, { fallbackDelayMs: 0 });

        expect(setTimeoutSpy).not.toHaveBeenCalled();
        await drainMicrotasks();
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('cancels the pending interaction task', async () => {
        mockReactNativeWithShippedInteractionManager('android');
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const fn = vi.fn();
        const cancel = runAfterInteractionsWithFallback(fn);
        cancel();

        await drainMicrotasks();
        await runMacrotask();
        expect(fn).not.toHaveBeenCalled();
    });

    it('still honours cancel when the interaction task itself cannot be cancelled', async () => {
        const scheduled: Array<() => void> = [];
        vi.doMock('react-native', async () => {
            const stub = await import('@/dev/reactNativeStub');
            return {
                ...stub,
                Platform: { ...stub.Platform, OS: 'ios' },
                InteractionManager: {
                    runAfterInteractions(task: () => void) {
                        scheduled.push(task);
                        // `@/dev/reactNativeStub` ships exactly this no-op cancel.
                        return { then: () => Promise.resolve(), cancel: () => {} };
                    },
                },
            };
        });
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const fn = vi.fn();
        const cancel = runAfterInteractionsWithFallback(fn);
        cancel();

        expect(scheduled).toHaveLength(1);
        scheduled[0]!();
        expect(fn).not.toHaveBeenCalled();
    });

    it('falls back to a macrotask when the react-native boundary exposes no InteractionManager', async () => {
        vi.doMock('react-native', async () => {
            const stub = await import('@/dev/reactNativeStub');
            return {
                ...stub,
                Platform: { ...stub.Platform, OS: 'ios' },
                InteractionManager: undefined,
            };
        });
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const fn = vi.fn();
        const cancel = runAfterInteractionsWithFallback(fn);

        await drainMicrotasks();
        expect(fn).toHaveBeenCalledTimes(0);

        await runMacrotask();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(() => cancel()).not.toThrow();
    });
});

describe('runAfterInteractionsWithFallback on web', () => {
    it('yields a macrotask rather than running synchronously or at the microtask checkpoint', async () => {
        mockReactNativeWithShippedInteractionManager('web');
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const order: string[] = [];
        runAfterInteractionsWithFallback(() => order.push('deferred'));

        expect(order).toEqual([]);
        await drainMicrotasks();
        expect(order).toEqual([]);

        await runMacrotask();
        expect(order).toEqual(['deferred']);
    });

    it('cancels the pending macrotask', async () => {
        mockReactNativeWithShippedInteractionManager('web');
        const { runAfterInteractionsWithFallback } = await import('./runAfterInteractionsWithFallback');

        const fn = vi.fn();
        const cancel = runAfterInteractionsWithFallback(fn);
        cancel();

        await runMacrotask();
        await runMacrotask();
        expect(fn).not.toHaveBeenCalled();
    });
});
