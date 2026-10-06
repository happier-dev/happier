import { pluginPermissionSubjectsEqualV1 } from '@happier-dev/protocol/plugins/permissions/grants';
import type { PluginPermissionCapabilityV1, PluginPermissionGrantAuthoritySourceV1, PluginPermissionGrantTargetScopeV1, PluginPermissionGrantV1, PluginPermissionSubjectV1 } from '@happier-dev/protocol';

function targetScopeMatches(
  left: PluginPermissionGrantTargetScopeV1,
  right: PluginPermissionGrantTargetScopeV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'project' && right.kind === 'project') return left.projectId === right.projectId;
  if (left.kind === 'workspace' && right.kind === 'workspace') return left.workspaceId === right.workspaceId;
  return left.kind === 'account' && right.kind === 'account';
}

/**
 * A grant records the exact machine installation whose person approved it. The
 * same Account, plugin, capability, scope and subject can be reached from every
 * other machine on the Account, so an Account-wide match alone would let one
 * machine's approval authorize every other machine and any later installation
 * that replaced the approved one.
 */
function authoritySourceMatches(
  granted: PluginPermissionGrantAuthoritySourceV1,
  current: PluginPermissionGrantAuthoritySourceV1 | null,
): boolean {
  if (!current || granted.kind !== current.kind) return false;
  if (granted.kind !== 'machine_installation' || current.kind !== 'machine_installation') {
    return false;
  }
  return granted.machineId === current.machineId
    && granted.installationId === current.installationId;
}

/** The single CLI-side exact evaluator for persisted plugin permission grants. */
export function evaluatePluginPermissionGrant(params: Readonly<{
  grant: PluginPermissionGrantV1;
  pluginId: string;
  capability: PluginPermissionCapabilityV1;
  targetScope: PluginPermissionGrantTargetScopeV1;
  subject: PluginPermissionSubjectV1;
  /** Exact machine installation asking now; a missing authority is never authorized. */
  currentAuthoritySource: PluginPermissionGrantAuthoritySourceV1 | null;
}>): boolean {
  if (
    params.grant.status !== 'active'
    || params.grant.pluginId !== params.pluginId
    || params.grant.capability !== params.capability
    || !targetScopeMatches(params.grant.targetScope, params.targetScope)
    || !authoritySourceMatches(params.grant.authoritySource, params.currentAuthoritySource)
    || !pluginPermissionSubjectsEqualV1(params.grant.subject, params.subject)
  ) {
    return false;
  }
  return true;
}
