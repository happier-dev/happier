import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** An engine admission failure has no fabricated reviewer Run identity. */
export const ReviewLaunchFailureSchema = lazyZodSchema(() => z.strictObject({
  engineId: z.string().check(z.trim(), z.minLength(1)),
  errorCode: z.string().check(z.minLength(1)),
  error: z.string().check(z.minLength(1)),
}));
export type ReviewLaunchFailure = z.infer<typeof ReviewLaunchFailureSchema>;
