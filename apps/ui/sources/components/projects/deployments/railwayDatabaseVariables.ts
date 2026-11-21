import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import { readPlatformResourceName } from './platformTargetLink';
import { buildPreviewBranchReadInput } from './previewDatabaseBranches';

export function railwayDatabaseReferenceChoices(detail: DeploymentEnvironmentReadDetailV1 | undefined) {
  if (!detail) return [];
  const runtime = detail.targetLinks.find(row => row.targetLink.id === detail.environment.runtimeTargetLinkId);
  const runtimeSource = runtime?.targetLink.source;
  if (runtimeSource?.kind !== 'plugin' || runtimeSource.contribution.pluginId !== 'happier.deploy.railway') return [];
  const runtimeProviderIdentity = runtime?.content?.providerIdentity;
  const runtimeProviderEnvironment = runtime?.content?.providerEnvironment;
  if (!runtimeProviderIdentity || !runtimeProviderEnvironment) return [];

  return detail.targetLinks.flatMap(row => {
    const { source, role, id } = row.targetLink;
    if (role !== 'data' || source.kind !== 'plugin' || source.contribution.pluginId !== 'happier.deploy.railway-data') return [];
    const data = buildPreviewBranchReadInput(detail, row);
    if (!data) return [];
    const serviceId = data.providerIdentity.providerResourceId;
    const title = readPlatformResourceName(row.content) ?? serviceId;
    return [{ id, title, ...(title === serviceId ? {} : { subtitle: serviceId }),
      actionId: formatQualifiedPluginActionId({ pluginId: source.contribution.pluginId, localId: source.contribution.localId + '-connection-reference' }),
      input: { ...data, runtimeProviderIdentity, runtimeProviderEnvironment } }];
  });
}
