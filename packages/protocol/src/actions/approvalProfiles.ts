import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { ActionSurfaceSchema } from './metadata.js';
import { isActionEnabledByActionsSettings, setActionApprovalOverride, setScopedActionApprovalPreference, tightenActionsSettingsV1,
  type ActionSettingsActionId, type ActionSettingsOverride, type ActionsSettingsV1 } from './actionSettings.js';
import { readExplicitActionApprovalPreferenceFromSettingsV1 } from './actionApprovalPreference.js';
import { isDelegatedActionRequesterV1 } from './delegatedRequesterV1.js';
import type { ActionApprovalPolicyScopeV1 } from './actionApprovalPolicy.js';
import type { ActionExecutorContext } from './executor/types.js';
import type { DatabaseAgentLevelV1 } from '../deployments/deploymentEnvironmentDeployerV1.js';
import type { ArtifactCallerAccessV1 } from '../artifacts/artifactAccessV1.js';
import { isDiscussionInviteActionIdV1 } from '../discussions/actionIds.js';

import { ApprovalProfileIdV1Schema } from './approvalProfileIdV1.js';
export { ApprovalProfileIdV1Schema } from './approvalProfileIdV1.js';
const ApprovalProfileSurfaceListV1Schema = lazyZodSchema(() => z.array(z.keyof(ActionSurfaceSchema)));
export type ApprovalProfileMergeModeV1 = 'full' | 'tighten-only';

/**
 * The Account Approval-settings policy fields of one Action. Placements and tool exposure
 * stay Account UI, so a stored row keeps only these keys.
 */
export const ApprovalProfileActionRowV1Schema = lazyZodSchema(() => z.strictObject({
  enabled: z.optional(z.boolean()),
  disabledSurfaces: z.optional(ApprovalProfileSurfaceListV1Schema),
  approvalRequiredSurfaces: z.optional(ApprovalProfileSurfaceListV1Schema),
}));
/**
 * A named per-Action overlay opened from an approval-profile Artifact,
 * never authority or a copy carried by a Session. Only Actions the person changed are stored.
 * Strict, so a row in any other shape (such as a pre-overlay `defaultMode` policy) is unusable
 * rather than read as an empty overlay that silently follows the Account settings.
 */
export const ApprovalProfileV1Schema = lazyZodSchema(() => z.strictObject({
  id: ApprovalProfileIdV1Schema,
  name: z.string().check(z.trim(), z.minLength(1)),
  actions: z.optional(z.record(z.string(), ApprovalProfileActionRowV1Schema)),
  approvalWaivedSurfaces: z.optional(z.record(z.string(), ApprovalProfileSurfaceListV1Schema)),
}));
export type ApprovalProfileV1 = z.infer<typeof ApprovalProfileV1Schema>;
export type ApprovalProfileActionRowV1 = z.infer<typeof ApprovalProfileActionRowV1Schema>;

export function resolveInheritedApprovalProfileIdV1(
  requestedId: string | null | undefined,
  inheritedId: string | null | undefined,
): string | null {
  return requestedId === undefined ? inheritedId ?? null : requestedId;
}

export const ApprovalProfileResolutionV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['available', 'missing']),
  requestedId: ApprovalProfileIdV1Schema,
}));
export type ApprovalProfileResolutionV1 = Readonly<z.infer<typeof ApprovalProfileResolutionV1Schema>>;

/** The opened Artifact catalog row; access is decided by the Artifact transport. */
export type ReadableApprovalProfileV1 = Readonly<{
  id: string;
  profile: ApprovalProfileV1;
  access: ArtifactCallerAccessV1;
  ownerAccountId?: string;
  ownerDisplayName?: string | null;
  revision: Readonly<{ headerVersion: number; bodyVersion: number }>;
}>;

/** One host-bound lookup, consumed by all admission and advertisement policy readers. */
export type BoundApprovalProfileV1 = Readonly<{
  profile: ApprovalProfileV1 | null;
  resolution: ApprovalProfileResolutionV1;
}>;

/**
 * The Session's captured choice. Machine defaults are resolved only when creating a root.
 */
export function resolveSessionApprovalProfileReferenceV1(
  metadata: Readonly<{ approvalProfileId?: unknown }>,
): string | null {
  const own = ApprovalProfileIdV1Schema.safeParse(metadata.approvalProfileId);
  if (own.success) return own.data;
  return null;
}

const EMPTY_ACTION_ROW: ActionSettingsOverride = Object.freeze({ enabledPlacements: [], disabledPlacements: [],
  disabledSurfaces: [], approvalRequiredSurfaces: [], toolExposureModes: {} });

/**
 * For each Action the profile names, its row and waiver list replace the Account's policy for
 * that Action; Account placements, tool exposure and every other Action stay as they are.
 * The routing owner then evaluates the merged settings with its usual floors.
 */
