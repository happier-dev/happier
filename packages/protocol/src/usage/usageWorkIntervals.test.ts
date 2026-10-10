import { describe, expect, it } from 'vitest';
import { projectUsageWorkIntervals, type UsageWorkIntervalFact } from './usageWorkIntervals.js';

const at = (value: string) => Date.parse(value);
const period = { startMs: at('2026-07-01T22:00:00Z'), endMs: at('2026-07-02T22:00:00Z') };
const busy = (workId: string, start: string, end: string | null, machineId = 'a'): UsageWorkIntervalFact => ({
    workId, machineId, agentId: 'agent', evidenceId: workId, kind: 'busy',
    startMs: at(start), endMs: end === null ? null : at(end),
});

describe('projectUsageWorkIntervals', () => {
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
