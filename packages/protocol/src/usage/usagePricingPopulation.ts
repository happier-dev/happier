import type { UsageAnalyticsContribution, UsageObservationCost, UsageObservationTokens, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { addUsageCost, aggregateUsageContributionCosts, addUsageMeasuredTokens, createUsageCostAccumulator, createUsageCostPartitionAccumulator, addUsageTokens, createEmptyUsageCost, resolveUsageContributionCosts, selectResolvedUsageCost, usageCostAggregationBasis, type AggregatedUsageCost } from './usageAggregation.js';
import { createUsageModelCostEstimator, priceUsageObservation } from './usageCostProjection.js';
import type { UsagePricingReuse } from './usagePricingReuse.js';
import { hasUnresolvedUsageReportedTotalScope, resolveUsageCostBasis, resolveUsageCostFacts, serializeUsageCostBasis, type UsageCostMode } from './usageCostFacts.js';
import { createUsageSourceCostFacts } from './usageCostFactTotals.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { hasZeroUsageTokens, resolveUsageTokenCategories } from './usageTokenCategories.js';
import { addUsageMoney, createUsageMoneyAccumulator, subtractUsageMoney, readUsageMoney, usageMoneyFromNumber, usageMoneyToNumber, withUsageMoney, type ExactUsageMoney } from './usageMoney.js';

type Group = UsagePricingPopulation['groups'][number];
type Decimal = Group['costUnits'][string];
const modes = ['auto', 'reported', 'estimated'] as const;
const tokenFields = ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'total'] as const;
const moneyFields = ['reportedUsd', 'estimatedUsd', 'invoiceUsd'] as const;
/** The canonical pricing projector reads only these admitted, tariff-independent operands. */
export type UsagePricingOperand = Pick<UsageAnalyticsContribution,
    'id' | 'modelId' | 'tokenCategories' | 'tokens' | 'cost' | 'eventCount' | 'observedAtMs'>;
export type UsagePricingPopulationStates = ReadonlyMap<UsageCostMode, ReadonlyMap<UsagePricingOperand, UsageObservationCost>>;
export type UsagePricingOperandSelection = Group['selection'];

/** Resolve the whole admitted subject before storing any dated subset. */
export function projectUsagePricingOperandSelections(rows: readonly UsagePricingOperand[]): ReadonlyMap<UsagePricingOperand, UsagePricingOperandSelection> {
    const shared = resolveUsagePricingPopulationStates(rows);
    return new Map(rows.map(row => {
        const cost = row.cost;
        return [row, readUsagePricingSelection(cost, resolveUsagePricingReportCosts(row, cost, shared))];
    }));
}

/** Retained selection states enter the existing group accumulator, never another money fold. */
export function buildUsageAdmittedPricingPopulation(rows: readonly UsagePricingOperand[],
    selections: ReadonlyMap<UsagePricingOperand, UsagePricingOperandSelection>, complete = true): UsagePricingPopulation {
    const noReportCosts: UsagePricingPopulationStates = new Map();
    const steps = prepareUsagePricingPopulationSteps(rows, complete, row =>
        prepareUsagePricingOperand(row, noReportCosts, undefined, selections.get(row)));
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value.population;
}

