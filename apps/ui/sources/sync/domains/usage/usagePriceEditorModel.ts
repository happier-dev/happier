import { bundledUsageModelPriceCatalog, canonicalUsageModelPriceId, readUsageModelPriceOverride, resolveUsageModelPrice, UsageModelPriceOverridesV1Schema,
    type ResolvedUsageModelPrice, type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { estimateUsageModelCost } from '@happier-dev/protocol/usage/usageCost';
import { resolveUsageTokenCategories } from '@happier-dev/protocol/usage/usageTokenCategories';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';

export interface UsagePriceEditorRow {
    modelId: string | null;
    override: UsageModelPriceOverridesV1[string] | null;
    catalogPrice: UsageModelPriceCatalog['models'][string] | null;
    effectivePrice: ResolvedUsageModelPrice | null;
    unpricedTokens: number;
}

export interface UsagePriceEditorModel {
    provenance: UsageModelPriceCatalog['provenance'];
    rows: ReadonlyArray<UsagePriceEditorRow>;
    mappingTargets: ReadonlyArray<string>;
}

/** Display-only projection: money and token-category decisions stay Protocol-owned. */
export function buildUsagePriceEditorModel(slice: UsageQueryResultSlice, overrides: UsageModelPriceOverridesV1,
    catalog: UsageModelPriceCatalog = slice.accounting?.priceCatalog ?? bundledUsageModelPriceCatalog): UsagePriceEditorModel {
    const contributions = slice.accounting?.contributions;
    const groups = contributions === undefined ? slice.accounting?.summary?.pricing?.totals?.groups ?? [] : [];
    const modelIds = new Set<string | null>([...(contributions ?? groups).map(row => row.modelId),
        ...(slice.accounting?.breakdowns?.model ?? []).map(row => row.key === 'unknown' ? null : row.key), ...Object.keys(overrides)]
        .map(id => canonicalUsageModelPriceId(id)));
    const rows = [...modelIds].sort((left, right) => (left ?? '').localeCompare(right ?? '')).map(modelId => ({
        modelId,
        override: readUsageModelPriceOverride(modelId, overrides),
        catalogPrice: resolveUsageModelPrice(modelId, catalog)?.rates ?? null,
        effectivePrice: resolveUsageModelPrice(modelId, catalog, overrides),
        unpricedTokens: contributions !== undefined
            ? contributions.reduce((sum, row) => sum + (canonicalUsageModelPriceId(row.modelId) === modelId && row.tokens.total > 0
                && !estimateUsageModelCost(row.modelId, row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null), catalog, overrides)
                ? row.tokens.total : 0), 0)
            : groups.reduce((sum, group) => sum + (canonicalUsageModelPriceId(group.modelId) === modelId && group.tokens.total > 0
                && !estimateUsageModelCost(group.modelId, group.categories, catalog, overrides) ? group.tokens.total : 0), 0),
    }));
    return { provenance: catalog.provenance, rows,
        mappingTargets: [...new Set([...Object.keys(catalog.models), ...Object.keys(overrides)]
            .map(id => canonicalUsageModelPriceId(id)!))].sort() };
}

export interface UsageModelPriceSettingsIntent {
    actionId: 'settings.set';
    input: { anchor: 'usage.modelPrices'; value: UsageModelPriceOverridesV1 };
}

/** The consumer executes this through ordinary Account settings Actions; no second writer. */
export function createUsageModelPriceSettingsIntent(current: UsageModelPriceOverridesV1,
    edit: Readonly<{ modelId: string; override: UsageModelPriceOverridesV1[string] | null }>): UsageModelPriceSettingsIntent {
    const modelId = canonicalUsageModelPriceId(edit.modelId);
    if (!modelId) throw new Error('Model identifier is required');
    const next = { ...current };
    for (const id of Object.keys(next)) {
        if (canonicalUsageModelPriceId(id) === modelId) delete next[id];
    }
    if (edit.override !== null) {
        const override = edit.override.kind === 'map'
            ? { ...edit.override, modelId: canonicalUsageModelPriceId(edit.override.modelId)! } : edit.override;
        Object.defineProperty(next, modelId, { value: override, enumerable: true, configurable: true, writable: true });
    }
    return { actionId: 'settings.set', input: { anchor: 'usage.modelPrices', value: UsageModelPriceOverridesV1Schema.parse(next) } };
}
