import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installTimerCensus } from '@/dev/testkit/performance/timerCensus';
import { formatNextScheduledRun, readNextScheduledRunRefreshAtMs } from '@/components/workflows/triggers/formatTriggerSummary';
import { formatRelativeTimeShort, formatShortRelativeTimeAt, readRelativeTimeShortRefreshAtMs, readShortRelativeTimeRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

import {
    createSessionListRuntimeClock,
    SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS,
    useSessionListRelativeNowMs,
    useSessionListRuntimeDeadlineNowMs,
    useSessionListRuntimeNowMs,
    useSessionListRuntimeWake,
    type SessionListRuntimeClock,
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
    it('does not invoke 128 old-date subscribers or read their snapshots for ten recent-label boundaries', async () => {
        vi.useFakeTimers();
        const now = Date.parse('2026-09-30T12:00:00.000Z');
        vi.setSystemTime(now);
        const clock = createSessionListRuntimeClock();
        let oldCallbacks = 0, oldSnapshotReads = 0;
        // Observation-only forwarding adapter: all decisions, snapshots and
        // physical timer scheduling remain in this one real canonical clock.
        const oldClock: SessionListRuntimeClock = {
            ...clock,
            getNowMs: () => { oldSnapshotReads += 1; return clock.getNowMs(); },
            subscribe: listener => clock.subscribe(() => { oldCallbacks += 1; listener(); }),
            subscribeWake: (token, listener) => clock.subscribeWake(token, () => { oldCallbacks += 1; listener(); }),
        };
        const nextOldBoundary = () => now + 86_400_000;
        function OldDate() { return String(useSessionListRuntimeDeadlineNowMs(nextOldBoundary, true, oldClock)); }
        function RecentDate(props: { at: number }) {
            const next = React.useCallback((at: number) => readShortRelativeTimeRefreshAtMs(props.at, at), [props.at]);
            return String(useSessionListRuntimeDeadlineNowMs(next, true, clock));
        }
        const screen = await renderScreen(<>{Array.from({ length: 128 }, (_, index) => <OldDate key={index} />)}
            <RecentDate at={now - 50_000} /><RecentDate at={now - 20_000} /></>);
        oldCallbacks = 0; oldSnapshotReads = 0;
        for (const step of [10_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 20_000]) {
            await act(async () => { vi.advanceTimersByTime(step); });
        }
        expect(oldCallbacks).toBe(0);
        expect(oldSnapshotReads).toBe(0);
        expect(vi.getTimerCount()).toBe(1);
        await act(async () => screen.tree.unmount());
        expect(vi.getTimerCount()).toBe(0);
    });
    it('changes every visible minute label in one commit on the wall-clock minute, and keeps hour-old rows off the minute tick', async () => {
        vi.useFakeTimers();
        const now = Date.parse('2026-09-30T12:00:20.000Z');
        vi.setSystemTime(now);
        const clock = createSessionListRuntimeClock();
        let hourRowRenders = 0;
        function MinuteLabel(props: { at: number }) {
            const next = React.useCallback((at: number) => readShortRelativeTimeRefreshAtMs(props.at, at), [props.at]);
            return formatShortRelativeTimeAt(props.at, useSessionListRuntimeDeadlineNowMs(next, true, clock));
        }
        function HourLabel(props: { at: number }) {
            hourRowRenders += 1;
            const next = React.useCallback((at: number) => readShortRelativeTimeRefreshAtMs(props.at, at), [props.at]);
            return formatShortRelativeTimeAt(props.at, useSessionListRuntimeDeadlineNowMs(next, true, clock));
        }
        let commits = 0;
        // 26 rows active at different seconds of the last minutes, as a freshly seeded list (iOS idle bed).
        const minuteRows = Array.from({ length: 26 }, (_, index) => now - 120_000 - index * 2_300);
        const screen = await renderScreen(<React.Profiler id="rows" onRender={() => { commits += 1; }}>
            {minuteRows.map((at) => <MinuteLabel key={at} at={at} />)}
            <HourLabel at={now - 2 * 3_600_000 - 5_000} />
        </React.Profiler>);
        commits = 0; hourRowRenders = 0;
        const before = minuteRows.map((at) => formatShortRelativeTimeAt(at, now));
        // One act per second, so separate timer fires cannot be batched into one commit by the test itself.
        for (let step = 0; step < 180; step += 1) await act(async () => { vi.advanceTimersByTime(1_000); });
        // Three wall-clock minutes passed (12:01, 12:02, 12:03): one commit each, every label moved.
        expect(commits).toBe(3);
        expect(minuteRows.map((at) => formatShortRelativeTimeAt(at, Date.now()))).not.toEqual(before);
        expect(hourRowRenders).toBe(0);
        await act(async () => screen.tree.unmount());
    });

    it('keeps distant display deadlines within the platform timer range without expiring them early', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const timers = vi.spyOn(globalThis, 'setTimeout');
        const target = 1_000 + 40 * 86_400_000;
        const status = await renderHook(() => useSessionListRuntimeDeadlineNowMs(
            now => now < target ? target : null, true, clock));
        try {
            expect(timers.mock.calls.map(([, delay]) => delay)).toEqual([2_147_483_647]);
            await flushHookEffects({ advanceTimersMs: 2_147_483_647, cycles: 1, turns: 2 });
            expect(status.getCurrent()).toBe(1_000);
            await flushHookEffects({ advanceTimersMs: target - Date.now(), cycles: 1, turns: 2 });
            expect(status.getCurrent()).toBe(target);
        } finally { await status.unmount(); timers.mockRestore(); }
    });
    it('retains one canonical instant for local-only observers, then refreshes after their last unsubscribe', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const next = (nowMs: number) => nowMs < 2_000 ? 2_000 : null;
        const status = await renderHook(() => useSessionListRuntimeDeadlineNowMs(next, true, clock));
        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(status.getCurrent()).toBe(2_000);
        expect(vi.getTimerCount()).toBe(0);
        vi.setSystemTime(5_000);
        expect(clock.getNowMs()).toBe(2_000);
        await status.unmount();
        vi.setSystemTime(50_000);
        expect(clock.getNowMs()).toBe(50_000);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('keeps settled Home row observers timer-free until a named consumer requests a deadline', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const census = installTimerCensus(stack => /[\\/]sessionListRuntimeClock\.ts:/.test(stack)
            ? 'session-list requested deadline' : null);
        const observer = await renderHook(() => useSessionListRuntimeNowMs(true, clock));
        try {
            // Baseline: a mounted observer with no freshness deadline owns zero
            // timers. No timing/noise margin applies to a fake-timer census.
            expect(census.read()).toEqual([]);
            expect(vi.getTimerCount()).toBe(0);
            const relativeAgeRow = {};
            clock.requestWake(relativeAgeRow, 2_000);
            expect(census.read()).toEqual([{
                kind: 'timeout', delayMs: 1_000, consumer: 'session-list requested deadline',
            }]);
            clock.clearWake(relativeAgeRow);
            expect(census.read()).toEqual([]);
            await flushHookEffects({ advanceTimersMs: 300_000, cycles: 1, turns: 2 });
            expect(observer.getCurrent()).toBe(1_000);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            await observer.unmount();
            census.stop();
        }
    });
    it('scopes a list read/wake pair to its own deadline and clears it on unmount', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const clock = createSessionListRuntimeClock();
        const listToken = {};
        const machineToken = {};
        let renders = 0;
        const list = await renderHook(({ wakeAtMs }: { wakeAtMs: number }) => {
            renders += 1;
            const now = useSessionListRuntimeNowMs(true, clock, listToken);
            useSessionListRuntimeWake(wakeAtMs, true, clock, listToken);
            return now;
        }, { initialProps: { wakeAtMs: 3_000 } });
        const before = renders;
        clock.requestWake(machineToken, 2_000);
        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(renders).toBe(before);
        expect(list.getCurrent()).toBe(1_000);
        await flushHookEffects({ advanceTimersMs: 1_000, cycles: 1, turns: 2 });
        expect(list.getCurrent()).toBe(3_000);
        expect(renders).toBe(before + 1);
        await list.rerender({ wakeAtMs: 5_000 });
        expect(vi.getTimerCount()).toBe(1);
        await list.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('refreshes rounded occurrences and floor ages independently while unrelated subscribers stay stable', async () => {
        vi.useFakeTimers();
        const now = new Date(2026, 9, 10, 10, 0, 30).getTime();
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
            // The cadence wakes on the wall-clock minute (requested at 60 s; the fake clock fires its 59 s delay
            // after the 500 ms system-time jump), not a rolling minute after the first mount (61.5 s).
            expect(firstRow.getCurrent()).toBeGreaterThanOrEqual(SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS);
            expect(firstRow.getCurrent()).toBeLessThan(1_500 + SESSION_LIST_RELATIVE_TIME_CLOCK_INTERVAL_MS);
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
