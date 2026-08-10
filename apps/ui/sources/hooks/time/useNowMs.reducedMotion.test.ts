import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

import { useNowMs } from './useNowMs';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

/**
 * The reduced-motion preference is read from the real platform boundary (`window.matchMedia`) so
 * `useReducedMotionPreference` runs for real underneath. Its store latches the first value it
 * reads, so the query must exist before the first render in this file — hence a whole file pinned
 * to "reduce motion is on".
 */
function installReducedMotionMediaQuery(): void {
    (globalThis as any).window = {
        matchMedia: (query: string) => ({
            matches: query.includes('prefers-reduced-motion'),
            addEventListener: () => {},
            removeEventListener: () => {},
        }),
    };
}

describe('useNowMs under reduced motion', () => {
    beforeEach(() => {
        installReducedMotionMediaQuery();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('uses the cadence the caller requested for reduced motion', async () => {
        const hook = await renderHook(() => useNowMs(1_000, { reducedMotionIntervalMs: 60_000 }));
        const initial = hook.getCurrent();

        await act(async () => {
            vi.advanceTimersByTime(59_000);
        });
        expect(hook.getCurrent()).toBe(initial);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(hook.getCurrent()).toBe(initial + 60_000);

        await hook.unmount();
    });

    it('leaves the cadence untouched when the caller requests no reduced-motion override', async () => {
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });

        // The clock owns no reduced-motion policy of its own: without an explicit request the
        // caller's cadence is the cadence.
        expect(hook.getCurrent()).toBe(initial + 1_000);

        await hook.unmount();
    });

    it('shares the reduced-motion bucket rather than the requested one', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const first = await renderHook(() => useNowMs(1_000, { reducedMotionIntervalMs: 60_000 }));
        const second = await renderHook(() => useNowMs(1_000, { reducedMotionIntervalMs: 60_000 }));

        expect(setIntervalSpy.mock.calls.filter((call) => call[1] === 60_000)).toHaveLength(1);
        expect(setIntervalSpy.mock.calls.filter((call) => call[1] === 1_000)).toHaveLength(0);

        await first.unmount();
        await second.unmount();
    });
});
