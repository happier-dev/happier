import { afterEach, expect, it, vi } from 'vitest';
import { normalizeUsageQuery } from '../inputs/usageQuery.js';
import * as howYouWork from './resolveUsageHowYouWork.js';
import { resolveUsagePageAggregation, type UsageQueryBatchResult } from './resolveUsagePageAggregation.js';
import { projectUsageQueryWorkEvidence, type OpenedUsageSession } from './usageWorkEvidence.js';
import type { UsageWorkIntervalFact } from './usageWorkIntervals.js';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsContribution } from './usageAnalyticsContracts.js';
import { projectUsageAgentAccountingCalendar } from './usageAgentCalendar.js';
import { buildUsageSummaryCalendarPricing, repriceUsageSummaryCalendarPricing } from './usageSummaryCalendarPricing.js';

afterEach(() => vi.restoreAllMocks());

// Account A's measured bootstrap contained 3,423 Sessions (USAGE-PAYLOAD-IDLE-1107 §C).
const population = 3_423;
const startMs = Date.parse('2026-11-06T10:00:00Z');
const period = { startMs, endMs: startMs + 3_600_000 };
const fact = (index: number, instant = startMs): UsageWorkIntervalFact => ({ workId: `work-${index}`, evidenceId: `busy-${index}`,
    agentId: 'codex', machineId: null, kind: 'busy', startMs: instant + 1, endMs: instant + 3_600_000 - 1 });

it('resolves once for unchanged evidence across source phases, then consumes changed facts and withdrawal', () => {
    const query = normalizeUsageQuery({ period: { startMs: startMs - 89 * 86_400_000, endMs: period.endMs }, includeComparison: false, includeWorkEvidence: false,
        includeActivity: false, includeModelTimeline: false, includeTranscriptEvidence: false });
    const sessions: OpenedUsageSession[] = Array.from({ length: population }, (_, index) => ({
        id: `session-${index}`, metadata: null, agentState: null,
    }));
    const sessionEvidence = new Map(sessions.map((session, index) => [session.id,
        { status: 'available' as const, facts: [fact(index, startMs - index % 90 * 86_400_000)] }]));
    const resolver = vi.spyOn(howYouWork, 'resolveUsageHowYouWork'); // Call-through cost observer, never a mocked derivation.
    let previous: UsageQueryBatchResult | undefined;
    const run = (index: number, errorCode?: string, nowMs = period.endMs + index) => {
        const detail = projectUsageQueryWorkEvidence({ query, sessions, sessionEvidence });
        previous = resolveUsagePageAggregation({ queries: [query], previous, nowMs,
            howYouWork: [{ query, detail, ...(errorCode ? { errorCode } : {}),
                sessionCoverage: { selected: population, admitted: population, notRead: 0 } }] });
        return previous.results[0]!.howYouWork!;
    };
    const initial = run(0);
    for (let phase = 1; phase < 44; phase++) expect(run(phase)).toBe(initial);
    console.info(JSON.stringify({ usageSwitchSessions: population, equalSourcePhases: 44, resolverExecutions: resolver.mock.calls.length }));
    expect(resolver.mock.calls.length, 'unchanged source phases must not re-run the How-you-work resolver').toBe(1);
    sessionEvidence.set(sessions[0]!.id, { status: 'available', facts: [{ ...fact(0), endMs: period.endMs - 1001 }] });
    const changed = run(44);
    expect(changed.intervals!.agentTimeMs).toBe(initial.intervals!.agentTimeMs - 1000);
    expect(resolver.mock.calls.length).toBe(2);
    expect(run(45, undefined, period.endMs + 86_400_000).todayInParallel).toBeNull();
    expect(resolver.mock.calls.length).toBe(3);
    expect(run(46, 'denied').intervals).toBeNull();
    expect(resolver.mock.calls.length).toBe(4);
});

