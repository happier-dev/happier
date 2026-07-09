import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

import {
    createSessionListRuntimeClock,
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
} from './sessionListRuntimeClock';

afterEach(() => {
    standardCleanup();
    vi.useRealTimers();
});

function useClockConsumer(params: {
    clock: ReturnType<typeof createSessionListRuntimeClock>;
    wakeAtMs: number | null;
    enabled: boolean;
}): number {
    const nowMs = useSessionListRuntimeNowMs(params.enabled, params.clock);
    useSessionListRuntimeWake(params.wakeAtMs, params.enabled, params.clock);
    return nowMs;
}

describe('sessionListRuntimeClock', () => {
    it('advances all subscribers together at the earliest requested wake time', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();

        const early = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 2_000, enabled: true } },
        );
        const late = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 5_000, enabled: true } },
        );

        expect(early.getCurrent()).toBe(1_000);
        expect(late.getCurrent()).toBe(1_000);

        await flushHookEffects({ advanceTimersMs: 1_001, cycles: 1, turns: 2 });

        // Both consumers observe the SAME timestamp even though only the early
        // consumer requested this wake — this is the single-clock invariant.
        expect(early.getCurrent()).toBe(2_001);
        expect(late.getCurrent()).toBe(2_001);

        await early.unmount();
        await late.unmount();
    });

    it('keeps firing later wake requests after earlier ones are satisfied', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();

        const early = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 2_000, enabled: true } },
        );
        const late = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 5_000, enabled: true } },
        );

        await flushHookEffects({ advanceTimersMs: 1_001, cycles: 1, turns: 2 });
        expect(late.getCurrent()).toBe(2_001);

        await flushHookEffects({ advanceTimersMs: 3_000, cycles: 1, turns: 2 });
        expect(early.getCurrent()).toBe(5_001);
        expect(late.getCurrent()).toBe(5_001);

        await early.unmount();
        await late.unmount();
    });

    it('does not schedule wakes or tick for disabled consumers', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();

        const frozen = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 1_500, enabled: false } },
        );

        expect(frozen.getCurrent()).toBe(1_000);

        await flushHookEffects({ advanceTimersMs: 2_000, cycles: 1, turns: 2 });

        // Disabled consumer requested nothing, so the clock never fired.
        expect(frozen.getCurrent()).toBe(1_000);

        await frozen.rerender({ wakeAtMs: 3_500, enabled: true });
        await flushHookEffects({ cycles: 1, turns: 2 });
        await flushHookEffects({ advanceTimersMs: 501, cycles: 1, turns: 2 });

        expect(frozen.getCurrent()).toBe(3_501);

        await frozen.unmount();
    });

    it('clears wake requests on unmount so orphaned timers do not fire', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();

        const requester = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 2_000, enabled: true } },
        );
        const observer = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: null, enabled: true } },
        );

        await requester.unmount();

        await flushHookEffects({ advanceTimersMs: 1_500, cycles: 1, turns: 2 });

        // The only wake request was withdrawn on unmount — no fire happened.
        expect(observer.getCurrent()).toBe(1_000);

        await observer.unmount();
    });

    it('refreshes the idle timestamp for a new surface after all consumers unsubscribed', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();

        const first = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: null, enabled: true } },
        );
        expect(first.getCurrent()).toBe(1_000);
        await first.unmount();

        vi.setSystemTime(50_000);
        const second = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: null, enabled: true } },
        );

        // The idle-latch refresh happens on the READ path, so the remounted
        // surface sees current wall time without an extra render.
        expect(second.getCurrent()).toBe(50_000);

        await second.unmount();
    });

    it('fires immediately for wake requests already in the past', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(9_500);
        const clock = createSessionListRuntimeClock();
        vi.setSystemTime(10_000);

        const consumer = await renderHook(
            (props: { wakeAtMs: number | null; enabled: boolean }) =>
                useClockConsumer({ clock, ...props }),
            { initialProps: { wakeAtMs: 9_000, enabled: true } },
        );

        // Subscribe refreshes the clock to the current wall time on mount.
        expect(consumer.getCurrent()).toBe(10_000);

        await flushHookEffects({ advanceTimersMs: 2, cycles: 1, turns: 2 });

        // The past-time request fired immediately (delay 0) and was consumed
        // without re-arming: the clock stays put on further timer advances.
        expect(consumer.getCurrent()).toBe(10_000);
        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(consumer.getCurrent()).toBe(10_000);

        await consumer.unmount();
    });
});
