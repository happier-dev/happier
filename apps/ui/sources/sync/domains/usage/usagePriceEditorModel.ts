import { bundledUsageModelPriceCatalog, resolveUsageModelPrice, UsageModelPriceOverridesV1Schema,
    type ResolvedUsageModelPrice, type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { estimateUsageModelCost } from '@happier-dev/protocol/usage/usageCost';
import { resolveUsageTokenCategories } from '@happier-dev/protocol/usage/usageTokenCategories';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';

export interface UsagePriceEditorRow {
    modelId: string | null;
    override: UsageModelPriceOverridesV1[string] | null;
    catalogPrice: UsageModelPriceCatalog['models'][string] | null;
    effectivePrice: ResolvedUsageModelPrice | null;
    unpricedContributions: ReadonlyArray<{ id: string; tokens: UsageObservationTokens }>;
}

export interface UsagePriceEditorModel {
    provenance: UsageModelPriceCatalog['provenance'];
    rows: ReadonlyArray<UsagePriceEditorRow>;
    mappingTargets: ReadonlyArray<string>;
}

/** Display-only projection: money and token-category decisions stay Protocol-owned. */
export function buildUsagePriceEditorModel(slice: UsageQueryResultSlice, overrides: UsageModelPriceOverridesV1,
    catalog: UsageModelPriceCatalog = slice.accounting?.priceCatalog ?? bundledUsageModelPriceCatalog): UsagePriceEditorModel {
    const contributions = slice.accounting?.contributions ?? [];
    const modelIds = new Set<string | null>([...contributions.map(row => row.modelId),
        ...(slice.accounting?.breakdowns?.model ?? []).map(row => row.key === 'unknown' ? null : row.key), ...Object.keys(overrides)]);
    const rows = [...modelIds].sort((left, right) => (left ?? '').localeCompare(right ?? '')).map(modelId => ({
        modelId,
        override: modelId === null || !Object.hasOwn(overrides, modelId) ? null : overrides[modelId]!,
        catalogPrice: modelId === null || !Object.hasOwn(catalog.models, modelId) ? null : catalog.models[modelId]!,
        effectivePrice: resolveUsageModelPrice(modelId, catalog, overrides),
        unpricedContributions: contributions.filter(row => row.modelId === modelId && row.tokens.total > 0
            && !estimateUsageModelCost(row.modelId, row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null), catalog, overrides))
            .map(row => ({ id: row.id, tokens: row.tokens })),
    }));
    return { provenance: catalog.provenance, rows,
        mappingTargets: [...new Set([...Object.keys(catalog.models), ...Object.keys(overrides)])].sort() };
}

export interface UsageModelPriceSettingsIntent {
    actionId: 'settings.set';
    input: { anchor: 'usage.modelPrices'; value: UsageModelPriceOverridesV1 };
}

/** The consumer executes this through ordinary Account settings Actions; no second writer. */
export function createUsageModelPriceSettingsIntent(current: UsageModelPriceOverridesV1,
    edit: Readonly<{ modelId: string; override: UsageModelPriceOverridesV1[string] | null }>): UsageModelPriceSettingsIntent {
    const modelId = edit.modelId.trim();
    if (!modelId) throw new Error('Model identifier is required');
    const next = { ...current };
    if (edit.override === null) delete next[modelId];
    else Object.defineProperty(next, modelId, { value: edit.override, enumerable: true, configurable: true, writable: true });
    return { actionId: 'settings.set', input: { anchor: 'usage.modelPrices', value: UsageModelPriceOverridesV1Schema.parse(next) } };
}
