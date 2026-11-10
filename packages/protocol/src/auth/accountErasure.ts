import { z } from '../zodRuntimePolicy.js';
import { ManagedResourceDependencyV1Schema, ManagedResourceDispositionV1Schema } from '../machines/managed/managedDependencyV1.js';

export const ACCOUNT_ERASURE_CONFIRMATION_V1 = 'DELETE' as const;
export const AccountErasureRequestV1Schema = z.strictObject({
  confirmation: z.literal(ACCOUNT_ERASURE_CONFIRMATION_V1),
  managedResourceDispositions: z.optional(z.array(ManagedResourceDispositionV1Schema)),
});
export type AccountErasureRequestV1 = z.infer<typeof AccountErasureRequestV1Schema>;
export const AccountErasureResponseV1Schema = z.strictObject({
  status: z.literal('deleted'),
});
export type AccountErasureResponseV1 = z.infer<typeof AccountErasureResponseV1Schema>;
export const AccountErasureErrorV1Schema = z.union([z.strictObject({
  // `home_owner_transfer_required` and `team_owner_transfer_required` are
  // additive: released clients that do not know them fall back to their
  // existing generic delete-failure handling. Both are refused before any
  // external object is deleted, so both are actionable and fully retryable.
  error: z.enum([
    'invalid_request',
    'present_user_required',
    'home_owner_transfer_required',
    'team_owner_transfer_required',
    'account_erasure_transition_cleanup_pending',
  ]),
}), z.strictObject({
  error: z.literal('account_erasure_managed_resources_review_required'),
  resources: z.array(ManagedResourceDependencyV1Schema),
})]);
export type AccountErasureErrorV1 = z.infer<typeof AccountErasureErrorV1Schema>;
export const ACCOUNT_ERASURE_HTTP_PATH_V1 = '/v1/auth/account/delete' as const;
