import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import { UsageModelPriceCatalogSchema, UsageModelPriceProvenanceSchema, resolveUsageModelPrice, type UsageModelPriceCatalog } from './usageModelPriceSchemas.js';

export const UsageModelPriceReadInputSchema = lazyZodSchema(() => z.strictObject({
  modelIds: z.optional(z.array(z.string().check(z.trim(), z.minLength(1)))),
}));
type UsageModelPriceReadInput = z.infer<typeof UsageModelPriceReadInputSchema>;

const UsageModelPriceSummarySchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), modelCount: z.number().check(z.int(), z.nonnegative()), provenance: UsageModelPriceProvenanceSchema,
}));
export const UsageModelPriceReadResultSchema = lazyZodSchema(() => z.union([
  UsageModelPriceCatalogSchema, UsageModelPriceSummarySchema,
]));
type UsageModelPriceReadResult = z.infer<typeof UsageModelPriceReadResultSchema>;

/** Full native catalogs stay available; agent tools request exact tariffs only when needed. */
export function projectUsageModelPriceDelivery(catalog: UsageModelPriceCatalog, input: UsageModelPriceReadInput,
  surface: ActionExecutorContext['surface']): UsageModelPriceReadResult {
  if (input.modelIds !== undefined) {
    const rows: Array<readonly [string, UsageModelPriceCatalog['models'][string]]> = [];
    for (const id of input.modelIds) {
      if (Object.hasOwn(catalog.models, id)) rows.push([id, catalog.models[id]!]);
      else {
        const selected = resolveUsageModelPrice(id, catalog);
        if (selected) rows.push([selected.modelId, selected.rates]);
      }
    }
    return { ...catalog, models: Object.fromEntries(rows) };
  }
  return surface === 'agent' || surface === 'mcp'
    ? { v: 1, modelCount: Object.keys(catalog.models).length, provenance: catalog.provenance }
    : catalog;
}
