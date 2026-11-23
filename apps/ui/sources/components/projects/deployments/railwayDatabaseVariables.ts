import { listDeploymentTargetsFromManifestsV1, readDeploymentDatabaseReferenceV1, type DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';

import { readPlatformResourceName } from './platformTargetLink';
import { buildPreviewBranchReadInput } from './previewDatabaseBranches';

export function providerDatabaseReferenceChoices(detail: DeploymentEnvironmentReadDetailV1,
  declarations: readonly Readonly<{ manifest: PluginPortableReleaseManifestV1 }>[]) {
  const runtime = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId);
  const runtimeSource = runtime?.targetLink.source;
  const runtimeProviderIdentity = runtime?.content?.providerIdentity;
  const runtimeProviderEnvironment = runtime?.content?.providerEnvironment;
  if (runtimeSource?.kind !== 'plugin' || !runtimeProviderIdentity || !runtimeProviderEnvironment) return [];

  const targets = new Map(listDeploymentTargetsFromManifestsV1(declarations).flatMap(target => target.source.kind === 'plugin'
    ? [[buildQualifiedPluginContributionKey(target.source.contribution), target] as const] : []));
  const runtimeTarget = targets.get(buildQualifiedPluginContributionKey(runtimeSource.contribution));
  if (!runtimeTarget) return [];
  return detail.targetLinks.flatMap(row => {
    const { source, role, id } = row.targetLink;
    if (role !== 'data' || source.kind !== 'plugin') return [];
    const dataTarget = targets.get(buildQualifiedPluginContributionKey(source.contribution));
    if (!dataTarget) return [];
    const reference = readDeploymentDatabaseReferenceV1(runtimeTarget, dataTarget, declarations);
    const data = buildPreviewBranchReadInput(detail, row);
    if (!reference || !data) return [];
    const title = readPlatformResourceName(row.content, reference.providerName) ?? reference.providerName;
    return [{ id, title, ...reference,
      input: { ...data, runtimeProviderIdentity, runtimeProviderEnvironment } }];
  });
}