it('does not revisit admitted private facts for accounting advances or Coach and How-you-work demand switches', () => {
    const visits = { permissions: 0, inputs: 0, turns: 0, autopsy: 0 };
    const detail: howYouWork.UsageHowYouWorkDetailInput = { status: 'partial',
        facts: Array.from({ length: population }, (_, index) => fact(index)),
        permissions: Array.from({ length: population }, (_, index) => ({ workId: `work-${index}`,
            get requestId() { visits.permissions++; return `request-${index}`; }, requestedAtMs: startMs + 2,
            decidedAtMs: startMs + 3, toolId: 'shell', answeringClientCategory: 'web' as const })),
        acceptedInputs: Array.from({ length: population }, (_, index) => ({ workId: `work-${index}`,
            get inputId() { visits.inputs++; return `input-${index}`; }, turnId: `turn-${index}`,
            acceptedAtMs: startMs + 2, deliveryKind: 'steer' as const })),
        closedTurns: Array.from({ length: population }, (_, index) => ({ workId: `work-${index}`, agentId: 'codex',
            status: 'completed' as const, get startMs() { visits.turns++; return startMs + 1; }, endMs: period.endMs - 1 })),
        phaseEvents: Array.from({ length: population }, (_, index) => ({ evidenceId: `phase-${index}`,
            sessionId: `session-${index}`, turnId: null, kind: 'execute' as const, method: 'tool_classification' as const,
            get observedAtMs() { visits.autopsy++; return startMs + index; } })),
    };
    const run = (index: number, includeSteering = true, evidence = detail, selectedPeriod = period) => howYouWork.resolveUsageHowYouWork({
        period: selectedPeriod, timeZoneOffsetMinutes: 0, nowMs: period.endMs + index, detail: evidence, includeSteering,
        includeAgentCalendar: false, accounting: { v: 1, totals: { eventCount: index,
            tokens: { input: index, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: index },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } },
    });
    const initial = run(0);
    Object.keys(visits).forEach(key => { visits[key as keyof typeof visits] = 0; });
    for (let phase = 1; phase <= 14; phase++) {
        const value = run(phase, phase % 2 === 0);
        expect(value.inputs).toEqual(initial.inputs);
        expect(value.permissions).toEqual(initial.permissions);
        expect(value.runLengths).toEqual(initial.runLengths);
        expect(value.autopsy).toEqual(initial.autopsy);
        expect(value.footprint?.coverage.accountedTokens.total).toBe(phase);
        if (phase % 2 === 0) expect(value.steering).toEqual(initial.steering);
    }
    console.info(JSON.stringify({ usagePrivateFactSessions: population, equalEvidencePublications: 14, visits }));
    expect(visits, 'accounting and output demand changes must not rederive unchanged private facts').toEqual({
        permissions: 0, inputs: 0, turns: 0, autopsy: 0,
    });
    const changed = run(15, true, { ...detail, acceptedInputs: [...detail.acceptedInputs!, {
        workId: 'work-0', inputId: 'changed-input', turnId: 'turn-0', acceptedAtMs: startMs + 5, deliveryKind: 'steer',
    }] });
    expect(changed.inputs!.acceptedCount).toBe(population + 1);
    expect(changed.steering!.byAgent[0]!.steeringCount).toBe(population + 1);
    const outsidePeriod = { startMs: period.endMs, endMs: period.endMs + 3_600_000 };
    const outside = run(16, true, detail, outsidePeriod);
    expect(outside.inputs!.acceptedCount).toBe(0);
    expect(outside.permissions).toBeNull();
    expect(outside.autopsy!.events).toHaveLength(0);
    const complete = run(17, true, { ...detail, status: 'available' }, outsidePeriod);
    expect(complete.detailStatus).toBe('available');
    expect(complete.permissions!.requestCount).toBe(0);
    const withdrawn = run(18, true, { status: 'unknown' });
    expect(withdrawn.inputs).toBeNull();
    expect(withdrawn.autopsy).toBeUndefined();
    expect(withdrawn.steering).toBeNull();
});

