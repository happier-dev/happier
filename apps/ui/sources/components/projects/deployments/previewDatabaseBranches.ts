import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { DeploymentTargetProviderIdentityV1 } from '@happier-dev/deployments/contracts/v1';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { z } from 'zod/mini';
import { DeploymentTargetDataInputV1Schema, DeploymentTargetRoleInputSchemasV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { isRecord } from '@happier-dev/protocol/common/records';

type LinkedTarget = DeploymentEnvironmentReadDetailV1['targetLinks'][number];
export type PreviewBranchTarget = LinkedTarget & Readonly<{ actionId: string; title: string }>;

/** Linked data targets consume their plugin's branch contribution, without a second provider catalog. */
export function previewBranchTargets(declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[],
  detail: DeploymentEnvironmentReadDetailV1): readonly PreviewBranchTarget[] {
  return detail.targetLinks.flatMap((row): PreviewBranchTarget[] => {
    const source = row.targetLink.source;
    if (row.targetLink.role !== 'data' || source.kind !== 'plugin') return [];
    const manifest = declarations.find(entry => entry.manifest.id === source.contribution.pluginId)?.manifest;
    const target = manifest?.contributes.deploymentTargets?.find(entry => entry.id === source.contribution.localId);
    const branches = target?.role === 'data' ? target.dataV1?.branches : undefined;
    if (!branches?.listAction || !branches.create || !branches.delete) return [];
    return [{ ...row, title: typeof target?.title === 'string' ? target.title : row.targetLink.targetKind,
      actionId: formatQualifiedPluginActionId({ pluginId: source.contribution.pluginId, localId: branches.listAction }) }];
  });
}

// Use the preparation contract's keys to project the saved link, excluding presentation-only facts.
const savedDataTargetReadInput = z.object(DeploymentTargetDataInputV1Schema.shape);
const savedDatabaseReferenceInput = z.object(DeploymentTargetRoleInputSchemasV1['connectionSecret.reference'].shape);

/** The host admits this recorded link custody; the UI never substitutes the viewer or changes its purpose. */
export function buildPreviewBranchReadInput(detail: DeploymentEnvironmentReadDetailV1, target: LinkedTarget, role?: 'connectionSecret.reference') {
  const credentialPrincipal = target.content?.credentialPrincipal;
  if (credentialPrincipal?.kind !== 'account' || credentialPrincipal.target.kind !== 'account') return null;
  const schema = role === 'connectionSecret.reference' ? savedDatabaseReferenceInput : savedDataTargetReadInput;
  const input = schema.safeParse({
    ...target.content,
    v: 1,
    serverId: detail.environment.serverId,
    environmentId: detail.environment.id,
    expectedRevision: detail.environment.revision,
    targetLinkId: target.targetLink.id,
    expectedTargetLinkRevision: target.targetLink.revision,
    credentialRef: credentialPrincipal.target.account,
  });
  if (!input.success || !input.data.providerIdentity) return null;
  return { ...input.data, providerIdentity: input.data.providerIdentity };
}

type ManagedPreviewSelection = Extract<NonNullable<DeploymentEnvironmentReadDetailV1['content']['previewTemplate']>['data'][number], { kind: 'managed' }>;
export type PreviewBranchParent = Readonly<{ title: string; parentBranchRef: ManagedPreviewSelection['parentBranchRef'] }>;

/** Public data-target results use project ids (Neon) or project refs (Supabase); only the linked parent is selectable. */
export function readPreviewBranchParents(value: unknown, identity: DeploymentTargetProviderIdentityV1): readonly PreviewBranchParent[] {
  if (!isRecord(value) || !Array.isArray(value.branches)) return [];
  return value.branches.flatMap((branch): PreviewBranchParent[] => {
    if (!isRecord(branch) || typeof branch.branchId !== 'string' || typeof branch.name !== 'string') return [];
    const projectId = typeof branch.providerProjectId === 'string' ? branch.providerProjectId : branch.projectRef;
    const matches = typeof branch.providerProjectId === 'string'
      ? projectId === identity.providerResourceId && branch.branchId === identity.providerEnvironment
      : branch.parentProjectRef === identity.providerResourceId && branch.projectRef === identity.providerEnvironment;
    return matches && typeof projectId === 'string'
      ? [{ title: branch.name, parentBranchRef: { providerProjectId: projectId, branchId: branch.branchId, displayName: branch.name } }] : [];
  });
}
