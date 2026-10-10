import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { LITELLM_BUNDLED_SNAPSHOT } from './usageModelPriceSnapshot.js';

export const LITELLM_MODEL_PRICE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const rate = lazyZodSchema(() => z.number().finite().nonnegative());
export const UsageModelPriceRatesSchema = lazyZodSchema(() => z.object({
  inputUsdPerMillion: rate, outputUsdPerMillion: rate,
  cacheReadUsdPerMillion: rate.optional(), cacheWriteUsdPerMillion: rate.optional(), reasoningUsdPerMillion: rate.optional(),
}).strict());
export type UsageModelPriceRates = z.infer<typeof UsageModelPriceRatesSchema>;
export const UsageModelPriceEntrySchema = lazyZodSchema(() => UsageModelPriceRatesSchema.extend({
  provider: z.string().min(1).optional(), sourceUrl: z.string().url().optional(),
}).strict());
export const UsageModelPriceProvenanceSchema = lazyZodSchema(() => z.object({
  source: z.literal('litellm'), origin: z.enum(['bundled', 'fetched', 'cached']),
  asOfMs: z.number().int().nonnegative(), revision: z.string().min(1),
  fetchStatus: z.enum(['ready', 'disabled', 'error']), errorCode: z.string().min(1).optional(),
}).strict());
export type UsageModelPriceProvenance = z.infer<typeof UsageModelPriceProvenanceSchema>;
export const UsageModelPriceCatalogSchema = lazyZodSchema(() => z.object({
  v: z.literal(1), models: z.record(z.string().trim().min(1), UsageModelPriceEntrySchema),
  provenance: UsageModelPriceProvenanceSchema,
}).strict());
export type UsageModelPriceCatalog = z.infer<typeof UsageModelPriceCatalogSchema>;
export const bundledUsageModelPriceCatalog: UsageModelPriceCatalog = UsageModelPriceCatalogSchema.parse(LITELLM_BUNDLED_SNAPSHOT);

export const UsageModelPriceOverrideSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  UsageModelPriceRatesSchema.omit({ reasoningUsdPerMillion: true }).extend({ kind: z.literal('rates') }).strict(),
  z.object({ kind: z.literal('map'), modelId: z.string().trim().min(1) }).strict(),
]));
// Zod records intentionally omit __proto__; reject it instead of acknowledging a lost setting.
export const UsageModelPriceOverridesV1Schema = lazyZodSchema(() => z.preprocess((value, context) => {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, '__proto__')) {
    context.addIssue({ code: 'custom', path: ['__proto__'], message: 'Reserved record key' });
  }
  return value;
}, z.record(z.string().trim().min(1), UsageModelPriceOverrideSchema)
  .superRefine((overrides, context) => {
    for (const id of Object.keys(overrides)) {
      const seen = new Set<string>();
      let current = id;
      while (Object.hasOwn(overrides, current)) {
        if (seen.has(current)) {
          context.addIssue({ code: 'custom', path: [id], message: 'Model price mappings must not contain a cycle' });
          break;
        }
        seen.add(current);
        const override = overrides[current]!;
        if (override.kind !== 'map') break;
        current = override.modelId;
      }
    }
  })));
export type UsageModelPriceOverridesV1 = z.infer<typeof UsageModelPriceOverridesV1Schema>;

/** LiteLLM is an external, heterogeneous file. Only standard text-token tariffs enter this catalog. */
export function parseLiteLlmModelPriceCatalog(value: unknown, provenance: UsageModelPriceProvenance): UsageModelPriceCatalog {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('model_price_file_invalid');
  const models: UsageModelPriceCatalog['models'] = {};
  for (const [id, raw] of Object.entries(value)) {
    if (id === 'sample_spec' || raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
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
    const cacheRead = readRate('cache_read_input_token_cost');
    const cacheWrite = readRate('cache_creation_input_token_cost');
    const reasoning = readRate('output_cost_per_reasoning_token');
    const provider: unknown = Reflect.get(raw, 'litellm_provider');
    const source: unknown = Reflect.get(raw, 'source');
    const sourceUrl = typeof source === 'string' && z.url().safeParse(source).success ? source : undefined;
    Object.defineProperty(models, id, { enumerable: true, configurable: true, writable: true, value: {
      inputUsdPerMillion: readRate('input_cost_per_token'), outputUsdPerMillion: readRate('output_cost_per_token'),
      ...(cacheRead === undefined ? {} : { cacheReadUsdPerMillion: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWriteUsdPerMillion: cacheWrite }),
      ...(reasoning === undefined ? {} : { reasoningUsdPerMillion: reasoning }),
      ...(typeof provider === 'string' && provider ? { provider } : {}), ...(sourceUrl ? { sourceUrl } : {}),
    } });
  }
  if (Object.keys(models).length === 0) throw new Error('model_price_file_empty');
  return UsageModelPriceCatalogSchema.parse({ v: 1, models, provenance });
}

export interface ResolvedUsageModelPrice {
  modelId: string;
  rates: UsageModelPriceRates;
  source: 'catalog' | 'override' | 'mapping';
  mappedFrom?: string;
}

/** Explicit user mappings win; catalog ids and the two documented vendor prefixes are exact aliases. */
export function resolveUsageModelPrice(modelId: string | null | undefined, catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}): ResolvedUsageModelPrice | null {
  if (!modelId?.trim()) return null;
  const original = modelId.trim();
  let current = original;
  const seen = new Set<string>();
  let mapped = false;
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const override = Object.hasOwn(overrides, current) ? overrides[current] : undefined;
    if (override?.kind === 'rates') return { modelId: current, rates: override, source: mapped ? 'mapping' : 'override',
      ...(mapped ? { mappedFrom: original } : {}) };
    if (override?.kind === 'map') { current = override.modelId; mapped = true; continue; }
    const rates = Object.hasOwn(catalog.models, current) ? catalog.models[current] : undefined;
    if (rates) return { modelId: current, rates, source: mapped ? 'mapping' : 'catalog', ...(mapped ? { mappedFrom: original } : {}) };
    const alias = /^(openai|anthropic)\/(.+)$/.exec(current);
    const entry = alias && Object.hasOwn(catalog.models, alias[2]!) ? catalog.models[alias[2]!] : undefined;
    if (entry && entry.provider === alias![1]) { current = alias![2]!; continue; }
    // The owned Claude [1m] variant selects the same base model; this is not fuzzy matching.
    const baseId = current.endsWith('[1m]') ? current.slice(0, -4).trim() : null;
    const base = baseId && Object.hasOwn(catalog.models, baseId) ? catalog.models[baseId] : undefined;
    if (base?.provider === 'anthropic') { current = baseId!; continue; }
    return null;
  }
}