it('prepares only the changed Session private facts while merging the admitted population', () => {
    const query = normalizeUsageQuery({ period, includeComparison: false, includeWorkEvidence: false });
    const visits = [0, 0, 0];
    const sessions: OpenedUsageSession[] = visits.map((_, index) => ({ id: `changed-${index}`, metadata: null, agentState: null }));
    const sessionEvidence = new Map(sessions.map((session, index) => [session.id, {
        status: 'partial' as const, facts: [{ ...fact(index),
            get evidenceId() { visits[index]!++; return `busy-${index}`; } }],
        acceptedInputs: [{ workId: `work-${index}`, get inputId() { visits[index]!++; return `input-${index}`; },
            turnId: `turn-${index}`, acceptedAtMs: startMs + 2, deliveryKind: 'steer' as const }],
        permissions: [{ workId: `work-${index}`, get requestId() { visits[index]!++; return `request-${index}`; },
            requestedAtMs: startMs + 2, decidedAtMs: startMs + 3, toolId: 'shell', answeringClientCategory: 'web' as const }],
        closedTurns: [{ workId: `work-${index}`, agentId: 'codex', status: 'completed' as const,
            get startMs() { visits[index]!++; return startMs + 1; }, endMs: period.endMs - 1 }],
        phaseEvents: [{ evidenceId: `phase-${index}`, sessionId: session.id, turnId: null, kind: 'execute' as const,
            method: 'tool_classification' as const, get observedAtMs() { visits[index]!++; return startMs + 4; } }],
    }]));
    const run = () => howYouWork.resolveUsageHowYouWork({ period, timeZoneOffsetMinutes: 0, includeAgentCalendar: false,
        detail: projectUsageQueryWorkEvidence({ query, sessions, sessionEvidence }) });
    expect(run().inputs!.acceptedCount).toBe(sessions.length);
    visits.fill(0);
    const first = sessionEvidence.get(sessions[0]!.id)!;
    sessionEvidence.set(sessions[0]!.id, { ...first, acceptedInputs: [...first.acceptedInputs, {
        workId: 'work-0', inputId: 'advanced-input', turnId: 'turn-0', acceptedAtMs: startMs + 5, deliveryKind: 'steer',
    }] });
    const changed = run();
    expect(changed.inputs!.acceptedCount).toBe(sessions.length + 1);
    expect(changed.permissions!.requestCount).toBe(sessions.length);
    expect(changed.runLengths!.sampleCount).toBe(sessions.length);
    expect(changed.autopsy!.events).toHaveLength(sessions.length);
    expect(changed.steering!.byAgent[0]!.steeringCount).toBe(sessions.length + 1);
    console.info(JSON.stringify({ changedSessionPreparations: visits }));
    expect(visits[0], 'the changed source must actually be prepared').toBeGreaterThan(0);
    expect(visits.slice(1), 'independent unchanged Session facts must not be prepared again').toEqual([0, 0]);
});

it('keeps private preparation with the admitted numeric period when accounting advances', () => {
    let preparations = 0;
    const query = normalizeUsageQuery({ period: { startMs: startMs - 29 * 86_400_000, endMs: period.endMs + 2 * 86_400_000 },
        includeComparison: false, includeWorkEvidence: false, includeActivity: false, includeModelTimeline: false });
    const detail: howYouWork.UsageHowYouWorkDetailInput = { status: 'available',
        facts: [{ ...fact(0), get evidenceId() { preparations++; return 'busy-0'; } }],
        acceptedInputs: [{ workId: 'work-0', inputId: 'steer', turnId: 'turn-0', acceptedAtMs: startMs + 2, deliveryKind: 'steer' }] };
    let previous: UsageQueryBatchResult | undefined;
    const run = (eventCount: number, nowMs = period.endMs) => {
        const accounting = { v: 1 as const, totals: { eventCount,
            tokens: { input: eventCount, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: eventCount },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } };
        previous = resolveUsagePageAggregation({ queries: [query], previous, nowMs,
            accounting: [{ query, value: accounting, status: 'available' }], howYouWork: [{ query, detail }] });
        return previous.results[0]!.howYouWork!;
    };
    expect(run(1).inputs?.acceptedCount).toBe(1);
    expect(preparations, 'the admitted full window and today both prepare their real source').toBe(2);
    preparations = 0;
    for (let generation = 2; generation <= 20; generation++) {
        const value = run(generation);
        expect(value.footprint?.coverage.accountedTokens.total).toBe(generation);
        expect(value.intervals?.agentTimeMs).toBe(3_600_000 - 2);
        expect(value.inputs?.acceptedCount).toBe(1);
    }
    expect(preparations, 'changed accounting keeps the current query period and its Session preparation').toBe(0);
    const nextDayMs = period.endMs + 86_400_000;
    expect(run(21, nextDayMs).todayInParallel?.agentTimeMs).toBe(0);
    expect(preparations, 'a new today role prepares its newly clipped range once').toBe(1);
    preparations = 0;
    expect(run(22, nextDayMs).todayInParallel?.agentTimeMs).toBe(0);
    expect(preparations, 'the current today role reuses its period across changed accounting').toBe(0);
});

