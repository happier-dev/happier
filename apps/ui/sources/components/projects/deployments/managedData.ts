import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { readDeploymentTargetActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import { DeploymentTargetPreparationBaseV1Schema, DeploymentTargetLinkProviderContentV1Schema,
  DeploymentTargetRoleInputProtocolSchemasV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readPluginActionCredentialPurposeV1 } from '@happier-dev/deployments';
import { readTeardownConsequence, type DeploymentPlatformTarget } from './platformTargetLink';

const roleInputSchemas = new Map(Object.entries(DeploymentTargetRoleInputProtocolSchemasV1));

/** Data operations come from the same role traversal that admits their execution. */
export function managedDataTargets(declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[]) {
  return declarations.flatMap(({ manifest }) => (manifest.contributes.deploymentTargets ?? []).flatMap(target => {
    if (target.role !== 'data') return [];
    const operations = readDeploymentTargetActionRolesV1(target).flatMap(binding => {
      if (binding.role === 'projects.delete' || binding.role === 'projects.observe') return [];
      const action = manifest.contributes.actions?.find(value => value.id === binding.action);
      if (!action) return [];
      const hints = normalizePluginActionInputHintsV2(action.inputHints, action.inputSchema);
      const protocolFields = roleInputSchemas.get(binding.role)?.jsonSchema.properties ?? {};
      return [{ ...binding, declaration: action, credential: readPluginActionCredentialPurposeV1(manifest, action.id), title: resolvePluginLocalizedStringV2Text(action.title),
        actionId: formatQualifiedPluginActionId({ pluginId: manifest.id, localId: action.id }),
        inputHints: { ...hints, fields: (hints?.fields ?? []).filter(field => {
          const root = field.path.split('.')[0]!;
          // Custody, paging and request identity come from the host operation, never editable form operands.
          return field.path === 'providerAccountId' || (root !== 'requestKey'
            && !Object.hasOwn(DeploymentTargetPreparationBaseV1Schema.shape, root)
            && !Object.hasOwn(protocolFields, root));
        }) } }];
    });
    // The same delete metadata a runtime platform target carries: whether delete is declared, and its own words.
    const removal: Pick<DeploymentPlatformTarget, 'teardown' | 'teardownConsequence'> = target.dataV1?.projects?.delete
      ? { teardown: true, ...readTeardownConsequence(manifest.contributes.actions ?? [], target.dataV1.projects.delete) } : {};
    return [{ key: `${manifest.id}/${target.id}`, pluginId: manifest.id, targetId: target.id, target, ...removal,
      title: resolvePluginLocalizedStringV2Text(target.title), operations }];
  }));
}

export type ManagedDataTarget = ReturnType<typeof managedDataTargets>[number];
export type ManagedDataOperation = ManagedDataTarget['operations'][number];

export function readManagedDataAdoptionReceipt(value: unknown) {
  if (!isRecord(value) || value.status !== 'adoption_required') return null;
  const { workflowId, workspaceId, projectId, railwayEnvironmentId } = value;
  if (typeof workflowId !== 'string' || !workflowId || typeof projectId !== 'string' || !projectId
    || typeof railwayEnvironmentId !== 'string' || !railwayEnvironmentId) return null;
  return { workflowId, scope: { projectId, railwayEnvironmentId,
    ...(typeof workspaceId === 'string' && workspaceId ? { workspaceId } : {}) } };
}

/** Only actual provider identities can be linked; ambiguous provision results remain recovery. */
export function managedDataLinkContent(credentialPrincipal: unknown, value: unknown) {
  if (!isRecord(value) || value.status === 'outcome_unknown' || value.status === 'unavailable' || value.status === 'adoption_required') return null;
  const parsed = DeploymentTargetLinkProviderContentV1Schema.safeParse({ credentialPrincipal,
    providerIdentity: value.providerIdentity, providerEnvironment: value.providerEnvironment,
    ...(typeof value.engine === 'string' ? { data: { engine: value.engine,
      ...(typeof value.engineVersion === 'number' || typeof value.engineVersion === 'string' ? { version: String(value.engineVersion) }
        : typeof value.version === 'string' ? { version: value.version } : {}),
      ...(value.providerConsole === undefined ? {} : { providerConsole: value.providerConsole }) } } : {}) });
  return parsed.success ? parsed.data : null;
}

/** Provider save results retain named opaque refs even after one save failed. */
export function managedDataConnections(value: unknown) {
  const saved = isRecord(value) && isRecord(value.connectionSave) ? value.connectionSave : value;
  if (!isRecord(saved) || !isRecord(saved.connections)) return [];
  return Object.entries(saved.connections).flatMap(([name, reference]) => isRecord(reference)
    && typeof reference.ref === 'string' && typeof reference.resourceRevision === 'number'
    ? [{ name, ref: reference.ref, resourceRevision: reference.resourceRevision }] : []);
}
