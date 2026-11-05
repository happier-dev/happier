import type { UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { resolveUsageCostBasis, type UsageCostMode, type UsageSelectedCostBasis } from './usageCostFacts.js';
import { addUsageMoney, createUsageMoneyAccumulator, hasUsageMoneyProvenance, readUsageMoney, usageMoneyToNumber, withUsageMoney, type ExactUsageMoney } from './usageMoney.js';

export function createEmptyUsageTokens(): UsageObservationTokens {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function createEmptyUsageCost(currency = 'USD'): UsageObservationCost {
    return { reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0, billingContext: 'unknown', costSource: 'none', currency };
}

export function addUsageTokens(left: UsageObservationTokens, right: UsageObservationTokens): UsageObservationTokens {
    const total = { input: left.input + right.input, output: left.output + right.output, reasoning: left.reasoning + right.reasoning,
        cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, total: left.total + right.total };
    const fields = Object.keys(total) as Array<keyof UsageObservationTokens>;
    if (!hasUsageMoneyProvenance(left) && !hasUsageMoneyProvenance(right)
        && fields.every(field => Number.isSafeInteger(left[field]) && Number.isSafeInteger(right[field]) && Number.isSafeInteger(total[field]))) return total;
    return withUsageMoney(total, Object.fromEntries(fields.map(field =>
        [field, addUsageMoney(readUsageMoney(left, field, left[field]), readUsageMoney(right, field, right[field]))])));
}

/** Fold raw monetary operands before publishing their public numeric representation. */
export function aggregateUsageCosts(costs: Iterable<UsageObservationCost>): UsageObservationCost {
    let accumulator: ReturnType<typeof createUsageCostAccumulator> | undefined;
    for (const cost of costs) {
        if (accumulator) accumulator.add(cost);
        else accumulator = createUsageCostAccumulator(cost);
    }
    return accumulator?.value() ?? createEmptyUsageCost();
}

/** A pricing group keeps exact operands, rather than an array of event-shaped costs. */
export function createUsageCostAccumulator(initial: UsageObservationCost) {
    const fields = ['reportedUsd', 'estimatedUsd', 'invoiceUsd'] as const;
    const first = { ...initial };
    const money = Object.fromEntries(fields.map(field => [field, createUsageMoneyAccumulator(readUsageMoney(first, field, first[field] ?? 0))] as const));
    const breakdownMoney = new Map<string, ReturnType<typeof createUsageMoneyAccumulator>>();
    for (const [key, value] of Object.entries(first.breakdown ?? {})) breakdownMoney.set(key, createUsageMoneyAccumulator(readUsageMoney(first.breakdown!, key, value)));
    let { billingContext, costSource, currency } = first;
    return { add(input: UsageObservationCost) {
        const cost = { ...input };
        for (const field of fields) money[field]!.add(readUsageMoney(cost, field, cost[field] ?? 0));
        for (const [key, value] of Object.entries(cost.breakdown ?? {})) {
            const amount = readUsageMoney(cost.breakdown!, key, value);
            const accumulated = breakdownMoney.get(key);
            if (accumulated) accumulated.add(amount);
            else breakdownMoney.set(key, createUsageMoneyAccumulator(amount));
        }
        if (billingContext !== cost.billingContext) billingContext = 'unknown';
        if (costSource !== cost.costSource) costSource = 'none';
        if (currency !== cost.currency) currency = 'MIXED';
    }, value(): UsageObservationCost {
        const amounts = Object.fromEntries(fields.map(field => [field, money[field]!.value()] as const));
        const breakdownAmounts = Object.fromEntries([...breakdownMoney].map(([key, value]) => [key, value.value()] as const));
        const breakdown = Object.keys(breakdownAmounts).length
            ? withUsageMoney(Object.fromEntries(Object.entries(breakdownAmounts).map(([key, value]) => [key, usageMoneyToNumber(value)])), breakdownAmounts) : undefined;
        return withUsageMoney({ reportedUsd: usageMoneyToNumber(amounts.reportedUsd!), estimatedUsd: usageMoneyToNumber(amounts.estimatedUsd!),
            invoiceUsd: usageMoneyToNumber(amounts.invoiceUsd!), billingContext, costSource, currency, breakdown }, amounts);
    } };
}

export function addUsageCost(left: UsageObservationCost, right: UsageObservationCost): UsageObservationCost {
    return aggregateUsageCosts([left, right]);
}

// Distinguish the initial zero accumulator from an already unpriced population.
// This aggregation-only evidence never enters the serialized contract.
export const usageCostAggregationBasis = Symbol('usageCostAggregationBasis');
export type AggregatedUsageCost = UsageObservationCost & { [usageCostAggregationBasis]?: {
    mode: UsageCostMode; available: boolean; selected?: UsageSelectedCostBasis; covered?: boolean;
} };

/** Selected monetary state, after population-level overlap has been resolved.
 * Available with no selection is the empty/covered identity; unavailable is sticky.
 */
export interface UsageSelectedCostAccumulator {
    available: boolean;
    selected: UsageSelectedCostBasis | null;
}

export function createEmptyUsageSelectedCost(): UsageSelectedCostAccumulator {
    return { available: true, selected: null };
}

export function selectResolvedUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageSelectedCostAccumulator {
    const admitted = (cost as AggregatedUsageCost)[usageCostAggregationBasis];
    if (admitted?.covered) return createEmptyUsageSelectedCost();
    const selected = resolveUsageCostBasis(cost, mode);
    return { available: admitted?.mode === mode ? admitted.available : selected !== null, selected };
}

/** Merge already-selected partitions without re-reading raw facts or resolving overlap. */
export function mergeUsageSelectedCosts(left: UsageSelectedCostAccumulator, right: UsageSelectedCostAccumulator,
    mode: UsageCostMode): UsageSelectedCostAccumulator {
    return publishSelectedCost(mergeSelectedCostOperands(selectedCostOperands(left), selectedCostOperands(right), mode));
}

type SelectedCostOperands = Readonly<{ available: boolean; basis: Omit<UsageSelectedCostBasis, 'amountUsd'> | null; amount?: ExactUsageMoney }>;
type SelectedCostEvidence = Pick<SelectedCostOperands, 'available' | 'basis'>;
function selectedCostOperands(state: UsageSelectedCostAccumulator): SelectedCostOperands {
    const basis = state.selected;
    return { available: state.available, basis,
        ...(basis ? { amount: readUsageMoney(basis, 'amountUsd', basis.amountUsd) } : {}) };
}
function mergeSelectedCostOperands(left: SelectedCostOperands, right: SelectedCostOperands, mode: UsageCostMode): SelectedCostOperands {
    const evidence = mergeSelectedCostEvidence(left, right, mode);
    return { ...evidence, ...(evidence.basis ? { amount: !left.basis ? right.amount : !right.basis ? left.amount
        : addUsageMoney(left.amount!, right.amount!) } : {}) };
}
function mergeSelectedCostEvidence(left: SelectedCostEvidence, right: SelectedCostEvidence, mode: UsageCostMode): SelectedCostEvidence {
    if (!left.available || !right.available) return { available: false, basis: null };
    if (!left.basis) return right;
    if (!right.basis) return left;
    const a = left.basis;
    const b = right.basis;
    if (a.currency !== b.currency || mode !== 'auto' && a.kind !== b.kind) return { available: false, basis: null };
    return { available: true,
        basis: { kind: a.kind === b.kind ? a.kind : 'mixed', currency: a.currency,
            source: a.kind === b.kind && a.source === b.source ? a.source : 'best_available' } };
}
function publishSelectedCost(state: SelectedCostOperands): UsageSelectedCostAccumulator {
    return { available: state.available, selected: state.basis ? withUsageMoney({ ...state.basis,
        amountUsd: usageMoneyToNumber(state.amount!) }, { amountUsd: state.amount! }) : null };
}

/** Resolve whole-total overlap only within the actual selected population, including bucket/Work subsets. */
export function resolveUsageContributionCosts(rows: readonly { id?: string; cost: UsageObservationCost }[], mode: UsageCostMode): UsageObservationCost[] {
    if (mode === 'estimated') return rows.map(row => {
        // A scoped money-only report is not another estimated-token population.
        if (!row.cost.reportedTotalContributionIds || row.cost.estimatedUsd !== 0) return row.cost;
        const cost: AggregatedUsageCost = { ...row.cost, [usageCostAggregationBasis]: { mode, available: true, covered: true } };
        return cost;
    });
    if (mode !== 'auto' && mode !== 'reported') return rows.map(row => row.cost);
    const ids = new Set(rows.flatMap(row => row.id ? [row.id] : []));
    const completeTotals = new Map(rows.filter(row => row.id && row.cost.reportedTotalContributionIds
        && row.cost.reportedTotalContributionIds.every(id => ids.has(id)))
        .map(row => [row.id!, new Set(row.cost.reportedTotalContributionIds)]));
    return rows.map(row => {
        const total = row.cost.reportedTotalId && completeTotals.get(row.cost.reportedTotalId);
        if (total && row.id && total.has(row.id)) {
            const cost: AggregatedUsageCost = { ...row.cost, [usageCostAggregationBasis]: { mode, available: true, covered: true } };
            return cost;
        }
        if (row.id && completeTotals.has(row.id)) {
            const { reportedTotalContributionIds: _scope, ...raw } = row.cost;
            const selected = resolveUsageCostBasis(raw, mode);
            const cost: AggregatedUsageCost = { ...row.cost, [usageCostAggregationBasis]: { mode,
                available: selected !== null, ...(selected ? { selected } : {}) } };
            return cost;
        }
        return row.cost;
    });
}

export function aggregateUsageContributionCosts(rows: readonly { id?: string; cost: UsageObservationCost }[], mode: UsageCostMode): AggregatedUsageCost {
    return aggregateUsageCostPartitions(resolveUsageContributionCosts(rows, mode), mode);
}

/** Already-admitted partitions retain their selected scope; do not resolve it again. */
export function aggregateUsageCostPartitions(costs: readonly UsageObservationCost[], mode: UsageCostMode): AggregatedUsageCost {
    return aggregateResolvedUsageCosts(createEmptyUsageCost(), costs, mode);
}

/** Hosts may service I/O between already-admitted monetary operands. */
export function* aggregateUsageCostPartitionsSteps(costs: readonly UsageObservationCost[], mode: UsageCostMode,
    shouldYield: () => boolean = () => true): Generator<void, AggregatedUsageCost, void> {
    return yield* aggregateResolvedUsageCostsSteps(createEmptyUsageCost(), costs, mode, shouldYield);
}

export function addUsageCostForMode(left: UsageObservationCost, right: UsageObservationCost, mode: UsageCostMode): AggregatedUsageCost {
    return aggregateResolvedUsageCosts(left, [right], mode);
}

/** Fold admitted exact operands; materialize public numbers/provenance once per output, not per row. */
function aggregateResolvedUsageCosts(initial: UsageObservationCost, costs: readonly UsageObservationCost[], mode: UsageCostMode): AggregatedUsageCost {
    const steps = aggregateResolvedUsageCostsSteps(initial, costs, mode);
    let next = steps.next();
    while (!next.done) next = steps.next();
    return next.value;
}

function* aggregateResolvedUsageCostsSteps(initial: UsageObservationCost, costs: readonly UsageObservationCost[], mode: UsageCostMode,
    shouldYield?: () => boolean): Generator<void, AggregatedUsageCost, void> {
    if (!costs.length) return initial;
    const fields = ['reportedUsd', 'estimatedUsd', 'invoiceUsd'] as const;
    const money = Object.fromEntries(fields.map(field => [field, createUsageMoneyAccumulator(readUsageMoney(initial, field, initial[field] ?? 0))])) as Record<typeof fields[number], ReturnType<typeof createUsageMoneyAccumulator>>;
    const breakdown = new Map(Object.entries(initial.breakdown ?? {}).map(([key, amount]) => [key, createUsageMoneyAccumulator(readUsageMoney(initial.breakdown!, key, amount))]));
    let api = initial.apiEquivalentUsd === undefined ? undefined : createUsageMoneyAccumulator(readUsageMoney(initial, 'apiEquivalentUsd', initial.apiEquivalentUsd));
    let currency = initial.currency;
    let billingContext = initial.billingContext;
    let costSource = initial.costSource;
    let pricingSource = initial.pricingSource;
    const initialState = (initial as AggregatedUsageCost)[usageCostAggregationBasis];
    let hasState = initialState !== undefined;
    const basis = resolveUsageCostBasis(initial, mode);
    let empty = initialState ? initialState.available && !initialState.selected
        : api === undefined && costSource === 'none' && fields.every(field => (initial[field] ?? 0) === 0);
    const initialSelected = selectedCostOperands({ available: empty || basis !== null, selected: basis });
    let selected: SelectedCostEvidence = initialSelected;
    const selectedMoney = createUsageMoneyAccumulator(initialSelected.amount ?? { units: 0n, scale: 0 });
    for (const input of costs) {
        // Snapshot the admitted numeric operand once. Symbols retain exact
        // precision and overlap admission; no schema/JSON round-trip occurs.
        const cost = { ...input };
        const admitted = selectResolvedUsageCost(cost, mode);
        const right = admitted.selected;
        const noApiPopulation = api === undefined && fields.every(field => money[field].isZero());
        if (!hasState && noApiPopulation) {
            api = cost.apiEquivalentUsd === undefined ? undefined : createUsageMoneyAccumulator(readUsageMoney(cost, 'apiEquivalentUsd', cost.apiEquivalentUsd));
        } else if (api !== undefined && cost.apiEquivalentUsd !== undefined) {
            api.add(readUsageMoney(cost, 'apiEquivalentUsd', cost.apiEquivalentUsd));
        } else api = undefined;
        pricingSource = api === undefined ? undefined : empty ? cost.pricingSource
            : pricingSource === cost.pricingSource ? pricingSource : 'effective_model_prices';
        currency = currency === cost.currency ? currency : 'MIXED';
        billingContext = billingContext === cost.billingContext ? billingContext : 'unknown';
        costSource = costSource === cost.costSource ? costSource : 'none';
        for (const field of fields) money[field].add(readUsageMoney(cost, field, cost[field] ?? 0));
        for (const [key, amount] of Object.entries(cost.breakdown ?? {})) {
            const operand = readUsageMoney(cost.breakdown!, key, amount);
            const accumulated = breakdown.get(key);
            if (accumulated) accumulated.add(operand);
            else breakdown.set(key, createUsageMoneyAccumulator(operand));
        }
        const rightOperands = selectedCostOperands(admitted);
        selected = mergeSelectedCostEvidence(selected, rightOperands, mode);
        if (selected.available && rightOperands.amount) selectedMoney.add(rightOperands.amount);
        if (empty && right) {
            currency = cost.currency;
            if (noApiPopulation) costSource = cost.costSource;
        }
        if (!selected.available) costSource = 'none';
        empty = selected.available && !selected.basis;
        hasState = true;
        if (shouldYield?.()) yield;
    }
    const exactMoney = Object.fromEntries(fields.map(field => [field, money[field].value()])) as Record<typeof fields[number], ExactUsageMoney>;
    const exactBreakdown = Object.fromEntries([...breakdown].map(([key, amount]) => [key, amount.value()]));
    const exactApi = api?.value();
    const exactSelected = selected.basis ? selectedMoney.value() : undefined;
    const published = publishSelectedCost({ ...selected, ...(exactSelected ? { amount: exactSelected } : {}) });
    const selectedBasis = published.selected;
    const amounts = { ...exactMoney, ...(exactApi === undefined ? {} : { apiEquivalentUsd: exactApi }),
        ...(exactSelected ? { effectiveUsd: exactSelected } : {}) };
    return withUsageMoney({ reportedUsd: usageMoneyToNumber(exactMoney.reportedUsd), estimatedUsd: usageMoneyToNumber(exactMoney.estimatedUsd),
        invoiceUsd: usageMoneyToNumber(exactMoney.invoiceUsd), currency, billingContext, costSource,
        breakdown: breakdown.size ? withUsageMoney(Object.fromEntries(Object.entries(exactBreakdown).map(([key, amount]) => [key, usageMoneyToNumber(amount)])), exactBreakdown) : undefined,
        ...(exactApi === undefined ? {} : { apiEquivalentUsd: usageMoneyToNumber(exactApi), pricingSource }),
        ...(selectedBasis ? { effectiveUsd: selectedBasis.amountUsd } : {}),
        [usageCostAggregationBasis]: { mode, available: published.available, ...(selectedBasis ? { selected: selectedBasis } : {}) } }, amounts);
}

export function withEffectiveUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
    const basis = resolveUsageCostBasis(cost, mode);
    const { effectiveUsd: _previous, ...raw } = cost;
    return basis ? withUsageMoney({ ...raw, effectiveUsd: basis.amountUsd },
        { effectiveUsd: readUsageMoney(basis, 'amountUsd', basis.amountUsd) }) : raw;
}