it('merges cross-Session witnesses before choosing duplicate winners, conflicts and attribution', () => {
    const sessions: OpenedUsageSession[] = ['first', 'second'].map(id => ({ id, metadata: null, agentState: null }));
    const permission = { workId: 'work-0', requestId: 'shared', requestedAtMs: startMs + 1,
        decidedAtMs: startMs + 3, toolId: 'shell', answeringClientCategory: 'web' as const };
    const accepted = { workId: 'work-0', inputId: 'shared', turnId: 'turn', acceptedAtMs: startMs + 2,
        deliveryKind: 'steer' as const };
    const turn = { workId: 'work-0', agentId: 'codex', status: 'completed' as const, startMs: startMs + 1, endMs: startMs + 10 };
    const point = { evidenceId: 'shared', sessionId: 'first', turnId: null, observedAtMs: startMs + 4 };
    const native = { evidenceId: 'native', workId: 'work-0', sourceSessionId: 'first', targetId: 'native-child',
        sourceAgentId: 'codex', targetAgentId: 'claude', observedAtMs: startMs + 4, relation: 'native' as const };
    const sourceDetails: howYouWork.UsageHowYouWorkDetailInput[] = [
        { status: 'partial', facts: [fact(0)], permissions: [{ ...permission, requestedAtMs: startMs - 10, decidedAtMs: startMs - 1 }],
            acceptedInputs: [{ ...accepted, acceptedAtMs: startMs - 1 }], closedTurns: [turn], collaboration: [native],
            coach: { detail: { coverage: 'partial', compactions: [point] } } },
        { status: 'partial', facts: [{ ...fact(0), agentId: 'claude' }], permissions: [permission], acceptedInputs: [accepted],
            closedTurns: [{ ...turn, endMs: startMs + 11 }],
            phaseEvents: [{ ...point, observedAtMs: startMs + 5, kind: 'compaction', method: 'tool_classification' }],
            collaboration: [{ ...native, evidenceId: 'run', targetId: 'run-child', nativeTargetId: native.targetId, relation: 'review' }] },
    ];
    const query = normalizeUsageQuery({ period });
    const detail = projectUsageQueryWorkEvidence({ query, sessions,
        sessionEvidence: new Map(sessions.map((session, index) => [session.id, sourceDetails[index]!])) });
    const run = (value: howYouWork.UsageHowYouWorkDetailInput) => howYouWork.resolveUsageHowYouWork({
        period, timeZoneOffsetMinutes: 0, includeAgentCalendar: false, detail: value });
    const result = run(detail);
    // Spreading drops the non-enumerable source provenance and exercises the ordinary flat-input entry point.
    expect(result).toEqual(run({ ...detail }));
    expect(result.permissions).toBeNull(); // The first permission identity wins before period selection.
    expect(result.inputs!.steeringCount).toBe(1); // Outside inputs do not consume an identity.
    expect(result.runLengths).toMatchObject({ sampleCount: 0, invalidCount: 1 });
    expect(result.autopsy!.events).toEqual([{ ...point, kind: 'compaction', method: 'native_event' }]);
    expect(result.collaboration!.edges).toEqual([{ sourceAgentId: 'codex', targetAgentId: 'claude', relation: 'review', count: 1 }]);
    expect(result.steering!.byAgent).toContainEqual(expect.objectContaining({ agentId: null, steeringCount: 1 }));
    const selected = projectUsageQueryWorkEvidence({ query: normalizeUsageQuery({ ...query, agents: ['codex'] }), sessions,
        sessionEvidence: new Map(sessions.map((session, index) => [session.id, sourceDetails[index]!])) });
    expect(run(selected).steering!.byAgent).toContainEqual(expect.objectContaining({ agentId: 'codex', steeringCount: 1 }));
});

