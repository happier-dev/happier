import { z } from 'zod';

import {
  ReviewAssumptionSchema,
  ReviewFindingSchema,
  ReviewQuestionSchema,
} from '@happier-dev/protocol';

export const ReviewFollowUpIntentInputSchema = z.object({
  kind: z.literal('review_follow_up.v1'),
  parentRunRef: z.object({
    runId: z.string().min(1),
    callId: z.string().min(1),
    backendId: z.string().min(1),
  }).passthrough(),
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
