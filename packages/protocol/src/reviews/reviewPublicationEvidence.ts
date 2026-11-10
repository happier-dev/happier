import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Host receipts from the existing review comment publication owner. */
export const ReviewPublicationMaterializationSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('complete') }),
  z.strictObject({ kind: z.literal('partial'), errorCode: z.string().check(z.minLength(1)) }),
  z.strictObject({ kind: z.literal('failed'), errorCode: z.string().check(z.minLength(1)) }),
]));
export type ReviewPublicationMaterialization = z.infer<typeof ReviewPublicationMaterializationSchema>;

/** Project receipts from a larger host-published result; absence is not success. */
export const ReviewPublicationEvidenceSchema = lazyZodSchema(() => z.object({
  reviewedFingerprint: z.optional(z.nullable(z.string())),
  commentIds: z.optional(z.array(z.string().check(z.minLength(1)))),
  materialization: z.optional(ReviewPublicationMaterializationSchema),
}));
export type ReviewPublicationEvidence = z.infer<typeof ReviewPublicationEvidenceSchema>;
