import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** A Discussion slot operand; its current owner and launch are verified at Session birth. */
export const SessionDiscussionParticipantV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: z.string().check(z.trim(), z.minLength(1)),
  participantSlotId: z.string().check(z.trim(), z.minLength(1)),
}));
export type SessionDiscussionParticipantV1 = z.infer<typeof SessionDiscussionParticipantV1Schema>;
