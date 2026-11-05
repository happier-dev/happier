import type { UsageAnalyticsContribution, UsageObservationCost, UsageObservationTokens, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import { addUsageCost, aggregateUsageCostPartitionsSteps, createUsageCostAccumulator, addUsageCostForMode, addUsageTokens, createEmptyUsageCost, resolveUsageContributionCosts, selectResolvedUsageCost, usageCostAggregationBasis, type AggregatedUsageCost } from './usageAggregation.js';
import { createUsageModelCostEstimator, priceUsageObservation } from './usageCost.js';
import { hasUnresolvedUsageReportedTotalScope, resolveUsageCostBasis, resolveUsageCostFacts, serializeUsageCostBasis, type UsageCostMode } from './usageCostFacts.js';
import { createUsageSourceCostFacts } from './usageCostFactTotals.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { resolveUsageTokenCategories } from './usageTokenCategories.js';
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
        const publicValue = Number(Reflect.get(value, field) ?? 0);
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
function operandKey(modelId: string | null, categories: UsageObservationTokens | null, raw: UsageObservationCost, hasTokens: boolean) {
    return JSON.stringify([modelId, categories === null ? null : [categories.cacheRead > 0, categories.cacheWrite > 0,
        tokenFields.every(field => categories[field] === 0)], raw.currency, raw.costSource, raw.billingContext,
        resolveUsageCostFacts(raw).map(fact => [fact.kind, fact.source]), hasTokens]);
}
function groupKey(modelId: string | null, categories: UsageObservationTokens | null, raw: UsageObservationCost, states: Group['selection'], hasTokens: boolean) {
    return JSON.stringify([operandKey(modelId, categories, raw, hasTokens), states]);
}
function admitUsagePricingOperand(row: UsagePricingOperand) {
    const categories = row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null);
    const cost = row.cost;
    const { apiEquivalentUsd: _api, pricingSource: _price, effectiveUsd: _effective, selectedBasis: _selected,
        reportedTotalId: _total, reportedTotalContributionIds: _scope, ...raw } = cost;
    return { categories, cost, raw, key: operandKey(row.modelId, categories, raw, row.tokens.total > 0) };
}

/** Group only tariff/availability/raw-fact dimensions, never event ids or times. */
export function buildUsagePricingPopulation(rows: readonly UsagePricingOperand[], sharedStates = resolveUsagePricingPopulationStates(rows), complete = true): UsagePricingPopulation {
    const steps = prepareUsagePricingPopulationSteps(rows, sharedStates, complete);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value.population;
}

