import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery, getUsageQueryKey, usageQueryToAnalyticsRequest } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageModelPriceCatalogSchema, type UsageModelPriceOverridesV1 } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { buildUsagePriceEditorModel, createUsageModelPriceSettingsIntent } from './usagePriceEditorModel';
import { projectUsageAnalyticsSummary } from '@happier-dev/protocol/usage/usageCost';

const catalog = UsageModelPriceCatalogSchema.parse({ v: 1, models: {
    reference: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
}, provenance: { source: 'litellm', origin: 'cached', asOfMs: 100, revision: 'catalog', fetchStatus: 'error', errorCode: 'fetch_failed' } });
const query = normalizeUsageQuery({});
const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
const contribution = { id: 'unpriced', observedAtMs: 150, sessionId: null, turnId: null, agentId: null,
    modelId: 'private', machineId: null, projectKey: null, workspaceId: null, source: null,
    tokens, cost: { reportedUsd: 3, estimatedUsd: 2, currency: 'USD' } };
const slice: UsageQueryResultSlice = { key: getUsageQueryKey(query), requestedQuery: query, shownQuery: query,
    sources: [{ source: 'accounting', status: 'available' }], pending: false,
    accounting: { v: 1, totals: { eventCount: 1, tokens, cost: contribution.cost }, contributions: [contribution] } };

describe('Usage model price editor projection', () => {
    it('preserves model identities and unpriced tokens from grouped evidence through edits, mappings and clearing', () => {
        const rich = { ...slice, accounting: { ...slice.accounting!, priceCatalog: catalog,
            contributions: [contribution, { ...contribution, id: 'null-model', modelId: null },
                { ...contribution, id: 'known', modelId: 'reference' },
                { ...contribution, id: 'unknown-categories', modelId: 'reference', tokens: { ...tokens, cacheRead: 2 } }] } };
        const compact = { ...rich, accounting: projectUsageAnalyticsSummary(rich.accounting, usageQueryToAnalyticsRequest(query, 1000)) };
        const edits: UsageModelPriceOverridesV1[] = [{}, { private: { kind: 'map', modelId: 'reference' } },
            { private: { kind: 'rates', inputUsdPerMillion: 3, outputUsdPerMillion: 5 } }, {}];
        for (const overrides of edits) {
            expect(buildUsagePriceEditorModel(compact, overrides)).toEqual(buildUsagePriceEditorModel(rich, overrides));
        }
        expect(buildUsagePriceEditorModel(compact, {}).rows).toEqual([
            expect.objectContaining({ modelId: null, unpricedTokens: 15 }),
            expect.objectContaining({ modelId: 'private', unpricedTokens: 15 }),
            expect.objectContaining({ modelId: 'reference', unpricedTokens: 15 }),
        ]);
    });
    it('offers one Haiku identity and edits or resets both existing alias overrides together', () => {
        const alias = 'claude-haiku-4-5';
        const dated = 'claude-haiku-4-5-20251001';
        const rates = { kind: 'rates' as const, inputUsdPerMillion: 20, outputUsdPerMillion: 40 };
        const haikuSlice = { ...slice, accounting: { ...slice.accounting!, contributions: [alias, dated].map(modelId => ({ ...contribution, modelId })) } };
        const model = buildUsagePriceEditorModel(haikuSlice, { [dated]: rates });
        expect(model.rows).toEqual([expect.objectContaining({ modelId: alias, override: rates,
            effectivePrice: expect.objectContaining({ source: 'override', rates }), unpricedTokens: 0 })]);
        expect(model.mappingTargets).toContain(alias);
        expect(model.mappingTargets).not.toContain(dated);
        const current = { [alias]: rates, [dated]: rates, other: { kind: 'map' as const, modelId: 'reference' } };
        expect(createUsageModelPriceSettingsIntent(current, { modelId: dated, override: null }).input.value).toEqual({ other: current.other });
        expect(createUsageModelPriceSettingsIntent(current, { modelId: dated, override: { kind: 'map', modelId: 'gpt-5.4' } }).input.value)
            .toEqual({ [alias]: { kind: 'map', modelId: 'gpt-5.4' }, other: current.other });
    });
    it('exposes catalog provenance and exact unpriced populations and resolves mappings through the canonical price owner', () => {
        const unpriced = buildUsagePriceEditorModel(slice, {}, catalog);
        expect(unpriced.provenance).toEqual(catalog.provenance);
        expect(unpriced.rows).toEqual([expect.objectContaining({ modelId: 'private', effectivePrice: null,
            unpricedTokens: tokens.total })]);
        const mapped = buildUsagePriceEditorModel(slice, { private: { kind: 'map', modelId: 'reference' } }, catalog);
        expect(mapped.rows).toEqual([expect.objectContaining({ modelId: 'private', override: { kind: 'map', modelId: 'reference' },
            effectivePrice: { modelId: 'reference', rates: catalog.models.reference, source: 'mapping', mappedFrom: 'private' },
            unpricedTokens: 0 })]);
        expect(mapped.mappingTargets).toEqual(['private', 'reference']);
        expect(buildUsagePriceEditorModel({ ...slice, accounting: { ...slice.accounting!, contributions: [{ ...contribution, modelId: null }] } }, {}, catalog)
            .rows[0]).toMatchObject({ modelId: null, effectivePrice: null, unpricedTokens: tokens.total });
        const overlapping = { ...tokens, cacheRead: 2 };
        expect(buildUsagePriceEditorModel({ ...slice, accounting: { ...slice.accounting!, contributions: [{ ...contribution, modelId: 'reference', tokens: overlapping }] } }, {}, catalog)
            .rows[0]).toMatchObject({ effectivePrice: { source: 'catalog' }, unpricedTokens: overlapping.total });
    });
    it('builds ordinary settings Action intents that preserve unrelated overrides and reject cyclic mappings', () => {
        const current = { private: { kind: 'rates' as const, inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
            other: { kind: 'map' as const, modelId: 'reference' } };
        expect(createUsageModelPriceSettingsIntent(current, { modelId: 'private', override: null }))
            .toEqual({ actionId: 'settings.set', input: { anchor: 'usage.modelPrices', value: { other: current.other } } });
        expect(createUsageModelPriceSettingsIntent(current, { modelId: 'private', override: { kind: 'map', modelId: 'reference' } }))
            .toMatchObject({ input: { value: { private: { kind: 'map', modelId: 'reference' }, other: current.other } } });
        expect(() => createUsageModelPriceSettingsIntent(current, { modelId: 'reference', override: { kind: 'map', modelId: 'other' } })).toThrow();
    });
    it('treats inherited names as unpriced, preserves ordinary own names, and rejects the schema-reserved prototype key', () => {
        const unknown = buildUsagePriceEditorModel({ ...slice, accounting: { ...slice.accounting!, contributions: [{ ...contribution, modelId: 'toString' }] } }, {}, catalog);
        expect(unknown.rows[0]).toMatchObject({ catalogPrice: null, override: null, effectivePrice: null });
        const rates = { kind: 'rates' as const, inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
        expect(() => createUsageModelPriceSettingsIntent({}, { modelId: '__proto__', override: rates })).toThrow();
        expect(createUsageModelPriceSettingsIntent({}, { modelId: 'toString', override: rates }).input.value.toString).toEqual(rates);
        expect(createUsageModelPriceSettingsIntent({}, { modelId: 'constructor', override: rates }).input.value.constructor).toEqual(rates);
    });
});
