import { z } from '../../zodRuntimePolicy.js';

/** Additive, non-authoritative Message presentation; unknown display fields are dropped. */
export const SessionHostOnboardingPresentationV1Schema = z.object({
  v: z.literal(1), templateName: z.string(), templateVersion: z.string(),
  authorDisplayName: z.optional(z.string()), firstTask: z.optional(z.string()),
});
export type SessionHostOnboardingPresentationV1 = z.infer<typeof SessionHostOnboardingPresentationV1Schema>;
const metadataSchema = z.object({ happierHostOnboardingV1: SessionHostOnboardingPresentationV1Schema });

export function readSessionHostOnboardingPresentationV1(meta: unknown): SessionHostOnboardingPresentationV1 | null {
  const parsed = metadataSchema.safeParse(meta);
  return parsed.success ? parsed.data.happierHostOnboardingV1 : null;
}
