import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { BinaryBlobContentKindV1Schema, BinaryBlobReferenceV1Schema, BinaryBlobStoredContentV1Schema } from '../storage/binaryBlobV1.js';
import { DiscussionIdSchema, DiscussionMessageIdSchema } from './references.js';

/** File locators are read only by the admitted invoking CLI host, never by Home. */
export const DiscussionAttachmentSourceV1Schema = lazyZodSchema(() => z.strictObject({
  blobId: BinaryBlobReferenceV1Schema.shape.blobId,
  path: z.string().check(z.minLength(1), z.refine(path => !path.includes('\0'), 'File paths cannot contain NUL')),
}));
export type DiscussionAttachmentSourceV1 = z.infer<typeof DiscussionAttachmentSourceV1Schema>;
export const DiscussionAttachmentSourcesV1Schema = lazyZodSchema(() => z.array(DiscussionAttachmentSourceV1Schema).check(
  z.refine(sources => new Set(sources.map(source => source.blobId)).size === sources.length,
    'Each attachment leaf has one source on the invoking Machine'),
));

/** Closed immutable binding identity, distinct from randomized ciphertext and upload progress. */
export const DiscussionAttachmentBindingV1Schema = lazyZodSchema(() => z.strictObject({
  blobId: BinaryBlobReferenceV1Schema.shape.blobId,
  t: BinaryBlobContentKindV1Schema,
}));
export type DiscussionAttachmentBindingV1 = z.infer<typeof DiscussionAttachmentBindingV1Schema>;
export const DiscussionAttachmentBindingsV1Schema = lazyZodSchema(() => z.array(DiscussionAttachmentBindingV1Schema).check(
  z.refine(bindings => new Set(bindings.map(binding => binding.blobId)).size === bindings.length,
    'Discussion attachment bindings must be unique'),
));

/** A blob id alone never authorizes disclosure: reads qualify its committed message and Discussion. */
export const DiscussionAttachmentReadRequestV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema, messageId: DiscussionMessageIdSchema,
  blobId: BinaryBlobReferenceV1Schema.shape.blobId,
}));
export type DiscussionAttachmentReadRequestV1 = z.infer<typeof DiscussionAttachmentReadRequestV1Schema>;
export const DiscussionAttachmentReadInputV1Schema = lazyZodSchema(() => z.extend(DiscussionAttachmentReadRequestV1Schema, {
  /** May narrow the protected addressed cutoff; never expands runtime authority. */
  throughSeq: z.optional(z.number().check(z.int(), z.nonnegative())),
}));
export type DiscussionAttachmentReadInputV1 = z.infer<typeof DiscussionAttachmentReadInputV1Schema>;
export const DiscussionAttachmentReadResponseV1Schema = lazyZodSchema(() => z.strictObject({
  blobId: BinaryBlobReferenceV1Schema.shape.blobId, content: BinaryBlobStoredContentV1Schema,
}));
export type DiscussionAttachmentReadResponseV1 = z.infer<typeof DiscussionAttachmentReadResponseV1Schema>;
/** Semantic Action output has already been opened and integrity checked by the invoking host. */
export const DiscussionAttachmentReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  ...BinaryBlobReferenceV1Schema.shape,
  bytesBase64: BinaryBlobStoredContentV1Schema.def.options[0].shape.v,
}));
export type DiscussionAttachmentReadResultV1 = z.infer<typeof DiscussionAttachmentReadResultV1Schema>;
