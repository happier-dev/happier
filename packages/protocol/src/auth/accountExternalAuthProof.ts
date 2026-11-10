import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Shared opaque proof carrier for purpose-bound OAuth and mTLS reauthentication. */
export const AccountExternalAuthProofV1Schema = lazyZodSchema(() => z.strictObject({
  provider: z.string().check(z.minLength(1), z.maxLength(128), z.regex(/^[a-z0-9][a-z0-9._-]*$/)),
  pending: z.string().check(z.minLength(1), z.maxLength(256)),
  proof: z.string().check(z.minLength(1), z.maxLength(4096)),
}));
export type AccountExternalAuthProofV1 = z.infer<typeof AccountExternalAuthProofV1Schema>;
