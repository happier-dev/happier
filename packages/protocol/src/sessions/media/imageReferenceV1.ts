import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

const IdSchema = lazyZodSchema(() => z.string().trim().min(1).max(256));

/** Durable reference only; the Session image reader verifies scope, digest and actual bytes. */
export const SessionImageFileReferenceV1Schema = lazyZodSchema(() => z.object({
  sessionId: IdSchema,
  storage: z.enum(['session', 'daemon']),
  path: z.string().trim().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  mimeType: z.literal('image/png'),
}).strict());
export type SessionImageFileReferenceV1 = z.infer<typeof SessionImageFileReferenceV1Schema>;

export const SessionImageMediaReferenceV1Schema = lazyZodSchema(() => z.object({
  mediaId: IdSchema,
  mediaKind: z.literal('image'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  sizeBytes: z.number().int().positive(),
  file: SessionImageFileReferenceV1Schema.optional(),
}).strict());
export type SessionImageMediaReferenceV1 = z.infer<typeof SessionImageMediaReferenceV1Schema>;
