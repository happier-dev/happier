import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

/** Durable reference only; the Session image reader verifies scope, digest and actual bytes. */
export const SessionImageFileReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: IdSchema,
  storage: z.enum(['session', 'daemon']),
  path: z.string().check(z.trim(), z.minLength(1)),
  sha256: z.string().check(z.regex(/^[a-f0-9]{64}$/i)),
  mimeType: z.literal('image/png'),
}));
export type SessionImageFileReferenceV1 = z.infer<typeof SessionImageFileReferenceV1Schema>;

export const SessionImageMediaReferenceV1Schema = lazyZodSchema(() => z.strictObject({
  mediaId: IdSchema,
  mediaKind: z.literal('image'),
  width: z.number().check(z.int(), z.positive()),
  height: z.number().check(z.int(), z.positive()),
  sizeBytes: z.number().check(z.int(), z.positive()),
  file: z.optional(SessionImageFileReferenceV1Schema),
}));
export type SessionImageMediaReferenceV1 = z.infer<typeof SessionImageMediaReferenceV1Schema>;
