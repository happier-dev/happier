import { z } from 'zod';

const NonNegativeTokenCountSchema = z.number().finite().min(0);

export const SessionContextUsageSnapshotV1Schema = z.object({
  v: z.literal(1),
  modelId: z.string().trim().min(1).nullable(),
  usedTokens: NonNegativeTokenCountSchema,
  windowTokens: NonNegativeTokenCountSchema.nullable(),
  totalProcessedTokens: NonNegativeTokenCountSchema.nullable(),
  baselineTokens: NonNegativeTokenCountSchema.nullable(),
  isAutoCompactEnabled: z.boolean().nullable(),
  categories: z.array(z.object({
    key: z.string().trim().min(1),
    label: z.string().trim().min(1).nullable(),
    tokens: NonNegativeTokenCountSchema,
  }).strict()).nullable(),
  observedAtMs: z.number().int().min(0),
  source: z.enum(['provider_live', 'provider_turn', 'derived_estimate']),
}).strict();

export type SessionContextUsageSnapshotV1 = z.infer<typeof SessionContextUsageSnapshotV1Schema>;

export function computeContextPercentUsed(snapshot: SessionContextUsageSnapshotV1): number | null {
  if (snapshot.windowTokens === null) {
    return null;
  }

  const baselineTokens = snapshot.baselineTokens ?? 0;
  const usableWindowTokens = snapshot.windowTokens - baselineTokens;
  if (usableWindowTokens <= 0) {
    return null;
  }

  const usedRatio = (snapshot.usedTokens - baselineTokens) / usableWindowTokens;
  return Math.min(100, Math.max(0, usedRatio * 100));
}
