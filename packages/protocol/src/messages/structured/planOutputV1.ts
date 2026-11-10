import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { ExecutionRunStructuredRunRefSchema } from './executionRunStructuredRunRef.js';

/**
 * Structured payload emitted by execution runs with `intent='plan'`.
 *
 * Transport:
 * - Stored on the session transcript message under `meta.happier`.
 * - Reducer propagates tool-result meta onto the originating tool-call message,
 *   so the card renders on the tool-call line in the transcript.
 */

export const PlanOutputSectionV1Schema = lazyZodSchema(() => z.looseObject({
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  items: z.array(z.string().check(z.minLength(1), z.maxLength(2_000))).check(z.maxLength(50)),
}));
export type PlanOutputSectionV1 = z.infer<typeof PlanOutputSectionV1Schema>;

export const PlanOutputMilestoneV1Schema = lazyZodSchema(() => z.looseObject({
  title: z.string().check(z.minLength(1), z.maxLength(200)),
  details: z.optional(z.string().check(z.maxLength(2_000))),
}));
export type PlanOutputMilestoneV1 = z.infer<typeof PlanOutputMilestoneV1Schema>;

export const PlanOutputV1Schema = lazyZodSchema(() => z.looseObject({
  runRef: ExecutionRunStructuredRunRefSchema,
  summary: z.string().check(z.minLength(1), z.maxLength(20_000)),
  sections: z.array(PlanOutputSectionV1Schema).check(z.maxLength(20)),
  risks: z.optional(z.array(z.string().check(z.minLength(1), z.maxLength(2_000))).check(z.maxLength(30))),
  milestones: z.optional(z.array(PlanOutputMilestoneV1Schema).check(z.maxLength(30))),
  recommendedBackendId: z.optional(z.string().check(z.minLength(1), z.maxLength(200))),
  generatedAtMs: z.number().check(z.int(), z.nonnegative()),
}));
export type PlanOutputV1 = z.infer<typeof PlanOutputV1Schema>;

export function parsePlanOutputV1(input: unknown): PlanOutputV1 | null {
  const parsed = PlanOutputV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
