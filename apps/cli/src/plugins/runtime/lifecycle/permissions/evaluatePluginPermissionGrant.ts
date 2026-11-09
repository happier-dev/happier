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
 * One approval covers every Machine and installation of the same Account (owner
 * ruling PL-19, 2026-10-30). The server lists only the asking Account's grants,
 * so another person's grant never reaches this evaluator. The grant keeps the
 * approving installation as provenance; the asking daemon must still be an
 * identified installation of that Account.
 */
function authoritySourceMatches(
  granted: PluginPermissionGrantAuthoritySourceV1,
  current: PluginPermissionGrantAuthoritySourceV1 | null,
): boolean {
  return granted.kind === 'machine_installation' && current?.kind === 'machine_installation';
}

/** The single CLI-side exact evaluator for persisted plugin permission grants. */
export function evaluatePluginPermissionGrant(params: Readonly<{
  grant: PluginPermissionGrantV1;
  pluginId: string;
  capability: PluginPermissionCapabilityV1;
  targetScope: PluginPermissionGrantTargetScopeV1;
  subject: PluginPermissionSubjectV1;
  /** The identified machine installation asking now; a missing authority is never authorized. */
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
