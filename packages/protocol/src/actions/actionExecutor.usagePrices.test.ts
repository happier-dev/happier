import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { bundledUsageModelPriceCatalog } from '../usage/usageModelPriceCatalog.js';
import { UsageModelPriceCatalogSchema } from '../usage/usageModelPriceSchemas.js';
import { measureExternalActionResultResponseEnvelopeUtf8BytesV1 } from './externalActionLimits.js';
import { getActionSpec } from './actionSpecs.js';
import { USAGE_PRICE_ACTION_IDS } from '../usage/usageActionIdsV1.js';

describe('model price Action delivery', () => {
  const catalog = bundledUsageModelPriceCatalog;
  const executor = createActionExecutor({ usageActions: {
    query: async () => { throw new Error('Price reads do not query private Usage'); },
    prices: { get: async () => catalog, refresh: async () => catalog },
  } } as ActionExecutorDeps);

  it.each(Object.values(USAGE_PRICE_ACTION_IDS))('%s summarizes the real bundled catalog within the existing agent tool budget and recovers exact prices', async actionId => {
    // Pi truncates tool output at 50 KiB. This is its existing boundary, not a new Usage limit.
    expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(catalog)).toBeGreaterThan(50 * 1024);
    const modelIds = Object.keys(catalog.models).slice(0, 2);
    for (const surface of ['agent', 'mcp'] as const) {
      const summary = await executor.execute(actionId, {}, { surface, authority: 'present_user' });
      expect(summary.ok).toBe(true);
      if (!summary.ok) throw new Error('Expected public price summary');
      expect(measureExternalActionResultResponseEnvelopeUtf8BytesV1(summary.result)).toBeLessThan(50 * 1024);
      expect(summary.result).toEqual({ v: 1, modelCount: Object.keys(catalog.models).length, provenance: catalog.provenance });
      expect(getActionSpec(actionId).outputSchema!.safeParse(summary.result).success).toBe(true);
      const selected = await executor.execute(actionId, { modelIds: [...modelIds, 'missing-model'] }, { surface, authority: 'present_user' });
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error('Expected exact selected prices');
      expect(UsageModelPriceCatalogSchema.parse(selected.result)).toEqual({ ...catalog,
        models: Object.fromEntries(modelIds.map(id => [id, catalog.models[id]])) });
      const missing = await executor.execute(actionId, { modelIds: ['toString', '__proto__'] }, { surface, authority: 'present_user' });
      expect(missing).toEqual({ ok: true, result: { ...catalog, models: {} } });
    }
  });

  it.each(['ui', 'cli'] as const)('keeps the full catalog default for %s', async surface => {
    const result = await executor.execute(USAGE_PRICE_ACTION_IDS.get, {}, { surface, authority: 'present_user' });
    expect(result).toEqual({ ok: true, result: catalog });
  });
});
