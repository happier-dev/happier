import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit';

import { useNowMs } from './useNowMs';

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

type TimerSpy = Readonly<{ mock: { calls: readonly (readonly unknown[])[] } }>;

function countIntervalsAt(spy: TimerSpy, delayMs: number): number {
    return spy.mock.calls.filter((call) => call[1] === delayMs).length;
}

function installVisibilityDocument() {
    const listeners = new Set<() => void>();
    const stub = {
        visibilityState: 'visible',
        addEventListener: (event: string, listener: () => void) => {
            if (event === 'visibilitychange') listeners.add(listener);
        },
        removeEventListener: (event: string, listener: () => void) => {
            listeners.delete(listener);
        },
    };
    (globalThis as any).document = stub;
    return {
        setVisibility(state: 'visible' | 'hidden') {
            stub.visibilityState = state;
        },
        emitVisibilityChange() {
            for (const listener of [...listeners]) listener();
        },
    };
}

describe('useNowMs', () => {
    beforeEach(() => {
        runtimeState.appState = 'active';
        vi.useFakeTimers();
        // Pin the wall clock so initial value is deterministic.
        vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('returns the current Date.now() on mount', async () => {
        const expected = Date.now();
        const hook = await renderHook(() => useNowMs());
        expect(hook.getCurrent()).toBe(expected);
        await hook.unmount();
    });

    it('ticks at the configured interval (default 60_000ms)', async () => {
        const hook = await renderHook(() => useNowMs());
        const initial = hook.getCurrent();

        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(hook.getCurrent()).toBe(initial + 60_000);

        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(hook.getCurrent()).toBe(initial + 120_000);
        await hook.unmount();
    });

    it('respects a custom intervalMs argument', async () => {
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        // No tick yet — interval has not elapsed.
        expect(hook.getCurrent()).toBe(initial);

        await act(async () => {
            vi.advanceTimersByTime(500);
        });
        expect(hook.getCurrent()).toBe(initial + 1_000);
        await hook.unmount();
    });

    it('rebinds the interval when intervalMs changes (cleans up the previous timer)', async () => {
        const hook = await renderHook(({ interval }: { interval: number }) => useNowMs(interval), {
            initialProps: { interval: 60_000 },
        });
        const initial = hook.getCurrent();

        await hook.rerender({ interval: 1_000 });

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(hook.getCurrent()).toBe(initial + 1_000);
        await hook.unmount();
    });

    it('cleans up the interval on unmount (no further ticks fire)', async () => {
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        await hook.unmount();

        await act(async () => {
            vi.advanceTimersByTime(10_000);
        });

        // After unmount the captured value never advances because the interval was cleared.
        expect(hook.getCurrent()).toBe(initial);
    });
});

describe('useNowMs shared bucket store', () => {
    beforeEach(() => {
        runtimeState.appState = 'active';
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('runs one timer for every subscriber sharing an interval bucket', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const first = await renderHook(() => useNowMs(1_000));
        const second = await renderHook(() => useNowMs(1_000));
        const third = await renderHook(() => useNowMs(1_000));

        expect(countIntervalsAt(setIntervalSpy, 1_000)).toBe(1);

        await first.unmount();
        await second.unmount();
        await third.unmount();
    });

    it('keeps one independent timer per interval bucket', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const fast = await renderHook(() => useNowMs(1_000));
        const slow = await renderHook(() => useNowMs(5_000));
        const fastInitial = fast.getCurrent();
        const slowInitial = slow.getCurrent();

        expect(countIntervalsAt(setIntervalSpy, 1_000)).toBe(1);
        expect(countIntervalsAt(setIntervalSpy, 5_000)).toBe(1);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });

        // The buckets are independent: the 1s bucket ticked, the 5s bucket did not.
        expect(fast.getCurrent()).toBe(fastInitial + 1_000);
        expect(slow.getCurrent()).toBe(slowInitial);

        await fast.unmount();
        await slow.unmount();
    });

    it('reports the same instant to a subscriber that joins mid-bucket', async () => {
        const first = await renderHook(() => useNowMs(1_000));
        const initial = first.getCurrent();

        // Land between ticks: the bucket last ticked at +3_000, the wall clock reads +3_500.
        await act(async () => {
            vi.advanceTimersByTime(3_500);
        });
        expect(first.getCurrent()).toBe(initial + 3_000);

        const second = await renderHook(() => useNowMs(1_000));

        // A late joiner adopts the shared instant instead of sampling its own Date.now(),
        // so two rows never render elapsed times one second apart.
        expect(second.getCurrent()).toBe(first.getCurrent());

        await first.unmount();
        await second.unmount();
    });

    it('keeps the shared timer until the last subscriber leaves, then clears it exactly once', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

        const first = await renderHook(() => useNowMs(1_000));
        const second = await renderHook(() => useNowMs(1_000));
        const intervalCall = setIntervalSpy.mock.calls.findIndex((call) => call[1] === 1_000);
        const intervalId = setIntervalSpy.mock.results[intervalCall]?.value;

        await first.unmount();
        expect(clearIntervalSpy.mock.calls.filter((call) => call[0] === intervalId)).toHaveLength(0);

        const beforeLastLeave = second.getCurrent();
        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(second.getCurrent()).toBe(beforeLastLeave + 1_000);

        await second.unmount();
        expect(clearIntervalSpy.mock.calls.filter((call) => call[0] === intervalId)).toHaveLength(1);
    });

    it('starts a fresh timer once a released bucket is subscribed again', async () => {
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

        const first = await renderHook(() => useNowMs(1_000));
        await first.unmount();

        const second = await renderHook(() => useNowMs(1_000));
        const initial = second.getCurrent();

        expect(countIntervalsAt(setIntervalSpy, 1_000)).toBe(2);

        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(second.getCurrent()).toBe(initial + 1_000);

        await second.unmount();
    });
});

describe('useNowMs runtime gating', () => {
    beforeEach(() => {
        runtimeState.appState = 'active';
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-12T00:00:00.000Z'));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('does not tick while the document is hidden and catches up when it becomes visible', async () => {
        const visibility = installVisibilityDocument();
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        visibility.setVisibility('hidden');
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(hook.getCurrent()).toBe(initial);

        visibility.setVisibility('visible');
        await act(async () => {
            visibility.emitVisibilityChange();
        });
        expect(hook.getCurrent()).toBe(initial + 5_000);

        await hook.unmount();
    });

    it('does not tick while the app is backgrounded', async () => {
        const hook = await renderHook(() => useNowMs(1_000));
        const initial = hook.getCurrent();

        runtimeState.appState = 'background';
        await act(async () => {
            vi.advanceTimersByTime(5_000);
        });
        expect(hook.getCurrent()).toBe(initial);

        runtimeState.appState = 'active';
        await act(async () => {
            vi.advanceTimersByTime(1_000);
        });
        expect(hook.getCurrent()).toBe(initial + 6_000);

        await hook.unmount();
    });
});
