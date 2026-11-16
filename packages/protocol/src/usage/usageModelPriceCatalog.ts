import { z } from '../zodRuntimePolicy.js';
import { LITELLM_BUNDLED_SNAPSHOT } from './usageModelPriceSnapshot.js';
import { UsageModelPriceCatalogSchema, UsageModelPriceEntrySchema, type UsageModelPriceCatalog, type UsageModelPriceProvenance } from './usageModelPriceSchemas.js';

export { LITELLM_MODEL_PRICE_URL } from './usageModelPriceSchemas.js';
export const bundledUsageModelPriceCatalog: UsageModelPriceCatalog = UsageModelPriceCatalogSchema.parse(LITELLM_BUNDLED_SNAPSHOT);

/** LiteLLM is an external, heterogeneous file. Only standard text-token tariffs enter this catalog. */
export function parseLiteLlmModelPriceCatalog(value: unknown, provenance: UsageModelPriceProvenance): UsageModelPriceCatalog {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('model_price_file_invalid');
  const models: UsageModelPriceCatalog['models'] = {};
  for (const [id, raw] of Object.entries(value)) {
    if (id === 'sample_spec' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const modelId = UsageModelPriceCatalogSchema.shape.models._zod.def.keyType.safeParse(id);
    if (!modelId.success) continue;
    const mode = Reflect.get(raw, 'mode');
    if (mode !== 'chat' && mode !== 'completion') continue;
    const input = Reflect.get(raw, 'input_cost_per_token');
    const output = Reflect.get(raw, 'output_cost_per_token');
    if (input === undefined || output === undefined) continue;
    const readRate = (field: string): number | undefined => {
      const amount: unknown = Reflect.get(raw, field);
      if (amount === undefined) return undefined;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) throw new Error('model_price_file_invalid');
      return amount * 1_000_000;
    };
    try {
      const cacheRead = readRate('cache_read_input_token_cost');
      const cacheWrite = readRate('cache_creation_input_token_cost');
      const reasoning = readRate('output_cost_per_reasoning_token');
      const provider: unknown = Reflect.get(raw, 'litellm_provider');
      const source: unknown = Reflect.get(raw, 'source');
      const sourceUrl = typeof source === 'string' && z.url().safeParse(source).success ? source : undefined;
      const entry = UsageModelPriceEntrySchema.safeParse({
        inputUsdPerMillion: readRate('input_cost_per_token'), outputUsdPerMillion: readRate('output_cost_per_token'),
        ...(cacheRead === undefined ? {} : { cacheReadUsdPerMillion: cacheRead }),
        ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: cacheWrite }),
        ...(reasoning === undefined ? {} : { reasoningUsdPerMillion: reasoning }),
        ...(typeof provider === 'string' && provider ? { provider } : {}), ...(sourceUrl ? { sourceUrl } : {}),
      });
      if (entry.success) Object.defineProperty(models, modelId.data, { enumerable: true, configurable: true, writable: true, value: entry.data });
    } catch {
      // One malformed external tariff does not discard the file's valid models.
    }
  }
  if (Object.keys(models).length === 0) throw new Error('model_price_file_empty');
  return UsageModelPriceCatalogSchema.parse({ v: 1, models, provenance });
}

export * from './usageModelPriceSchemas.js';
