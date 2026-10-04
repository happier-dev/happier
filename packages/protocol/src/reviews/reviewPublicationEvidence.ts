import { z } from 'zod';

/** Host receipts from the existing review comment publication owner. */
export const ReviewPublicationMaterializationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('complete') }).strict(),
  z.object({ kind: z.literal('partial'), errorCode: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('failed'), errorCode: z.string().min(1) }).strict(),
]);
export type ReviewPublicationMaterialization = z.infer<typeof ReviewPublicationMaterializationSchema>;

/** Project receipts from a larger host-published result; absence is not success. */
export const ReviewPublicationEvidenceSchema = z.object({
  reviewedFingerprint: z.string().nullable().optional(),
  commentIds: z.array(z.string().min(1)).optional(),
  materialization: ReviewPublicationMaterializationSchema.optional(),
}).strip();
export type ReviewPublicationEvidence = z.infer<typeof ReviewPublicationEvidenceSchema>;
