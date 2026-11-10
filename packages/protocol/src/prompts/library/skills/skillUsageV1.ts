import { z } from '../../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../../json/storedReadSchema.js';

/** Consumers rank and describe usage in days; this is the sole write interval. */
export const SKILL_USAGE_WRITE_INTERVAL_MS_V1 = 86_400_000;
export const SkillUsageRowV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  lastUsedAt: z.record(z.string().check(z.minLength(1)), z.number().check(z.int(), z.nonnegative(), z.int())),
}));
export type SkillUsageRowV1 = z.infer<typeof SkillUsageRowV1Schema>;
const stored = createStoredReadSchema(SkillUsageRowV1Schema);

export function readSkillUsageRowV1(value: unknown): SkillUsageRowV1 | null {
  const parsed = stored.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Oldest retained use is a lower bound on observation, including deleted skills. */
export function skillUsageObservedSinceV1(row: SkillUsageRowV1 | null | undefined): number | null {
  if (!row) return null;
  let oldest: number | null = null;
  for (const timestamp of Object.values(row.lastUsedAt)) {
    if (oldest === null || timestamp < oldest) oldest = timestamp;
  }
  return oldest;
}

/** Keeps historical facts, including deleted skills; no use counter or pruning. */
export function planSkillUsageWriteV1(input: Readonly<{
  row: SkillUsageRowV1; skillIds: readonly string[]; nowMs: number;
}>): SkillUsageRowV1 | null {
  const eligible = [...new Set(input.skillIds)].filter(id => {
    const last = Object.hasOwn(input.row.lastUsedAt, id) ? input.row.lastUsedAt[id] : undefined;
    return last === undefined || input.nowMs - last >= SKILL_USAGE_WRITE_INTERVAL_MS_V1;
  });
  if (eligible.length === 0) return null;
  return { v: 1, lastUsedAt: { ...input.row.lastUsedAt, ...Object.fromEntries(eligible.map(id => [id, input.nowMs])) } };
}