export function applyApprovalProfileOverlayV1(settings: ActionsSettingsV1, profile: ApprovalProfileV1,
  mode: ApprovalProfileMergeModeV1 = 'full'): ActionsSettingsV1 {
  const ids = new Set([...Object.keys(profile.actions ?? {}),
    ...(mode === 'full' ? Object.keys(profile.approvalWaivedSurfaces ?? {}) : [])]);
  if (ids.size === 0) return settings;
  const actions = { ...settings.actions };
  const waivers = { ...settings.approvalWaivedSurfaces };
  for (const id of ids) {
    const row = profile.actions?.[id];
    if (mode === 'tighten-only') {
      const base = settings.actions[id] ?? EMPTY_ACTION_ROW;
      const approvalRequiredSurfaces = [...new Set([...base.approvalRequiredSurfaces, ...row?.approvalRequiredSurfaces ?? []])];
      actions[id] = { ...base,
        ...(row?.enabled === false ? { enabled: false } : {}),
        disabledSurfaces: [...new Set([...base.disabledSurfaces, ...row?.disabledSurfaces ?? []])],
        approvalRequiredSurfaces };
      const waived = waivers[id]?.filter(surface => !approvalRequiredSurfaces.includes(surface));
      if (waived?.length) waivers[id] = waived;
      else delete waivers[id];
      continue;
    }
    const { enabled: _accountEnabled, ...base } = settings.actions[id] ?? EMPTY_ACTION_ROW;
    actions[id] = { ...base, ...(row?.enabled === undefined ? {} : { enabled: row.enabled }),
      disabledSurfaces: row?.disabledSurfaces ?? [], approvalRequiredSurfaces: row?.approvalRequiredSurfaces ?? [] };
    const waived = profile.approvalWaivedSurfaces?.[id];
    if (waived?.length) waivers[id] = waived;
    else delete waivers[id];
  }
  const { approvalWaivedSurfaces: _accountWaivers, ...rest } = settings;
  return { ...rest, actions, ...(Object.keys(waivers).length > 0 ? { approvalWaivedSurfaces: waivers } : {}) };
}

/** A target policy already admitted by its owning domain, not a second target-access decision. */
export type ActionTargetApprovalV1 = Readonly<{
  actionId: ActionSettingsActionId;
  databaseAgentLevel: DatabaseAgentLevelV1;
  approvalScope?: ActionApprovalPolicyScopeV1;
}>;

export type ProfiledActionsSettingsOptionsV1 = Readonly<{
  actionId?: string;
  /** Already resolved by the host catalog once for this invocation. */
  boundProfile?: BoundApprovalProfileV1 | null;
  /** Produced once by the creation-default resolver; an explicit pick clears this bit. */
  approvalProfileTeamOrGroupDerived?: boolean;
  context?: Pick<ActionExecutorContext, 'surface' | 'callerSurface' | 'actionCaller' | 'actionsSettings' | 'authority'>;
  targetApproval?: ActionTargetApprovalV1;
}>;

function applyAdmittedTargetApproval(account: ActionsSettingsV1, profiled: ActionsSettingsV1,
  options: ProfiledActionsSettingsOptionsV1): ActionsSettingsV1 {
  const target = options.targetApproval;
  const surface = options.context?.surface;
  // The same delegated-requester fact the database access decider admits agents by (SEC-1117 M1).
  if (!target || !surface || !isDelegatedActionRequesterV1(options.context ?? {})
    || (target.databaseAgentLevel !== 'readWriteAsk' && target.databaseAgentLevel !== 'readWriteNoApproval')) return profiled;
  const ownAsk = readExplicitActionApprovalPreferenceFromSettingsV1(target.actionId, account, options.context, target.approvalScope) === true;
  const required = target.databaseAgentLevel === 'readWriteAsk' || ownAsk;
  // Project onto the same effective scope the preference reader consumes. This is
  // an invocation-local overlay; inherited template identity is never persisted
  // as part of a child preference.
  const scope = target.approvalScope?.kind === 'environment'
    ? { kind: 'environment' as const,
      environmentId: target.approvalScope.inheritedEnvironmentId ?? target.approvalScope.environmentId }
    : target.approvalScope;
  let settings = scope
    ? setScopedActionApprovalPreference({ settings: profiled, actionId: target.actionId, scope,
      surface, mode: required ? 'required' : 'waived' })
    : setActionApprovalOverride({ settings: profiled, actionId: target.actionId, surface, approvalRequired: required });
  // A target's no-approval choice never turns on what this person explicitly turned off,
  // even when a picked profile otherwise replaces the Account's row.
  if (!isActionEnabledByActionsSettings(target.actionId, account, { surface })) {
    const row = settings.actions[target.actionId] ?? EMPTY_ACTION_ROW;
    settings = { ...settings, actions: { ...settings.actions, [target.actionId]: { ...row,
      ...(account.actions[target.actionId]?.enabled === false ? { enabled: false } : {}),
      disabledSurfaces: [...new Set([...row.disabledSurfaces, surface])] } } };
  }
  return settings;
}

/** The settings an invocation with this profile reference is decided on, and the visible resolution. */
export function resolveProfiledActionsSettingsV1(settings: ActionsSettingsV1, approvalProfileId: string | null | undefined,
  options: ProfiledActionsSettingsOptionsV1 = {}):
  Readonly<{ settings: ActionsSettingsV1; profile?: ApprovalProfileResolutionV1 }> {
  const selected = options.boundProfile !== undefined ? options.boundProfile
    : approvalProfileId ? { profile: null, resolution: { status: 'missing' as const, requestedId: approvalProfileId } } : undefined;
  const profiled = selected?.profile ? applyApprovalProfileOverlayV1(settings, selected.profile,
    options.approvalProfileTeamOrGroupDerived === true ? 'tighten-only' : 'full') : settings;
  const effective = applyAdmittedTargetApproval(settings, profiled, options);
  const context = options.context;
  const retainedInvitationPolicy = options.actionId && isDiscussionInviteActionIdV1(options.actionId)
    && context?.actionCaller?.kind === 'workflowRun' && context.actionCaller.discussionModelReservation !== undefined
    ? context.actionsSettings : undefined;
  return { settings: retainedInvitationPolicy ? tightenActionsSettingsV1(retainedInvitationPolicy, effective) : effective,
    ...(selected ? { profile: selected.resolution } : {}) };
}
