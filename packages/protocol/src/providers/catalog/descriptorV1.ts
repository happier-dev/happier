import { z } from 'zod';

import { ProviderLocalIdSchema } from '../ids.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';
import { PROVIDER_CATALOG_LIMITS_V1 } from './limits.js';

/**
 * The catalog wire formats Happier bundles an implementation for. This list
 * answers only "does the host already implement this format"; it never decides
 * whether a declared format is valid. A Provider plugin contributes its own
 * format through the `providers` contribution family, exactly like a bundled
 * Provider does.
 */
export const BUNDLED_PROVIDER_CATALOG_PARSERS_V1 = Object.freeze([
  'openai-models',
  'anthropic-models',
  'ollama-tags',
  'lmstudio-native-models',
] as const);

export const BundledProviderCatalogParserV1Schema = z.enum(
  BUNDLED_PROVIDER_CATALOG_PARSERS_V1,
);
export type BundledProviderCatalogParserV1 = z.infer<
  typeof BundledProviderCatalogParserV1Schema
>;

/**
 * An open catalog-format identifier: a bundled format, or any format a
 * currently installed Provider plugin contributes. Never narrow this to the
 * bundled set to reject an id or gate a capability.
 */
export type ProviderCatalogParserV1 =
  | BundledProviderCatalogParserV1
  | (string & {});

export const ProviderCatalogParserV1Schema:
  z.ZodType<ProviderCatalogParserV1, ProviderCatalogParserV1> = ProviderLocalIdSchema;

const BUNDLED_PROVIDER_CATALOG_PARSER_IDS: ReadonlySet<string> = new Set(
  BUNDLED_PROVIDER_CATALOG_PARSERS_V1,
);

/**
 * Answers only whether the host bundles an implementation for this format.
 * A `false` result means "no bundled implementation", never "invalid format".
 */
export function isBundledProviderCatalogParserV1(
  parser: ProviderCatalogParserV1,
): parser is BundledProviderCatalogParserV1 {
  return BUNDLED_PROVIDER_CATALOG_PARSER_IDS.has(parser);
}

/**
 * Read a bundled catalog-format fact by an open format id.
 *
 * Bundled fact records are exhaustive over the bundled formats only. A
 * contributed format has no entry, so the lookup reports a typed unavailable
 * instead of borrowing another format's fact.
 */
export function readBundledProviderCatalogParserFactV1<T>(
  factsByParser: Readonly<Record<BundledProviderCatalogParserV1, T>>,
  parser: ProviderCatalogParserV1,
): T | null {
  return isBundledProviderCatalogParserV1(parser) ? factsByParser[parser] : null;
}

const BUNDLED_PROVIDER_CATALOG_PARSER_REPORTS_MODEL_LOAD_STATE_V1 = Object.freeze({
  'openai-models': false,
  'anthropic-models': false,
  'ollama-tags': false,
  'lmstudio-native-models': true,
} as const satisfies Record<BundledProviderCatalogParserV1, boolean>);

export const ProviderCatalogProbeV1Schema = z.object({
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  parser: ProviderCatalogParserV1Schema,
  /**
   * Declares that this probe's catalog format reports per-model load state.
   * Bundled formats carry that fact centrally; a contributed format states it
   * here so model loading is decided by the format's behavior rather than by
   * whether the host happens to bundle it.
   */
  reportsModelLoadState: z.boolean().optional(),
}).strict();
export type ProviderCatalogProbeV1 = z.infer<typeof ProviderCatalogProbeV1Schema>;

/**
 * Stable semantic identity for a Provider's dynamic catalog source. This is
 * intentionally declaration-owned: it changes when the source registry or
 * generated adapter can produce different model rows, not on process restart,
 * credential refresh, or plugin reload.
 */
export const ProviderCatalogSourceRegistryVersionV1Schema = z.string()
  .trim()
  .min(1);
export type ProviderCatalogSourceRegistryVersionV1 = z.infer<
  typeof ProviderCatalogSourceRegistryVersionV1Schema
>;

/**
 * Canonical owner for "does this catalog probe report model load state".
 * An explicit declaration wins; otherwise the bundled fact answers, and an
 * unknown contributed format reports `false` rather than being guessed.
 */
export function providerCatalogProbeReportsModelLoadStateV1(
  probe: Readonly<{ parser: ProviderCatalogParserV1; reportsModelLoadState?: boolean }>,
): boolean {
  return probe.reportsModelLoadState
    ?? readBundledProviderCatalogParserFactV1(
      BUNDLED_PROVIDER_CATALOG_PARSER_REPORTS_MODEL_LOAD_STATE_V1,
      probe.parser,
    )
    ?? false;
}

export const ProviderCatalogMembershipPolicyV1Schema = z.enum([
  'augment',
  'probe-authoritative',
]);
export type ProviderCatalogMembershipPolicyV1 = z.infer<
  typeof ProviderCatalogMembershipPolicyV1Schema
>;

const ManualCatalogSchema = z.object({
  source: z.literal('manual'),
  manualModelPolicy: z.literal('allowed'),
}).strict();
const StaticCatalogSchema = z.object({
  source: z.literal('static'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  staticModels: z.array(ProviderModelDescriptorV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
}).strict();
const ProbeCatalogSchema = z.object({
  source: z.literal('probe'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  probes: z.array(ProviderCatalogProbeV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes),
  sourceRegistryVersion: ProviderCatalogSourceRegistryVersionV1Schema.optional(),
}).strict();
const StaticProbeCatalogSchema = z.object({
  source: z.literal('static+probe'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  membershipPolicy: ProviderCatalogMembershipPolicyV1Schema.optional(),
  staticModels: z.array(ProviderModelDescriptorV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxModelsPerConnection),
  probes: z.array(ProviderCatalogProbeV1Schema).min(1).max(PROVIDER_CATALOG_LIMITS_V1.maxCatalogProbes),
  sourceRegistryVersion: ProviderCatalogSourceRegistryVersionV1Schema.optional(),
}).strict();

export const ProviderCatalogDeclarationV1Schema = z.discriminatedUnion('source', [
  ManualCatalogSchema,
  StaticCatalogSchema,
  ProbeCatalogSchema,
  StaticProbeCatalogSchema,
]).superRefine((value, ctx) => {
  const models = 'staticModels' in value ? value.staticModels : [];
  const ids = new Set<string>();
  models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', path: ['staticModels', index, 'id'], message: 'Duplicate static model id' });
    ids.add(model.id);
  });
});
export type ProviderCatalogDeclarationV1 = z.infer<typeof ProviderCatalogDeclarationV1Schema>;
