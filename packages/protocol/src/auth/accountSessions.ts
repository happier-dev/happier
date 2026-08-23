import { z } from 'zod';

/**
 * A present-user Action can revoke only the authenticated Account's signed
 * sessions. The Account is always derived below the Action boundary.
 */
export const AccountSessionsSignOutEverywhereActionInputV1Schema = z.object({}).strict();
export type AccountSessionsSignOutEverywhereActionInputV1 = z.infer<
  typeof AccountSessionsSignOutEverywhereActionInputV1Schema
>;

export const AccountSessionsSignOutEverywhereActionOutputV1Schema = z.object({
  status: z.literal('signed_out'),
}).strict();
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

export const AccountSessionsSignOutEverywhereServerErrorV1Schema = z.object({
  error: z.enum(['invalid_request', 'present_user_required']),
}).strict();
export type AccountSessionsSignOutEverywhereServerErrorV1 = z.infer<
  typeof AccountSessionsSignOutEverywhereServerErrorV1Schema
>;
