import { describe, expect, it } from 'vitest';
import { projectUsageWorkIntervals, summarizeUsageRunLengthObservations, type UsageWorkIntervalFact } from './usageWorkIntervals.js';

const at = (value: string) => Date.parse(value);
const period = { startMs: at('2026-07-01T22:00:00Z'), endMs: at('2026-07-02T22:00:00Z') };
const busy = (workId: string, start: string, end: string | null, machineId = 'a'): UsageWorkIntervalFact => ({
    workId, machineId, agentId: 'agent', evidenceId: workId, kind: 'busy',
    startMs: at(start), endMs: end === null ? null : at(end),
});

describe('anonymous run-length observations', () => {
    it('retains equal-value samples and Unknown, sharing exact quantiles without lifecycle identities or dates', () => {
        const observations = [
            { agentId: 'claude', durationMs: 400 }, { agentId: 'claude', durationMs: 100 },
            { agentId: 'claude', durationMs: 400 }, { agentId: 'claude', durationMs: 200 },
            { agentId: null, durationMs: 0 },
            ...[100, 1, 9, 2, 8, 3, 7, 4, 6, 5].map(durationMs => ({ agentId: 'codex', durationMs })),
        ];
        const summary = summarizeUsageRunLengthObservations(observations);
        expect(summary).toEqual({ sampleCount: 15, byAgent: [
            { agentId: null, sampleCount: 1, medianMs: 0, p90Ms: 0, durationsMs: [0] },
            { agentId: 'claude', sampleCount: 4, medianMs: 300, p90Ms: 400, durationsMs: [100, 200, 400, 400] },
            { agentId: 'codex', sampleCount: 10, medianMs: 5.5, p90Ms: 9, durationsMs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 100] },
        ] });
        expect(summarizeUsageRunLengthObservations([...observations].reverse())).toEqual(summary);
        expect(summarizeUsageRunLengthObservations([])).toEqual({ sampleCount: 0, byAgent: [] });
        expect(summarizeUsageRunLengthObservations([
            { agentId: 'claude', durationMs: Number.MAX_VALUE },
            { agentId: 'claude', durationMs: Number.MAX_VALUE },
        ]).byAgent[0]?.medianMs).toBe(Number.MAX_VALUE);
        expect(observations[0]).toEqual({ agentId: 'claude', durationMs: 400 });
    });

    it('refuses invalid duration values rather than silently changing the observed sample population', () => {
        for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => summarizeUsageRunLengthObservations([{ agentId: 'claude', durationMs }])).toThrow(RangeError);
        }
    });
});