export function resolveUsagePricingPopulationStates(rows: readonly UsagePricingOperand[]): UsagePricingPopulationStates {
    // Ordinary observed money has no identity-scoped overlap. Do not build
    // three event-identity indexes for that population (or each ranked subset).
    if (!rows.some(row => row.cost.reportedTotalId !== undefined || row.cost.reportedTotalContributionIds !== undefined)) return new Map();
    return new Map(modes.map(mode => {
        const resolved = resolveUsageContributionCosts(rows, mode);
        const scoped = new Map<UsagePricingOperand, UsageObservationCost>();
        for (let index = 0; index < rows.length; index++) {
            const row = rows[index]!;
            if (resolved[index] !== row.cost) scoped.set(row, resolved[index]!);
        }
        return [mode, scoped] as const;
    }));
}
function encode(value: ExactUsageMoney): Decimal { return { units: String(value.units), scale: value.scale }; }
function decode(value: Decimal): ExactUsageMoney { return { units: BigInt(value.units), scale: value.scale }; }
function units(value: object, fields: readonly string[]) {
    return Object.fromEntries(fields.flatMap(field => {
        const publicValue: unknown = Reflect.get(value, field);
        if (typeof publicValue !== 'number') return [];
        const exact = readUsageMoney(value, field, publicValue);
        return subtractUsageMoney(exact, usageMoneyFromNumber(publicValue)).units === 0n ? [] : [[field, encode(exact)]];
    }));
}
function restore<T extends object>(value: T, exact: Record<string, Decimal>): T {
    return withUsageMoney(value, Object.fromEntries(Object.entries(exact).map(([key, amount]) => [key, decode(amount)])));
}
function costUnits(cost: UsageObservationCost): Record<string, Decimal> {
    return { ...units(cost, moneyFields), ...Object.fromEntries(Object.entries(cost.breakdown ?? {}).flatMap(([field, value]) => {
        const exact = readUsageMoney(cost.breakdown!, field, value);
        return subtractUsageMoney(exact, usageMoneyFromNumber(value)).units === 0n ? [] : [[`breakdown:${field}`, encode(exact)]];
    })) };
}
function restoreCost(cost: UsageObservationCost, exact: Record<string, Decimal>): UsageObservationCost {
    const fields = Object.fromEntries(Object.entries(exact).filter(([field]) => !field.startsWith('breakdown:')));
    const breakdown = Object.fromEntries(Object.entries(exact).filter(([field]) => field.startsWith('breakdown:'))
        .map(([field, value]) => [field.slice('breakdown:'.length), value]));
    return restore({ ...cost, ...(cost.breakdown ? { breakdown: restore(cost.breakdown, breakdown) } : {}) }, fields);
}
function selection(raw: UsageObservationCost, resolved: UsageObservationCost, mode: UsageCostMode): Group['selection']['auto'] {
    const basis = (resolved as AggregatedUsageCost)[usageCostAggregationBasis];
    if (basis?.mode === mode) return basis.covered ? 'covered' : 'total';
    return hasUnresolvedUsageReportedTotalScope(raw, mode) ? 'unavailable' : 'plain';
}
function operandKey(modelId: string | null, categories: UsageObservationTokens | null, raw: UsageObservationCost) {
    return JSON.stringify([modelId, categories === null ? null : [categories.cacheRead !== null && categories.cacheRead > 0, categories.cacheWrite !== null && categories.cacheWrite > 0,
        hasZeroUsageTokens(categories), tokenFields.map(field => categories[field] === null)], raw.currency, raw.costSource, raw.billingContext,
        resolveUsageCostFacts(raw).map(fact => [fact.kind, fact.source])]);
}
function groupKey(modelId: string | null, categories: UsageObservationTokens | null, raw: UsageObservationCost, states: Group['selection']) {
    return JSON.stringify([operandKey(modelId, categories, raw), states]);
}
function resolveUsagePricingReportCosts(row: UsagePricingOperand, cost: UsageObservationCost, shared: UsagePricingPopulationStates) {
    return {
        auto: shared.get('auto')?.get(row) ?? cost,
        reported: shared.get('reported')?.get(row) ?? cost,
        estimated: shared.get('estimated')?.get(row) ?? cost,
    };
}

function readUsagePricingSelection(cost: UsageObservationCost, resolved: Record<typeof modes[number], UsageObservationCost>): UsagePricingOperandSelection {
    return { auto: selection(cost, resolved.auto, 'auto'), reported: selection(cost, resolved.reported, 'reported'),
        estimated: selection(cost, resolved.estimated, 'estimated') };
}

