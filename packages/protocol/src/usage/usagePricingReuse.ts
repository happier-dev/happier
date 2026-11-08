import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import type { UsageObservationTokens, UsagePricingPopulation } from './usageAnalyticsContracts.js';
import type { UsageModelCostEstimate } from './usageCost.js';
import type { UsageCostMode, UsageSelectedCostBasis } from './usageCostFacts.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { restoreUsageMoneyProvenance, serializeUsageMoneyProvenance, type SerializedUsageMoneyProvenance } from './usageMoney.js';

type SavedEstimate = Readonly<{ value: UsageModelCostEstimate | null;
    money?: SerializedUsageMoneyProvenance; breakdownMoney?: SerializedUsageMoneyProvenance }>;

type SavedCalendarTarget = Readonly<{ populationKeys: readonly string[]; selected: UsageSelectedCostBasis | null;
    money?: SerializedUsageMoneyProvenance }>;

/** Private pricing-owner checkpoint, never part of an analytics response. */
export interface UsagePricingReuseCheckpoint {
    v: 1;
    priceInputs: string;
    estimates: Array<readonly [string, SavedEstimate]>;
    calendar?: { populations: Record<string, UsagePricingPopulation>; targets: Record<string, SavedCalendarTarget> };
}

export interface UsagePricingReuse {
    readonly reusesPreviousPriceInputs: boolean;
    readonly stats: Readonly<{ tariffCalculations: number; tariffReuses: number;
        calendarTargetCalculations: number; calendarTargetReuses: number }>;
    estimate(modelId: string | null | undefined, categories: UsageObservationTokens | null,
        calculate: () => UsageModelCostEstimate | null): UsageModelCostEstimate | null;
    calendarTarget(key: string, inputs: readonly Readonly<{ key: string; population: UsagePricingPopulation }>[],
        calculate: () => UsageSelectedCostBasis | null): UsageSelectedCostBasis | null;
    snapshot(): UsagePricingReuseCheckpoint;
}

/** Public token numbers alone can hide admitted decimal precision. */
export function usageModelCostOperandKey(modelId: string | null | undefined, categories: UsageObservationTokens | null): string {
    return JSON.stringify([modelId ?? null, categories && [categories.input, categories.output,
        categories.reasoning, categories.cacheRead, categories.cacheWrite, categories.total,
        serializeUsageMoneyProvenance(categories)]]);
}

function restoreEstimate(saved: SavedEstimate): UsageModelCostEstimate | null {
    if (!saved.value) return null;
    return restoreUsageMoneyProvenance({ ...saved.value, ...(saved.value.breakdown ? {
        breakdown: restoreUsageMoneyProvenance({ ...saved.value.breakdown }, saved.breakdownMoney ?? {}),
    } : {}) }, saved.money ?? {});
}

/** One read reuses exact tariffs and calendar selections from a previous JSON-restored projection. */
export function createUsagePricingReuse(catalog: UsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1,
    mode: UsageCostMode, previous?: UsagePricingReuseCheckpoint): UsagePricingReuse {
    const priceInputs = JSON.stringify([catalog, overrides, mode]);
    let reusesPreviousPriceInputs = false;
    if (previous?.v === 1 && typeof previous.priceInputs === 'string' && Array.isArray(previous.estimates)) {
        try { reusesPreviousPriceInputs = sameStrictJsonValue(JSON.parse(previous.priceInputs), JSON.parse(priceInputs)); }
        catch { /* An obsolete private checkpoint is a cache miss. */ }
    }
    const saved = new Map(reusesPreviousPriceInputs ? previous!.estimates : []);
    const used = new Map<string, UsageModelCostEstimate | null>();
    const previousCalendar = reusesPreviousPriceInputs ? previous!.calendar : undefined;
    const populations = new Map<string, { population: UsagePricingPopulation; unchanged: boolean }>();
    const targets = new Map<string, SavedCalendarTarget>();
    const stats = { tariffCalculations: 0, tariffReuses: 0, calendarTargetCalculations: 0, calendarTargetReuses: 0 };
    return { reusesPreviousPriceInputs, stats,
        estimate(modelId, categories, calculate) {
            const key = usageModelCostOperandKey(modelId, categories);
            if (used.has(key)) { stats.tariffReuses++; return used.get(key)!; }
            const previousEstimate = saved.get(key);
            if (previousEstimate !== undefined) {
                stats.tariffReuses++;
                const value = restoreEstimate(previousEstimate);
                used.set(key, value);
                return value;
            }
            stats.tariffCalculations++;
            const value = calculate();
            used.set(key, value);
            return value;
        },
        // Compare each dated hour/Agent once, before any larger target merges it.
        // Selection depends on the complete ordered operands, including evidence and exact units.
        calendarTarget(key, inputs, calculate) {
            let unchanged = true;
            const populationKeys = inputs.map(input => {
                let admitted = populations.get(input.key);
                if (!admitted || admitted.population !== input.population) {
                    admitted = { population: input.population,
                        unchanged: sameStrictJsonValue(previousCalendar?.populations[input.key], input.population) };
                    populations.set(input.key, admitted);
                }
                unchanged = unchanged && admitted.unchanged;
                return input.key;
            });
            const previousTarget = previousCalendar?.targets[key];
            let selected: UsageSelectedCostBasis | null;
            if (unchanged && previousTarget && sameStrictJsonValue(previousTarget.populationKeys, populationKeys)) {
                stats.calendarTargetReuses++;
                selected = previousTarget.selected ? restoreUsageMoneyProvenance({ ...previousTarget.selected }, previousTarget.money ?? {}) : null;
            } else {
                stats.calendarTargetCalculations++;
                selected = calculate();
            }
            targets.set(key, { populationKeys, selected,
                ...(selected ? { money: serializeUsageMoneyProvenance(selected) } : {}) });
            return selected;
        },
        snapshot() {
            return { v: 1, priceInputs, ...(targets.size > 0 ? { calendar: {
                populations: Object.fromEntries([...populations].map(([key, input]) => [key, input.population])),
                targets: Object.fromEntries(targets) } } : {}), estimates: [...used].map(([key, value]) => [key, { value,
                ...(value ? { money: serializeUsageMoneyProvenance(value),
                    ...(value.breakdown ? { breakdownMoney: serializeUsageMoneyProvenance(value.breakdown) } : {}) } : {}) }]) };
        },
    };
}
