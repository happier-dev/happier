import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { BrowserHttpOriginV1Schema } from '../url.js';

const IdSchema = lazyZodSchema(() => z.string().trim().min(1).max(256));

export const BrowserPermissionKindV1Schema = lazyZodSchema(() => z.enum([
  'origin',
  'downloads',
  'uploads',
  'clipboard',
  'camera',
  'microphone',
  'fileAccess',
  'popups',
  'browserUse',
]));
export type BrowserPermissionKindV1 = z.infer<typeof BrowserPermissionKindV1Schema>;

export const BrowserPermissionStateV1Schema = lazyZodSchema(() => z.enum(['allowed', 'denied', 'prompt']));
export type BrowserPermissionStateV1 = z.infer<typeof BrowserPermissionStateV1Schema>;

export const BrowserPermissionScopeV1Schema = lazyZodSchema(() => z.enum(['profile', 'session', 'target']));
export type BrowserPermissionScopeV1 = z.infer<typeof BrowserPermissionScopeV1Schema>;

export const BrowserPermissionGrantV1Schema = lazyZodSchema(() => z
  .object({
    id: IdSchema,
    profileId: IdSchema.optional(),
    browserSessionId: IdSchema.optional(),
    origin: BrowserHttpOriginV1Schema,
    permission: BrowserPermissionKindV1Schema,
    state: BrowserPermissionStateV1Schema,
    scope: BrowserPermissionScopeV1Schema,
    targetId: IdSchema.optional(),
    updatedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((grant, context) => {
    if (grant.scope === 'profile' && grant.profileId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profileId'],
        message: 'Profile-scoped browser permission grants require a profileId.',
      });
    }
    if (grant.scope === 'target' && grant.targetId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: 'Target-scoped browser permission grants require a targetId.',
      });
    }
    if (grant.scope === 'session' && grant.browserSessionId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['browserSessionId'],
        message: 'Session-scoped browser permission grants require a browserSessionId.',
      });
    }
  }));
export type BrowserPermissionGrantV1 = z.infer<typeof BrowserPermissionGrantV1Schema>;
