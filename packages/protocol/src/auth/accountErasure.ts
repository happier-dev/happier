import { z } from 'zod';

export const ACCOUNT_ERASURE_CONFIRMATION_V1 = 'DELETE' as const;
export const AccountErasureRequestV1Schema = z.object({
  confirmation: z.literal(ACCOUNT_ERASURE_CONFIRMATION_V1),
}).strict();
export type AccountErasureRequestV1 = z.infer<typeof AccountErasureRequestV1Schema>;
export const AccountErasureResponseV1Schema = z.object({
  status: z.literal('deleted'),
}).strict();
export type AccountErasureResponseV1 = z.infer<typeof AccountErasureResponseV1Schema>;
export const AccountErasureErrorV1Schema = z.object({
  error: z.enum(['invalid_request', 'present_user_required']),
}).strict();
export type AccountErasureErrorV1 = z.infer<typeof AccountErasureErrorV1Schema>;
export const ACCOUNT_ERASURE_HTTP_PATH_V1 = '/v1/auth/account/delete' as const;