/** Admit observed and already-priced money together, without estimating a row twice. */
export function buildUsagePricedPartition(rows: readonly UsagePricingOperand[], mode: UsageCostMode,
    sharedStates = resolveUsagePricingPopulationStates(rows)) {
    const steps = buildUsagePricedPartitionSteps(rows, mode, sharedStates, admitUsagePricingOperand);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

function* buildUsagePricedPartitionSteps(rows: readonly UsagePricingOperand[], mode: UsageCostMode,
    sharedStates: UsagePricingPopulationStates, admit: typeof admitUsagePricingOperand, shouldYield?: () => boolean) {
    const { population, prices, admittedCosts } = yield* prepareUsagePricingPopulationSteps(rows, sharedStates, true, mode, admit, shouldYield);
    // Selected provenance follows the witnessed row order, including interleaved
    // covered facts. Compact grouping is a separate operand, not a new ordering
    // of that canonical rich fold.
    const cost = yield* aggregateUsageCostPartitionsSteps(admittedCosts, mode, shouldYield ?? (() => false));
    return { population, cost,
        allPriced: prices.every(price => price.api !== undefined),
        api: prices.reduce((sum, price) => addUsageMoney(sum, price.api ?? usageMoneyFromNumber(0)), usageMoneyFromNumber(0)),
        pricingSource: prices.every(price => price.source === prices[0]?.source) ? prices[0]?.source : 'effective_model_prices' };
}

/** One committed projection owns the operands shared by its output partitions. */
export function createUsagePricedPartitionBuilder(mode: UsageCostMode, shouldYield?: () => boolean) {
    const operands = new Map<UsagePricingOperand, ReturnType<typeof admitUsagePricingOperand>>();
    const admit = (row: UsagePricingOperand) => {
        let operand = operands.get(row);
        if (!operand) { operand = admitUsagePricingOperand(row); operands.set(row, operand); }
        return operand;
    };
    const steps = (rows: readonly UsagePricingOperand[], sharedStates = resolveUsagePricingPopulationStates(rows)) =>
        buildUsagePricedPartitionSteps(rows, mode, sharedStates, admit, shouldYield);
    return { steps, build(rows: readonly UsagePricingOperand[], sharedStates?: UsagePricingPopulationStates) {
        const projection = steps(rows, sharedStates);
        let next = projection.next();
        while (!next.done) next = projection.next();
        return next.value;
    } };

}

function* prepareUsagePricingPopulationSteps(rows: readonly UsagePricingOperand[], sharedStates: UsagePricingPopulationStates,
    complete: boolean, selectedMode?: UsageCostMode, admit = admitUsagePricingOperand, shouldYield?: () => boolean) {
    const includePrices = selectedMode !== undefined;
    const admittedCosts: UsageObservationCost[] = [];
    const grouped = new Map<string, { group: Group; costs?: ReturnType<typeof createUsageCostAccumulator>;
        api?: ReturnType<typeof createUsageMoneyAccumulator>; allPriced: boolean; source?: string }>();
    for (const row of rows) {
        const { categories, cost, raw, key } = admit(row);
        if (selectedMode !== undefined) admittedCosts.push(sharedStates.get(selectedMode)?.get(row) ?? cost);
        const state = (mode: typeof modes[number]) => selection(cost, sharedStates.get(mode)?.get(row) ?? cost, mode);
        const states = { auto: state('auto'), reported: state('reported'), estimated: state('estimated') };
        const signature = JSON.stringify([key, states]);
        const partition = grouped.get(signature);
        const api = includePrices && cost.apiEquivalentUsd !== undefined
            ? readUsageMoney(cost, 'apiEquivalentUsd', cost.apiEquivalentUsd) : undefined;
        if (partition) {
            partition.costs ??= createUsageCostAccumulator(partition.group.cost);
            partition.costs.add(raw);
            const group = partition.group;
            group.tokens = addUsageTokens(group.tokens, row.tokens);
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
    return { population: { groups: [...grouped.values()].map(({ group, costs }) => {
        const cost = costs?.value() ?? group.cost;
        return { ...group, cost, categoryUnits: group.categories ? units(group.categories, tokenFields) : {}, costUnits: costUnits(cost) };
    }) }, prices: includePrices ? [...grouped.values()].map(partition => ({
        api: partition.allPriced ? partition.api!.value() : undefined, source: partition.source,
    })) : [], admittedCosts };
}

function selectPricingGroupCost(cost: UsageObservationCost, group: Group, mode: UsageCostMode): UsageObservationCost {
    if (mode === 'api_equivalent' || group.selection[mode] === 'plain') return cost;
    const state = group.selection[mode];
    const selected = state === 'total' ? resolveUsageCostBasis(cost, mode) : null;
    return { ...cost, [usageCostAggregationBasis]: { mode, available: state !== 'unavailable',
        ...(state === 'covered' ? { covered: true } : {}), ...(selected ? { selected } : {}) } } as AggregatedUsageCost;
}

/** Combine already-admitted partitions in group space, without revisiting events. */
export function mergeUsagePricingPopulations(populations: readonly UsagePricingPopulation[]): UsagePricingPopulation {
    const grouped = new Map<string, Group>();
    for (const population of populations) for (const group of population.groups) {
        const key = groupKey(group.modelId, group.categories, group.cost, group.selection, group.tokens.total > 0);
        const previous = grouped.get(key);
        if (!previous) { grouped.set(key, group); continue; }
        const cost = addUsageCost(restoreCost(previous.cost, previous.costUnits), restoreCost(group.cost, group.costUnits));
        const categories = previous.categories && group.categories
            ? addUsageTokens(restore(previous.categories, previous.categoryUnits), restore(group.categories, group.categoryUnits)) : null;
        grouped.set(key, { ...previous, cost, costUnits: costUnits(cost), categories,
            categoryUnits: categories ? units(categories, tokenFields) : {}, tokens: addUsageTokens(previous.tokens, group.tokens),
            contributionCount: previous.contributionCount + group.contributionCount, eventCount: previous.eventCount + group.eventCount,
            asOfMs: Math.min(previous.asOfMs, group.asOfMs), complete: previous.complete && group.complete });
    }
    return { groups: [...grouped.values()] };
}

/** Shared exact arithmetic owners price grouped operands just as they price rows. */
export function priceUsagePricingPopulation(population: UsagePricingPopulation, catalog: UsageModelPriceCatalog,
    overrides: UsageModelPriceOverridesV1, mode: UsageCostMode) {
    let total = createEmptyUsageCost();
    let api = usageMoneyFromNumber(0);
    let savings = usageMoneyFromNumber(0);
    let cacheSavingsComplete = true;
    let pricedContributionCount = 0;
    let allPriced = true;
    const pricingSources = new Set<string>();
    const facts = createUsageSourceCostFacts();
    const estimateCost = createUsageModelCostEstimator(catalog, overrides);
    for (const group of population.groups) {
        const categories = group.categories ? restore(group.categories, group.categoryUnits) : null;
        const raw = restoreCost(group.cost, group.costUnits);
        const priced = priceUsageObservation(raw, group.modelId, categories, catalog, overrides, mode, estimateCost(group.modelId, categories));
        let cost = priced.cost;
        const estimate = priced.estimate;
        if (!estimate && group.tokens.cacheRead > 0) cacheSavingsComplete = false;
        savings = addUsageMoney(savings, readUsageMoney(estimate?.breakdown ?? {}, 'cacheSavingsUsd', estimate?.breakdown?.cacheSavingsUsd ?? 0));
        if (cost.apiEquivalentUsd !== undefined) {
            api = addUsageMoney(api, readUsageMoney(cost, 'apiEquivalentUsd', cost.apiEquivalentUsd));
            pricedContributionCount += group.contributionCount;
            pricingSources.add(cost.pricingSource ?? 'effective_model_prices');
        } else allPriced = false;
        const base = { tokens: group.tokens, eventCount: group.eventCount,
            asOfMs: group.asOfMs, complete: group.complete };
        for (const fact of resolveUsageCostFacts(cost)) facts.add({ ...base, ...fact, currency: fact.kind === 'api_equivalent' ? 'USD' : fact.currency }, group.contributionCount);
        if (!estimate && group.tokens.total > 0) facts.add({ ...base, kind: 'unpriced', currency: 'USD', amountUsd: null,
            source: categories ? 'model_price_unknown' : 'token_categories_unknown', complete: false }, group.contributionCount);
        cost = selectPricingGroupCost(cost, group, mode);
        total = addUsageCostForMode(total, cost, mode);
    }
    const selected = resolveUsageCostBasis(total, mode);
    const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, ...observed } = total;
    const cost = withUsageMoney({ ...observed, ...(allPriced ? { apiEquivalentUsd: usageMoneyToNumber(api),
        pricingSource: pricingSources.size === 1 ? [...pricingSources][0] : 'effective_model_prices' } : {}),
        ...(selected ? { effectiveUsd: selected.amountUsd } : {}) }, { ...(allPriced ? { apiEquivalentUsd: api } : {}),
            ...(selected ? { effectiveUsd: readUsageMoney(selected, 'amountUsd', selected.amountUsd) } : {}) });
    const projectedFacts = facts.values();
    return { cost: serializeUsageCostBasis(cost, mode), selected, selectedCost: selectResolvedUsageCost(total, mode),
        pricedContributionCount, pricingSources: [...pricingSources].sort(), apiEquivalentUsd: usageMoneyToNumber(api),
        facts: projectedFacts, cacheSavingsUsd: usageMoneyToNumber(savings), cacheSavingsComplete };
}
