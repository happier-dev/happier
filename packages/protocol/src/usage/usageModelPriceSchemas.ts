import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Immutable vendored LiteLLM revision, shared by lightweight projection facts. */
export const BUNDLED_USAGE_MODEL_PRICE_REVISION = '729b02d05719715f4faeb1f81ef2728ef06c3273';
export const LITELLM_MODEL_PRICE_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Exact price identities only; vendor/platform-specific tariffs remain distinct.
 * Haiku's API alias and snapshot name the same model:
 * https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
 */
export function canonicalUsageModelPriceId(modelId: string | null | undefined): string | null {
  if (!modelId?.trim()) return null;
  const current = modelId.trim();
  // Claude emits transcript bookkeeping under this sentinel, never a priced model.
  if (current === '<synthetic>') return null;
  return current === 'claude-haiku-4-5-20251001' ? 'claude-haiku-4-5' : current;
}

const rate = lazyZodSchema(() => z.number().check(z.nonnegative()));
export const UsageModelPriceRatesSchema = lazyZodSchema(() => z.strictObject({
  inputUsdPerMillion: rate, outputUsdPerMillion: rate,
  cacheReadUsdPerMillion: z.optional(rate), cacheWriteUsdPerMillion: z.optional(rate), reasoningUsdPerMillion: z.optional(rate),
}));
export type UsageModelPriceRates = z.infer<typeof UsageModelPriceRatesSchema>;
export const UsageModelPriceEntrySchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(UsageModelPriceRatesSchema, {
  provider: z.optional(z.string().check(z.minLength(1))), sourceUrl: z.optional(z.string().check(z.url())),
})));
export const UsageModelPriceProvenanceSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('litellm'), origin: z.enum(['bundled', 'fetched', 'cached']),
  asOfMs: z.number().check(z.int(), z.nonnegative()), revision: z.string().check(z.minLength(1)),
  fetchStatus: z.enum(['ready', 'disabled', 'error']), errorCode: z.optional(z.string().check(z.minLength(1))),
}));
export type UsageModelPriceProvenance = z.infer<typeof UsageModelPriceProvenanceSchema>;
export const UsageModelPriceCatalogSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1), models: z.record(z.string().check(z.trim(), z.minLength(1)), UsageModelPriceEntrySchema),
  provenance: UsageModelPriceProvenanceSchema,
}));
export type UsageModelPriceCatalog = z.infer<typeof UsageModelPriceCatalogSchema>;
export const UsageModelPriceOverrideSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(UsageModelPriceRatesSchema, { reasoningUsdPerMillion: true }), { kind: z.literal('rates') })),
  z.strictObject({ kind: z.literal('map'), modelId: z.string().check(z.trim(), z.minLength(1)) }),
]));
// Zod records intentionally omit __proto__; reject it instead of acknowledging a lost setting.
export const UsageModelPriceOverridesV1Schema = lazyZodSchema(() => (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value, context) => {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, '__proto__')) {
    context.issues.push({ code: 'custom', path: ['__proto__'], message: 'Reserved record key', input: context.value });
  }
  return value;
}), z.record(z.string().check(z.trim(), z.minLength(1)), UsageModelPriceOverrideSchema).check(z.superRefine((overrides, context) => {
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
  }))));
export type UsageModelPriceOverridesV1 = z.infer<typeof UsageModelPriceOverridesV1Schema>;

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
export function resolveUsageModelPrice(modelId: string | null | undefined, catalog: UsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}): ResolvedUsageModelPrice | null {
  let current = canonicalUsageModelPriceId(modelId);
  if (current === null) return null;
  const original = modelId!.trim();
  const seen = new Set<string>();
  let mapped = false;
  while (true) {
    if (seen.has(current)) return null;
    seen.add(current);
    const override = readUsageModelPriceOverride(current, overrides);
    if (override?.kind === 'rates') return { modelId: current, rates: override, source: mapped ? 'mapping' : 'override',
      ...(mapped ? { mappedFrom: original } : {}) };
    if (override?.kind === 'map') {
      const target = canonicalUsageModelPriceId(override.modelId);
      if (target === null) return null;
      current = target; mapped = true; continue;
    }
    // A fetched catalog can retain only the vendor snapshot spelling.
    const catalogId = !Object.hasOwn(catalog.models, current) && current === 'claude-haiku-4-5'
      ? 'claude-haiku-4-5-20251001' : current;
    const rates = Object.hasOwn(catalog.models, catalogId) ? catalog.models[catalogId] : undefined;
    if (rates) return { modelId: current, rates, source: mapped ? 'mapping' : 'catalog', ...(mapped ? { mappedFrom: original } : {}) };
    // Retain the existing fallback only after exact overrides and catalog tariffs.
    const alias = /^(openai|anthropic)\/(.+)$/.exec(current);
    const entry = alias && Object.hasOwn(catalog.models, alias[2]!) ? catalog.models[alias[2]!] : undefined;
    if (entry && entry.provider === alias![1]) { current = canonicalUsageModelPriceId(alias![2]!)!; continue; }
    const baseId: string | null = current.endsWith('[1m]') ? current.slice(0, -4).trim() : null;
    const base = baseId && Object.hasOwn(catalog.models, baseId) ? catalog.models[baseId] : undefined;
    if (base?.provider === 'anthropic') { current = canonicalUsageModelPriceId(baseId)!; continue; }
    return null;
  }
}
