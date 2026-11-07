import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ApprovalProfileIdV1Schema, ApprovalProfileV1Schema } from './approvalProfiles.js';
import { ActionSurfaceSchema, ActionToolExposureModeSchema, ActionToolExposureSurfaceSchema } from './metadata.js';
import { ActionUiPlacementSchema } from './actionUiPlacements.js';
import { ActionApprovalScopeV1Schema, ActionPolicyAudienceV1Schema, normalizeActionSettingsActionId } from './actionSettings.js';
export { ACTION_POLICY_ACTION_IDS, isActionPolicyActionId, type ActionPolicyActionId } from './actionPolicyActionIds.js';

export type ActionAudiencePolicyMode = 'allowed' | 'ask_first' | 'off' | 'default';
const actionId = lazyZodSchema(() => z.string().check(z.refine(value => normalizeActionSettingsActionId(value) === value)));
const target = { actionId, audience: ActionPolicyAudienceV1Schema };
const mode = lazyZodSchema(() => z.enum(['allowed', 'ask_first', 'off', 'default']));
const scopedTarget = { ...target, audience: lazyZodSchema(() => z.keyof(ActionSurfaceSchema)), scope: ActionApprovalScopeV1Schema };
const selectedTarget = lazyZodSchema(() => z.union([z.strictObject(target), z.strictObject(scopedTarget)]));
const result = lazyZodSchema(() => z.strictObject({ ...target, scope: z.optional(ActionApprovalScopeV1Schema), mode, actionEnabled: z.boolean(), enabled: z.boolean() }));
const changed = lazyZodSchema(() => z.union([
  // Removal is the only intent accepting a retained, no-longer-installed Action id.
  z.strictObject({ actionId: z.string().check(z.minLength(1)), change: z.strictObject({
    kind: z.literal('scoped_approval_remove'), scope: ActionApprovalScopeV1Schema,
  }) }),
  z.strictObject({ actionId, change: z.union([
    z.strictObject({ kind: z.literal('enabled'), enabled: z.boolean() }),
    z.strictObject({ kind: z.literal('audience_enabled'), audience: ActionPolicyAudienceV1Schema, enabled: z.boolean() }),
    z.strictObject({ kind: z.literal('placement'), placement: ActionUiPlacementSchema, enabled: z.boolean() }),
    z.strictObject({ kind: z.literal('placement_policy'), placement: z.literal('slash_command'), mode }),
    z.strictObject({ kind: z.literal('tool_exposure'), surface: ActionToolExposureSurfaceSchema,
      mode: z.union([ActionToolExposureModeSchema, z.literal('default')]) }),
  ]) }),
  z.strictObject({ actionId: z.literal('capture.view'), change: z.strictObject({
    kind: z.literal('plugin_host_capture'), pluginId: z.string().check(z.minLength(1)), approvalRequired: z.boolean(),
  }) }),
]));
const profileChange = lazyZodSchema(() => z.strictObject({ profileChange: z.union([
  z.strictObject({ kind: z.literal('upsert'), profile: ApprovalProfileV1Schema.check(z.refine(
    profile => !profile.id.startsWith('builtin:'))) }),
  z.strictObject({ kind: z.literal('delete'), id: ApprovalProfileIdV1Schema.check(z.refine(
    id => !id.startsWith('builtin:'))) }),
]) }));
export const ActionPolicyInputSchemas = {
  'actions.policy.get': lazyZodSchema(() => z.union([selectedTarget, z.strictObject({ profiles: z.literal(true) })])),
  'actions.policy.set': lazyZodSchema(() => z.union([z.strictObject({ ...target, mode }),
    z.strictObject({ ...scopedTarget, mode: z.enum(['allowed', 'ask_first', 'default']) }), changed, profileChange])),
  'actions.policy.reset': selectedTarget,
} as const;
export const ActionPolicyOutputSchemas = {
  'actions.policy.get': lazyZodSchema(() => z.union([result, z.strictObject({ profiles: z.array(ApprovalProfileV1Schema) })])),
  'actions.policy.set': lazyZodSchema(() => z.union([result, changed, profileChange])),
  'actions.policy.reset': result,
} as const;
export type ActionAudiencePolicyResult = z.infer<typeof result>;
export type ActionPolicySetInput = z.infer<typeof ActionPolicyInputSchemas['actions.policy.set']>;
export type ActionPolicySetResult = z.infer<typeof ActionPolicyOutputSchemas['actions.policy.set']>;
