import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

export const TeamCredentialDirectMaterialIdentityV1Schema = lazyZodSchema(() => z.string().trim().min(1).max(256));

/** Material-safe source-owner census used by the Access surface. */
export const TeamCredentialDirectMaterialCensusInputV1Schema = lazyZodSchema(() => z.object({
  teamId: TeamCredentialDirectMaterialIdentityV1Schema,
  resourceId: TeamCredentialDirectMaterialIdentityV1Schema,
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict());
export type TeamCredentialDirectMaterialCensusInputV1 = z.infer<
  typeof TeamCredentialDirectMaterialCensusInputV1Schema
>;

export const TeamCredentialDirectMaterialCensusOutputV1Schema = lazyZodSchema(() => z.object({
  resourceRevision: z.number().int().nonnegative(),
  sourceOwner: z.literal(true),
  recipients: z.array(z.object({
    recipientAccountId: TeamCredentialDirectMaterialIdentityV1Schema,
    readiness: z.enum([
      'ready',
      'preparing',
      'recipient_binding_changed',
      'source_changed',
    ]),
  }).strict()),
  nextCursor: z.string().trim().min(1).max(512).nullable(),
}).strict());
export type TeamCredentialDirectMaterialCensusOutputV1 = z.infer<
  typeof TeamCredentialDirectMaterialCensusOutputV1Schema
>;
