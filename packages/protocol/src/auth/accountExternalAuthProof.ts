import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/** Shared opaque proof carrier for purpose-bound OAuth and mTLS reauthentication. */
export const AccountExternalAuthProofV1Schema = lazyZodSchema(() => z.object({
  provider: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._-]*$/),
  pending: z.string().min(1).max(256),
  proof: z.string().min(1).max(4096),
}).strict());
export type AccountExternalAuthProofV1 = z.infer<typeof AccountExternalAuthProofV1Schema>;
