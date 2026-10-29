import { lazyZodSchema } from '@happier-dev/protocol/lazyZodSchema';
import { z } from 'zod/mini';

import { ReviewAssumptionSchema } from '@happier-dev/protocol/reviews/ReviewAssumption';
import { ReviewFindingSchema } from '@happier-dev/protocol/reviews/ReviewFinding';
import { ReviewQuestionSchema } from '@happier-dev/protocol/reviews/ReviewQuestion';
import { ExecutionRunStructuredRunRefSchema } from '@happier-dev/protocol/messages/structured/executionRunStructuredRunRef';

export const ReviewFollowUpIntentInputSchema = lazyZodSchema(() => z.looseObject({
  kind: z.literal('review_follow_up.v1'),
  parentRunRef: ExecutionRunStructuredRunRefSchema,
  threadId: z.string().check(z.minLength(1)),
  findingIds: z._default(z.array(z.string().check(z.minLength(1))), []),
  replyToQuestionId: z.optional(z.string().check(z.minLength(1))),
  messageMarkdown: z.string().check(z.minLength(1)),
  summary: z.string().check(z.minLength(1)),
  overviewMarkdown: z.string().check(z.minLength(1)),
  findings: z._default(z.array(ReviewFindingSchema), []),
  questions: z._default(z.array(ReviewQuestionSchema), []),
  assumptions: z._default(z.array(ReviewAssumptionSchema), []),
}));

export type ReviewFollowUpIntentInput = z.infer<typeof ReviewFollowUpIntentInputSchema>;