function prepareUsagePricingOperand(row: UsagePricingOperand, shared: UsagePricingPopulationStates,
    mode?: UsageCostMode, admittedSelection?: UsagePricingOperandSelection) {
    const categories = row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null);
    const cost = row.cost;
    const { apiEquivalentUsd: _api, pricingSource: _price, effectiveUsd: _effective, selectedBasis: _selected,
        reportedTotalId: _total, reportedTotalContributionIds: _scope, ...raw } = cost;
    const reports = admittedSelection ? undefined : resolveUsagePricingReportCosts(row, cost, shared);
    const states = admittedSelection ?? readUsagePricingSelection(cost, reports ?? { auto: cost, reported: cost, estimated: cost });
    const signature = groupKey(row.modelId, categories, raw, states);
    const selected = mode === undefined ? undefined
        : selectResolvedUsageCost(mode === 'api_equivalent' ? cost : reports?.[mode] ?? cost, mode);
    return { categories, cost, raw, states, signature, selected };
}

type PrepareUsagePricingOperand = (row: UsagePricingOperand) => ReturnType<typeof prepareUsagePricingOperand>;

/** Group only tariff/availability/raw-fact dimensions, never event ids or times. */
export function buildUsagePricingPopulation(rows: readonly UsagePricingOperand[], sharedStates = resolveUsagePricingPopulationStates(rows), complete = true): UsagePricingPopulation {
    const steps = prepareUsagePricingPopulationSteps(rows, complete, row => prepareUsagePricingOperand(row, sharedStates));
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value.population;
}

