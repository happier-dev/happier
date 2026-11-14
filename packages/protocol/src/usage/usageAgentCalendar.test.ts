import { describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryResponseSchema, type UsageAnalyticsContribution } from './usageAnalyticsContracts.js';
import { createEmptyUsageTokens } from './usageAggregation.js';
import { mergeUsageCalendarAccountingFacts, projectUsageCalendarAccountingFacts, projectUsageAgentAccountingCalendar,
    projectUsageAgentCalendar, UsageAgentCalendarSchema } from './usageAgentCalendar.js';

describe('measured calendar accounting', () => {
    it('conserves reported totals plus parts-only floors across retained cells and calendar partitions', () => {
        const tokens = createEmptyUsageTokens();
        const rows: UsageAnalyticsContribution[] = [
            { ...tokens, total: 1000, input: 20 }, { ...tokens, input: 100, output: 50 },
            tokens, { ...tokens, total: 0, input: 500 },
        ].map((tokens, index) => ({ id: `measurement-${index}`, tokens, observedAtMs: 1000 + index,
            eventCount: 1, sessionId: 'session', turnId: null, agentId: index === 1 ? 'claude' : 'codex',
            modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
            cost: { reportedUsd: null, estimatedUsd: null, currency: 'USD' } }));
        const facts = projectUsageCalendarAccountingFacts(rows);
        expect(facts).toMatchObject({ tokens: 1150, tokensFromParts: true });
        expect(mergeUsageCalendarAccountingFacts(rows.map(row => projectUsageCalendarAccountingFacts([row]))))
            .toEqual(facts);
        const accounting = UsageAnalyticsQueryResponseSchema.parse({ v: 1, contributions: rows,
            totals: { eventCount: 4, tokens, cost: rows[0]!.cost } });
        const input = { accounting, period: { startMs: 0, endMs: 86_400_000 }, timeZoneOffsetMinutes: 0 };
        const carried = projectUsageAgentAccountingCalendar(input);
        const retained = projectUsageAgentAccountingCalendar({ ...input, accounting: { ...accounting, contributions: undefined },
            accountingHourFacts: [{ startMs: 0, agents: ['codex', 'claude'].map(agentId => ({ agentId,
                facts: projectUsageCalendarAccountingFacts(rows.filter(row => row.agentId === agentId)) })) }] });
        for (const calendar of [carried.projection, retained.projection, projectUsageAgentCalendar({ ...input, accountingCalendar: carried,
            steering: { inputsObserved: true, coverage: 'partial', hourly: [] } })]) {
            const parsed = UsageAgentCalendarSchema.parse(calendar);
            for (const cell of [parsed.periodSummary, ...parsed.days, ...parsed.weeks, ...parsed.hours,
                ...parsed.weekdayHourBuckets, ...parsed.hourOfDayBuckets]) {
                expect(cell.totals).toMatchObject({ tokens: 1150, tokensFromParts: true });
                expect(cell.agents.find(agent => agent.agentId === 'claude')?.metrics)
                    .toMatchObject({ tokens: 150, tokensFromParts: true });
            }
        }
        expect(projectUsageCalendarAccountingFacts([rows[2]!])).toMatchObject({ tokens: null });
        expect(projectUsageCalendarAccountingFacts([rows[3]!])).toMatchObject({ tokens: 0 });
    });
});
