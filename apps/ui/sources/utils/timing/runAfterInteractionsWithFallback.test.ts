import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Scheduling model of the mocked boundary — React Native 0.81.5, New Architecture (bridgeless).
 * Verified in `node_modules` rather than assumed:
 *
 * - `ReactNativeFeatureFlags.disableInteractionManager` defaults to `true`
 *   (`react-native/src/private/featureflags/ReactNativeFeatureFlags.js`), so the `InteractionManager`
 *   export resolves to `InteractionManagerStub` (`react-native/Libraries/Interaction/InteractionManager.js`).
 * - `InteractionManagerStub.runAfterInteractions` schedules the task with `setImmediate`.
 * - Bridgeless RN polyfills `setImmediate` onto `global.queueMicrotask`
 *   (`react-native/Libraries/Core/setUpTimers.js` -> `Libraries/Core/Timers/immediateShim.js`).
 *
 * So on native the callback runs in the *current* JS task's microtask checkpoint. It never yields to
 * layout/paint, it cannot be starved by interactions, and no timeout can ever beat it. The web path is
 * the deliberate opposite: `setTimeout(fn, 0)` is a real macrotask. These tests assert that difference
 * by ordering the callback against an already-queued timer, so they fail if either platform silently
 * adopts the other's scheduling.
 */

type ReactNativeMockOptions = Readonly<{
    os: 'web' | 'ios';
    /** Model an environment where `InteractionManager` is missing/unusable. */
    throwOnSchedule?: boolean;
    /**
     * Records `task.cancel()` calls but deliberately still fires the callback, so the tests prove the
     * helper's own guard prevents a cancelled callback rather than leaning on the platform handle.
     */
    onCancel?: () => void;
}>;

function mockReactNative(options: ReactNativeMockOptions): void {
    vi.doMock('react-native', async () => {
        const stub = await import('@/dev/reactNativeStub');
        return {
            ...stub,
            Platform: { ...stub.Platform, OS: options.os },
            InteractionManager: {
                runAfterInteractions: (task: () => void) => {
                    if (options.throwOnSchedule) throw new Error('InteractionManager unavailable');
                    queueMicrotask(task);
                    return { cancel: () => options.onCancel?.() };
                },
            },
        };
    });
}

function nextMacrotask(): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

async function importHelper() {
    const module = await import('./runAfterInteractionsWithFallback');
    return module.runAfterInteractionsWithFallback;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.clearAllMocks();
});

describe('runAfterInteractionsWithFallback', () => {
    it('web: yields a real macrotask, running after an already-queued timer', async () => {
        mockReactNative({ os: 'web' });
        const runAfterInteractionsWithFallback = await importHelper();

        const order: string[] = [];
        setTimeout(() => order.push('queued-timer'), 0);
        runAfterInteractionsWithFallback(() => order.push('deferred'));

        await Promise.resolve();
        expect(order).toEqual([]);

        await nextMacrotask();
        expect(order).toEqual(['queued-timer', 'deferred']);
    });

    it('web: cancel prevents the callback', async () => {
        mockReactNative({ os: 'web' });
        const runAfterInteractionsWithFallback = await importHelper();

        const fn = vi.fn();
        runAfterInteractionsWithFallback(fn)();

        await nextMacrotask();
        expect(fn).not.toHaveBeenCalled();
    });

    it('native: runs in the current JS task, before an already-queued macrotask', async () => {
        mockReactNative({ os: 'ios' });
        const runAfterInteractionsWithFallback = await importHelper();

        const order: string[] = [];
        setTimeout(() => order.push('queued-timer'), 0);
        runAfterInteractionsWithFallback(() => order.push('deferred'));

        await Promise.resolve();
        expect(order).toEqual(['deferred']);

        await nextMacrotask();
        expect(order).toEqual(['deferred', 'queued-timer']);
    });

    it('native: leaves no pending timer behind', async () => {
        mockReactNative({ os: 'ios' });
        const runAfterInteractionsWithFallback = await importHelper();

        const fn = vi.fn();
        vi.useFakeTimers();
        runAfterInteractionsWithFallback(fn);

        expect(vi.getTimerCount()).toBe(0);

        await Promise.resolve();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('native: cancel releases the platform handle and prevents a callback that still fires', async () => {
        const onCancel = vi.fn();
        mockReactNative({ os: 'ios', onCancel });
        const runAfterInteractionsWithFallback = await importHelper();

        const fn = vi.fn();
        runAfterInteractionsWithFallback(fn)();

        expect(onCancel).toHaveBeenCalledTimes(1);

        await Promise.resolve();
        await nextMacrotask();
        expect(fn).not.toHaveBeenCalled();
    });

    it('native: falls back to a macrotask when InteractionManager is unusable', async () => {
        mockReactNative({ os: 'ios', throwOnSchedule: true });
        const runAfterInteractionsWithFallback = await importHelper();

        const fn = vi.fn();
        const cancel = runAfterInteractionsWithFallback(fn);

        await Promise.resolve();
        expect(fn).not.toHaveBeenCalled();

        await nextMacrotask();
        expect(fn).toHaveBeenCalledTimes(1);

        const cancelled = vi.fn();
        runAfterInteractionsWithFallback(cancelled)();
        await nextMacrotask();
        expect(cancelled).not.toHaveBeenCalled();
        expect(() => cancel()).not.toThrow();
    });
});
