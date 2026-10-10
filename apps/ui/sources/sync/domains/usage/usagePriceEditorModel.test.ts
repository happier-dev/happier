import { describe, expect, it } from 'vitest';
import { normalizeUsageQuery, getUsageQueryKey } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { UsageModelPriceCatalogSchema } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { buildUsagePriceEditorModel, createUsageModelPriceSettingsIntent } from './usagePriceEditorModel';

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
    it('exposes catalog provenance and exact unpriced populations and resolves mappings through the canonical price owner', () => {
        const unpriced = buildUsagePriceEditorModel(slice, {}, catalog);
        expect(unpriced.provenance).toEqual(catalog.provenance);
        expect(unpriced.rows).toEqual([expect.objectContaining({ modelId: 'private', effectivePrice: null,
            unpricedContributions: [{ id: 'unpriced', tokens }] })]);
        const mapped = buildUsagePriceEditorModel(slice, { private: { kind: 'map', modelId: 'reference' } }, catalog);
        expect(mapped.rows).toEqual([expect.objectContaining({ modelId: 'private', override: { kind: 'map', modelId: 'reference' },
            effectivePrice: { modelId: 'reference', rates: catalog.models.reference, source: 'mapping', mappedFrom: 'private' },
            unpricedContributions: [] })]);
        expect(mapped.mappingTargets).toEqual(['private', 'reference']);
        expect(buildUsagePriceEditorModel({ ...slice, accounting: { ...slice.accounting!, contributions: [{ ...contribution, modelId: null }] } }, {}, catalog)
            .rows[0]).toMatchObject({ modelId: null, effectivePrice: null, unpricedContributions: [{ id: 'unpriced', tokens }] });
        const overlapping = { ...tokens, cacheRead: 2 };
        expect(buildUsagePriceEditorModel({ ...slice, accounting: { ...slice.accounting!, contributions: [{ ...contribution, modelId: 'reference', tokens: overlapping }] } }, {}, catalog)
            .rows[0]).toMatchObject({ effectivePrice: { source: 'catalog' }, unpricedContributions: [{ id: 'unpriced', tokens: overlapping }] });
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
