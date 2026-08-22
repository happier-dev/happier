import {
  PluginPermissionSubjectV1Schema,
  type PluginInstallReviewPrincipalDigest,
  type PluginPermissionCapabilityV1,
  type PluginPermissionGrantAuthoritySourceV1,
  type PluginPermissionGrantTargetScopeV1,
  type PluginPermissionGrantV1,
  type PluginPermissionSubjectV1,
} from '@happier-dev/protocol';

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

function subjectMatches(
  leftInput: PluginPermissionSubjectV1,
  rightInput: PluginPermissionSubjectV1,
): boolean {
  const left = PluginPermissionSubjectV1Schema.parse(leftInput);
  const right = PluginPermissionSubjectV1Schema.parse(rightInput);
  if (left.kind !== right.kind) return false;
  if (left.kind === 'general' && right.kind === 'general') return true;
  if (left.kind !== 'credential_access_disclosure' || right.kind !== 'credential_access_disclosure') {
    return false;
  }
  return left.contribution.pluginId === right.contribution.pluginId
    && left.contribution.localId === right.contribution.localId
    && left.credentialSlotId === right.credentialSlotId
    && left.purpose === right.purpose
    && left.accessDeclarationDigest === right.accessDeclarationDigest
    && left.selectedAuthorityDigest === right.selectedAuthorityDigest
    && left.selectedRawAccessDigest === right.selectedRawAccessDigest
    && left.installedGenerationId === right.installedGenerationId
    && left.installReviewPrincipalDigest === right.installReviewPrincipalDigest;
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
  currentInstallReviewPrincipalDigest?: PluginInstallReviewPrincipalDigest;
}>): boolean {
  if (
    params.grant.status !== 'active'
    || params.grant.pluginId !== params.pluginId
    || params.grant.capability !== params.capability
    || !targetScopeMatches(params.grant.targetScope, params.targetScope)
    || !authoritySourceMatches(params.grant.authoritySource, params.currentAuthoritySource)
    || !subjectMatches(params.grant.subject, params.subject)
  ) {
    return false;
  }
  if (params.grant.subject.kind === 'general') return true;
  return params.currentInstallReviewPrincipalDigest !== undefined
    && params.grant.subject.installReviewPrincipalDigest === params.currentInstallReviewPrincipalDigest;
}
