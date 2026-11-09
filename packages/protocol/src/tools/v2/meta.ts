import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../../plugins/contributionIdentity.js';

export const ToolNormalizationProtocolSchema = lazyZodSchema(() => z.enum(['acp', 'codex', 'claude']));
export type ToolNormalizationProtocol = z.infer<typeof ToolNormalizationProtocolSchema>;

export const ToolHappierMetaV2Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(2),
  protocol: ToolNormalizationProtocolSchema,
  provider: z.string(),
  rawToolName: z.string(),
  // Forward-compatible: providers/normalizers may emit new canonical tool names
  // before the protocol package is updated. Keep this permissive and validate
  // against KnownCanonicalToolNameV2Schema only where needed (e.g. renderer registry).
  canonicalToolName: z.string().check(z.minLength(1)),
}));

export type ToolHappierMetaV2 = z.infer<typeof ToolHappierMetaV2Schema>;

/** Current producer facts; the tool envelope itself still uses the V2 format. */
export const ToolNormalizationSourceV3Schema = lazyZodSchema(() => z.strictObject({
  protocol: z.enum(['native', 'acp']),
  agent: asProtocolZod(PluginContributionIdentityV1Schema),
}));
export type ToolNormalizationSourceV3 = z.infer<typeof ToolNormalizationSourceV3Schema>;

export const ToolHappierMetaV3Schema = lazyZodSchema(() => z.looseObject({
  v: z.literal(3),
  ...ToolNormalizationSourceV3Schema.shape,
  rawToolName: z.string(),
  canonicalToolName: z.string().check(z.minLength(1)),
}));
export type ToolHappierMetaV3 = z.infer<typeof ToolHappierMetaV3Schema>;

export const ToolHappierMetaSchema = lazyZodSchema(() => z.union([
  ToolHappierMetaV2Schema,
  ToolHappierMetaV3Schema,
]));

// Legacy alias accepted during the `_happy` -> `_happier` migration window.
export const ToolHappyMetaV2Schema = ToolHappierMetaV2Schema;
export type ToolHappyMetaV2 = ToolHappierMetaV2;

export const ToolEnvelopeMetaContainerV2Schema = lazyZodSchema(() => z.looseObject({
  _happier: z.optional(ToolHappierMetaV2Schema),
  _happy: z.optional(ToolHappyMetaV2Schema),
}));

export const ToolEnvelopeMetaContainerSchema = lazyZodSchema(() => z.looseObject({
  _happier: z.optional(ToolHappierMetaSchema),
  _happy: z.optional(ToolHappyMetaV2Schema),
}));

/** Historical provider tags carry no qualified contribution identity. */
export type LegacyToolEnvelopeMeta = Readonly<Pick<ToolHappierMetaV2,
  'v' | 'provider' | 'rawToolName' | 'canonicalToolName'> & {
  protocol: ToolNormalizationSourceV3['protocol'];
}> & Readonly<Record<string, unknown>>;

export type ToolEnvelopeMeta = ToolHappierMetaV3 | LegacyToolEnvelopeMeta;

/** Decode current and released metadata once at the transcript ingress owner. */
export function resolveToolEnvelopeMeta(value: unknown): ToolEnvelopeMeta | null {
  const parsed = ToolEnvelopeMetaContainerSchema.safeParse(value);
  if (!parsed.success) return null;
  const meta = parsed.data._happier ?? parsed.data._happy;
  if (!meta) return null;
  if (meta.v === 3) return meta;
  return { ...meta, protocol: meta.protocol === 'acp' ? 'acp' : 'native' };
}

export function resolveToolEnvelopeMetaV2(value: unknown): ToolHappierMetaV2 | null {
  const parsed = ToolEnvelopeMetaContainerV2Schema.safeParse(value);
  if (!parsed.success) return null;

  // Canonical key wins if both are present.
  const meta = parsed.data._happier ?? parsed.data._happy;
  return meta ?? null;
}
