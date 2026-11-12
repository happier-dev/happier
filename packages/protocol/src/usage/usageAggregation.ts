import type { UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { resolveEffectiveUsageCostUsd, resolveUsageCostBasis, type UsageCostMode, type UsageSelectedCostBasis } from './usageCostFacts.js';
import { addUsageMoney, createUsageMoneyAccumulator, hasUsageMoneyProvenance, readUsageMoney, usageMoneyToNumber, withUsageMoney, type ExactUsageMoney } from './usageMoney.js';

export function createEmptyUsageTokens(): UsageObservationTokens {
    return { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null };
}

export function createEmptyUsageCost(currency = 'USD'): UsageObservationCost {
    return { reportedUsd: null, estimatedUsd: null, invoiceUsd: null, billingContext: 'unknown', costSource: 'none', currency };
}

/** NULL means not measured; zero is an admitted measurement. */
export function addUsageMeasurements(left: number | null, right: number | null): number | null {
    return left === null ? right : right === null ? left : left + right;
}

/** Returns the measured lower bound when a provider omits its aggregate total. */
export function sumKnownUsageTokenParts(tokens: UsageObservationTokens): number | null {
    return [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite]
        .reduce<number | null>((sum, value) => addUsageMeasurements(sum, value), null);
}

/** Descending presentation order retains unknown values after every measured value. */
export function compareUsageMeasurementsDescending(left: number | null, right: number | null): number {
    return left === null ? right === null ? 0 : 1 : right === null ? -1 : right - left;
}

export function addUsageTokens(left: UsageObservationTokens, right: UsageObservationTokens): UsageObservationTokens {
    const total = { input: addUsageMeasurements(left.input, right.input), output: addUsageMeasurements(left.output, right.output),
        reasoning: addUsageMeasurements(left.reasoning, right.reasoning), cacheRead: addUsageMeasurements(left.cacheRead, right.cacheRead),
        cacheWrite: addUsageMeasurements(left.cacheWrite, right.cacheWrite), total: addUsageMeasurements(left.total, right.total) };
    const fields = Object.keys(total) as Array<keyof UsageObservationTokens>;
    if (!hasUsageMoneyProvenance(left) && !hasUsageMoneyProvenance(right)
        && fields.every(field => (left[field] === null || Number.isSafeInteger(left[field]))
            && (right[field] === null || Number.isSafeInteger(right[field]))
            && (total[field] === null || Number.isSafeInteger(total[field])))) return total;
    return withUsageMoney(total, Object.fromEntries(fields.flatMap(field => {
        const a = left[field];
        const b = right[field];
        if (a === null && b === null) return [];
        return [[field, a === null ? readUsageMoney(right, field, b!) : b === null ? readUsageMoney(left, field, a)
            : addUsageMoney(readUsageMoney(left, field, a), readUsageMoney(right, field, b))]];
    })));
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
    const money = new Map<typeof fields[number], ReturnType<typeof createUsageMoneyAccumulator>>();
    for (const field of fields) {
        const value = first[field];
        if (value != null) money.set(field, createUsageMoneyAccumulator(readUsageMoney(first, field, value)));
    }
    const breakdownMoney = new Map<string, ReturnType<typeof createUsageMoneyAccumulator>>();
    for (const [key, value] of Object.entries(first.breakdown ?? {})) breakdownMoney.set(key, createUsageMoneyAccumulator(readUsageMoney(first.breakdown!, key, value)));
    let { billingContext, costSource, currency } = first;
    return { add(input: UsageObservationCost) {
        const cost = { ...input };
        if (fields.some(field => cost[field] != null) || Object.keys(cost.breakdown ?? {}).length > 0) {
            if (money.size === 0 && breakdownMoney.size === 0) {
                ({ billingContext, costSource, currency } = cost);
            } else {
                if (billingContext !== cost.billingContext) billingContext = 'unknown';
                if (costSource !== cost.costSource) costSource = 'none';
                if (currency !== cost.currency) currency = 'MIXED';
            }
        }
        for (const field of fields) {
            const value = cost[field];
            if (value == null) continue;
            const operand = readUsageMoney(cost, field, value);
            const accumulator = money.get(field);
            if (accumulator) accumulator.add(operand);
            else money.set(field, createUsageMoneyAccumulator(operand));
        }
        for (const [key, value] of Object.entries(cost.breakdown ?? {})) {
            const amount = readUsageMoney(cost.breakdown!, key, value);
            const accumulated = breakdownMoney.get(key);
            if (accumulated) accumulated.add(amount);
            else breakdownMoney.set(key, createUsageMoneyAccumulator(amount));
        }
    }, value(): UsageObservationCost {
        const amounts = Object.fromEntries([...money].map(([field, value]) => [field, value.value()] as const));
        const breakdownAmounts = Object.fromEntries([...breakdownMoney].map(([key, value]) => [key, value.value()] as const));
        const breakdown = Object.keys(breakdownAmounts).length
            ? withUsageMoney(Object.fromEntries(Object.entries(breakdownAmounts).map(([key, value]) => [key, usageMoneyToNumber(value)])), breakdownAmounts) : undefined;
        return withUsageMoney({ reportedUsd: amounts.reportedUsd ? usageMoneyToNumber(amounts.reportedUsd) : null,
            estimatedUsd: amounts.estimatedUsd ? usageMoneyToNumber(amounts.estimatedUsd) : null,
            invoiceUsd: amounts.invoiceUsd ? usageMoneyToNumber(amounts.invoiceUsd) : null, billingContext, costSource, currency, breakdown }, amounts);
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
    return { available: admitted?.mode === mode ? admitted.available : true, selected };
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
    if (rows.length === 0) return { ...createEmptyUsageCost(), reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0,
        effectiveUsd: 0, selectedBasis: { mode, value: null } };
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
    const initialState = (initial as AggregatedUsageCost)[usageCostAggregationBasis];
    const initialBasis = resolveUsageCostBasis(initial, mode);
    const identity = !initialState && initial.costSource === 'none' && initial.apiEquivalentUsd === undefined
        && fields.every(field => initial[field] == null);
    let raw = identity ? undefined : createUsageCostAccumulator(initial);
    let api = initial.apiEquivalentUsd === undefined ? undefined : createUsageMoneyAccumulator(readUsageMoney(initial, 'apiEquivalentUsd', initial.apiEquivalentUsd));
    let pricingSource = initial.pricingSource;
    let selected: SelectedCostEvidence = selectedCostOperands({ available: initialState?.available ?? true, selected: initialBasis });
    const selectedMoney = createUsageMoneyAccumulator(initialBasis
        ? readUsageMoney(initialBasis, 'amountUsd', initialBasis.amountUsd) : { units: 0n, scale: 0 });
    for (const input of costs) {
        // Snapshot once before raw and selected exact arithmetic share the operand.
        const cost = { ...input };
        if (raw) raw.add(cost);
        else raw = createUsageCostAccumulator(cost);
        if (cost.apiEquivalentUsd !== undefined) {
            const operand = readUsageMoney(cost, 'apiEquivalentUsd', cost.apiEquivalentUsd);
            if (api) {
                api.add(operand);
                if (pricingSource !== cost.pricingSource) pricingSource = 'effective_model_prices';
            } else {
                api = createUsageMoneyAccumulator(operand);
                pricingSource = cost.pricingSource;
            }
        }
        const right = selectedCostOperands(selectResolvedUsageCost(cost, mode));
        selected = mergeSelectedCostEvidence(selected, right, mode);
        if (selected.available && right.amount) selectedMoney.add(right.amount);
        if (shouldYield?.()) yield;
    }
    const observed = raw!.value();
    const exactApi = api?.value();
    const exactSelected = selected.basis ? selectedMoney.value() : undefined;
    const published = publishSelectedCost({ ...selected, ...(exactSelected ? { amount: exactSelected } : {}) });
    const selectedBasis = published.selected;
    return withUsageMoney({ ...observed,
        ...(exactApi === undefined ? {} : { apiEquivalentUsd: usageMoneyToNumber(exactApi), pricingSource }),
        ...(selectedBasis ? { effectiveUsd: selectedBasis.amountUsd } : {}),
        [usageCostAggregationBasis]: { mode, available: published.available, ...(selectedBasis ? { selected: selectedBasis } : {}) } },
        { ...(exactApi === undefined ? {} : { apiEquivalentUsd: exactApi }), ...(exactSelected ? { effectiveUsd: exactSelected } : {}) });
}

export function withEffectiveUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
    const basis = resolveUsageCostBasis(cost, mode);
    const amount = basis?.amountUsd ?? resolveEffectiveUsageCostUsd(cost, mode);
    const { effectiveUsd: _previous, ...raw } = cost;
    return amount === null ? raw : withUsageMoney({ ...raw, effectiveUsd: amount },
        { effectiveUsd: basis ? readUsageMoney(basis, 'amountUsd', amount) : readUsageMoney(cost, 'effectiveUsd', amount) });
}
