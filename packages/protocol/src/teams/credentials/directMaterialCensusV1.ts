import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

export const TeamCredentialDirectMaterialIdentityV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

/** Material-safe source-owner census used by the Access surface. */
export const TeamCredentialDirectMaterialCensusInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: TeamCredentialDirectMaterialIdentityV1Schema,
  resourceId: TeamCredentialDirectMaterialIdentityV1Schema,
  cursor: z.optional(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
}));
export type TeamCredentialDirectMaterialCensusInputV1 = z.infer<
  typeof TeamCredentialDirectMaterialCensusInputV1Schema
>;

export const TeamCredentialDirectMaterialCensusOutputV1Schema = lazyZodSchema(() => z.strictObject({
  resourceRevision: z.number().check(z.int(), z.nonnegative()),
  sourceOwner: z.literal(true),
  recipients: z.array(z.strictObject({
    recipientAccountId: TeamCredentialDirectMaterialIdentityV1Schema,
    readiness: z.enum([
      'ready',
      'preparing',
      'recipient_binding_changed',
      'source_changed',
    ]),
  })),
  nextCursor: z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(512))),
}));
export type TeamCredentialDirectMaterialCensusOutputV1 = z.infer<
  typeof TeamCredentialDirectMaterialCensusOutputV1Schema
>;
