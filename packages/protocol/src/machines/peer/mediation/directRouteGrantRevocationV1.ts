import { z } from 'zod';

export const DirectRouteGrantRevocationReasonV1Schema = z.enum([
  'policy_changed',
  'account_revoked',
  'machine_revoked',
  'session_revoked',
  'manual',
  'expired',
]);

export const DirectRouteGrantRevocationV1Schema = z
  .object({
    v: z.literal(1),
    grantId: z.string().min(1).optional(),
    grantFamilyId: z.string().min(1).optional(),
    reason: DirectRouteGrantRevocationReasonV1Schema,
    revokedAt: z.number().int().nonnegative(),
  })
  .refine((value) => Boolean(value.grantId || value.grantFamilyId), {
    message: 'grantId or grantFamilyId is required',
  });

export type DirectRouteGrantRevocationReasonV1 = z.infer<typeof DirectRouteGrantRevocationReasonV1Schema>;
export type DirectRouteGrantRevocationV1 = z.infer<typeof DirectRouteGrantRevocationV1Schema>;
