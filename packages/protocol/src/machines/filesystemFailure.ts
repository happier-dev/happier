import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Identifier-only filesystem admission facts; paths, payloads and credentials stay local. */
export const FilesystemEffectFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  reason: z.enum(['requester_identity_unavailable', 'admission_not_current', 'admission_unavailable']),
}));
export type FilesystemEffectFailureDetailsV1 = z.infer<typeof FilesystemEffectFailureDetailsV1Schema>;