/** Admit observed and already-priced money together, without estimating a row twice. */
export function buildUsagePricedPartition(rows: readonly UsagePricingOperand[], mode: UsageCostMode,
    sharedStates = resolveUsagePricingPopulationStates(rows)) {
    const steps = buildUsagePricedPartitionSteps(rows, mode, row => prepareUsagePricingOperand(row, sharedStates, mode));
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

function* buildUsagePricedPartitionSteps(rows: readonly UsagePricingOperand[], mode: UsageCostMode,
    admit: PrepareUsagePricingOperand, shouldYield?: () => boolean) {
    const { population, prices, resolvedCost } = yield* prepareUsagePricingPopulationSteps(rows, true, admit, mode, shouldYield);
    // Selected provenance follows the witnessed row order, including interleaved
    // covered facts. Compact grouping is a separate operand, not a new ordering
    // of that canonical rich fold.
    const cost = rows.length === 0 ? aggregateUsageContributionCosts([], mode)
        : resolvedCost!;
    const priced = prices.filter(price => price.api !== undefined);
    return { population, cost,
        allPriced: prices.every(price => price.api !== undefined),
        hasPrices: prices.some(price => price.api !== undefined),
        api: prices.reduce((sum, price) => addUsageMoney(sum, price.api ?? usageMoneyFromNumber(0)), usageMoneyFromNumber(0)),
        pricingSource: priced.every(price => price.source === priced[0]?.source) ? priced[0]?.source : 'effective_model_prices' };
}

/** The total's admission fixes the monetary operands for all of its subsets. */
export function* buildUsagePricedProjectionSteps(rows: readonly UsagePricingOperand[], mode: UsageCostMode,
    shouldYield?: () => boolean, states: UsagePricingPopulationStates = resolveUsagePricingPopulationStates(rows)):
    Generator<void, {
        total: ReturnType<typeof buildUsagePricedPartition>;
        project: (subset: readonly UsagePricingOperand[]) => Generator<void, ReturnType<typeof buildUsagePricedPartition>, void>;
    }, void> {
    const admitted = new Map<UsagePricingOperand, ReturnType<PrepareUsagePricingOperand>>();
    const total = yield* buildUsagePricedPartitionSteps(rows, mode, row => {
        const operand = prepareUsagePricingOperand(row, states, mode);
        admitted.set(row, operand);
        return operand;
    }, shouldYield);
    return { total, project: (subset: readonly UsagePricingOperand[]) =>
        buildUsagePricedPartitionSteps(subset, mode, row => admitted.get(row)!, shouldYield) };
}

function* prepareUsagePricingPopulationSteps(rows: readonly UsagePricingOperand[], complete: boolean,
    admit: PrepareUsagePricingOperand, selectedMode?: UsageCostMode, shouldYield?: () => boolean) {
    const includePrices = selectedMode !== undefined;
    let observedCost: UsageObservationCost;
    const resolvedCosts = selectedMode === undefined ? undefined
        : createUsageCostPartitionAccumulator(createEmptyUsageCost(), selectedMode, () => observedCost);
    const grouped = new Map<string, { group: Group; costs?: ReturnType<typeof createUsageCostAccumulator>;
        api?: ReturnType<typeof createUsageMoneyAccumulator>; allPriced: boolean; source?: string }>();
    for (const row of rows) {
        const { categories, cost, raw, states, signature, selected } = admit(row);
        resolvedCosts?.add(cost, selected);
        const partition = grouped.get(signature);
        const api = includePrices && cost.apiEquivalentUsd !== undefined
            ? readUsageMoney(cost, 'apiEquivalentUsd', cost.apiEquivalentUsd) : undefined;
        if (partition) {
            partition.costs ??= createUsageCostAccumulator(partition.group.cost);
            partition.costs.add(raw);
            const group = partition.group;
            group.tokens = addUsageMeasuredTokens(group.tokens, row.tokens);
            group.categories = categories && group.categories ? addUsageTokens(group.categories, categories) : categories;
            group.contributionCount++;
            group.eventCount += row.eventCount ?? 1;
            group.asOfMs = Math.min(group.asOfMs, row.observedAtMs);
            group.complete &&= row.eventCount !== undefined;
            if (includePrices) {
                partition.allPriced &&= api !== undefined;
                if (api) partition.api!.add(api);
                if (partition.source !== cost.pricingSource) partition.source = 'effective_model_prices';
            }
        } else {
            grouped.set(signature, { allPriced: api !== undefined,
                ...(includePrices ? { api: createUsageMoneyAccumulator(api ?? usageMoneyFromNumber(0)), source: cost.pricingSource } : {}),
                group: { modelId: row.modelId, categories,
            categoryUnits: {}, cost: raw, costUnits: {}, tokens: row.tokens,
            contributionCount: 1, eventCount: row.eventCount ?? 1, asOfMs: row.observedAtMs,
            complete: complete && row.eventCount !== undefined, selection: states } });
        }
        if (shouldYield?.()) yield;
    }
    const groups: Group[] = [];
    let observed: ReturnType<typeof createUsageCostAccumulator> | undefined;
    for (const { group, costs } of grouped.values()) {
        const cost = costs?.value() ?? group.cost;
        groups.push({ ...group, cost, categoryUnits: group.categories ? units(group.categories, tokenFields) : {}, costUnits: costUnits(cost) });
        if (selectedMode !== undefined) {
            if (observed) observed.add(cost);
            else observed = createUsageCostAccumulator(cost);
        }
        if (shouldYield?.()) yield;
    }
    if (selectedMode !== undefined) observedCost = observed?.value() ?? createEmptyUsageCost();
    return { population: { groups }, prices: includePrices ? [...grouped.values()].map(partition => ({
        api: partition.allPriced ? partition.api!.value() : undefined, source: partition.source,
    })) : [], resolvedCost: resolvedCosts?.value() };
}

/** Combine already-admitted partitions in group space, without revisiting events. */
export function mergeUsagePricingPopulations(populations: readonly UsagePricingPopulation[]): UsagePricingPopulation {
    const grouped = new Map<string, Group>();
    for (const population of populations) for (const group of population.groups) {
        const key = groupKey(group.modelId, group.categories, group.cost, group.selection);
        const previous = grouped.get(key);
        if (!previous) { grouped.set(key, group); continue; }
        const cost = addUsageCost(restoreCost(previous.cost, previous.costUnits), restoreCost(group.cost, group.costUnits));
        const categories = previous.categories && group.categories
            ? addUsageTokens(restore(previous.categories, previous.categoryUnits), restore(group.categories, group.categoryUnits)) : null;
        grouped.set(key, { ...previous, cost, costUnits: costUnits(cost), categories,
            categoryUnits: categories ? units(categories, tokenFields) : {}, tokens: addUsageMeasuredTokens(previous.tokens, group.tokens),
            contributionCount: previous.contributionCount + group.contributionCount, eventCount: previous.eventCount + group.eventCount,
            asOfMs: Math.min(previous.asOfMs, group.asOfMs), complete: previous.complete && group.complete });
    }
    return { groups: [...grouped.values()] };
}

/** Shared exact arithmetic owners price grouped operands just as they price rows. */
export function priceUsagePricingPopulation(population: UsagePricingPopulation, catalog: UsageModelPriceCatalog,
    overrides: UsageModelPriceOverridesV1, mode: UsageCostMode, reuse?: UsagePricingReuse) {
    const costs = createUsageCostPartitionAccumulator(createEmptyUsageCost(), mode);
    let savings = usageMoneyFromNumber(0);
    let cacheSavingsComplete = true;
    let pricedContributionCount = 0;
    const pricingSources = new Set<string>();
    const facts = createUsageSourceCostFacts();
    const estimateCost = createUsageModelCostEstimator(catalog, overrides, reuse);
    for (const group of population.groups) {
        const categories = group.categories ? restore(group.categories, group.categoryUnits) : null;
        const raw = restoreCost(group.cost, group.costUnits);
        const priced = priceUsageObservation(raw, group.modelId, categories, catalog, overrides, mode, estimateCost(group.modelId, categories));
        const cost = priced.cost;
        const estimate = priced.estimate;
        if (!estimate && group.tokens.cacheRead !== 0) cacheSavingsComplete = false;
        savings = addUsageMoney(savings, readUsageMoney(estimate?.breakdown ?? {}, 'cacheSavingsUsd', estimate?.breakdown?.cacheSavingsUsd ?? 0));
        if (cost.apiEquivalentUsd !== undefined) {
            pricedContributionCount += group.contributionCount;
            pricingSources.add(cost.pricingSource ?? 'effective_model_prices');
        }
        const base = { tokens: group.tokens, eventCount: group.eventCount,
            asOfMs: group.asOfMs, complete: group.complete };
        for (const fact of resolveUsageCostFacts(cost)) facts.add({ ...base, ...fact, currency: fact.kind === 'api_equivalent' ? 'USD' : fact.currency }, group.contributionCount);
        if (!estimate && cost.apiEquivalentUsd === undefined) facts.add({ ...base, kind: 'unpriced', currency: 'USD', amountUsd: null,
            source: categories ? 'model_price_unknown' : 'token_categories_unknown', complete: false }, group.contributionCount);
        // The producer already admitted each group's report selection. A missing
        // report selects no charge, just as for a rich row; it does not invalidate
        // unrelated known money. Both shapes use the same selected-money fold.
        const state = mode === 'api_equivalent' ? 'plain' : group.selection[mode];
        costs.add(cost, state === 'plain' ? undefined : { available: true,
            selected: state === 'total' ? resolveUsageCostBasis(cost, mode) : null });
    }
    const total = population.groups.length === 0 ? aggregateUsageContributionCosts([], mode) : costs.value();
    const selected = resolveUsageCostBasis(total, mode);
    const projectedFacts = facts.values();
    return { cost: serializeUsageCostBasis(total, mode), selected, selectedCost: selectResolvedUsageCost(total, mode),
        pricedContributionCount, pricingSources: [...pricingSources].sort(), apiEquivalentUsd: total.apiEquivalentUsd ?? null,
        facts: projectedFacts, cacheSavingsUsd: usageMoneyToNumber(savings), cacheSavingsComplete };
}
