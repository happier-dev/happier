import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { ProviderLocalIdSchema } from '../ids.js';
import { ProviderOriginRelativePathSchema } from '../originRelativePathSchema.js';
import { ProviderModelDescriptorV1Schema } from '../../models/descriptor.js';

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
] as const);

export const BundledProviderCatalogParserV1Schema = lazyZodSchema(() => z.enum(
  BUNDLED_PROVIDER_CATALOG_PARSERS_V1,
));
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
  z.ZodMiniType<ProviderCatalogParserV1, ProviderCatalogParserV1> = ProviderLocalIdSchema;

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

export const ProviderCatalogProbeV1Schema = lazyZodSchema(() => z.strictObject({
  endpointTemplateId: ProviderLocalIdSchema,
  path: ProviderOriginRelativePathSchema,
  parser: ProviderCatalogParserV1Schema,
  /**
   * Declares that this probe's catalog format reports per-model load state.
   * The declaring Provider owns this fact independently of parser identity.
   */
  reportsModelLoadState: z.optional(z.boolean()),
}));
export type ProviderCatalogProbeV1 = z.infer<typeof ProviderCatalogProbeV1Schema>;

/**
 * Stable semantic identity for a Provider's dynamic catalog source. This is
 * intentionally declaration-owned: it changes when the source registry or
 * generated adapter can produce different model rows, not on process restart,
 * credential refresh, or plugin reload.
 */
export const ProviderCatalogSourceRegistryVersionV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));
export type ProviderCatalogSourceRegistryVersionV1 = z.infer<
  typeof ProviderCatalogSourceRegistryVersionV1Schema
>;

/**
 * Canonical owner for "does this catalog probe report model load state".
 * Only an explicit declaration reports load state; an absent fact stays false.
 */
export function providerCatalogProbeReportsModelLoadStateV1(
  probe: Readonly<{ parser: ProviderCatalogParserV1; reportsModelLoadState?: boolean }>,
): boolean {
  return probe.reportsModelLoadState === true;
}

export const ProviderCatalogMembershipPolicyV1Schema = lazyZodSchema(() => z.enum([
  'augment',
  'probe-authoritative',
]));
export type ProviderCatalogMembershipPolicyV1 = z.infer<
  typeof ProviderCatalogMembershipPolicyV1Schema
>;

const ManualCatalogSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('manual'),
  manualModelPolicy: z.literal('allowed'),
}));
const StaticCatalogSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('static'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  staticModels: z.array(ProviderModelDescriptorV1Schema).check(z.minLength(1)),
}));
const ProbeCatalogSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('probe'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  probes: z.array(ProviderCatalogProbeV1Schema).check(z.minLength(1)),
  sourceRegistryVersion: z.optional(ProviderCatalogSourceRegistryVersionV1Schema),
}));
const StaticProbeCatalogSchema = lazyZodSchema(() => z.strictObject({
  source: z.literal('static+probe'),
  manualModelPolicy: z.enum(['allowed', 'catalog-only']),
  membershipPolicy: z.optional(ProviderCatalogMembershipPolicyV1Schema),
  staticModels: z.array(ProviderModelDescriptorV1Schema).check(z.minLength(1)),
  probes: z.array(ProviderCatalogProbeV1Schema).check(z.minLength(1)),
  sourceRegistryVersion: z.optional(ProviderCatalogSourceRegistryVersionV1Schema),
}));

export const ProviderCatalogDeclarationV1Schema = lazyZodSchema(() => z.discriminatedUnion('source', [
  ManualCatalogSchema,
  StaticCatalogSchema,
  ProbeCatalogSchema,
  StaticProbeCatalogSchema,
]).check(z.superRefine((value, ctx) => {
  const models = 'staticModels' in value ? value.staticModels : [];
  const ids = new Set<string>();
  models.forEach((model, index) => {
    if (ids.has(model.id)) ctx.addIssue({ code: 'custom', path: ['staticModels', index, 'id'], message: 'Duplicate static model id' });
    ids.add(model.id);
  });
})));
export type ProviderCatalogDeclarationV1 = z.infer<typeof ProviderCatalogDeclarationV1Schema>;
