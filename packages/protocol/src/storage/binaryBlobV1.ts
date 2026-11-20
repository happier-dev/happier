import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const PRIVATE_BINARY_STORAGE_UNAVAILABLE_CODE_V1 = 'private_storage_unavailable';
export const PrivateBinaryStorageUnavailableReasonV1Schema = z.enum(['s3_private_bucket_missing', 'backend_unavailable']);
export const PrivateBinaryStorageUnavailableResponseV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.literal(PRIVATE_BINARY_STORAGE_UNAVAILABLE_CODE_V1),
  reason: PrivateBinaryStorageUnavailableReasonV1Schema,
}));
export type PrivateBinaryStorageUnavailableResponseV1 = z.infer<typeof PrivateBinaryStorageUnavailableResponseV1Schema>;

/** Private binary identity; sensitive descriptors belong inside the resource content envelope. */
export const BinaryBlobReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  blobId: z.string().check(z.uuid()),
  mime: z.string().check(z.minLength(1)),
  sizeBytes: z.number().check(z.int(), z.nonnegative(), z.maximum(Number.MAX_SAFE_INTEGER)),
  sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
}));
export type BinaryBlobReferenceV1 = z.infer<typeof BinaryBlobReferenceV1Schema>;
export const BinaryBlobContentKindV1Schema = lazyZodSchema(() => z.enum(['plain', 'encrypted']));

const bytesBase64 = z.string().check(z.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/));
/** Explicit resource mode must be checked before opening or disclosing the bytes. */
export const BinaryBlobStoredContentV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: bytesBase64 }),
  z.strictObject({ t: z.literal('encrypted'), c: bytesBase64 }),
]));
export type BinaryBlobStoredContentV1 = z.infer<typeof BinaryBlobStoredContentV1Schema>;

/** Signed conversion identifies already staged bytes instead of carrying a whole file in JSON. */
export const BinaryBlobAccountEncryptionStageV1Schema = lazyZodSchema(() => z.strictObject({
  t: BinaryBlobContentKindV1Schema, uploadId: z.string().check(z.uuid()),
  contentSha256: z.string().check(z.regex(/^[a-f0-9]{64}$/)),
}));
export type BinaryBlobAccountEncryptionStageV1 = z.infer<typeof BinaryBlobAccountEncryptionStageV1Schema>;
