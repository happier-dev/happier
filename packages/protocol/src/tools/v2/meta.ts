import { z } from 'zod';

export const ToolNormalizationProtocolSchema = z.enum(['acp', 'codex', 'claude']);
export type ToolNormalizationProtocol = z.infer<typeof ToolNormalizationProtocolSchema>;

export const ToolHappierMetaV2Schema = z.object({
  v: z.literal(2),
  protocol: ToolNormalizationProtocolSchema,
  provider: z.string(),
  rawToolName: z.string(),
  // Forward-compatible: providers/normalizers may emit new canonical tool names
  // before the protocol package is updated. Keep this permissive and validate
  // against KnownCanonicalToolNameV2Schema only where needed (e.g. renderer registry).
  canonicalToolName: z.string().min(1),
}).passthrough();

export type ToolHappierMetaV2 = z.infer<typeof ToolHappierMetaV2Schema>;

// Legacy alias accepted during the `_happy` -> `_happier` migration window.
export const ToolHappyMetaV2Schema = ToolHappierMetaV2Schema;
export type ToolHappyMetaV2 = ToolHappierMetaV2;

export const ToolEnvelopeMetaContainerV2Schema = z.object({
  _happier: ToolHappierMetaV2Schema.optional(),
  _happy: ToolHappyMetaV2Schema.optional(),
}).passthrough();

export function resolveToolEnvelopeMetaV2(value: unknown): ToolHappierMetaV2 | null {
  const parsed = ToolEnvelopeMetaContainerV2Schema.safeParse(value);
  if (!parsed.success) return null;

  // Canonical key wins if both are present.
  const meta = parsed.data._happier ?? parsed.data._happy;
  return meta ?? null;
}
