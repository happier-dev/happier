import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

/** Qualified address shared by Voice and widgets, independent of the Follow API graph. */
export const VoiceTrackedSessionAddressV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: z.string().check(z.trim(), z.minLength(1)),
  sessionId: z.string().check(z.trim(), z.minLength(1)),
}));
