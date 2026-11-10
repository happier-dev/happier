import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { BrowserHttpOriginV1Schema } from '../url.js';

const IdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(256)));

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

export const BrowserPermissionGrantV1Schema = lazyZodSchema(() => z.strictObject({
    id: IdSchema,
    profileId: z.optional(IdSchema),
    browserSessionId: z.optional(IdSchema),
    origin: BrowserHttpOriginV1Schema,
    permission: BrowserPermissionKindV1Schema,
    state: BrowserPermissionStateV1Schema,
    scope: BrowserPermissionScopeV1Schema,
    targetId: z.optional(IdSchema),
    updatedAt: z.number().check(z.int(), z.nonnegative()),
    expiresAt: z.optional(z.number().check(z.int(), z.nonnegative())),
  }).check(z.superRefine((grant, context) => {
    if (grant.scope === 'profile' && grant.profileId == null) {
      context.addIssue({
        code: "custom",
        path: ['profileId'],
        message: 'Profile-scoped browser permission grants require a profileId.',
      });
    }
    if (grant.scope === 'target' && grant.targetId == null) {
      context.addIssue({
        code: "custom",
        path: ['targetId'],
        message: 'Target-scoped browser permission grants require a targetId.',
      });
    }
    if (grant.scope === 'session' && grant.browserSessionId == null) {
      context.addIssue({
        code: "custom",
        path: ['browserSessionId'],
        message: 'Session-scoped browser permission grants require a browserSessionId.',
      });
    }
  })));
export type BrowserPermissionGrantV1 = z.infer<typeof BrowserPermissionGrantV1Schema>;
