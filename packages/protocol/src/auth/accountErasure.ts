import { z } from '../zodRuntimePolicy.js';
import { HomeAccountDeleteResultV1Schema } from '../home/governance/accounts.js';
import { HomeGovernanceErrorV1Schema } from '../home/governance/errors.js';
import { ManagedResourceDispositionV1Schema } from '../machines/managed/managedDependencyV1.js';

export const ACCOUNT_ERASURE_CONFIRMATION_V1 = 'DELETE' as const;
export const AccountErasureRequestV1Schema = z.strictObject({
  confirmation: z.literal(ACCOUNT_ERASURE_CONFIRMATION_V1),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
});
export type AccountErasureRequestV1 = z.infer<typeof AccountErasureRequestV1Schema>;
// Both entry points report committed retirement separately from confirmed physical deletion.
export const AccountErasureResponseV1Schema = HomeAccountDeleteResultV1Schema;
export type AccountErasureResponseV1 = z.infer<typeof AccountErasureResponseV1Schema>;
export const AccountErasureErrorV1Schema = z.union([z.strictObject({
  error: z.enum([
    'invalid_request',
    'present_user_required',
  ]),
}), HomeGovernanceErrorV1Schema]);
export type AccountErasureErrorV1 = z.infer<typeof AccountErasureErrorV1Schema>;
export const ACCOUNT_ERASURE_HTTP_PATH_V1 = '/v1/auth/account/delete' as const;
