import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const ReviewFollowUpInputSchema = lazyZodSchema(() => z.looseObject({
  findingIds: z._default(z.array(z.string().check(z.minLength(1))).check(z.maxLength(100)), []),
  threadId: z.optional(z.string().check(z.minLength(1))),
  replyToQuestionId: z.optional(z.string().check(z.minLength(1))),
  messageMarkdown: z.string().check(z.minLength(1)),
}));
export type ReviewFollowUpInput = z.infer<typeof ReviewFollowUpInputSchema>;
