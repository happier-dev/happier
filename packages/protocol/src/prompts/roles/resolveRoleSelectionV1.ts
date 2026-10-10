import type { RoleArtifactV1, RoleEngineV1 } from './roleArtifactV1.js';
import type { PluginRoleContributionV1, RoleInstructionsOverrideV1, RoleOverrideV1, WorkflowRoleV1, ResolvedRoleV1 } from './rolesV1.js';
import { readSessionRolesV1, type SessionRolesV1 } from './sessionRolesSnapshot.js';
import { BUILT_IN_ROLES_V1 } from './builtInRolesV1.js';
import { ResolvedRoleV1Schema, type RoleResolutionLayerV1 } from './rolesV1.js';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '../../backends/targets/backendTargetRefV2.js';
import type { RoleSourceInventoryV1 } from './accountRoleActions.js';

export type ResolveRoleSelectionV1Input = Readonly<{
  roleId: string;
  roleSourceInventory?: RoleSourceInventoryV1;
  settingsRoles?: Readonly<Record<string, RoleArtifactV1>>;
  settingsOverrides?: Readonly<Record<string, RoleInstructionsOverrideV1>>;
  pluginRoles?: readonly PluginRoleContributionV1[];
  sessionRoles?: SessionRolesV1;
  workflowRoles?: readonly WorkflowRoleV1[];
  runOverrides?: readonly RoleOverrideV1[];
  defaultEngine?: RoleEngineV1;
  availableAgentTargetKeys?: readonly string[];
  availableProfileIds?: readonly string[];
}>;
export type RoleSelectionRefusalV1 = Readonly<{ code: 'role_target_unavailable' | 'role_source_incomplete' | 'target_unavailable'; roleId: string; agentTargetKey?: string }>;
export type ResolveRoleSelectionV1Result = Readonly<{ ok: true; selection: ResolvedRoleV1 }> | Readonly<{ ok: false; refusal: RoleSelectionRefusalV1 }>;

/** A role adds a workspace ceiling; it never changes permission mode or grants coordination authority. */
export function readSessionWorkspaceWritesV1(
  metadata: unknown,
  layers: Omit<ResolveRoleSelectionV1Input, 'roleId' | 'sessionRoles'> = {},
): 'allow' | 'deny' | undefined {
  const sessionRoles = readSessionRolesV1(metadata);
  if (!sessionRoles) {
    if (metadata && typeof metadata === 'object' && 'work' in metadata
      && metadata.work && typeof metadata.work === 'object' && 'sessionRolesV1' in metadata.work) return 'deny';
    return undefined;
  }
  if (!sessionRoles.roleId) return undefined;
  const role = resolveRoleSelectionV1({ ...layers, roleId: sessionRoles.roleId, sessionRoles });
  return role.ok ? role.selection.workspaceWrites : 'deny';
}

export function resolveRoleSelectionV1(input: ResolveRoleSelectionV1Input): ResolveRoleSelectionV1Result {
  const builtIn = Object.hasOwn(BUILT_IN_ROLES_V1, input.roleId)
    ? BUILT_IN_ROLES_V1[input.roleId as keyof typeof BUILT_IN_ROLES_V1]
    : undefined;
  const plugin = input.pluginRoles?.find((entry) => `plugin:${entry.pluginId}/${entry.localId}` === input.roleId)?.role;
  const source = builtIn ?? (input.roleSourceInventory
    ? input.roleSourceInventory.entries.find(entry => entry.roleId === input.roleId)?.role
    : input.settingsRoles?.[input.roleId] ?? plugin);
  const inherited = input.sessionRoles?.sessionRoles[input.roleId];
  const pin = input.workflowRoles?.find((entry) => entry.roleId === input.roleId);
  if (!source && input.roleSourceInventory?.status === 'partial'
    && inherited?.roleId !== input.roleId && !(pin && 'name' in pin && 'instructions' in pin)) {
    return { ok: false, refusal: { code: 'role_source_incomplete', roleId: input.roleId } };
  }
  let selection: Partial<ResolvedRoleV1> = source ? { ...source } : {};
  let changedAt: RoleResolutionLayerV1 | undefined;
  const apply = (value: Partial<RoleArtifactV1> & { instructionsOverride?: string }, layer: RoleResolutionLayerV1) => {
    // Undefined means fall through, not erase. An engine is one role field: its
    // model and effort must never be silently borrowed from a different target.
    for (const field of ['name', 'instructions', 'engine', 'runsAs', 'profileId', 'workspaceWrites', 'secondOpinion', 'enabled'] as const) {
      if (value[field] !== undefined) {
        selection = { ...selection, [field]: value[field] };
        changedAt = layer;
      }
    }
    if (value.instructionsOverride !== undefined) {
      selection.instructions = value.instructionsOverride;
      changedAt = layer;
    }
  };
  const settingsOverride = input.settingsOverrides?.[input.roleId];
  if (settingsOverride?.roleId === input.roleId) apply(settingsOverride, 'settings');
  if (inherited?.roleId === input.roleId) apply(inherited, 'session');
  const sessionOverride = input.sessionRoles?.overrides[input.roleId];
  if (sessionOverride?.roleId === input.roleId) apply(sessionOverride, 'session');
  if (pin) apply(pin, 'workflow');
  const run = input.runOverrides?.find((entry) => entry.roleId === input.roleId);
  if (run) apply(run, 'run');
  let defaultEngine = input.defaultEngine;
  if (input.roleId === 'second_opinion' && selection.engine === undefined && defaultEngine) {
    // Configured variants of one Agent are the same family. The host supplies
    // enabled inventory order; changing Agent must not carry its caller's model.
    const family = (key: string) => {
      const target = parseBackendTargetKeyV2(key);
      return target.kind === 'agent' ? buildBackendTargetKeyV2(target)
        : buildBackendTargetKeyV2({ kind: 'backend', backendId: target.backendId });
    };
    const callerFamily = family(defaultEngine.agentTargetKey);
    const alternative = input.availableAgentTargetKeys?.find((key) => family(key) !== callerFamily);
    if (alternative) defaultEngine = { agentTargetKey: alternative };
  }
  const parsed = ResolvedRoleV1Schema.safeParse({
    enabled: true, workspaceWrites: 'allow', secondOpinion: 'off',
    ...selection, roleId: input.roleId,
    ...(selection.engine === undefined && defaultEngine ? { engine: defaultEngine } : {}),
    ...(changedAt ? { changedAt } : {}),
  });
  if (!parsed.success || !parsed.data.enabled) {
    return { ok: false, refusal: { code: 'role_target_unavailable', roleId: input.roleId } };
  }
  const role = parsed.data;
  if (input.availableAgentTargetKeys && (!role.engine || !input.availableAgentTargetKeys.includes(role.engine.agentTargetKey))) {
    return { ok: false, refusal: { code: 'target_unavailable', roleId: input.roleId, ...(role.engine ? { agentTargetKey: role.engine.agentTargetKey } : {}) } };
  }
  if (role.profileId && input.availableProfileIds && !input.availableProfileIds.includes(role.profileId)) role.profileUnavailable = true;
  return { ok: true, selection: role };
}
