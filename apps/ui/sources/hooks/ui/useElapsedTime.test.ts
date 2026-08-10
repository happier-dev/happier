import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit';

import { useElapsedTime } from './useElapsedTime';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const runtimeState = vi.hoisted(() => ({
    appState: 'active' as 'active' | 'background',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        AppState: {
            get currentState() {
                return runtimeState.appState;
            },
        },
    });
});

const START_MS = Date.parse('2026-05-12T00:00:00.000Z');

function countIntervalsAt(spy: { mock: { calls: readonly (readonly unknown[])[] } }, delayMs: number): number {
    return spy.mock.calls.filter((call) => call[1] === delayMs).length;
}

/**
 * A running tool card shows a live elapsed value, and a streaming transcript can hold many of them.
 * The value is the contract; the timer behind it is not, and one `setInterval` per card is the
 * shape the shared clock exists to remove.
 */
describe('useElapsedTime', () => {
    beforeEach(() => {
        runtimeState.appState = 'active';
        vi.useFakeTimers();
        vi.setSystemTime(new Date(START_MS + 5_000));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('reports whole elapsed seconds and advances once a second', async () => {
        const hook = await renderHook(() => useElapsedTime(START_MS));

        expect(hook.getCurrent()).toBe(5);
        await act(async () => {
            vi.advanceTimersByTime(2_000);
        });
        expect(hook.getCurrent()).toBe(7);

        await hook.unmount();
    });

    it('accepts a Date and clamps a future timestamp to zero', async () => {
        const withDate = await renderHook(() => useElapsedTime(new Date(START_MS)));
        expect(withDate.getCurrent()).toBe(5);
        await withDate.unmount();

        const future = await renderHook(() => useElapsedTime(START_MS + 60_000));
        expect(future.getCurrent()).toBe(0);
        await future.unmount();

        const missing = await renderHook(() => useElapsedTime(null));
        expect(missing.getCurrent()).toBe(0);
        await missing.unmount();
    });

    it('shares one timer across every consumer instead of one per card', async () => {
        const setInterval = vi.spyOn(globalThis, 'setInterval');

        const first = await renderHook(() => useElapsedTime(START_MS));
        const second = await renderHook(() => useElapsedTime(START_MS - 30_000));
        const third = await renderHook(() => useElapsedTime(START_MS - 90_000));

        expect(countIntervalsAt(setInterval, 1_000)).toBe(1);
        // Different start times, one clock: the readings still differ.
        expect(second.getCurrent()).toBe(35);
        expect(third.getCurrent()).toBe(95);

        await first.unmount();
        await second.unmount();
        await third.unmount();
    });

    it('stops advancing while the app is backgrounded', async () => {
        runtimeState.appState = 'background';

        const hook = await renderHook(() => useElapsedTime(START_MS));
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });

        // A backgrounded app re-rendering every running tool card once a second is pure waste. The
        // shared clock is gated on the runtime being active and catches up when it returns; the
        // per-component timer this replaced kept ticking all the way through.
        expect(hook.getCurrent()).toBe(5);

        await hook.unmount();
    });
});
