import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { TeamCredentialDirectMaterialIdentityV1Schema } from './directMaterialCensusV1.js';

export const TeamCredentialDirectMaterialReconcileInputV1Schema = lazyZodSchema(() => z.strictObject({
  teamId: TeamCredentialDirectMaterialIdentityV1Schema,
  resourceId: TeamCredentialDirectMaterialIdentityV1Schema,
}));
export type TeamCredentialDirectMaterialReconcileInputV1 = z.infer<
  typeof TeamCredentialDirectMaterialReconcileInputV1Schema
>;

export const TeamCredentialDirectMaterialReconcileOutputV1Schema = lazyZodSchema(() => z.strictObject({
  prepared: z.number().check(z.int(), z.nonnegative()),
  remaining: z.number().check(z.int(), z.nonnegative()),
  failures: z.array(z.strictObject({
    sourceMemberKey: z.optional(z.string().check(z.minLength(1), z.maxLength(256))),
    reason: z.enum([
      'source_changed',
      'source_unavailable',
      'recipient_unavailable',
      'upload_failed',
      'cancelled',
      'unsupported_direct_source',
      'access_only_expiry_unavailable',
    ]),
  })),
}));
export type TeamCredentialDirectMaterialReconcileOutputV1 = z.infer<
  typeof TeamCredentialDirectMaterialReconcileOutputV1Schema
>;
