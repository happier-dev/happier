import type { UsageAnalyticsTokens, UsageAnalyticsContribution, UsageAnalyticsCoverage, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageAnalyticsSummary, UsageObservationTokens, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { addUsageMeasuredTokens, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from './usageAggregation.js';
import { resolveUsageBucketBounds, resolveUsageCalendarInstant } from './usageCalendar.js';
import { mergeUsageAccountingSessionMembership, projectUsageAccountingSessionIds, projectUsageAccountingSessionMembership, type UsageAccountingSessionMembership } from './usageAccountingMembership.js';
import { projectUsageAgentAccountingCalendar, projectUsageCalendarAccountingFacts, resolveUsageAccountingCalendarPeriod, type UsageAgentAccountingHourFacts } from './usageAgentCalendar.js';
import { buildUsageAdmittedPricingPopulation, mergeUsagePricingPopulations, projectUsagePricingOperandSelections, type UsagePricingOperandSelection } from './usagePricingPopulation.js';
import { hasCompleteUsageCostEvidence } from './usageAnalyticsDemandProjection.js';
import { BUNDLED_USAGE_MODEL_PRICE_REVISION } from './usageModelPriceSchemas.js';
import { summarizeUsageExecutionSources } from './usageSourceSummary.js';
import { sameQualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { restoreUsageMoneyProvenance, serializeUsageMoneyProvenance, type SerializedUsageMoneyProvenance } from './usageMoney.js';
import { resolveUsageSummaryCalendarWholePopulation, usageSummaryCalendarHourPricingKey } from './usageSummaryCalendarPricing.js';

/** Internal JSON checkpoint: the row and its subject-wide admitted report selections travel together. */
export interface UsageActivityProjectionOperand {
    row: UsageAnalyticsContribution;
    selection: UsagePricingOperandSelection;
    accountSelection?: UsagePricingOperandSelection;
    exact: { tokens: SerializedUsageMoneyProvenance; categories?: SerializedUsageMoneyProvenance;
        cost: SerializedUsageMoneyProvenance; breakdown?: SerializedUsageMoneyProvenance };
}
export interface UsageActivitySubjectProjectionDay { dayStartMs: number; operands: UsageActivityProjectionOperand[] }
type Totals = Pick<UsageAnalyticsQueryResponse['totals'], 'tokens' | 'eventCount' | 'context'>;
type AccountRows = { ref: NonNullable<UsageAnalyticsContribution['connectedAccount']>; rows: UsageAnalyticsContribution[] };

export function groupUsageSummaryAccounts(rows: readonly UsageAnalyticsContribution[]): AccountRows[] {
    const groups: AccountRows[] = [];
    for (const row of rows) if (row.providerAttribution === 'known' && row.connectedAccount) {
        let group = groups.find(group => sameQualifiedConnectedAccountRef(group.ref, row.connectedAccount!));
        if (!group) { group = { ref: row.connectedAccount, rows: [] }; groups.push(group); }
        group.rows.push(row);
    }
    return groups;
}
export function countUsageSummaryUnknownAccounts(rows: readonly UsageAnalyticsContribution[]): number {
    return rows.filter(row => row.providerAttribution !== 'known'
        || !row.connectedAccount && row.providerSource !== 'provider' && !(row.providerSource === 'native' && row.connectedAccount === null)).length;
}
export function projectUsageSummaryObservationRange(rows: readonly Pick<UsageAnalyticsContribution, 'observedAtMs'>[]): UsageAnalyticsSummary['observationRange'] {
    if (rows.length === 0) return undefined;
    let startMs = Infinity;
    let endMs = -Infinity;
    for (const row of rows) { startMs = Math.min(startMs, row.observedAtMs); endMs = Math.max(endMs, row.observedAtMs + 1); }
    return { startMs, endMs };
}

/** Canonical non-monetary totals; folded source identities are disjoint across admitted contributions. */
export function projectUsageContributionTotals(rows: readonly (Pick<UsageAnalyticsContribution, 'eventCount' | 'context'> & { tokens: UsageAnalyticsTokens })[],
    cost: UsageAnalyticsQueryResponse['totals']['cost']): UsageAnalyticsQueryResponse['totals'] {
    let tokens: UsageAnalyticsTokens = rows.length ? createEmptyUsageTokens()
        : { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let eventCount = 0;
    let context: Totals['context'];
    for (const row of rows) {
        tokens = addUsageMeasuredTokens(tokens, row.tokens);
        eventCount += row.eventCount ?? 1;
        if (row.context && (row.context.usedTokens != null || row.context.windowTokens != null)) context = row.context;
    }
    return { eventCount, tokens, cost, context };
}

/** Category totals include only witnessed nonoverlapping measurements. */
export function projectUsageContributionTokenCategories(rows: readonly Pick<UsageAnalyticsContribution, 'tokenCategories'>[]): UsageObservationTokens | undefined {
    const known = rows.flatMap(row => row.tokenCategories ? [row.tokenCategories] : []);
    return known.length > 0 ? known.reduce(addUsageTokens, createEmptyUsageTokens()) : undefined;
}

/** Recorded activity and retained hour facts share this count/bucket reducer. */
export function projectUsageRecordedActivity(rows: readonly Pick<UsageAnalyticsContribution, 'observedAtMs' | 'eventCount'>[],
    resolution: UsageAnalyticsQueryRequest['activityResolution'], timeZoneOffsetMinutes = 0): UsageAnalyticsQueryResponse['activity'] {
    if (rows.length === 0) return undefined;
    const days = new Map<string, number>();
    const hours = new Map<string, { weekday: number; hour: number; eventCount: number }>();
    for (const row of rows) {
        const start = resolveUsageBucketBounds('day', row.observedAtMs, timeZoneOffsetMinutes).bucketStartMs;
        const date = new Date(start + timeZoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
        const count = row.eventCount ?? 1;
        days.set(date, (days.get(date) ?? 0) + count);
        const { weekday, hour } = resolveUsageCalendarInstant(row.observedAtMs, timeZoneOffsetMinutes);
        const key = `${weekday}:${hour}`;
        const bucket = hours.get(key) ?? { weekday, hour, eventCount: 0 };
        bucket.eventCount += count;
        hours.set(key, bucket);
    }
    return { calendarDays: resolution === 'weekdayHour' ? undefined : [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, eventCount]) => ({ date, eventCount })),
        weekdayHourBuckets: resolution === 'calendar' ? undefined : [...hours.values()].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour) };
}

export function readUsageActivityProjectionOperand(operand: UsageActivityProjectionOperand): UsageAnalyticsContribution {
    const { row, exact } = operand;
    return { ...row, tokens: restoreUsageMoneyProvenance(row.tokens, exact.tokens),
        ...(row.tokenCategories ? { tokenCategories: restoreUsageMoneyProvenance(row.tokenCategories, exact.categories ?? {}) } : {}),
        cost: restoreUsageMoneyProvenance({ ...row.cost, ...(row.cost.breakdown ? {
            breakdown: restoreUsageMoneyProvenance(row.cost.breakdown, exact.breakdown ?? {}) } : {}) }, exact.cost) };
}

/** Report scopes are decided over a whole selected subject, before local-day partitioning. */
export function projectUsageActivitySubjectProjectionFacts(rows: readonly UsageAnalyticsContribution[], query: UsageAnalyticsQueryRequest): UsageActivitySubjectProjectionDay[] {
    const selections = projectUsagePricingOperandSelections(rows);
    const accountSelections = new Map<UsageAnalyticsContribution, UsagePricingOperandSelection>();
    for (const group of groupUsageSummaryAccounts(rows)) {
        const selected = projectUsagePricingOperandSelections(group.rows);
        for (const row of group.rows) accountSelections.set(row, selected.get(row)!);
    }
    const days = new Map<number, UsageActivityProjectionOperand[]>();
    for (const row of rows) {
        const key = resolveUsageBucketBounds('day', row.observedAtMs, query.timeZoneOffsetMinutes).bucketStartMs;
        const operands = days.get(key) ?? [];
        operands.push({ row, selection: selections.get(row)!, ...(accountSelections.has(row) ? { accountSelection: accountSelections.get(row)! } : {}),
            exact: { tokens: serializeUsageMoneyProvenance(row.tokens),
            ...(row.tokenCategories ? { categories: serializeUsageMoneyProvenance(row.tokenCategories) } : {}),
            cost: serializeUsageMoneyProvenance(row.cost), ...(row.cost.breakdown ? { breakdown: serializeUsageMoneyProvenance(row.cost.breakdown) } : {}) } });
        days.set(key, operands);
    }
    return [...days].sort(([a], [b]) => a - b).map(([dayStartMs, operands]) => ({ dayStartMs, operands }));
}

/** Aggregates contain no event-shaped rows; unchanged days need only these mergeable facts. */
export interface UsageActivityProjectionDayFacts {
    totals: Totals;
    tokenCategories?: UsageObservationTokens;
    exact: { tokens: SerializedUsageMoneyProvenance; categories?: SerializedUsageMoneyProvenance };
    contributionCount: number;
    observationRange?: UsageAnalyticsSummary['observationRange'];
    unknownAccountCount: number;
    accounts: Array<{ ref: AccountRows['ref']; contributionCount: number; population: UsagePricingPopulation }>;
    execution: UsageAnalyticsSummary['execution'];
    sessionIds: string[];
    sessionMembership: UsageAccountingSessionMembership;
    hours: UsageAgentAccountingHourFacts[];
    pricing: UsagePricingPopulation;
    hourPricing: Array<{ startMs: number; agentId: string | null; population: UsagePricingPopulation }>;
}

export function projectUsageActivityProjectionDayFacts(operands: readonly UsageActivityProjectionOperand[], query: UsageAnalyticsQueryRequest): UsageActivityProjectionDayFacts {
    const rows = operands.map(readUsageActivityProjectionOperand);
    const selections = new Map(rows.map((row, index) => [row, operands[index]!.selection]));
    const accountSelections = new Map(rows.map((row, index) => [row, operands[index]!.accountSelection ?? operands[index]!.selection]));
    const population = (selected: readonly UsageAnalyticsContribution[]) => buildUsageAdmittedPricingPopulation(selected, selections);
    const { cost: _cost, ...totals } = projectUsageContributionTotals(rows, createEmptyUsageCost());
    const categories = projectUsageContributionTokenCategories(rows);
    const hourly = new Map<number, Map<string | null, UsageAnalyticsContribution[]>>();
    for (const row of rows) {
        const start = resolveUsageBucketBounds('hour', row.observedAtMs, query.timeZoneOffsetMinutes).bucketStartMs;
        const agents = hourly.get(start) ?? new Map<string | null, UsageAnalyticsContribution[]>();
        const group = agents.get(row.agentId) ?? [];
        group.push(row); agents.set(row.agentId, group); hourly.set(start, agents);
    }
    const execution = summarizeUsageExecutionSources(rows);
    return { totals, tokenCategories: categories, contributionCount: rows.length,
        exact: { tokens: serializeUsageMoneyProvenance(totals.tokens), ...(categories ? { categories: serializeUsageMoneyProvenance(categories) } : {}) },
        observationRange: projectUsageSummaryObservationRange(rows), unknownAccountCount: countUsageSummaryUnknownAccounts(rows),
        accounts: groupUsageSummaryAccounts(rows).map(group => ({ ref: group.ref, contributionCount: group.rows.length,
            population: buildUsageAdmittedPricingPopulation(group.rows, accountSelections) })),
        execution: { ...execution, groups: execution.groups.map(({ contributions: _rows, ...group }) => group) },
        sessionIds: projectUsageAccountingSessionIds(rows), sessionMembership: projectUsageAccountingSessionMembership(rows),
        hours: [...hourly].sort(([a], [b]) => a - b).map(([startMs, agents]) => ({ startMs,
            agents: [...agents].map(([agentId, selected]) => ({ agentId, facts: projectUsageCalendarAccountingFacts(selected) })) })),
        pricing: population(rows), hourPricing: [...hourly].flatMap(([startMs, agents]) => [...agents].map(([agentId, selected]) => ({ startMs, agentId, population: population(selected) }))) };
}

/** Merge admitted dated operands, then use the existing calendar and repricing owners for presentation. */
export function mergeUsageActivityProjectionFacts(parts: readonly UsageActivityProjectionDayFacts[], query: UsageAnalyticsQueryRequest,
    coverage: UsageAnalyticsCoverage): UsageAnalyticsQueryResponse {
    const populated = parts.filter(part => part.contributionCount > 0);
    const totals = projectUsageContributionTotals(populated.map(part => ({ ...part.totals, tokens: restoreUsageMoneyProvenance(part.totals.tokens, part.exact.tokens) })), createEmptyUsageCost());
    const tokenCategories = projectUsageContributionTokenCategories(populated.map(part => ({
        tokenCategories: part.tokenCategories && restoreUsageMoneyProvenance(part.tokenCategories, part.exact.categories ?? {}) })));
    const execution = summarizeUsageExecutionSources(parts.flatMap(part => part.execution.groups.map(group => ({ tokens: { total: group.tokens, ...(group.tokensFromParts && group.tokens !== null ? { measured: { total: group.tokens, fromParts: true as const } } : {}) }, sourceContext: { execution: group.execution } }))));
    const accountGroups: Array<{ ref: AccountRows['ref']; contributionCount: number; populations: UsagePricingPopulation[] }> = [];
    for (const part of parts) for (const account of part.accounts) {
        let group = accountGroups.find(group => sameQualifiedConnectedAccountRef(group.ref, account.ref));
        if (!group) { group = { ref: account.ref, contributionCount: 0, populations: [] }; accountGroups.push(group); }
        group.contributionCount += account.contributionCount; group.populations.push(account.population);
    }
    const observed = parts.flatMap(part => part.observationRange ? [part.observationRange] : []);
    const observationRange = observed.length ? { startMs: Math.min(...observed.map(range => range.startMs)), endMs: Math.max(...observed.map(range => range.endMs)) } : undefined;
    const hours = parts.flatMap(part => part.hours);
    const activityRows = hours.map(hour => ({ observedAtMs: Math.max(query.dateRange?.startMs ?? hour.startMs, hour.startMs),
        eventCount: hour.agents.reduce((sum, agent) => sum + (agent.facts.eventCount ?? 0), 0) }));
    const value: UsageAnalyticsQueryResponse = { v: 1, totals,
        ...(query.includeActivity ? { activity: projectUsageRecordedActivity(activityRows, query.activityResolution, query.timeZoneOffsetMinutes) } : {}),
        costFacts: [], coverage, tokenCategories };
    const complete = hasCompleteUsageCostEvidence(value);
    const totalPricing = mergeUsagePricingPopulations(parts.map(part => part.pricing));
    const pricing: Record<string, UsagePricingPopulation> = { totals: complete ? totalPricing : { groups: totalPricing.groups.map(group => ({ ...group, complete: false })) } };
    const contributionCount = parts.reduce((sum, part) => sum + part.contributionCount, 0);
    const endMs = query.dateRange?.endMs ?? coverage.range.endMs;
    const period = endMs === undefined ? undefined : resolveUsageAccountingCalendarPeriod({ accounting: value,
        period: { startMs: query.dateRange ? query.dateRange.startMs : coverage.range.startMs, endMs },
        observationStartMs: observationRange?.startMs, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes });
    const calendar = query.includeActivity && period ? projectUsageAgentAccountingCalendar({ accounting: value, accountingHourFacts: hours,
        period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, costMode: query.costMode }).projection : undefined;
    for (const [index, group] of accountGroups.entries()) pricing[`account:${index}`] = mergeUsagePricingPopulations(group.populations);
    return { ...value, summary: { v: 1, costMode: query.costMode ?? 'auto', pricing, rankedPricing: {}, countedPricing: true,
        observationRange, catalogRevision: BUNDLED_USAGE_MODEL_PRICE_REVISION,
        ...(calendar && period ? { accountingCalendar: { value: calendar, pricing: Object.fromEntries(parts.flatMap(part => part.hourPricing)
            .map(hour => [usageSummaryCalendarHourPricingKey(Math.max(period.startMs, hour.startMs), hour.agentId),
                resolveUsageSummaryCalendarWholePopulation(pricing.totals, contributionCount,
                    hour.population.groups.reduce((sum, group) => sum + group.contributionCount, 0)) ?? hour.population])) } } : {}),
        accounts: { unknownContributionCount: parts.reduce((sum, part) => sum + part.unknownAccountCount, 0),
            values: accountGroups.map(group => ({ ref: group.ref, contributionCount: group.contributionCount, pricedContributionCount: 0, apiEquivalentUsd: 0, pricingSources: [] })) },
        execution: { ...execution, groups: execution.groups.map(({ contributions: _rows, ...group }) => group) } },
        // The existing full projection appends the selected presentation before delivery admits membership.
        costPresentation: undefined,
        sessionIds: [...new Set(parts.flatMap(part => part.sessionIds))],
        sessionMembership: mergeUsageAccountingSessionMembership(parts.map(part => part.sessionMembership)) };
}
