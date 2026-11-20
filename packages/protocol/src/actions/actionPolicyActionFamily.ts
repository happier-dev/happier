import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ApprovalProfileIdV1Schema } from './approvalProfileIdV1.js';
import { ApprovalProfileArtifactChangeV1Schema, ApprovalProfileArtifactChangeResultV1Schema,
  ReadableApprovalProfileV1Schema } from './approvalProfileArtifactV1.js';
import { ActionSurfaceSchema, ActionToolExposureModeSchema, ActionToolExposureSurfaceSchema } from './metadata.js';
import { ActionUiPlacementSchema } from './actionUiPlacements.js';
import { ActionApprovalScopeV1Schema, ActionPolicyAudienceV1Schema, normalizeActionSettingsActionId } from './actionSettings.js';
import { SessionApprovalConsentRowV1Schema } from './sessionApprovalConsentsV1.js';
export { ACTION_POLICY_ACTION_IDS, isActionPolicyActionId, type ActionPolicyActionId } from './actionPolicyActionIds.js';

export type ActionAudiencePolicyMode = 'allowed' | 'ask_first' | 'off' | 'default';
const actionId = lazyZodSchema(() => z.string().check(z.refine(value => normalizeActionSettingsActionId(value) === value)));
const target = { actionId, audience: ActionPolicyAudienceV1Schema };
const mode = lazyZodSchema(() => z.enum(['allowed', 'ask_first', 'off', 'default']));
const scopedTarget = { ...target, audience: lazyZodSchema(() => z.keyof(ActionSurfaceSchema)), scope: ActionApprovalScopeV1Schema };
/** "Allow for this Session": the caller names the Session; the server admits only its owner's writes. */
const session = lazyZodSchema(() => z.strictObject({ sessionId: z.string().check(z.trim(), z.minLength(1)) }));
const sessionTarget = { actionId, audience: lazyZodSchema(() => z.keyof(ActionSurfaceSchema)), session,
  scope: z.optional(ActionApprovalScopeV1Schema) };
const sessionMode = lazyZodSchema(() => z.enum(['allowed', 'ask_first', 'default']));
const sessionList = lazyZodSchema(() => z.strictObject({ session }));
/** Continue after a failed resume moves the source Session's rows to the new Session. */
const sessionMoveTarget = lazyZodSchema(() => z.strictObject({
  fromSessionId: z.string().check(z.trim(), z.minLength(1)), toSessionId: z.string().check(z.trim(), z.minLength(1)) }));
const sessionMove = lazyZodSchema(() => z.strictObject({ sessionConsentsMove: sessionMoveTarget }));
const selectedTarget = lazyZodSchema(() => z.union([z.strictObject(target), z.strictObject(scopedTarget), z.strictObject(sessionTarget)]));
const result = lazyZodSchema(() => z.strictObject({ ...target, scope: z.optional(ActionApprovalScopeV1Schema), mode, actionEnabled: z.boolean(), enabled: z.boolean() }));
const sessionResult = lazyZodSchema(() => z.strictObject({ ...sessionTarget, mode: sessionMode }));
const sessionRows = lazyZodSchema(() => z.strictObject({ session, rows: z.array(SessionApprovalConsentRowV1Schema) }));
const sessionMoved = lazyZodSchema(() => z.strictObject({ sessionConsentsMove: sessionMoveTarget, moved: z.boolean() }));
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
const machineDefault = lazyZodSchema(() =>
  /** The person's profile for their own Sessions on one Machine; null follows Account settings. */
  z.strictObject({ kind: z.literal('machine_default'), machineId: z.string().check(z.trim(), z.minLength(1)),
    id: z.nullable(ApprovalProfileIdV1Schema) }));
const profileChange = lazyZodSchema(() => z.strictObject({ profileChange: z.union([
  ApprovalProfileArtifactChangeV1Schema, machineDefault,
]) }));
export const ActionPolicyInputSchemas = {
  'actions.policy.get': lazyZodSchema(() => z.union([selectedTarget, z.strictObject({ profiles: z.literal(true) }), sessionList])),
  'actions.policy.set': lazyZodSchema(() => z.union([z.strictObject({ ...target, mode }),
    z.strictObject({ ...scopedTarget, mode: z.enum(['allowed', 'ask_first', 'default']) }),
    z.strictObject({ ...sessionTarget, mode: sessionMode }), sessionMove, changed, profileChange])),
  'actions.policy.reset': selectedTarget,
} as const;
export const ActionPolicyOutputSchemas = {
  'actions.policy.get': lazyZodSchema(() => z.union([result, z.strictObject({ profiles: z.array(ReadableApprovalProfileV1Schema) }),
    sessionResult, sessionRows])),
  'actions.policy.set': lazyZodSchema(() => z.union([result, sessionResult, sessionMoved, changed,
    z.strictObject({ profileChange: z.union([ApprovalProfileArtifactChangeResultV1Schema, machineDefault]) })])),
  'actions.policy.reset': lazyZodSchema(() => z.union([result, sessionResult])),
} as const;
export type ActionAudiencePolicyResult = z.infer<typeof result>;
export type ActionPolicySetInput = z.infer<typeof ActionPolicyInputSchemas['actions.policy.set']>;
export type ActionPolicySetResult = z.infer<typeof ActionPolicyOutputSchemas['actions.policy.set']>;
export type ActionPolicyGetInput = z.infer<typeof ActionPolicyInputSchemas['actions.policy.get']>;
export type ActionPolicyResetInput = z.infer<typeof ActionPolicyInputSchemas['actions.policy.reset']>;
