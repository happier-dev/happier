import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { SessionTargetV1Schema } from '../actions/sessionTargetV1.js';
import { SessionMessageSendResultV1Schema } from '../sessions/messages/sessionInputAdmission.js';
import { ReviewFindingSchema } from './ReviewFinding.js';

/** Reviewed findings are untrusted data; current acceptance and CAS always come from ReviewComment. */
export const ReviewFindingsApplyInputV1Schema = lazyZodSchema(() => z.union([z.strictObject({
  sessionId: SessionTargetV1Schema,
  reviews: z.array(z.strictObject({
    runId: z.string().check(z.minLength(1)),
    findings: z.array(z.extend(z.object(ReviewFindingSchema.shape), {
      threadRefs: z.optional(z.array(z.string().check(z.minLength(1)))),
    })),
  })).check(z.minLength(1)),
}), z.strictObject({
  sessionId: SessionTargetV1Schema,
  reviewId: z.string().check(z.minLength(1)),
}), z.strictObject({
  reviewId: z.string().check(z.minLength(1)),
  destination: z.literal('prompt'),
})]));
export type ReviewFindingsApplyInputV1 = z.infer<typeof ReviewFindingsApplyInputV1Schema>;
export const ReviewFindingsApplyResultV1Schema = lazyZodSchema(() => z.union([
  SessionMessageSendResultV1Schema,
  z.strictObject({ status: z.literal('prepared'), prompt: z.string(), commentIds: z.array(z.string()) }),
  z.strictObject({ status: z.literal('unchanged'), commentIds: z.array(z.string()) }),
]));
export type ReviewFindingsApplyResultV1 = z.infer<typeof ReviewFindingsApplyResultV1Schema>;