it.each([0, 345, -210])('partitions calendar bounds by range and timezone, independent of Session count (offset %s)', timeZoneOffsetMinutes => {
    const utc = vi.spyOn(Date, 'UTC'); // Date is the actual calendar system boundary; all projections stay real.
    const run = (count: number) => {
        utc.mockClear();
        const result = howYouWork.resolveUsageHowYouWork({ period, timeZoneOffsetMinutes, nowMs: period.endMs - 1,
            includeSteering: true, includeAgentCalendar: true,
            detail: { status: 'available', facts: Array.from({ length: count }, (_, index) => fact(index)),
                acceptedInputs: Array.from({ length: count }, (_, index) => ({ inputId: `input-${index}`,
                    workId: `work-${index}`, turnId: `turn-${index}`, acceptedAtMs: startMs + 2,
                    deliveryKind: 'steer' as const })) } });
        return { result, bounds: utc.mock.calls.length };
    };
    const one = run(1);
    const many = run(population);
    console.info(JSON.stringify({ usageCalendarSessions: population, timeZoneOffsetMinutes,
        oneSessionCalendarConversions: one.bounds, manySessionCalendarConversions: many.bounds }));
    expect(many.result.intervals!.agentTimeMs).toBe(one.result.intervals!.agentTimeMs * population);
    expect(many.result.agentCalendar!.periodSummary.totals.busyMs).toBe(one.result.intervals!.agentTimeMs * population);
    expect(many.result.inputs!.steeringCount).toBe(population);
    expect(many.bounds, 'the same calendar range must not recalculate bounds for every Session or interval').toBe(one.bounds);
});

it('partitions accounting and compact pricing once per range, independent of row and Agent count', () => {
    const query = UsageAnalyticsQueryRequestSchema.parse({ dateRange: period, timeZoneOffsetMinutes: 345 });
    const utc = vi.spyOn(Date, 'UTC');
    const run = (count: number) => {
        const rows: UsageAnalyticsContribution[] = Array.from({ length: count }, (_, index) => ({
            id: `event-${index}`, eventCount: 1, observedAtMs: startMs + 1, sessionId: `session-${index}`, turnId: null,
            agentId: `agent-${index % 5}`, modelId: null, machineId: null, projectKey: null, workspaceId: null,
            source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' },
            tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
            cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' },
        }));
        utc.mockClear();
        const calendar = projectUsageAgentAccountingCalendar({ period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
            accounting: { v: 1, contributions: rows, totals: { eventCount: count,
                tokens: { input: count, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: count },
                cost: { reportedUsd: count, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' } } } }).projection;
        const compact = buildUsageSummaryCalendarPricing(calendar, rows, query);
        const repriced = repriceUsageSummaryCalendarPricing(calendar, compact.populations,
            { v: 1, models: {}, provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1,
                revision: 'count-fixture', fetchStatus: 'ready' } }, {}, 'auto');
        return { bounds: utc.mock.calls.length, repriced };
    };
    const one = run(1);
    const many = run(population);
    console.info(JSON.stringify({ usageAccountingRows: population, oneRowCalendarConversions: one.bounds,
        manyRowCalendarConversions: many.bounds }));
    expect(many.repriced.periodSummary.totals.tokens).toBe(population);
    expect(many.repriced.periodSummary.totals.cost?.amountUsd).toBe(population);
    expect(many.bounds, 'calendar conversion work follows dated cells, not accounting rows or Agents').toBe(one.bounds);
});
