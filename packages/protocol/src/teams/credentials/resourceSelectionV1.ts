import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** The authenticated Account selects only its own direct-material sources. */
export const TeamCredentialResourceCustodianListInputV1Schema = lazyZodSchema(() => z.strictObject({
  scope: z.literal('custodian'),
  filter: z.literal('direct'),
  cursor: z.optional(z.string().check(z.minLength(1), z.maxLength(512))),
  limit: z._default(z.number().check(z.int(), z.minimum(1), z.maximum(100)), 50),
}));
