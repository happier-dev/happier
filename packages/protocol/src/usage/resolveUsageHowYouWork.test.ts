import { describe, expect, it } from 'vitest';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema } from './resolveUsageHowYouWork.js';

const hour = 3_600_000;
const day = Date.parse('2026-10-09T00:00:00Z');
const fact = (workId: string, startMs: number, endMs: number) => ({
    workId, evidenceId: workId, agentId: 'agent', machineId: workId,
    kind: 'busy' as const, startMs, endMs,
});

describe('How-you-work admitted projection', () => {
    it('distributes only full closed turns, deduplicating work and keeping open, cropped and invalid observations separate', () => {
        const turn = { workId: 'closed', agentId: 'claude', status: 'completed' as const, startMs: day, endMs: day + hour };
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + 4 * hour }, timeZoneOffsetMinutes: 0,
            detail: { status: 'partial', facts: [fact('closed', day, day + hour),
                { ...fact('closed', day, day + hour / 2), kind: 'permission_wait' }], closedTurns: [turn, turn,
                { ...turn, workId: 'long', endMs: day + 3 * hour },
                { ...turn, workId: 'open', status: 'in_progress', endMs: null },
                { ...turn, workId: 'cropped', startMs: day - hour },
                { ...turn, workId: 'invalid', endMs: day - 1 },
            ] } });
        expect(result.runLengths).toMatchObject({ coverage: 'partial', sampleCount: 2, openCount: 1, croppedCount: 1,
            invalidCount: 1, byAgent: [{ agentId: 'claude', sampleCount: 2, medianMs: 2 * hour, p90Ms: 3 * hour,
                durationsMs: [hour, 3 * hour] }] });
        expect(UsageHowYouWorkSchema.safeParse(result).success).toBe(true);
    });

    it('joins accepted steering to historical work, bins answers by decision time and names the observed busy-hour denominator', () => {
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + 4 * hour }, timeZoneOffsetMinutes: 0,
            detail: { status: 'partial', facts: [
                { ...fact('old-turn', day, day + 2 * hour), agentId: 'claude' },
                { ...fact('new-turn', day + 2 * hour, day + 3 * hour), agentId: 'codex' },
                { ...fact('old-turn', day, day + 2 * hour), agentId: 'claude' },
            ], acceptedInputs: [
                { inputId: 's', workId: 'old-turn', turnId: 'old', acceptedAtMs: day + hour, deliveryKind: 'steer' },
                { inputId: 's', workId: 'old-turn', turnId: 'old', acceptedAtMs: day + hour, deliveryKind: 'steer' },
                { inputId: 'f', workId: 'new-turn', turnId: 'new', acceptedAtMs: day + 2 * hour, deliveryKind: 'followUp' },
                { inputId: 'u', workId: 'missing-turn', turnId: 'missing', acceptedAtMs: day, deliveryKind: 'steer' },
            ], permissions: [
                { requestId: 'paired', workId: 'old-turn', requestedAtMs: day + hour, decidedAtMs: day + 2 * hour,
                    toolId: 'shell', answeringClientCategory: 'ios' },
                { requestId: 'unpaired', workId: 'missing-turn', requestedAtMs: null, decidedAtMs: day + hour,
                    toolId: 'shell', answeringClientCategory: 'web' },
                { requestId: 'cancelled', workId: 'new-turn', requestedAtMs: day + 2 * hour, decidedAtMs: null,
                    toolId: 'shell', answeringClientCategory: null },
            ] } });
        expect(result.steering?.byAgent).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentId: 'claude', steeringCount: 1, followUpCount: 0, busyMs: 2 * hour,
                steersPerBusyHour: 0.5, permissionAnswerCount: 1, pairedDecisionCount: 1, decisionLatencyMs: hour }),
            expect.objectContaining({ agentId: 'codex', steeringCount: 0, followUpCount: 1, permissionAnswerCount: 0 }),
            expect.objectContaining({ agentId: null, steeringCount: 1, busyMs: null, steersPerBusyHour: null,
                permissionAnswerCount: 1, pairedDecisionCount: 0, decisionLatencyMs: null }),
        ]));
        expect(result.steering?.hourly).toEqual(expect.arrayContaining([
            expect.objectContaining({ agentId: 'claude', hour: 2, permissionAnswerCount: 1,
                byAnsweringClient: { ios: 1, android: 0, web: 0, desktop: 0, unknown: 0 } }),
            expect.objectContaining({ agentId: null, hour: 1, permissionAnswerCount: 1,
                byAnsweringClient: { ios: 0, android: 0, web: 1, desktop: 0, unknown: 0 } }),
        ]));
        expect(UsageHowYouWorkSchema.safeParse(result).success).toBe(true);
    });
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
        const facts = [fact('night', day, day + hour)];
        const activityAtMs = [day];
        const result = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            nightHours: { startHour: 22, endHour: 6 }, accounting: { v: 1, totals: { eventCount: 7,
                tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
                activity: { weekdayHourBuckets: [{ weekday: 5, hour: 0, eventCount: 7 }] } },
            detail: { status: 'partial', facts, permissions: [], acceptedInputs: [], activityAtMs } });
        expect(result.intervals?.night).toMatchObject({ busyMs: hour, activityCount: 7 });
        const privateOnly = resolveUsageHowYouWork({ period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0,
            nightHours: { startHour: 22, endHour: 6 }, detail: { status: 'partial', facts, activityAtMs } });
        expect(privateOnly.intervals?.night?.activityCount).toBe(1);
        expect(result.intervals?.night?.activityCount).toBe(7);
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

    it('does not turn an empty partial lifecycle subset into no runs today or no approvals', () => {
        const project = (status: 'partial' | 'available') => resolveUsageHowYouWork({
            period: { startMs: day - 24 * hour, endMs: day + hour }, timeZoneOffsetMinutes: 0, nowMs: day,
            detail: { status, facts: [], permissions: [] },
        });
        expect(project('partial')).toMatchObject({ detailStatus: 'partial', todayInParallel: null, permissions: null });
        // A genuinely complete empty observation can establish zero; partial historical coverage cannot.
        expect(project('available')).toMatchObject({ todayInParallel: { agentTimeMs: 0, maxParallel: 0 },
            permissions: { requestCount: 0 } });
        const olderRuns = resolveUsageHowYouWork({
            period: { startMs: day - 24 * hour, endMs: day + hour }, timeZoneOffsetMinutes: 0, nowMs: day,
            detail: { status: 'partial', facts: [fact('yesterday', day - 2 * hour, day - hour)] },
        });
        expect(olderRuns.intervals?.agentTimeMs).toBe(hour);
        expect(olderRuns.todayInParallel).toBeNull();
        const unfinished = resolveUsageHowYouWork({
            period: { startMs: day, endMs: day + hour }, timeZoneOffsetMinutes: 0, nowMs: day,
            detail: { status: 'available', facts: [{ ...fact('unfinished', day, day + hour), endMs: null }] },
        });
        expect(unfinished.intervals?.unknownEndCount).toBe(1);
        expect(unfinished.todayInParallel).toBeNull();
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
