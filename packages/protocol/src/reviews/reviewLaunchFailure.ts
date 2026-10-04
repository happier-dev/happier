import { z } from 'zod';

/** An engine admission failure has no fabricated reviewer Run identity. */
export const ReviewLaunchFailureSchema = z.object({
  engineId: z.string().trim().min(1),
  errorCode: z.string().min(1),
  error: z.string().min(1),
}).strict();
export type ReviewLaunchFailure = z.infer<typeof ReviewLaunchFailureSchema>;
