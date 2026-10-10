import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { TeamCredentialDirectMaterialIdentityV1Schema } from './directMaterialCensusV1.js';

export const TeamCredentialDirectMaterialReconcileInputV1Schema = lazyZodSchema(() => z.object({
  teamId: TeamCredentialDirectMaterialIdentityV1Schema,
  resourceId: TeamCredentialDirectMaterialIdentityV1Schema,
}).strict());
export type TeamCredentialDirectMaterialReconcileInputV1 = z.infer<
  typeof TeamCredentialDirectMaterialReconcileInputV1Schema
>;

export const TeamCredentialDirectMaterialReconcileOutputV1Schema = lazyZodSchema(() => z.object({
  prepared: z.number().int().nonnegative(),
  remaining: z.number().int().nonnegative(),
  failures: z.array(z.object({
    sourceMemberKey: z.string().min(1).max(256).optional(),
    reason: z.enum([
      'source_changed',
      'source_unavailable',
      'recipient_unavailable',
      'upload_failed',
      'cancelled',
      'unsupported_direct_source',
    ]),
  }).strict()),
}).strict());
export type TeamCredentialDirectMaterialReconcileOutputV1 = z.infer<
  typeof TeamCredentialDirectMaterialReconcileOutputV1Schema
>;
