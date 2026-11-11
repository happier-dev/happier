import {
  resolveManagedSessionDefaults,
  projectManagedSessionDefaultsLayers,
  type ManagedConnectedServiceDefaultV1,
  type ManagedDefaultsV1,
  type ManagedSessionDefaultsV1,
  type ManagedSessionPlacementV1,
  type TeamCapabilitiesV1,
  type TeamPolicySetInputV1,
} from '@happier-dev/protocol/teams';
import { qualifiedPurposeKey } from '@happier-dev/protocol/connect/connectedAccountPurposeBindings';
import type { AgentPermissionIntentV1 } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { SessionModelSelectionV1 } from '@happier-dev/protocol/providers/selection/v1';
import type { SessionModelSelectionV2 } from '@happier-dev/protocol/providers/selection/v2';

/**
 * Whose defaults a "Defaults for members" section edits. The Team's own layer, or
 * one Group's layer; both live in the one Team document `teams.policy.set` writes.
 */
export type MemberDefaultsScope =
  | Readonly<{ kind: 'team' }>
  | Readonly<{ kind: 'group'; groupId: string }>;

type ModelDefault = SessionModelSelectionV1 | SessionModelSelectionV2;
type MemberDefaultsPatch = Pick<
  TeamPolicySetInputV1,
  'managedDefaults' | 'managedGroupDefaults'
>;

const NO_DEFAULTS: ManagedSessionDefaultsV1 = Object.freeze({});

/** The layer this scope edits, or no defaults ("None" on every row). */
export function readMemberDefaults(
  stored: ManagedDefaultsV1 | null | undefined,
  scope: MemberDefaultsScope,
): ManagedSessionDefaultsV1 {
  const layer =
    scope.kind === 'team' ? stored?.team : stored?.groups[scope.groupId];
  return layer ?? NO_DEFAULTS;
}

function withAgentEntry<
  K extends
    | 'permissionModeByAgentTargetKey'
    | 'modelByAgentTargetKey'
    | 'connectedServicesByAgentTargetKey',
>(
  defaults: ManagedSessionDefaultsV1,
  field: K,
  agentTargetKey: string,
  value: NonNullable<ManagedSessionDefaultsV1[K]>[string] | undefined,
): ManagedSessionDefaultsV1 {
  const { [agentTargetKey]: _previous, ...others } = (defaults[field] ??
    {}) as Record<string, unknown>;
  const entries =
    value === undefined ? others : { ...others, [agentTargetKey]: value };
  const { [field]: _field, ...rest } = defaults;
  // An empty record is the same answer as no record: keep the stored document minimal.
  return Object.keys(entries).length === 0
    ? rest
    : { ...rest, [field]: entries };
}

export function withPlacement(
  defaults: ManagedSessionDefaultsV1,
  placement: ManagedSessionPlacementV1 | undefined,
): ManagedSessionDefaultsV1 {
  const { placement: _previous, ...rest } = defaults;
  return placement === undefined ? rest : { ...rest, placement };
}

export function withPermissionMode(
  defaults: ManagedSessionDefaultsV1,
  agentTargetKey: string,
  mode: AgentPermissionIntentV1 | undefined,
): ManagedSessionDefaultsV1 {
  return withAgentEntry(
    defaults,
    'permissionModeByAgentTargetKey',
    agentTargetKey,
    mode,
  );
}

export function withModel(
  defaults: ManagedSessionDefaultsV1,
  agentTargetKey: string,
  model: ModelDefault | undefined,
): ManagedSessionDefaultsV1 {
  return withAgentEntry(
    defaults,
    'modelByAgentTargetKey',
    agentTargetKey,
    model,
  );
}

/** Sets or clears one qualified purpose's default for an Agent; other purposes keep theirs. */
export function withConnectedService(
  defaults: ManagedSessionDefaultsV1,
  agentTargetKey: string,
  purposeKey: string,
  binding: ManagedConnectedServiceDefaultV1 | null,
): ManagedSessionDefaultsV1 {
  const others = (
    defaults.connectedServicesByAgentTargetKey?.[agentTargetKey] ?? []
  ).filter((entry) => qualifiedPurposeKey(entry.purpose) !== purposeKey);
  const next = binding ? [...others, binding] : others;
  return withAgentEntry(
    defaults,
    'connectedServicesByAgentTargetKey',
    agentTargetKey,
    next.length > 0 ? next : undefined,
  );
}

