import type { UsageAnalyticsContribution, UsageAnalyticsQueryRequest, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { resolveUsageCalendarLeaders, resolveUsageCalendarShare, type UsageAgentCalendar } from './usageAgentCalendar.js';
import { createUsageFixedBucketResolver, resolveUsageCalendarInstant } from './usageCalendar.js';
import type { UsageCostMode } from './usageCostFacts.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { buildUsagePricingPopulation, mergeUsagePricingPopulations, priceUsagePricingPopulation, resolveUsagePricingPopulationStates } from './usagePricingPopulation.js';
import type { UsagePricingReuse } from './usagePricingReuse.js';

type CalendarFigures = Pick<UsageAgentCalendar['days'][number], 'totals' | 'agents' | 'leaders'>;
type CalendarFamily = 'period' | 'days' | 'weeks' | 'hours' | 'weekdayHourBuckets' | 'hourOfDayBuckets';
const target = (family: CalendarFamily, cell: number | string) => JSON.stringify([family, cell]);
const agentTarget = (cell: string, agentId: string | null) => JSON.stringify([cell, agentId]);
export const usageSummaryCalendarHourPricingKey = (startMs: number, agentId: string | null): string => agentTarget(target('hours', startMs), agentId);

/** An identical cell retains whole-population evidence completeness as well as its operands. */
export function resolveUsageSummaryCalendarWholePopulation(wholePopulation: UsagePricingPopulation | undefined,
    contributionCount: number, cellContributionCount: number): UsagePricingPopulation | undefined {
    return wholePopulation && cellContributionCount === contributionCount ? wholePopulation : undefined;
}

/** Deliver each dated hour/Agent's operands once; larger cells reuse these exact populations. */
export function buildUsageSummaryCalendarPricing(value: UsageAgentCalendar, rows: readonly UsageAnalyticsContribution[],
    query: UsageAnalyticsQueryRequest,
    wholePopulation?: UsagePricingPopulation): { value: UsageAgentCalendar; populations: Record<string, UsagePricingPopulation> } {
    const selected = rows.filter(row => row.observedAtMs >= value.period.startMs && row.observedAtMs < value.period.endMs);
    // A scoped report can cover estimates in another day/hour. Resolve its
    // query-wide admission before partitioning identical row objects by cell.
    const states = resolveUsagePricingPopulationStates(selected);
    const hourlyAgents = new Map<string, UsageAnalyticsContribution[]>();
    const hourBoundsAt = createUsageFixedBucketResolver('hour', value.period.startMs, query.timeZoneOffsetMinutes);
    for (const row of selected) {
        const bounds = hourBoundsAt(row.observedAtMs);
        const key = usageSummaryCalendarHourPricingKey(Math.max(value.period.startMs, bounds.bucketStartMs), row.agentId);
        const group = hourlyAgents.get(key) ?? [];
        group.push(row);
        hourlyAgents.set(key, group);
    }
    return { value, populations: Object.fromEntries([...hourlyAgents].map(([key, atomicRows]) => [key,
        resolveUsageSummaryCalendarWholePopulation(wholePopulation, rows.length, atomicRows.length)
            ?? buildUsagePricingPopulation(atomicRows, states)])) };
}

/** Reconstitute rendered cell operands without repeating them in accounting delivery. */
function calendarPricingTargets(value: UsageAgentCalendar, populations: Readonly<Record<string, UsagePricingPopulation>>) {
    const groups = new Map<string, Array<{ key: string; population: UsagePricingPopulation }>>();
    const append = (key: string, populationKey: string, population: UsagePricingPopulation) => {
        const group = groups.get(key) ?? [];
        group.push({ key: populationKey, population });
        groups.set(key, group);
    };
    const families = ([['days', 'day'], ['weeks', 'week'], ['hours', 'hour']] as const).map(([family, granularity]) => ({
        family, boundsAt: createUsageFixedBucketResolver(granularity, value.period.startMs, value.timeZoneOffsetMinutes),
    }));
    for (const hour of value.hours) {
        const local = resolveUsageCalendarInstant(hour.startMs, value.timeZoneOffsetMinutes);
        const keys = [target('period', 0), target('weekdayHourBuckets', `${local.weekday}:${local.hour}`),
            target('hourOfDayBuckets', local.hour)];
        for (const { family, boundsAt } of families) {
            const bounds = boundsAt(hour.startMs);
            keys.push(target(family, Math.max(value.period.startMs, bounds.bucketStartMs)));
        }
        for (const agent of hour.agents) {
            const populationKey = usageSummaryCalendarHourPricingKey(hour.startMs, agent.agentId);
            const population = populations[populationKey];
            if (!population) continue;
            for (const key of keys) {
                append(key, populationKey, population);
                append(agentTarget(key, agent.agentId), populationKey, population);
            }
        }
    }
    return groups;
}

/** Replay typed grouped operands through the same money owner as rich accounting. */
export function repriceUsageSummaryCalendarPricing(value: UsageAgentCalendar, populations: Readonly<Record<string, UsagePricingPopulation>>,
    catalog: UsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1, mode: UsageCostMode,
    reuse?: UsagePricingReuse): UsageAgentCalendar {
    const costs = new Map([...calendarPricingTargets(value, populations)].map(([key, inputs]) => {
        const calculate = () => priceUsagePricingPopulation(mergeUsagePricingPopulations(inputs.map(input => input.population)),
            catalog, overrides, mode, reuse).selected;
        return [key, reuse ? reuse.calendarTarget(key, inputs, calculate) : calculate()] as const;
    }));
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
