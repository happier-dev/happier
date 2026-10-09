import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** C41 signs the complete existing Machine RPC envelope, including this private payload. */
export const SessionRequesterInstallationSealedBootstrapV1Schema = lazyZodSchema(() => z.object({
  kind: z.literal('installation_sealed_v1'),
  installationId: z.string().trim().min(1),
  ciphertext: z.string().regex(/^[A-Za-z0-9_-]+$/u),
}).strict());
