import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/** Canonical connected-service credential category primitive. */
export const ConnectedServiceCredentialKindSchema = lazyZodSchema(() => z.enum(['oauth', 'token']));
export type ConnectedServiceCredentialKind = z.infer<
  typeof ConnectedServiceCredentialKindSchema
>;
