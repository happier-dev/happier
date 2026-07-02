import { z } from 'zod';

import { BrowserHttpOriginV1Schema } from '../url.js';

export const BrowserPermissionKindV1Schema = z.enum([
  'origin',
  'downloads',
  'uploads',
  'clipboard',
  'camera',
  'microphone',
  'fileAccess',
  'popups',
  'browserUse',
]);
export type BrowserPermissionKindV1 = z.infer<typeof BrowserPermissionKindV1Schema>;

export const BrowserPermissionStateV1Schema = z.enum(['allowed', 'denied', 'prompt']);
export type BrowserPermissionStateV1 = z.infer<typeof BrowserPermissionStateV1Schema>;

export const BrowserPermissionScopeV1Schema = z.enum(['profile', 'session', 'target']);
export type BrowserPermissionScopeV1 = z.infer<typeof BrowserPermissionScopeV1Schema>;

export const BrowserPermissionGrantV1Schema = z
  .object({
    id: z.string().trim().min(1).max(256),
    origin: BrowserHttpOriginV1Schema,
    permission: BrowserPermissionKindV1Schema,
    state: BrowserPermissionStateV1Schema,
    scope: BrowserPermissionScopeV1Schema,
    targetId: z.string().trim().min(1).max(256).optional(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.scope === 'target' && grant.targetId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: 'Target-scoped browser permission grants require a targetId.',
      });
    }
  });
export type BrowserPermissionGrantV1 = z.infer<typeof BrowserPermissionGrantV1Schema>;

export const BrowserPermissionsV1Schema = z
  .object({
    profileId: z.string().trim().min(1).max(256),
    grants: z.array(BrowserPermissionGrantV1Schema).optional().default([]),
  })
  .strict();
export type BrowserPermissionsV1 = z.infer<typeof BrowserPermissionsV1Schema>;
