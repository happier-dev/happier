import { describe, expect, it } from 'vitest';
import type { UsageAnalyticsContribution, UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { projectUsageAgentAccountingCalendar, projectUsageAgentCalendar, UsageAgentCalendarSchema } from './usageAgentCalendar.js';
import { projectUsageWorkIntervals } from './usageWorkIntervals.js';
import { aggregateUsageContributionCosts, resolveUsageContributionCosts } from './usageAggregation.js';
import { resolveUsageCostBasis, type UsageCostMode } from './usageCostFacts.js';
import { buildUsagePricingPopulation, priceUsagePricingPopulation, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';

const ms = (value: string) => Date.parse(value);
const period = { startMs: ms('2026-10-18T21:30Z'), endMs: ms('2026-10-20T23:00Z') };
const tokens = (total: number) => ({ input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total });
function row(id: string, agentId: string | null, total: number, at = '2026-10-19T00:00Z'): UsageAnalyticsContribution {
    return { id, agentId, observedAtMs: ms(at), eventCount: 1, sessionId: 'session', turnId: null, modelId: null,
        machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
        sourceContext: { path: 'runtime', execution: 'happier' }, tokens: tokens(total),
        cost: { reportedUsd: total / 10, estimatedUsd: 99, currency: 'USD', costSource: 'provider_reported' } };
}
function accounting(contributions: UsageAnalyticsContribution[]): UsageAnalyticsQueryResponse {
    return { v: 1, totals: { eventCount: contributions.length, tokens: tokens(contributions.reduce((sum, value) => sum + value.tokens.total, 0)),
        cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' } }, contributions,
        coverage: { status: 'complete', reasons: [], missingDimensions: [], range: { complete: true }, ranked: [],
            sources: [{ source: 'runtime', path: 'runtime', status: 'available', eventCount: contributions.length, historyComplete: true }] } };
}

describe('projectUsageAgentCalendar', () => {
    it('keeps covered identity separate from unavailable money when admitted compact costs cross local hours', () => {
        const selectedPeriod = { startMs: 0, endMs: 3_600_000 };
        const covered = { ...row('covered', 'a', 2), observedAtMs: 600_000,
            cost: { reportedUsd: 0, estimatedUsd: 0.2, currency: 'USD', costSource: 'pricing_estimate' as const,
                reportedTotalId: 'report' } };
        const report = { ...row('report', 'a', 0), observedAtMs: 2_400_000,
            cost: { reportedUsd: 1.25, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const,
                reportedTotalContributionIds: ['covered'] } };
        const unknown = { ...row('unknown', 'a', 1), observedAtMs: 2_500_000,
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const } };
        const catalog = { v: 1 as const, models: {}, provenance: { source: 'litellm' as const,
            origin: 'bundled' as const, asOfMs: 1, revision: 'calendar-admitted', fetchStatus: 'ready' as const } };
        for (const originals of [[covered, report], [covered, report, unknown]]) {
            const states = resolveUsagePricingPopulationStates(originals);
            const populations = new Map(originals.map(item => [item.id, buildUsagePricingPopulation([item], states)]));
            const compact = originals.map(item => {
                const { reportedTotalId: _id, reportedTotalContributionIds: _ids, ...cost } = item.cost;
                return { ...item, cost };
            });
            const expected = projectUsageAgentAccountingCalendar({ period: selectedPeriod,
                timeZoneOffsetMinutes: 30, accounting: accounting(originals) }).projection;
            const input = { period: selectedPeriod, timeZoneOffsetMinutes: 30, accounting: accounting(compact),
                accountingSelectedCosts: (selected: readonly UsageAnalyticsContribution[], mode: UsageCostMode) =>
                    selected.map(item => priceUsagePricingPopulation(populations.get(item.id)!, catalog, {}, mode).selectedCost) };
            const actual = projectUsageAgentAccountingCalendar(input).projection;
            expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
            expect(actual.hours[0]?.totals.cost).toBeNull();
            expect(actual.periodSummary.totals.cost?.amountUsd ?? null).toBe(originals.length === 2 ? 1.25 : null);
        }
    });
    it('keeps carried and direct projections identical across source coverage, cost modes and refused private evidence', () => {
        const intervals = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120, facts: [
            { workId: 'shared', agentId: 'a', machineId: null, evidenceId: 'busy', kind: 'busy',
                startMs: period.startMs, endMs: period.startMs + 3_600_000 },
            { workId: 'disjoint', agentId: null, machineId: null, evidenceId: 'busy', kind: 'busy',
                startMs: period.startMs + 300_000, endMs: period.startMs + 1_800_000 },
            { workId: 'wait', agentId: 'wait-only', machineId: null, evidenceId: 'wait', kind: 'permission_wait',
                startMs: period.startMs, endMs: period.endMs },
        ] });
        for (const costMode of ['auto', 'reported', 'estimated', 'api_equivalent'] as const) {
            const left = row('first', 'a', 3, '2026-10-18T21:45Z');
            const right = row('second', 'b', 3, '2026-10-20T00:00Z');
            right.cost = { reportedUsd: 1, estimatedUsd: 2, apiEquivalentUsd: 3, currency: 'EUR', costSource: 'provider_reported' };
            const complete = accounting([left, right]);
            complete.activity = { weekdayHourBuckets: [{ weekday: 1, hour: 0, eventCount: 3 }] };
            const partial = { ...complete, coverage: { ...complete.coverage!, range: { complete: false } } };
            for (const data of [complete, partial, accounting([]), undefined]) {
                const accountingCalendar = projectUsageAgentAccountingCalendar({ period, timeZoneOffsetMinutes: 120, accounting: data, costMode });
                for (const detailStatus of ['available', 'partial', 'unknown'] as const) {
                    const input = { period, timeZoneOffsetMinutes: 120, accounting: data, costMode, detailStatus, intervals,
                        steering: { inputsObserved: true, coverage: 'partial' as const, hourly: [
                            { agentId: 'steer-only', date: '2026-10-19', weekday: 1, hour: 0, steeringCount: null },
                        ] }, nightHours: { startHour: 0, endHour: 6 } };
                    expect(projectUsageAgentCalendar({ ...input, accountingCalendar })).toEqual(projectUsageAgentCalendar(input));
                    const mismatched = { ...input, intervals: { ...intervals, period: { ...period, endMs: period.endMs + 1 } } };
                    expect(projectUsageAgentCalendar({ ...mismatched, accountingCalendar })).toEqual(projectUsageAgentCalendar(mismatched));
                }
            }
        }
    });
    it('reuses a carried accounting projection while composing distinct private lanes and configured night windows', () => {
        let costReads = 0;
        const value = row('one', 'a', 5);
        const cost = value.cost;
        Object.defineProperty(value, 'cost', { enumerable: true, get() { costReads++; return cost; } });
        const data = accounting([value]);
        data.activity = { weekdayHourBuckets: [{ weekday: 1, hour: 0, eventCount: 1 }, { weekday: 1, hour: 12, eventCount: 3 }] };
        expect(projectUsageAgentAccountingCalendar).toBeTypeOf('function');
        const accountingCalendar = projectUsageAgentAccountingCalendar({ period, timeZoneOffsetMinutes: 0, accounting: data, costMode: 'auto' });
        const afterPreparation = costReads;
        expect(projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: data, accountingCalendar })).toBe(accountingCalendar.projection);
        const intervals = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 0, facts: [
            { workId: 'busy-b', agentId: 'b', machineId: null, evidenceId: 'busy', kind: 'busy',
                startMs: ms('2026-10-19T01:00Z'), endMs: ms('2026-10-19T02:00Z') },
        ] });
        const input = { period, timeZoneOffsetMinutes: 0, accounting: data, intervals, detailStatus: 'available' as const,
            nightHours: { startHour: 0, endHour: 1 }, steering: { inputsObserved: true, coverage: 'complete_for_supplied_facts' as const,
                hourly: [{ agentId: null, date: '2026-10-19', weekday: 1, hour: 1, steeringCount: 2 }] } };
        const composed = projectUsageAgentCalendar({ ...input, accountingCalendar });
        expect(costReads).toBe(afterPreparation);
        expect(composed).toEqual(projectUsageAgentCalendar(input));
        expect(composed.periodSummary.agents.map(agent => agent.agentId)).toEqual([null, 'a', 'b']);
        expect(composed.dayNightActivity?.nightShare).toBe(0.25);
        const otherWindow = projectUsageAgentCalendar({ ...input, accountingCalendar, nightHours: { startHour: 12, endHour: 13 } });
        expect(otherWindow.dayNightActivity?.nightShare).toBe(0.75);
        const changed = accounting([row('new', 'c', 9)]);
        expect(projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: changed, accountingCalendar }).periodSummary.totals.tokens).toBe(9);
    });
    it('resolves monetary overlap once for the full population instead of repeating it for each calendar partition', () => {
        let scopeReads = 0;
        const rows = Array.from({ length: 240 }, (_, index) => {
            const value = row(String(index), index % 2 ? 'a' : 'b', 1,
                new Date(period.startMs + index * 600_000).toISOString());
            Object.defineProperty(value.cost, 'reportedTotalContributionIds', { enumerable: true, get() { scopeReads++; return undefined; } });
            return value;
        });
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 120, accounting: accounting(rows) });
        expect(result.periodSummary.totals.cost?.amountUsd).toBeCloseTo(24);
        // The overlap owner reads each row's scope once during the full-population
        // selection. Calendar partitioning must not repeat that owner operation.
        expect(scopeReads).toBeLessThanOrEqual(rows.length * 2);
    });
    it.each(['auto', 'reported', 'estimated', 'api_equivalent'] as const)('preserves %s monetary selection, overlap and provenance in every calendar grouping', costMode => {
        const covered = row('covered', 'a', 2, '2026-10-18T23:30Z');
        covered.cost = { reportedUsd: 0, estimatedUsd: 2, apiEquivalentUsd: 3, pricingSource: 'catalog:test',
            costSource: 'pricing_estimate', currency: 'USD', reportedTotalId: 'report' };
        const report = row('report', 'a', 0, '2026-10-19T00:30Z');
        report.cost = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported', reportedTotalContributionIds: ['covered'] };
        const other = row('other', null, 3, '2026-10-19T00:45Z');
        other.cost = { reportedUsd: 0, estimatedUsd: 1, apiEquivalentUsd: 4, pricingSource: 'catalog:test', currency: 'USD', costSource: 'pricing_estimate' };
        const rows = [covered, report, other];
        const costs = resolveUsageContributionCosts(rows, costMode);
        const resolved = rows.map((value, index) => ({ ...value, cost: costs[index]! }));
        const expected = (selected: typeof rows) => selected.length ? resolveUsageCostBasis(aggregateUsageContributionCosts(selected, costMode), costMode) : null;
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting(rows), costMode });
        for (const bucket of [...result.days, ...result.weeks, ...result.hours]) {
            const selected = resolved.filter(value => value.observedAtMs >= bucket.startMs && value.observedAtMs < bucket.endMs);
            expect(bucket.totals.cost).toEqual(expected(selected));
            for (const agent of bucket.agents) expect(agent.metrics.cost).toEqual(expected(selected.filter(value => value.agentId === agent.agentId)));
        }
        expect(result.periodSummary.totals.cost).toEqual(expected(resolved));
        for (const cell of result.hourOfDayBuckets) expect(cell.totals.cost).toEqual(expected(resolved.filter(value => new Date(value.observedAtMs).getUTCHours() === cell.hour)));
    });
    it('projects full-period distinct facts and Agent shares over complete accounting including unknown attribution', () => {
        const range = { startMs: ms('2026-10-19T00:00Z'), endMs: ms('2026-10-21T00:00Z') };
        const rows = [row('a-one', 'a', 6, '2026-10-19T00:30Z'), row('a-two', 'a', 6, '2026-10-20T00:30Z'),
            row('b', 'b', 8, '2026-10-19T00:45Z'), row('rest', null, 10, '2026-10-20T00:45Z')];
        rows[0]!.backendMode = 'one';
        rows[1]!.backendMode = 'two';
        const intervals = projectUsageWorkIntervals({ period: range, timeZoneOffsetMinutes: 0, facts: [
            ['first-a', 'a', '2026-10-19T00:00Z', '2026-10-19T01:00Z'],
            ['first-b', 'b', '2026-10-19T00:00Z', '2026-10-19T01:00Z'],
            ['second-a', 'a', '2026-10-20T00:00Z', '2026-10-20T01:00Z'],
            ['second-b', 'b', '2026-10-20T00:00Z', '2026-10-20T01:00Z'],
            ['second-rest', null, '2026-10-20T00:00Z', '2026-10-20T01:00Z'],
        ].map(([workId, agentId, start, end]) => ({ workId: workId!, agentId: agentId ?? null, evidenceId: 'busy', machineId: 'm',
            kind: 'busy' as const, startMs: ms(start!), endMs: ms(end!) })) });
        const result = projectUsageAgentCalendar({ period: range, timeZoneOffsetMinutes: 0, accounting: accounting(rows), intervals, detailStatus: 'available' });
        expect(result).toHaveProperty('periodSummary');
        expect(result.periodSummary.totals).toMatchObject({ tokens: 30, sessions: 1, peakParallel: 3 });
        expect(result.periodSummary.agents.map(agent => [agent.agentId, agent.metrics.tokens, agent.shares.tokens])).toEqual([
            [null, 10, 10 / 30], ['a', 12, 12 / 30], ['b', 8, 8 / 30],
        ]);
        expect(result.periodSummary.agents.map(agent => agent.shares.cost)).toEqual([1 / 3, 1.2 / 3, 0.8 / 3]);
        expect(UsageAgentCalendarSchema.parse(result)).toEqual(JSON.parse(JSON.stringify(result)));
    });
    it('keeps period shares unavailable for zero populations, unpriced rows and incompatible monetary currencies', () => {
        const zero = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting([row('zero', 'a', 0)]) });
        expect(zero).toHaveProperty('periodSummary');
        expect(zero.periodSummary.agents[0]!.shares).toEqual({ tokens: null, cost: null });
        const unpriced = row('unpriced', 'b', 2);
        unpriced.cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' };
        const data = accounting([row('priced', 'a', 2), unpriced]);
        const unknown = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: data });
        expect(unknown.periodSummary.totals.cost).toBeNull();
        expect(unknown.periodSummary.agents.map(agent => agent.shares.cost)).toEqual([null, null]);
        unpriced.cost = { reportedUsd: 3, estimatedUsd: 0, currency: 'EUR', costSource: 'provider_reported' };
        const mixed = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting([row('usd', 'a', 2), unpriced]) });
        expect(mixed.periodSummary.totals.cost).toBeNull();
        expect(mixed.periodSummary.agents.map(agent => agent.shares.cost)).toEqual([null, null]);
    });
    it('retains context-only producer membership without assigning its encoded zero tokens a measured share', () => {
        // Pi projectPiSessionStatsUsage omits paid tokens for context-only stats;
        // buildUsageEventIngestRequest encodes absent tokens/cost as zero. The query
        // contribution preserves context and identity, but loses measurement presence.
        const context = { ...row('context', 'context-agent', 0), source: 'pi-session-stats',
            context: { usedTokens: 12_000, windowTokens: 200_000 },
            cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } };
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting([row('paid', 'a', 10), context]) });
        expect(result).toHaveProperty('periodSummary');
        const agent = result.periodSummary.agents.find(value => value.agentId === 'context-agent')!;
        expect(agent.shares).toEqual({ tokens: null, cost: null });
        expect(agent.coverage.accounting).toBe('unknown');
    });
    it('reduces hour of day across weekdays with distinct Sessions, maximum peaks and unavailable steering', () => {
        const range = { startMs: ms('2026-10-19T00:00Z'), endMs: ms('2026-10-20T01:00Z') };
        const rows = [row('first-a', 'a', 2, '2026-10-19T00:30Z'), row('first-b', 'a', 3, '2026-10-19T00:45Z'),
            row('second-a', 'a', 5, '2026-10-20T00:30Z'), { ...row('second-b', 'b', 7, '2026-10-20T00:45Z'), sessionId: 'other' }];
        const intervals = projectUsageWorkIntervals({ period: range, timeZoneOffsetMinutes: 120, facts: [
            ['first-a', 'a', '2026-10-19T00:00Z', '2026-10-19T01:00Z'],
            ['second-a', 'a', '2026-10-20T00:00Z', '2026-10-20T01:00Z'],
            ['second-b', 'b', '2026-10-20T00:00Z', '2026-10-20T01:00Z'],
        ].map(([workId, agentId, start, end]) => ({ workId: workId!, agentId: agentId!, evidenceId: 'busy', machineId: 'm',
            kind: 'busy' as const, startMs: ms(start!), endMs: ms(end!) })) });
        const result = projectUsageAgentCalendar({ period: range, timeZoneOffsetMinutes: 120, accounting: accounting(rows), intervals, detailStatus: 'available' });
        expect(result).toHaveProperty('hourOfDayBuckets');
        expect(result.hourOfDayBuckets).toHaveLength(1);
        const cell = result.hourOfDayBuckets[0]!;
        expect(cell.hour).toBe(2);
        expect(cell.totals).toMatchObject({ tokens: 17, eventCount: 4, sessions: 2, peakParallel: 2, busyMs: 10_800_000, steeringCount: null });
        expect(cell.totals.cost?.amountUsd).toBeCloseTo(1.7);
        expect(cell.agents.map(agent => [agent.agentId, agent.metrics.sessions, agent.metrics.peakParallel])).toEqual([['a', 1, 1], ['b', 1, 1]]);
        expect(cell.leaders.steeringCount.status).toBe('unavailable');
        expect(UsageAgentCalendarSchema.parse(result)).toEqual(JSON.parse(JSON.stringify(result)));
    });
    it('reduces typical weekday hours from actual Session identities and dated concurrency rather than adding their counts', () => {
        const range = { startMs: ms('2026-10-19T00:30Z'), endMs: ms('2026-10-26T01:00Z') };
        const rows = [row('a1', 'a', 2, '2026-10-19T00:45Z'), row('b1', 'b', 3, '2026-10-19T00:45Z'),
            row('a2', 'a', 5, '2026-10-26T00:45Z'), row('b2', 'b', 7, '2026-10-26T00:45Z')];
        rows[1]!.sessionId = 'other';
        rows[3]!.sessionId = 'other';
        const intervals = projectUsageWorkIntervals({ period: range, timeZoneOffsetMinutes: 120, facts: [
            ['a1', 'a', '2026-10-19T00:00Z', '2026-10-19T01:00Z'],
            ['b1', 'b', '2026-10-19T00:00Z', '2026-10-19T01:00Z'],
            ['a2', 'a', '2026-10-26T00:00Z', '2026-10-26T01:00Z'],
            ['b2', 'b', '2026-10-26T00:00Z', '2026-10-26T01:00Z'],
            ['b3', 'b', '2026-10-26T00:00Z', '2026-10-26T01:00Z'],
        ].map(([workId, agentId, start, end]) => ({ workId: workId!, agentId: agentId!, evidenceId: 'busy', machineId: 'm',
            kind: 'busy' as const, startMs: ms(start!), endMs: ms(end!) })) });
        const result = projectUsageAgentCalendar({ period: range, timeZoneOffsetMinutes: 120, accounting: accounting(rows), intervals,
            detailStatus: 'available', steering: { inputsObserved: true, coverage: 'complete_for_supplied_facts', hourly: [
                { agentId: 'a', date: '2026-10-19', weekday: 1, hour: 2, steeringCount: 1 },
                { agentId: 'a', date: '2026-10-26', weekday: 1, hour: 2, steeringCount: 2 },
            ] } });
        expect(result).toHaveProperty('weekdayHourBuckets');
        const cell = result.weekdayHourBuckets.find(value => value.weekday === 1 && value.hour === 2)!;
        expect(cell.totals).toMatchObject({ tokens: 17, eventCount: 4, sessions: 2, busyMs: 14_400_000, peakParallel: 3,
            steeringCount: 3, cost: { amountUsd: 1.7, kind: 'reported' } });
        expect(cell.agents.map(agent => [agent.agentId, agent.metrics.sessions, agent.metrics.peakParallel])).toEqual([['a', 1, 1], ['b', 1, 2]]);
        expect(cell.leaders.sessions).toEqual({ status: 'tied', agentIds: ['a', 'b'], includesUnknown: false });
        expect(cell.leaders.peakParallel).toEqual({ status: 'leading', agentIds: ['b'], includesUnknown: false });
        expect(UsageAgentCalendarSchema.parse(result)).toEqual(JSON.parse(JSON.stringify(result)));
    });
    it('keeps epoch-start all-history projections sparse rather than materializing empty hours', () => {
        const data = accounting([row('only', 'a', 3, '1970-01-02T01:00Z')]);
        const result = projectUsageAgentCalendar({ period: { startMs: 0, endMs: 172_800_000 }, timeZoneOffsetMinutes: 0, accounting: data });
        expect(result.hours).toHaveLength(1);
        expect(result.days).toHaveLength(2);
        expect(result.weeks).toHaveLength(1);
    });
    it('folds the complete Agent population before metric-specific leading selection and retains ties and unknown', () => {
        const rows = [row('a1', 'a', 6), row('a2', 'a', 6), row('b', 'b', 10), row('unknown', null, 12)];
        rows[0]!.backendMode = 'one';
        rows[1]!.backendMode = 'two';
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 120, accounting: accounting(rows) });
        expect(UsageAgentCalendarSchema.parse(result)).toEqual(JSON.parse(JSON.stringify(result)));
        const day = result.days.find(value => value.date === '2026-10-19')!;
        expect(day.agents.map(value => [value.agentId, value.metrics.tokens])).toEqual([[null, 12], ['a', 12], ['b', 10]]);
        expect(day.leaders.tokens).toEqual({ status: 'tied', agentIds: ['a'], includesUnknown: true });
        expect(day.leaders.eventCount).toEqual({ status: 'leading', agentIds: ['a'], includesUnknown: false });
        expect(day.totals.cost?.amountUsd).toBeCloseTo(3.4);
        expect(day.totals.cost?.kind).toBe('reported');
        expect(result.weeks.map(value => [value.startMs, value.endMs])).toEqual([
            [period.startMs, ms('2026-10-18T22:00Z')], [ms('2026-10-18T22:00Z'), period.endMs],
        ]);
        expect(result.weeklyAgentMix[1]!.mix.map(value => [value.agentId, value.share])).toEqual([[null, 12 / 34], ['a', 12 / 34], ['b', 10 / 34]]);
        expect(result.agentActiveDays.map(value => [value.agentId, value.days])).toEqual([[null, 1], ['a', 1], ['b', 1]]);
    });

    it('clips witnessed busy lanes at offset hours and weeks, excluding waits and preserving independent concurrency', () => {
        const intervals = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 120, facts: [
            { workId: 'a', evidenceId: 'busy', agentId: 'a', machineId: 'm', kind: 'busy', startMs: ms('2026-10-18T21:00Z'), endMs: ms('2026-10-18T23:00Z') },
            { workId: 'a', evidenceId: 'wait', agentId: 'a', machineId: 'm', kind: 'permission_wait', startMs: ms('2026-10-18T22:15Z'), endMs: ms('2026-10-18T22:45Z') },
            { workId: 'b', evidenceId: 'busy', agentId: 'b', machineId: 'm', kind: 'busy', startMs: ms('2026-10-18T21:45Z'), endMs: ms('2026-10-18T22:30Z') },
        ] });
        const recorded = accounting([row('b', 'b', 100)]);
        recorded.activity = { weekdayHourBuckets: [{ weekday: 1, hour: 0, eventCount: 1 }, { weekday: 1, hour: 12, eventCount: 3 }] };
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 120, intervals, detailStatus: 'available',
            accounting: recorded, nightHours: { startHour: 0, endHour: 1 } });
        expect(result.weeks.map(value => value.totals.peakParallel)).toEqual([2, 2]);
        expect(result.weeklyPeakParallel.map(value => value.peak)).toEqual([2, 2]);
        const monday = result.days.find(value => value.date === '2026-10-19')!;
        expect(monday.leaders.busyMs).toEqual({ status: 'tied', agentIds: ['a', 'b'], includesUnknown: false });
        expect(monday.leaders.tokens.agentIds).toEqual(['b']);
        expect(monday.totals.busyMs).toBe(3_600_000);
        expect(result.hours[0]!.totals.busyMs).toBe(2_700_000);
        expect(result.dayNightActivity).toMatchObject({ basis: 'recorded_activity', window: { startHour: 0, endHour: 1 }, dayShare: 0.75, nightShare: 0.25 });
        expect(result.machineKinds).toEqual({ status: 'unavailable', reason: 'no_witnessed_kind' });
    });

    it('distinguishes observed empty, missing accounting, unknown counts and unattributed positive metrics', () => {
        const empty = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting([]) });
        expect(empty.days[0]!.totals.tokens).toBe(0);
        expect(empty.days[0]!.leaders.tokens.status).toBe('empty');
        expect(empty.dayNightActivity).toBeNull();
        const intervals = projectUsageWorkIntervals({ period, timeZoneOffsetMinutes: 0, facts: [] });
        const witnessedEmpty = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, intervals, detailStatus: 'available',
            nightHours: { startHour: 22, endHour: 6 } });
        expect(witnessedEmpty.hours).toEqual([]);
        expect(witnessedEmpty.weeklyPeakParallel.map(week => week.peak)).toEqual([0, 0]);
        expect(witnessedEmpty.dayNightActivity).toBeNull();
        const partial = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, intervals, detailStatus: 'partial' });
        expect(partial.weeklyPeakParallel).toEqual([]);
        expect(partial.weeks.every(week => week.totals.peakParallel === null)).toBe(true);
        const missing = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0 });
        expect(missing.days[0]!.totals.tokens).toBeNull();
        expect(missing.days[0]!.leaders.tokens.status).toBe('unavailable');
        expect(missing.weeklyAgentMix).toEqual([]);
        const unknown = row('unknown', null, 4);
        delete unknown.eventCount;
        unknown.sessionId = null;
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting([unknown]) });
        const day = result.days.find(value => value.date === '2026-10-19')!;
        expect(day.totals.eventCount).toBeNull();
        expect(day.totals.sessions).toBeNull();
        expect(day.leaders.tokens).toEqual({ status: 'unattributed', agentIds: [], includesUnknown: true });
        expect(day.totals.busyMs).toBeNull();
    });

    it('selects whole reported money before calendar partitioning and never attributes covered estimates twice', () => {
        const covered = row('covered', 'a', 10, '2026-10-18T23:30Z');
        covered.cost = { reportedUsd: 0, estimatedUsd: 2, currency: 'USD', costSource: 'pricing_estimate', reportedTotalId: 'reported' };
        const independent = row('estimate', 'a', 5, '2026-10-18T23:45Z');
        independent.cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' };
        const reported = row('reported', 'a', 0, '2026-10-19T00:30Z');
        reported.cost = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported', reportedTotalContributionIds: ['covered'] };
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: accounting([covered, independent, reported]), costMode: 'auto' });
        expect(result.days.slice(0, 2).map(day => day.totals.cost?.amountUsd)).toEqual([1, 7]);
        expect(result.days.slice(0, 2).map(day => day.totals.cost?.kind)).toEqual(['estimated', 'reported']);
    });

    it('uses canonical nullable steering hours and does not certify unrelated Agent source history', () => {
        const data = accounting([row('a', 'a', 1), { ...row('b', 'b', 2), source: 'missing-source' }]);
        const result = projectUsageAgentCalendar({ period, timeZoneOffsetMinutes: 0, accounting: data,
            steering: { inputsObserved: true, coverage: 'partial', hourly: [
                { agentId: 'a', date: '2026-10-19', weekday: 1, hour: 1, steeringCount: 3 },
                { agentId: 'b', date: '2026-10-19', weekday: 1, hour: 1, steeringCount: null },
            ] } });
        const day = result.days.find(value => value.date === '2026-10-19')!;
        expect(day.agents.find(agent => agent.agentId === 'a')!.coverage.accounting).toBe('complete_for_supplied_facts');
        expect(day.agents.find(agent => agent.agentId === 'b')!.coverage.accounting).toBe('unknown');
        expect(day.totals.steeringCount).toBeNull();
        expect(day.agents.find(agent => agent.agentId === 'a')!.metrics.steeringCount).toBe(3);
        expect(day.agents.find(agent => agent.agentId === 'b')!.metrics.steeringCount).toBeNull();
        expect(day.leaders.steeringCount.status).toBe('unavailable');
    });
});
