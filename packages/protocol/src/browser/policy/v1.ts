import { z } from 'zod';

import { BrowserPermissionKindV1Schema } from '../permissions/v1.js';
import { BrowserProfileStorageModeV1Schema } from '../profile/v1.js';
import { BrowserViewTargetKindV1Schema } from '../target/v1.js';
import { BrowserHttpOriginV1Schema, BrowserHttpUrlV1Schema } from '../url.js';

const IdSchema = z.string().trim().min(1).max(256);

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

export const BrowserTargetPermissionPolicyV1Schema = z
  .object({
    downloads: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    uploads: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    clipboard: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    camera: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    microphone: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    fileAccess: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    popups: BrowserPermissionActionPolicyV1Schema.optional().default('deny'),
    browserUse: BrowserPermissionActionPolicyV1Schema.optional().default('prompt'),
  })
  .strict();
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

export const BrowserOriginSecuritySummaryV1Schema = z
  .object({
    url: BrowserHttpUrlV1Schema.optional(),
    origin: BrowserHttpOriginV1Schema.optional(),
    securityLevel: BrowserOriginSecurityLevelV1Schema,
    reasonCodes: z.array(BrowserPolicyReasonCodeV1Schema).optional(),
  })
  .strict();
export type BrowserOriginSecuritySummaryV1 = z.infer<typeof BrowserOriginSecuritySummaryV1Schema>;

export const BrowserTargetPolicyDecisionV1Schema = z
  .object({
    targetKind: BrowserViewTargetKindV1Schema,
    state: BrowserPolicyDecisionStateV1Schema,
    reasonCode: BrowserPolicyReasonCodeV1Schema.optional(),
    profileId: IdSchema.optional(),
    profileMode: BrowserProfileStorageModeV1Schema.optional(),
    origin: BrowserHttpOriginV1Schema.optional(),
    security: BrowserOriginSecuritySummaryV1Schema.optional(),
    permissions: BrowserTargetPermissionPolicyV1Schema.optional().default(
      DEFAULT_BROWSER_TARGET_PERMISSION_POLICY_V1,
    ),
    disabledReasons: z.array(z.string().trim().min(1).max(256)).optional(),
  })
  .strict()
  .superRefine((decision, context) => {
    if (decision.state !== 'allowed' && decision.reasonCode == null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reasonCode'],
        message: 'Non-allowed browser policy decisions require a reason code.',
      });
    }
  });
export type BrowserTargetPolicyDecisionV1 = z.infer<typeof BrowserTargetPolicyDecisionV1Schema>;

export function isBrowserPermissionKindV1(value: unknown): value is z.infer<typeof BrowserPermissionKindV1Schema> {
  return BrowserPermissionKindV1Schema.safeParse(value).success;
}