describe('projectUsageWorkIntervals', () => {
    it('reuses immutable facts across equal option wrappers and alternating period views, then responds to changed facts', () => {
        let factPasses = 0;
        const facts = new Proxy([busy('one', '2026-07-02T08:00:00Z', '2026-07-02T10:00:00Z')], {
            get(target, property, receiver) {
                if (property === Symbol.iterator) factPasses += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        const activityAtMs = [at('2026-07-02T08:30:00Z')];
        const full = () => projectUsageWorkIntervals({ period: { ...period }, timeZoneOffsetMinutes: 120,
            facts, activityAtMs, nightHours: { startHour: 8, endHour: 10 } });
        const today = () => projectUsageWorkIntervals({ period: { startMs: at('2026-07-02T00:00:00Z'), endMs: period.endMs },
            timeZoneOffsetMinutes: 120, facts });
        const firstFull = full();
        const firstToday = today();
        expect(factPasses).toBe(2);
        for (let repeat = 0; repeat < 3; repeat += 1) {
            expect(full()).toBe(firstFull);
            expect(today()).toBe(firstToday);
        }
        expect(factPasses).toBe(2);
        const changed = projectUsageWorkIntervals({ period: { ...period }, timeZoneOffsetMinutes: 120,
            facts: [{ ...facts[0]!, endMs: at('2026-07-02T09:00:00Z') }], activityAtMs,
            nightHours: { startHour: 8, endHour: 10 } });
        expect(changed.agentTimeMs).toBe(3_600_000);
        expect(firstFull.agentTimeMs).toBe(7_200_000);
        expect(full()).toBe(firstFull);
        expect(factPasses).toBe(2);
        expect(firstFull.night?.activityCount).toBe(0);
        expect(projectUsageWorkIntervals({ period: { ...period }, timeZoneOffsetMinutes: 120, facts, activityAtMs,
            nightHours: { startHour: 10, endHour: 12 } }).night?.activityCount).toBe(1);
        expect(projectUsageWorkIntervals({ period: { ...period }, timeZoneOffsetMinutes: 0, facts, activityAtMs,
            nightHours: { startHour: 8, endHour: 10 } }).night?.activityCount).toBe(1);
        expect(projectUsageWorkIntervals({ period: { ...period }, timeZoneOffsetMinutes: 120, facts,
            activityAtMs: [...activityAtMs], nightHours: { startHour: 8, endHour: 10 } })).not.toBe(firstFull);
        expect(full()).toBe(firstFull);
        expect(today()).toBe(firstToday);
    });

    it('clips spanning work to the range and distinguishes agent sum from parallel elapsed union', () => {
        const result = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120, facts: [
            busy('one', '2026-07-01T21:00:00Z', '2026-07-02T00:00:00Z'),
            busy('two', '2026-07-01T23:00:00Z', '2026-07-02T01:00:00Z', 'b'),
        ] });
        expect(result.agentTimeMs).toBe(4 * 3_600_000);
        expect(result.elapsedBusyMs).toBe(3 * 3_600_000);
        expect(result.parallelBusyMs).toBe(3_600_000);
        expect(result.maxParallel).toBe(2);
        expect(result.calendarDays).toEqual([{ date: '2026-07-02', busyMs: 3 * 3_600_000, waitMs: 0 }]);
    });

    it('counts witnessed child work once across parent/child projections and subtracts paired waits', () => {
        const child = busy('child', '2026-07-02T08:00:00Z', '2026-07-02T10:00:00Z');
        const result = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120, facts: [
            { ...child, parentWorkId: 'parent' }, child,
            { ...child, kind: 'permission_wait', evidenceId: 'request', startMs: at('2026-07-02T08:30:00Z'), endMs: at('2026-07-02T09:00:00Z') },
        ] });
        expect(result.agentTimeMs).toBe(90 * 60_000);
        expect(result.elapsedBusyMs).toBe(90 * 60_000);
        expect(result.elapsedWaitMs).toBe(30 * 60_000);
        expect(result.maxParallel).toBe(1);
        expect(result.lanes).toHaveLength(1);
        expect(result.lanes[0]!.parentWorkId).toBe('parent');
    });

    it('never extends unknown terminal work to now or fabricates wait/device evidence', () => {
        const result = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120, facts: [
            busy('open', '2026-07-02T08:00:00Z', null),
            { ...busy('closed', '2026-07-02T09:00:00Z', '2026-07-02T10:00:00Z'), kind: 'permission_wait', evidenceId: 'unpaired', endMs: null },
        ] });
        expect(result.coverage).toBe('partial');
        expect(result.unknownEndCount).toBe(2);
        expect(result.elapsedBusyMs).toBe(0);
        expect(result.elapsedWaitMs).toBe(0);
    });

    it('uses stated local night hours and recorded activity instants, never token count as time', () => {
        const result = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120,
            nightHours: { startHour: 22, endHour: 6 }, facts: [
                busy('night', '2026-07-01T22:00:00Z', '2026-07-02T05:00:00Z'),
            ], activityAtMs: [at('2026-07-01T22:30:00Z'), at('2026-07-02T10:00:00Z')] });
        expect(result.night).toEqual({ startHour: 22, endHour: 6, busyMs: 6 * 3_600_000, activityCount: 1 });
        expect(result.weekdayHourBuckets.find(row => row.hour === 0)?.busyMs).toBe(3_600_000);
    });

    it('does not collapse distinct child work merely because a parent, machine or time coincides', () => {
        const result = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120, facts: [
            { ...busy('a', '2026-07-02T08:00:00Z', '2026-07-02T10:00:00Z'), parentWorkId: 'p' },
            { ...busy('b', '2026-07-02T08:00:00Z', '2026-07-02T10:00:00Z'), parentWorkId: 'p' },
        ] });
        expect(result.agentTimeMs).toBe(4 * 3_600_000);
        expect(result.elapsedBusyMs).toBe(2 * 3_600_000);
        expect(result.maxParallel).toBe(2);
    });
});
