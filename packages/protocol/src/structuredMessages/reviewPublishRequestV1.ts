import { z } from 'zod';

import { ReviewFindingSchema } from '../reviews/ReviewFinding.js';

export const ReviewPublishRequestV1Schema = z.object({
  sourceRunRef: z.object({
    runId: z.string().min(1),
    callId: z.string().min(1),
    backendId: z.string().min(1),
  }).passthrough(),
  findingIds: z.array(z.string().min(1)).min(1),
  publishedFindings: z.array(ReviewFindingSchema).min(1),
  threadRefs: z.array(z.string().min(1)).optional(),
}).passthrough();

export type ReviewPublishRequestV1 = z.infer<typeof ReviewPublishRequestV1Schema>;

export function parseReviewPublishRequestV1(payload: unknown): ReviewPublishRequestV1 | null {
  const parsed = ReviewPublishRequestV1Schema.safeParse(payload);
  if (!parsed.success) return null;
  return parsed.data;
}
