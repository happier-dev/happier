import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { formatNextScheduledRun, readNextScheduledRunRefreshAtMs } from '@/components/workflows/triggers/formatTriggerSummary';
import { formatRelativeTimeShort, readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

import {
    createSessionListRuntimeClock,
    SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS,
    useSessionListRelativeNowMs,
    useSessionListRuntimeDeadlineNowMs,
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
    it('refreshes rounded occurrences and floor ages independently while unrelated subscribers stay stable', async () => {
        vi.useFakeTimers();
        const now = new Date(2026, 9, 10, 10).getTime();
        vi.setSystemTime(now);
        const clock = createSessionListRuntimeClock();
        const next = now + 120_000;
        const started = now - 90_000;
        const readNextOccurrence = (at: number) => readNextScheduledRunRefreshAtMs(next, at);
        const readNextAge = (at: number) => readRelativeTimeShortRefreshAtMs(started, at);
        const noDeadline = () => null;
        let idleRenders = 0;
        const idle = await renderHook(() => {
            idleRenders += 1;
            return useSessionListRuntimeDeadlineNowMs(noDeadline, true, clock);
        });
        const occurrence = await renderHook(() => formatNextScheduledRun(next, true,
            useSessionListRuntimeDeadlineNowMs(readNextOccurrence, true, clock)));
        const age = await renderHook(() => formatRelativeTimeShort(started,
            useSessionListRuntimeDeadlineNowMs(readNextAge, true, clock)));
        const before = idleRenders;
        const firstOccurrence = occurrence.getCurrent();
        const firstAge = age.getCurrent();
        await flushHookEffects({ advanceTimersMs: 30_000, cycles: 1, turns: 2 });
        expect(age.getCurrent()).not.toBe(firstAge);
        expect(occurrence.getCurrent()).toBe(firstOccurrence);
        await flushHookEffects({ advanceTimersMs: 1, cycles: 1, turns: 2 });
        expect(occurrence.getCurrent()).not.toBe(firstOccurrence);
        expect(idleRenders).toBe(before);
        expect(vi.getTimerCount()).toBe(1);
        await occurrence.unmount();
        await age.unmount();
        await idle.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('withdraws a status deadline while inactive and observes current time on re-enable', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const next = (nowMs: number) => nowMs < 2_000 ? 2_000 : null;
        let renders = 0;
        const status = await renderHook((props: { enabled: boolean }) => {
            renders += 1;
            return useSessionListRuntimeDeadlineNowMs(next, props.enabled, clock);
        }, { initialProps: { enabled: true } });
        await status.rerender({ enabled: false });
        const inactiveRenders = renders;
        expect(vi.getTimerCount()).toBe(0);
        await flushHookEffects({ advanceTimersMs: 2_000, cycles: 1, turns: 2 });
        expect(renders).toBe(inactiveRenders);
        expect(status.getCurrent()).toBe(1_000);
        await status.rerender({ enabled: true });
        expect(status.getCurrent()).toBe(3_000);
        expect(vi.getTimerCount()).toBe(0);
        await status.unmount();
    });

    it('keeps status consumers stable until their own deadlines and schedules the next boundary', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const readNextRefresh = (nowMs: number) => nowMs < 3_000 ? 3_000 : nowMs < 5_000 ? 5_000 : null;
        let renders = 0;
        const status = await renderHook(() => {
            renders += 1;
            return useSessionListRuntimeDeadlineNowMs(readNextRefresh, true, clock);
        });
        const before = renders;
        const otherSurface = {};
        clock.requestWake(otherSurface, 2_000);
        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(status.getCurrent()).toBe(1_000);
        expect(renders).toBe(before);
        expect(vi.getTimerCount()).toBe(1);
        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(status.getCurrent()).toBe(3_000);
        expect(vi.getTimerCount()).toBe(1);
        await flushHookEffects({ advanceTimersMs: 2_000, cycles: 1, turns: 2 });
        expect(status.getCurrent()).toBe(5_000);
        expect(vi.getTimerCount()).toBe(0);
        await status.unmount();
    });

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
        expect(vi.getTimerCount()).toBe(1);

        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });

        // Both consumers observe the SAME timestamp even though only the early
        // consumer requested this wake — this is the single-clock invariant.
        expect(early.getCurrent()).toBe(2_000);
        expect(late.getCurrent()).toBe(2_000);

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

        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(late.getCurrent()).toBe(2_000);

        await flushHookEffects({ advanceTimersMs: 3_000, cycles: 1, turns: 2 });
        expect(early.getCurrent()).toBe(5_000);
        expect(late.getCurrent()).toBe(5_000);

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
        await flushHookEffects({ advanceTimersMs: 500, cycles: 1, turns: 2 });

        expect(frozen.getCurrent()).toBe(3_500);

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

    describe('useSessionListRelativeNowMs', () => {
        it('renders every row from one timer and one instant', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(1_000);
            const clock = createSessionListRuntimeClock();

            const firstRow = await renderHook(() => useSessionListRelativeNowMs(true, clock));
            // A row mounted later must not carry a clock of its own reading a
            // different `Date.now()`: a list of N rows costs one timer, not N.
            vi.setSystemTime(1_500);
            const secondRow = await renderHook(() => useSessionListRelativeNowMs(true, clock));

            expect(vi.getTimerCount()).toBe(1);
            expect(firstRow.getCurrent()).toBe(1_000);
            expect(secondRow.getCurrent()).toBe(1_000);

            await flushHookEffects({
                advanceTimersMs: SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS,
                cycles: 1,
                turns: 2,
            });

            // One tick moved both rows to the SAME new instant. Under a
            // per-row timer each row ticks on its own mount offset and the two
            // labels disagree about "now" for the rest of the minute.
            expect(firstRow.getCurrent()).toBe(1_500 + SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS);
            expect(secondRow.getCurrent()).toBe(firstRow.getCurrent());
            expect(vi.getTimerCount()).toBe(1);

            await firstRow.unmount();
            await secondRow.unmount();
        });

        it('stops the cadence while disabled and re-syncs to wall time on re-enable', async () => {
            vi.useFakeTimers();
            vi.setSystemTime(1_000);
            const clock = createSessionListRuntimeClock();

            const row = await renderHook(
                (props: { enabled: boolean }) => useSessionListRelativeNowMs(props.enabled, clock),
                { initialProps: { enabled: false } },
            );

            expect(row.getCurrent()).toBe(1_000);

            vi.setSystemTime(400_000);
            await flushHookEffects({ advanceTimersMs: 0, cycles: 1, turns: 2 });

            // Disabled: no timer was armed while the surface was inactive.
            expect(vi.getTimerCount()).toBe(0);
            expect(row.getCurrent()).toBe(1_000);

            await row.rerender({ enabled: true });
            await flushHookEffects({ cycles: 1, turns: 2 });
            await flushHookEffects({ advanceTimersMs: 2, cycles: 1, turns: 2 });

            // Re-enabling re-syncs to current wall time rather than resuming
            // from the instant the surface was frozen at: the horizon carried
            // over from the frozen instant is already in the past, so the
            // shared clock catches up on the first tick after re-enable.
            expect(row.getCurrent()).toBe(400_000);

            await row.unmount();
        });
    });
});
