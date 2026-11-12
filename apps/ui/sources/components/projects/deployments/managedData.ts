import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { readDeploymentTargetActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargets';
import { DeploymentTargetPreparationBaseV1Schema, DeploymentTargetLinkProviderContentV1Schema,
  DeploymentTargetRoleInputProtocolSchemasV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { normalizePluginActionInputHintsV2 } from '@happier-dev/protocol/plugins/actions/v2';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import { isRecord } from '@happier-dev/protocol/common/records';
import { readPluginActionCredentialPurpose } from './platformTargetLink';

/** Data operations come from the same role traversal that admits their execution. */
export function managedDataTargets(declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[]) {
  return declarations.flatMap(({ manifest }) => (manifest.contributes.deploymentTargets ?? []).flatMap(target => {
    if (target.role !== 'data') return [];
    const operations = readDeploymentTargetActionRolesV1(target).flatMap(binding => {
      if (binding.role === 'query.readOnly') return [];
      const action = manifest.contributes.actions?.find(value => value.id === binding.action);
      if (!action) return [];
      const hints = normalizePluginActionInputHintsV2(action.inputHints, action.inputSchema);
      return [{ ...binding, declaration: action, credential: readPluginActionCredentialPurpose(manifest, action.id), title: resolvePluginLocalizedStringV2Text(action.title),
        actionId: formatQualifiedPluginActionId({ pluginId: manifest.id, localId: action.id }),
        inputHints: { ...hints, fields: (hints?.fields ?? []).filter(field => {
          const root = field.path.split('.')[0]!;
          // Custody, paging and request identity come from the host operation, never editable form operands.
          return field.path === 'providerAccountId' || (root !== 'requestKey'
            && !Object.hasOwn(DeploymentTargetPreparationBaseV1Schema.shape, root)
            && !Object.hasOwn(DeploymentTargetRoleInputProtocolSchemasV1[binding.role].jsonSchema.properties ?? {}, root));
        }) } }];
    });
    return [{ key: `${manifest.id}/${target.id}`, pluginId: manifest.id, target,
      title: resolvePluginLocalizedStringV2Text(target.title), operations }];
  }));
}

export type ManagedDataTarget = ReturnType<typeof managedDataTargets>[number];
export type ManagedDataOperation = ManagedDataTarget['operations'][number];

/** Only actual provider identities can be linked; ambiguous provision results remain recovery. */
export function managedDataLinkContent(credentialPrincipal: unknown, value: unknown) {
  if (!isRecord(value) || value.status === 'outcome_unknown' || value.status === 'unavailable') return null;
  const parsed = DeploymentTargetLinkProviderContentV1Schema.safeParse({ credentialPrincipal,
    providerIdentity: value.providerIdentity, providerEnvironment: value.providerEnvironment });
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
