import { z } from 'zod/mini';
import { LITELLM_BUNDLED_SNAPSHOT } from './usageModelPriceSnapshot.js';
import { canonicalUsageModelPriceId, UsageModelPriceCatalogSchema, UsageModelPriceEntrySchema, type UsageModelPriceCatalog, type UsageModelPriceProvenance, type UsageModelPriceRates, type UsageModelPriceOverridesV1 } from './usageModelPriceSchemas.js';
export * from './usageModelPriceSchemas.js';

export const LITELLM_MODEL_PRICE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
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

export interface ResolvedUsageModelPrice {
  modelId: string;
  rates: UsageModelPriceRates;
  source: 'catalog' | 'override' | 'mapping';
  mappedFrom?: string;
}

/** Read pre-fix alias keys without maintaining a second override authority.
 * If both spellings were edited, the canonical key wins consistently for every reader.
 */
export function readUsageModelPriceOverride(modelId: string | null | undefined, overrides: UsageModelPriceOverridesV1): UsageModelPriceOverridesV1[string] | null {
  const canonical = canonicalUsageModelPriceId(modelId);
  if (canonical === null) return null;
  if (Object.hasOwn(overrides, canonical)) return overrides[canonical]!;
  const alias = Object.keys(overrides).sort().find(id => canonicalUsageModelPriceId(id) === canonical);
  return alias === undefined ? null : overrides[alias]!;
}

/** Explicit user mappings win; all readers consume the same exact model identity. */
export function resolveUsageModelPrice(modelId: string | null | undefined, catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}): ResolvedUsageModelPrice | null {
  if (!modelId?.trim()) return null;
  const original = modelId.trim();
  let current = canonicalUsageModelPriceId(original)!;
  const seen = new Set<string>();
  let mapped = false;
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const override = readUsageModelPriceOverride(current, overrides);
    if (override?.kind === 'rates') return { modelId: current, rates: override, source: mapped ? 'mapping' : 'override',
      ...(mapped ? { mappedFrom: original } : {}) };
    if (override?.kind === 'map') { current = canonicalUsageModelPriceId(override.modelId)!; mapped = true; continue; }
    // A fetched catalog can retain only the vendor snapshot spelling.
    const catalogId = !Object.hasOwn(catalog.models, current) && current === 'claude-haiku-4-5'
      ? 'claude-haiku-4-5-20251001' : current;
    const rates = Object.hasOwn(catalog.models, catalogId) ? catalog.models[catalogId] : undefined;
    if (rates) return { modelId: current, rates, source: mapped ? 'mapping' : 'catalog', ...(mapped ? { mappedFrom: original } : {}) };
    // Retain the existing fallback only after exact overrides and catalog tariffs.
    const alias = /^(openai|anthropic)\/(.+)$/.exec(current);
    const entry = alias && Object.hasOwn(catalog.models, alias[2]!) ? catalog.models[alias[2]!] : undefined;
    if (entry && entry.provider === alias![1]) { current = canonicalUsageModelPriceId(alias![2]!)!; continue; }
    const baseId = current.endsWith('[1m]') ? current.slice(0, -4).trim() : null;
    const base = baseId && Object.hasOwn(catalog.models, baseId) ? catalog.models[baseId] : undefined;
    if (base?.provider === 'anthropic') { current = canonicalUsageModelPriceId(baseId)!; continue; }
    return null;
  }
}
