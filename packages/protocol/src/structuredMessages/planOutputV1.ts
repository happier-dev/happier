import { z } from 'zod';

/**
 * Structured payload emitted by execution runs with `intent='plan'`.
 *
 * Transport:
 * - Stored on the session transcript message under `meta.happier`.
 * - Reducer propagates tool-result meta onto the originating tool-call message,
 *   so the card renders on the tool-call line in the transcript.
 */

export const PlanOutputSectionV1Schema = z.object({
  title: z.string().min(1).max(200),
  items: z.array(z.string().min(1).max(2_000)).max(50),
}).passthrough();
export type PlanOutputSectionV1 = z.infer<typeof PlanOutputSectionV1Schema>;

export const PlanOutputMilestoneV1Schema = z.object({
  title: z.string().min(1).max(200),
  details: z.string().max(2_000).optional(),
}).passthrough();
export type PlanOutputMilestoneV1 = z.infer<typeof PlanOutputMilestoneV1Schema>;

export const PlanOutputV1Schema = z.object({
  runRef: z.object({
    runId: z.string().min(1),
    callId: z.string().min(1),
    backendId: z.string().min(1),
  }).passthrough(),
  summary: z.string().min(1).max(20_000),
  sections: z.array(PlanOutputSectionV1Schema).max(20),
  risks: z.array(z.string().min(1).max(2_000)).max(30).optional(),
  milestones: z.array(PlanOutputMilestoneV1Schema).max(30).optional(),
  recommendedBackendId: z.string().min(1).max(200).optional(),
  generatedAtMs: z.number().int().nonnegative(),
}).passthrough();
export type PlanOutputV1 = z.infer<typeof PlanOutputV1Schema>;

export function parsePlanOutputV1(input: unknown): PlanOutputV1 | null {
  const parsed = PlanOutputV1Schema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

