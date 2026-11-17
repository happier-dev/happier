import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDatabaseActivityController } from './activityController';

// The engine read transport and platform AppState are genuine boundaries. The controller and
// shared scheduler stay real, so these counts observe reads rather than internal wiring.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) } });
});

describe('database Activity presented demand', () => {
    const releases: Array<() => void> = [];
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        for (const release of releases.splice(0)) release();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('reads at the retained interval, shares demand and has zero reads after hide or close', async () => {
        const read = vi.fn(async () => ({ backends: 1 }));
        const controller = createDatabaseActivityController({ read });
        const stopA = controller.retainAutoRefresh({ intervalMs: 5000 });
        const stopB = controller.retainAutoRefresh({ intervalMs: 5000 });
        releases.push(stopA, stopB);
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(13); // Initial read plus 60_000 / interval.
        stopA();
        stopB();
        await controller.refresh(); // A stale gesture after hiding cannot admit another read.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(13);
    });

    it('joins a pending manual or automatic read and preserves the last result after a typed failure', async () => {
        let resolve!: (value: { backends: number }) => void;
        const read = vi.fn<() => Promise<{ backends: number }>>()
            .mockImplementationOnce(() => new Promise((done) => { resolve = done; }))
            .mockRejectedValueOnce(Object.assign(new Error('Target disconnected'), { code: 'database_connection_lost' }))
            .mockResolvedValue({ backends: 2 });
        const controller = createDatabaseActivityController({ read });
        releases.push(controller.retainAutoRefresh({ intervalMs: 5000 }));
        await vi.advanceTimersByTimeAsync(0);
        const manual = controller.refresh();
        await vi.advanceTimersByTimeAsync(20_000);
        expect(read).toHaveBeenCalledTimes(1);
        resolve({ backends: 1 });
        await manual;
        expect(controller.getSnapshot()).toMatchObject({ value: { backends: 1 }, loading: false, error: null });
        await vi.advanceTimersByTimeAsync(5000);
        expect(controller.getSnapshot()).toMatchObject({ value: { backends: 1 }, loading: false,
            error: { code: 'database_connection_lost' } });
        await controller.refresh();
        expect(controller.getSnapshot()).toMatchObject({ value: { backends: 2 }, loading: false, error: null });
    });

    it.each([false, true])('keeps manual Refresh available with automatic refresh disabled (initial failure: %s)', async (initialFailure) => {
        const read = vi.fn(async () => ({ backends: 3 }));
        const failure = Object.assign(new Error('Target disconnected'), { code: 'database_connection_lost' });
        if (initialFailure) read.mockRejectedValueOnce(failure);
        const controller = createDatabaseActivityController({ read });
        releases.push(controller.retainAutoRefresh({ intervalMs: 0 }));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(1);
        expect(controller.getSnapshot().error).toBe(initialFailure ? failure : null);
        expect(vi.getTimerCount()).toBe(0);
        await controller.refresh();
        expect(read).toHaveBeenCalledTimes(2);
        expect(controller.getSnapshot()).toMatchObject({ value: { backends: 3 }, error: null });
    });

    it('continues the visible Activity cadence when the window is unfocused', async () => {
        vi.stubGlobal('document', { visibilityState: 'visible', hasFocus: () => false });
        const read = vi.fn(async () => ({ backends: 1 }));
        const controller = createDatabaseActivityController({ read });
        releases.push(controller.retainAutoRefresh({ intervalMs: 5000 }));
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(13);
    });

    it.each([[2000, 5000], [7000, 10000]])('keeps scheduled ticks after a %dms read without catching up missed ticks', async (durationMs, nextReadAtMs) => {
        let finish!: (value: { backends: number }) => void;
        const read = vi.fn<() => Promise<{ backends: number }>>()
            .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
            .mockResolvedValue({ backends: 2 });
        const controller = createDatabaseActivityController({ read });
        releases.push(controller.retainAutoRefresh({ intervalMs: 5000 }));
        await vi.advanceTimersByTimeAsync(0);
        const pending = controller.refresh();
        await vi.advanceTimersByTimeAsync(durationMs);
        expect(read).toHaveBeenCalledTimes(1);
        finish({ backends: 1 });
        await pending;
        await vi.advanceTimersByTimeAsync(nextReadAtMs - durationMs - 1);
        expect(read).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(read).toHaveBeenCalledTimes(2);
    });

    it('cancels a retired consumer and does not publish its late result after the pane closes', async () => {
        let finish!: (value: { backends: number }) => void;
        let signal: AbortSignal | undefined;
        const read = vi.fn(async (options: { signal: AbortSignal }) => {
            signal = options.signal;
            return new Promise<{ backends: number }>((resolve) => { finish = resolve; });
        });
        const controller = createDatabaseActivityController({ read });
        const stop = controller.retainAutoRefresh({ intervalMs: 5000 });
        releases.push(stop);
        await vi.advanceTimersByTimeAsync(0);
        expect(read).toHaveBeenCalledTimes(1);
        const pending = controller.refresh();
        stop();
        expect(signal?.aborted).toBe(true);
        finish({ backends: 8 });
        await pending;
        expect(controller.getSnapshot()).toEqual({ value: null, loading: false, error: null });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(read).toHaveBeenCalledTimes(1);
    });
});
