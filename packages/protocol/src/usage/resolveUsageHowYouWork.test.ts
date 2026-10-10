import { describe, expect, it } from 'vitest';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema } from './resolveUsageHowYouWork.js';

const hour = 3_600_000;
const day = Date.parse('2026-10-09T00:00:00Z');
const fact = (workId: string, startMs: number, endMs: number) => ({
    workId, evidenceId: workId, agentId: 'agent', machineId: workId,
    kind: 'busy' as const, startMs, endMs,
});

describe('How-you-work admitted projection', () => {
    it('retains native night activity when private lifecycle duration is unavailable', () => {
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            nightHours: { startHour: 22, endHour: 6 }, accounting: { v: 1, totals: { eventCount: 7,
                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
                activity: { weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }] } } });
        expect(result).toMatchObject({ detailStatus: 'unknown', intervals: null,
            nightShift: { startHour: 22, endHour: 6, recordedActivityCount: 7, observedBusyMs: null } });
        expect(UsageHowYouWorkSchema.safeParse({ ...result,
            nightShift: { ...result.nightShift, observedBusyMs: 1 } }).success).toBe(false);
    });
    it('uses admitted recorded activity rather than turn starts as the native night activity basis', () => {
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            nightHours: { startHour: 22, endHour: 6 }, accounting: { v: 1, totals: { eventCount: 7,
                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
                activity: { weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }] } },
            detail: { status: 'partial', facts: [fact('night', day, day + hour)], permissions: [], acceptedInputs: [], activityAtMs: [day] } });
        expect(result.intervals?.night).toMatchObject({ busyMs: hour, activityCount: 7 });
        const withoutActivity = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            nightHours: { startHour: 22, endHour: 6 }, accounting: { v: 1, totals: { eventCount: 7,
                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } },
            detail: { status: 'partial', facts: [fact('night', day, day + hour)], permissions: [], acceptedInputs: [], activityAtMs: [day] } });
        expect(withoutActivity.intervals?.night).toMatchObject({ busyMs: hour, activityCount: null });
    });
    it('does not manufacture a zero night activity count when event evidence is absent', () => {
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'partial',
                facts: [fact('night', day, day + hour)], permissions: [], acceptedInputs: [] } });
        expect(result.intervals?.night).toMatchObject({ busyMs: hour, activityCount: null });
    });
    it('rejects private detail relabelled as unknown at the public result boundary', () => {
        const known = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            detail: { status: 'partial', facts: [fact('private-work', day, day + hour)], permissions: [], acceptedInputs: [] } });
        expect(UsageHowYouWorkSchema.safeParse({ ...known, detailStatus: 'unknown' }).success).toBe(false);
    });
    it('does not equate unloaded private facts with zero activity or zero footprint', () => {
        expect(resolveUsageHowYouWork({ period: { startMs: day, endMs: day + 24 * hour }, timeZoneOffsetMinutes: 120 }))
            .toMatchObject({ detailStatus: 'unknown', intervals: null, todayInParallel: null, permissions: null, inputs: null, footprint: null });
    });

    it('projects today in the queried calendar and keeps steering distinct from other accepted deliveries', () => {
        const result = resolveUsageHowYouWork({
            period: { startMs: day - 24 * hour, endMs: day + 24 * hour }, timeZoneOffsetMinutes: 120, nowMs: day,
            detail: { status: 'partial', facts: [fact('a', day - 4 * hour, day + 2 * hour), fact('b', day - 3 * hour, day + hour)],
                permissions: [{ requestId: 'p', workId: 'a', requestedAtMs: day - hour, decidedAtMs: day,
                    toolId: 'shell', answeringClientCategory: 'ios' }],
                acceptedInputs: [
                    { inputId: 'i', workId: 'a', turnId: 't', acceptedAtMs: day, deliveryKind: 'steer' },
                    { inputId: 'i', workId: 'a', turnId: 't', acceptedAtMs: day, deliveryKind: 'steer' },
                    { inputId: 'f', workId: 'a', turnId: 't', acceptedAtMs: day, deliveryKind: 'followUp' },
                    { inputId: 'old', workId: 'a', turnId: 't', acceptedAtMs: day - 48 * hour, deliveryKind: 'steer' },
                ],
            },
        });
        expect(result).toMatchObject({ detailStatus: 'partial', todayInParallel: {
            date: '2026-10-09', agentTimeMs: 7 * hour, elapsedBusyMs: 4 * hour, parallelBusyMs: 3 * hour, maxParallel: 2,
        }, inputs: { acceptedCount: 2, steeringCount: 1, byDeliveryKind: { newTurn: 0, followUp: 1, steer: 1 } },
        permissions: { requestCount: 1, pairedDecisionCount: 1, decisionLatencyMs: hour,
            byAnsweringClient: { ios: 1, android: 0, web: 0, desktop: 0, unknown: 0 } } });
    });

    it('leaves unpaired decision latency and historical answering devices unknown', () => {
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            detail: { status: 'available', facts: [], acceptedInputs: [], permissions: [
                { requestId: 'pending', workId: 'a', requestedAtMs: day, decidedAtMs: null, toolId: 'shell', answeringClientCategory: null },
                { requestId: 'historical', workId: 'b', requestedAtMs: null, decidedAtMs: day, toolId: 'shell', answeringClientCategory: null },
            ] } });
        expect(result.permissions).toMatchObject({ requestCount: 2, pairedDecisionCount: 0, decisionLatencyMs: null,
            unknownRequestTimeCount: 1, unknownDecisionTimeCount: 1, byAnsweringClient: { unknown: 1 } });
    });
});
