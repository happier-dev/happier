import { z } from 'zod/mini';

import { BrowserPermissionKindV1Schema } from '../permissions/v1.js';
import { BrowserProfileStorageModeV1Schema } from '../profile/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';
import { BrowserHttpOriginV1Schema, BrowserHttpUrlV1Schema } from '../url.js';

const IdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));

export const BrowserPolicyDecisionStateV1Schema = z.enum(['allowed', 'prompt', 'denied', 'unavailable']);
export type BrowserPolicyDecisionStateV1 = z.infer<typeof BrowserPolicyDecisionStateV1Schema>;

export const BrowserPolicyReasonCodeV1Schema = z.enum([
  'feature_disabled',
  'profile_missing',
  'profile_unusable',
  'policy_missing',
  'policy_denied',
  'external_url_disabled',
  'hosted_plugin_profile_mismatch',
  'adapter_unavailable',
  'permission_denied',
  'unsupported_target',
]);
export type BrowserPolicyReasonCodeV1 = z.infer<typeof BrowserPolicyReasonCodeV1Schema>;

export const BrowserPermissionActionPolicyV1Schema = z.enum(['deny', 'prompt', 'allow']);
export type BrowserPermissionActionPolicyV1 = z.infer<typeof BrowserPermissionActionPolicyV1Schema>;

export const BrowserTargetPermissionPolicyV1Schema = z.strictObject({
    downloads: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    uploads: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    clipboard: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    camera: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    microphone: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    fileAccess: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    popups: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'deny'),
    browserUse: z._default(z.optional(BrowserPermissionActionPolicyV1Schema), 'prompt'),
  });
export type BrowserTargetPermissionPolicyV1 = z.infer<typeof BrowserTargetPermissionPolicyV1Schema>;

export const DEFAULT_BROWSER_TARGET_PERMISSION_POLICY_V1: BrowserTargetPermissionPolicyV1 = {
  downloads: 'deny',
  uploads: 'deny',
  clipboard: 'deny',
  camera: 'deny',
  microphone: 'deny',
  fileAccess: 'deny',
  popups: 'deny',
  browserUse: 'prompt',
};

export const BrowserOriginSecurityLevelV1Schema = z.enum([
  'unknown',
  'secure',
  'insecure',
  'localPreview',
  'hostedPlugin',
  'sensitive',
]);
export type BrowserOriginSecurityLevelV1 = z.infer<typeof BrowserOriginSecurityLevelV1Schema>;

export const BrowserOriginSecuritySummaryV1Schema = z.strictObject({
    url: z.optional(BrowserHttpUrlV1Schema),
    origin: z.optional(BrowserHttpOriginV1Schema),
    securityLevel: BrowserOriginSecurityLevelV1Schema,
    reasonCodes: z.optional(z.array(BrowserPolicyReasonCodeV1Schema)),
  });
export type BrowserOriginSecuritySummaryV1 = z.infer<typeof BrowserOriginSecuritySummaryV1Schema>;

export const BrowserTargetPolicyDecisionV1Schema = z.strictObject({
    targetKind: BrowserViewTargetKindV1Schema,
    state: BrowserPolicyDecisionStateV1Schema,
    reasonCode: z.optional(BrowserPolicyReasonCodeV1Schema),
    profileId: z.optional(IdSchema),
    profileMode: z.optional(BrowserProfileStorageModeV1Schema),
    origin: z.optional(BrowserHttpOriginV1Schema),
    security: z.optional(BrowserOriginSecuritySummaryV1Schema),
    permissions: z.optional(BrowserTargetPermissionPolicyV1Schema),
    disabledReasons: z.optional(z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)))),
  }).check(z.superRefine((decision, context) => {
    if (decision.state !== 'allowed' && decision.reasonCode == null) {
      context.addIssue({
        code: "custom",
        path: ['reasonCode'],
        message: 'Non-allowed browser policy decisions require a reason code.',
      });
    }
  }));
export type BrowserTargetPolicyDecisionV1 = z.infer<typeof BrowserTargetPolicyDecisionV1Schema>;

export function isBrowserPermissionKindV1(value: unknown): value is z.infer<typeof BrowserPermissionKindV1Schema> {
  return BrowserPermissionKindV1Schema.safeParse(value).success;
}
