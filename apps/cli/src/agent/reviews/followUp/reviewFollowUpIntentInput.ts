import { z } from 'zod';

import {
  ReviewAssumptionSchema,
  ReviewFindingSchema,
  ReviewQuestionSchema,
  ExecutionRunStructuredRunRefSchema,
} from '@happier-dev/protocol';

export const ReviewFollowUpIntentInputSchema = z.object({
  kind: z.literal('review_follow_up.v1'),
  parentRunRef: ExecutionRunStructuredRunRefSchema,
  threadId: z.string().min(1),
  findingIds: z.array(z.string().min(1)).default([]),
  replyToQuestionId: z.string().min(1).optional(),
  messageMarkdown: z.string().min(1),
  summary: z.string().min(1),
  overviewMarkdown: z.string().min(1),
  findings: z.array(ReviewFindingSchema).default([]),
  questions: z.array(ReviewQuestionSchema).default([]),
  assumptions: z.array(ReviewAssumptionSchema).default([]),
}).passthrough();

export type ReviewFollowUpIntentInput = z.infer<typeof ReviewFollowUpIntentInputSchema>;
