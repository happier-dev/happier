import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

const NonNegativeTokenCountSchema = lazyZodSchema(() => z.number().check(z.minimum(0)));

export const SessionContextUsageSnapshotV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  modelId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  usedTokens: NonNegativeTokenCountSchema,
  windowTokens: z.nullable(NonNegativeTokenCountSchema),
  totalProcessedTokens: z.nullable(NonNegativeTokenCountSchema),
  baselineTokens: z.nullable(NonNegativeTokenCountSchema),
  isAutoCompactEnabled: z.nullable(z.boolean()),
  categories: z.nullable(z.array(z.strictObject({
    key: z.string().check(z.trim(), z.minLength(1)),
    label: z.nullable(z.string().check(z.trim(), z.minLength(1))),
    tokens: NonNegativeTokenCountSchema,
  }))),
  observedAtMs: z.number().check(z.int(), z.minimum(0)),
  source: z.enum(['provider_live', 'provider_turn', 'derived_estimate']),
}));

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
