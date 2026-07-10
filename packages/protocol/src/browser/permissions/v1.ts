import { z } from 'zod';

import { BrowserHttpOriginV1Schema } from '../url.js';

const IdSchema = z.string().trim().min(1).max(256);

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
  });
export type BrowserPermissionGrantV1 = z.infer<typeof BrowserPermissionGrantV1Schema>;

export const BrowserPermissionDecisionSourceV1Schema = z.enum(['user', 'policy', 'adapter', 'system']);
export type BrowserPermissionDecisionSourceV1 = z.infer<typeof BrowserPermissionDecisionSourceV1Schema>;

export const BrowserPermissionRequestV1Schema = z
  .object({
    permissionRequestId: IdSchema,
    browserSessionId: IdSchema,
    viewId: IdSchema,
    profileId: IdSchema,
    permission: BrowserPermissionKindV1Schema,
    origin: BrowserHttpOriginV1Schema.optional(),
    targetId: IdSchema.optional(),
    requestedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BrowserPermissionRequestV1 = z.infer<typeof BrowserPermissionRequestV1Schema>;

export const BrowserPermissionDecisionV1Schema = z
  .object({
    decisionId: IdSchema,
    permissionRequestId: IdSchema.optional(),
    profileId: IdSchema,
    browserSessionId: IdSchema.optional(),
    targetId: IdSchema.optional(),
    origin: BrowserHttpOriginV1Schema.optional(),
    permission: BrowserPermissionKindV1Schema,
    state: BrowserPermissionStateV1Schema,
    scope: BrowserPermissionScopeV1Schema,
    source: BrowserPermissionDecisionSourceV1Schema,
    decidedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative().optional(),
    auditId: IdSchema.optional(),
    disabledReason: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.scope === 'target' && decision.targetId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetId'],
        message: 'Target-scoped browser permission decisions require a targetId.',
      });
    }
    if (decision.scope === 'session' && decision.browserSessionId == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['browserSessionId'],
        message: 'Session-scoped browser permission decisions require a browserSessionId.',
      });
    }
  });
export type BrowserPermissionDecisionV1 = z.infer<typeof BrowserPermissionDecisionV1Schema>;

export const BrowserPermissionsV1Schema = z
  .object({
    profileId: IdSchema,
    requests: z.array(BrowserPermissionRequestV1Schema).optional().default([]),
    grants: z.array(BrowserPermissionGrantV1Schema).optional().default([]),
    decisions: z.array(BrowserPermissionDecisionV1Schema).optional().default([]),
  })
  .strict();
export type BrowserPermissionsV1 = z.infer<typeof BrowserPermissionsV1Schema>;
