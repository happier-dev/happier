import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

/**
 * Revokes the authenticated Account's signed sessions and, on explicit request,
 * its API tokens. The Account is always derived below the Action boundary.
 */
export const AccountSessionsSignOutEverywhereActionInputV1Schema = lazyZodSchema(() => z.strictObject({
  revokeApiTokens: z.optional(z.boolean()),
}));
export type AccountSessionsSignOutEverywhereActionInputV1 = z.infer<
  typeof AccountSessionsSignOutEverywhereActionInputV1Schema
>;

export const AccountSessionsSignOutEverywhereActionOutputV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.literal('signed_out'),
}));
export type AccountSessionsSignOutEverywhereActionOutputV1 = z.infer<
  typeof AccountSessionsSignOutEverywhereActionOutputV1Schema
>;

/** One authenticated route; callers never select an Account id. */
export const ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 =
  '/v1/auth/sessions/sign-out-everywhere';

export const AccountSessionsSignOutEverywhereServerOutputV1Schema =
  AccountSessionsSignOutEverywhereActionOutputV1Schema;
export type AccountSessionsSignOutEverywhereServerOutputV1 = z.infer<
  typeof AccountSessionsSignOutEverywhereServerOutputV1Schema
>;

export const AccountSessionsSignOutEverywhereServerErrorV1Schema = lazyZodSchema(() => z.strictObject({
  error: z.enum(['invalid_request', 'present_user_required']),
}));
export type AccountSessionsSignOutEverywhereServerErrorV1 = z.infer<
  typeof AccountSessionsSignOutEverywhereServerErrorV1Schema
>;
