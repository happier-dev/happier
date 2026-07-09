import { z } from 'zod';

import {
  BrowserTargetDisplayV1Schema,
  BrowserViewTargetV1Schema,
} from '../../../browser/target/v1.js';
import { PluginUiCompatibilityV1Schema } from '../ui/compatibility.js';
import { PluginUiPredicateV1Schema } from '../ui/predicates.js';

export const PluginBrowserActionKindV1Schema = z.enum([
  'openTarget',
  'focusExistingView',
  'suggestTarget',
]);
export type PluginBrowserActionKindV1 = z.infer<typeof PluginBrowserActionKindV1Schema>;

export const PluginBrowserProfileModeV1Schema = z.enum([
  'session',
  'ephemeral',
  'user',
]);
export type PluginBrowserProfileModeV1 = z.infer<typeof PluginBrowserProfileModeV1Schema>;

export const PluginBrowserActionPolicyV1Schema = z.object({
  requiredFeatureIds: z.array(z.string().trim().min(1)).default([]),
  requiredPermissionIds: z.array(z.string().trim().min(1)).default([]),
  profileMode: PluginBrowserProfileModeV1Schema.optional(),
}).strict();
export type PluginBrowserActionPolicyV1 = z.infer<typeof PluginBrowserActionPolicyV1Schema>;

const PLUGIN_BROWSER_TARGET_CONTRIBUTION_KEYS = new Set([
  'id',
  'target',
  'display',
  'visibility',
  'featureGate',
  'order',
  'compatibility',
]);

const PLUGIN_BROWSER_ACTION_CONTRIBUTION_KEYS = new Set([
  ...PLUGIN_BROWSER_TARGET_CONTRIBUTION_KEYS,
  'kind',
  'enabled',
  'policy',
]);

function rejectUnknownContributionKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
  ctx: z.RefinementCtx,
): void {
  for (const key of Object.keys(value)) {
    if (allowedKeys.has(key)) {
      continue;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Unsupported plugin browser contribution field: ${key}`,
      path: [key],
    });
  }
}

const PluginBrowserContributionBaseV1Shape = {
  id: z.string().trim().min(1),
  target: BrowserViewTargetV1Schema,
  display: BrowserTargetDisplayV1Schema,
  visibility: PluginUiPredicateV1Schema.optional(),
  featureGate: z.string().trim().min(1).optional(),
  order: z.number().int().optional(),
  compatibility: PluginUiCompatibilityV1Schema.optional(),
} as const;

export const PluginBrowserTargetContributionV1Schema = z
  .object(PluginBrowserContributionBaseV1Shape)
  .passthrough()
  .superRefine((value, ctx) => {
    rejectUnknownContributionKeys(value, PLUGIN_BROWSER_TARGET_CONTRIBUTION_KEYS, ctx);
  });
export type PluginBrowserTargetContributionV1 =
  z.infer<typeof PluginBrowserTargetContributionV1Schema>;

export const PluginBrowserActionContributionV1Schema = z
  .object({
    ...PluginBrowserContributionBaseV1Shape,
    kind: PluginBrowserActionKindV1Schema,
    enabled: PluginUiPredicateV1Schema.optional(),
    policy: PluginBrowserActionPolicyV1Schema.default({
      requiredFeatureIds: [],
      requiredPermissionIds: [],
    }),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    rejectUnknownContributionKeys(value, PLUGIN_BROWSER_ACTION_CONTRIBUTION_KEYS, ctx);
  });
export type PluginBrowserActionContributionV1 =
  z.infer<typeof PluginBrowserActionContributionV1Schema>;