/**
 * The `teams.policy.set` input for one edit. A Team edit replaces the whole
 * document and carries every Group layer unchanged (its editor reads them all);
 * a Group edit sends only that Group's layer, and an emptied layer is removed.
 */
export function buildMemberDefaultsPatch(
  stored: ManagedDefaultsV1 | null | undefined,
  scope: MemberDefaultsScope,
  next: ManagedSessionDefaultsV1,
): MemberDefaultsPatch {
  if (scope.kind === 'team') {
    return { managedDefaults: { team: next, groups: stored?.groups ?? {} } };
  }
  return {
    managedGroupDefaults: {
      teamGroupId: scope.groupId,
      defaults: Object.keys(next).length === 0 ? null : next,
    },
  };
}

export type MemberDefaultsAccess =
  | Readonly<{ editable: true }>
  | Readonly<{ editable: false; reason: 'team' | 'group' }>;

/**
 * Who may change these, as the Home decides it for `teams.policy.set`: Team
 * defaults need `manageSettings`; a Group's need `manageGroups` and management
 * of that Group's own roster.
 */
export function memberDefaultsAccess(
  scope: MemberDefaultsScope,
  team: Pick<TeamCapabilitiesV1, 'manageSettings' | 'manageGroups'>,
  group?: Readonly<{ manageNativeMembers: boolean }>,
): MemberDefaultsAccess {
  if (scope.kind === 'team')
    return team.manageSettings
      ? { editable: true }
      : { editable: false, reason: 'team' };
  return team.manageGroups && group?.manageNativeMembers === true
    ? { editable: true }
    : { editable: false, reason: 'group' };
}

export type MemberDefaultsConflicts = Readonly<{
  placement: boolean;
  permissionMode: boolean;
  model: boolean;
  /** Qualified purpose keys whose Group defaults disagree. */
  connectedServices: ReadonlySet<string>;
}>;

/**
 * Where Groups disagree, read through the one precedence owner: a member in
 * Groups that disagree starts from the next layer instead. On a Group page the
 * question is whether this Group disagrees with any other.
 */
export function memberDefaultsConflicts(
  stored: ManagedDefaultsV1 | null | undefined,
  scope: MemberDefaultsScope,
  agentTargetKey: string,
  homeDefaults?: ManagedSessionDefaultsV1 | null,
): MemberDefaultsConflicts {
  const groupIds = Object.keys(stored?.groups ?? {});
  const comparisons =
    scope.kind === 'team'
      ? [groupIds]
      : groupIds
          .filter((id) => id !== scope.groupId)
          .map((other) => [scope.groupId, other]);
  let placement = false;
  let permissionMode = false;
  let model = false;
  const connectedServices = new Set<string>();
  for (const ids of comparisons) {
    const resolved = resolveManagedSessionDefaults({
      teamDefaults: stored ?? null,
      homeDefaults,
      groupIds: ids,
      agentTargetKey,
    });
    placement ||= resolved.placement.groupConflict;
    permissionMode ||= resolved.permissionMode.groupConflict;
    model ||= resolved.model.groupConflict;
    // The reader answers one decision per purpose, in sorted purpose-key order over the
    // layers it was given (here these Groups and the Team). A disagreeing purpose can fall
    // through to no value, so its key is read from that same order.
    const purposeKeys = projectManagedSessionDefaultsLayers({
      teamDefaults: stored ?? null,
      homeDefaults,
      groupIds: ids,
      agentTargetKey,
    }).purposeKeys;
    resolved.connectedServices.forEach((decision, index) => {
      const key = purposeKeys[index];
      if (decision.groupConflict && key) connectedServices.add(key);
    });
  }
  return { placement, permissionMode, model, connectedServices };
}
