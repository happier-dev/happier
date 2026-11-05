import type { UsageAnalyticsContribution, UsageAnalyticsQueryRequest, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { resolveUsageCalendarLeaders, resolveUsageCalendarShare, type UsageAgentCalendar } from './usageAgentCalendar.js';
import { resolveUsageBucketBounds, resolveUsageCalendarInstant } from './usageCalendar.js';
import type { UsageCostMode } from './usageCostFacts.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { buildUsagePricingPopulation, mergeUsagePricingPopulations, priceUsagePricingPopulation, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';

type CalendarFigures = Pick<UsageAgentCalendar['days'][number], 'totals' | 'agents' | 'leaders'>;
type CalendarFamily = 'period' | 'days' | 'weeks' | 'hours' | 'weekdayHourBuckets' | 'hourOfDayBuckets';
const target = (family: CalendarFamily, cell: number | string) => JSON.stringify([family, cell]);
const agentTarget = (cell: string, agentId: string | null) => JSON.stringify([cell, agentId]);

/** Deliver each dated hour/Agent's operands once; larger cells reuse these exact populations. */
export function buildUsageSummaryCalendarPricing(value: UsageAgentCalendar, rows: readonly UsageAnalyticsContribution[],
    query: UsageAnalyticsQueryRequest,
    wholePopulation?: UsagePricingPopulation): { value: UsageAgentCalendar; populations: Record<string, UsagePricingPopulation> } {
    const selected = rows.filter(row => row.observedAtMs >= value.period.startMs && row.observedAtMs < value.period.endMs);
    // A scoped report can cover estimates in another day/hour. Resolve its
    // query-wide admission before partitioning identical row objects by cell.
    const states = resolveUsagePricingPopulationStates(selected);
    const hourlyAgents = new Map<string, UsageAnalyticsContribution[]>();
    for (const row of selected) {
        const bounds = resolveUsageBucketBounds('hour', row.observedAtMs, query.timeZoneOffsetMinutes);
        const key = agentTarget(target('hours', Math.max(value.period.startMs, bounds.bucketStartMs)), row.agentId);
        const group = hourlyAgents.get(key) ?? [];
        group.push(row);
        hourlyAgents.set(key, group);
    }
    return { value, populations: Object.fromEntries([...hourlyAgents].map(([key, atomicRows]) => [key,
        wholePopulation && selected.length === rows.length && atomicRows.length === rows.length
            ? wholePopulation : buildUsagePricingPopulation(atomicRows, states)])) };
}

/** Reconstitute rendered cell operands without repeating them in accounting delivery. */
function calendarPricingTargets(value: UsageAgentCalendar, populations: Readonly<Record<string, UsagePricingPopulation>>) {
    const groups = new Map<string, UsagePricingPopulation[]>();
    const append = (key: string, population: UsagePricingPopulation) => {
        const group = groups.get(key) ?? [];
        group.push(population);
        groups.set(key, group);
    };
    for (const hour of value.hours) for (const agent of hour.agents) {
        const population = populations[agentTarget(target('hours', hour.startMs), agent.agentId)];
        if (!population) continue;
        const local = resolveUsageCalendarInstant(hour.startMs, value.timeZoneOffsetMinutes);
        const keys = [target('period', 0), target('weekdayHourBuckets', `${local.weekday}:${local.hour}`),
            target('hourOfDayBuckets', local.hour)];
        for (const [family, granularity] of [['days', 'day'], ['weeks', 'week'], ['hours', 'hour']] as const) {
            const bounds = resolveUsageBucketBounds(granularity, hour.startMs, value.timeZoneOffsetMinutes);
            keys.push(target(family, Math.max(value.period.startMs, bounds.bucketStartMs)));
        }
        for (const key of keys) {
            append(key, population);
            append(agentTarget(key, agent.agentId), population);
        }
    }
    return Object.fromEntries([...groups].map(([key, group]) => [key, mergeUsagePricingPopulations(group)]));
}

/** Replay typed grouped operands through the same money owner as rich accounting. */
export function repriceUsageSummaryCalendarPricing(value: UsageAgentCalendar, populations: Readonly<Record<string, UsagePricingPopulation>>,
    catalog: UsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1, mode: UsageCostMode): UsageAgentCalendar {
    const costs = new Map(Object.entries(calendarPricingTargets(value, populations)).map(([key, population]) =>
        [key, priceUsagePricingPopulation(population, catalog, overrides, mode).selected]));
    const figures = (previous: CalendarFigures, key: string): CalendarFigures => {
        const totals = { ...previous.totals, cost: costs.has(key) ? costs.get(key)! : previous.totals.cost };
        const agents = previous.agents.map(agent => {
            const agentKey = agentTarget(key, agent.agentId);
            return { ...agent, metrics: { ...agent.metrics,
                cost: costs.has(agentKey) ? costs.get(agentKey)! : agent.metrics.cost } };
        });
        return { totals, agents, leaders: { ...previous.leaders, cost: resolveUsageCalendarLeaders(agents, 'cost', totals) } };
    };
    const period = figures(value.periodSummary, target('period', 0));
    const previousAgents = new Map(value.periodSummary.agents.map(agent => [agent.agentId, agent]));
    const totalCost = period.totals.cost;
    const periodSummary = { ...period, agents: period.agents.map(agent => {
        const cost = agent.metrics.cost;
        return { ...agent, shares: { ...previousAgents.get(agent.agentId)!.shares,
            cost: cost?.currency === totalCost?.currency
                ? resolveUsageCalendarShare(cost?.amountUsd ?? null, totalCost?.amountUsd ?? null) : null } };
    }) };
    return { ...value, costMode: mode, periodSummary,
        days: value.days.map(bucket => ({ ...bucket, ...figures(bucket, target('days', bucket.startMs)) })),
        weeks: value.weeks.map(bucket => ({ ...bucket, ...figures(bucket, target('weeks', bucket.startMs)) })),
        hours: value.hours.map(bucket => ({ ...bucket, ...figures(bucket, target('hours', bucket.startMs)) })),
        weekdayHourBuckets: value.weekdayHourBuckets.map(bucket => ({ ...bucket,
            ...figures(bucket, target('weekdayHourBuckets', `${bucket.weekday}:${bucket.hour}`)) })),
        hourOfDayBuckets: value.hourOfDayBuckets.map(bucket => ({ ...bucket, ...figures(bucket, target('hourOfDayBuckets', bucket.hour)) })),
    };
}
