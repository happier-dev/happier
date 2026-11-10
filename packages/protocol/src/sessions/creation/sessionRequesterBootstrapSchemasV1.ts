import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** C41 signs the complete existing Machine RPC envelope, including this private payload. */
export const SessionRequesterInstallationSealedBootstrapV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('installation_sealed_v1'),
  installationId: z.string().check(z.trim(), z.minLength(1)),
  ciphertext: z.string().check(z.regex(/^[A-Za-z0-9_-]+$/u)),
}));
