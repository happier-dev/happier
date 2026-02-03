import { z } from 'zod';
import { CanonicalToolNameV2Schema } from './names.js';

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

// Backward-compatible aliases: the on-the-wire metadata container is still named `_happy`
// (for legacy client compatibility), but the project is now "happier".
export const ToolHappyMetaV2Schema = ToolHappierMetaV2Schema;
export type ToolHappyMetaV2 = ToolHappierMetaV2;
