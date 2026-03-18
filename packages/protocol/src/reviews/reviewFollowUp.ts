import { z } from 'zod';

export const ReviewFollowUpInputSchema = z.object({
  findingIds: z.array(z.string().min(1)).max(100).default([]),
  threadId: z.string().min(1).optional(),
  replyToQuestionId: z.string().min(1).optional(),
  messageMarkdown: z.string().min(1),
}).passthrough();
export type ReviewFollowUpInput = z.infer<typeof ReviewFollowUpInputSchema>;
