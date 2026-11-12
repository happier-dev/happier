import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { DeploymentPlatformCredentialDisclosure } from './DeploymentPlatformCredentialDisclosure';
import { useDeploymentPlatformTargetTitles } from './DeploymentPlatformTargetSheet';

/** Present the runtime link's recorded identity; the viewer's deploy permission does not own its credentials. */
export function DeploymentPlatformAccess(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  scope: ServerAccountScope | null;
  lifetime: ServerAccountScopeLifetime | null;
}>) {
  const runtime = props.detail.runtimeTargetLink;
  const content = props.detail.targetLinks.find(row => row.targetLink.id === runtime?.id)?.content;
  const principal = content?.credentialPrincipal;
  const provider = content?.providerIdentity;
  const platformTitle = useDeploymentPlatformTargetTitles(props.lifetime, principal !== undefined && runtime?.source.kind === 'plugin');
  if (!runtime || !principal || !provider) return null;
  const platform = runtime.source.kind === 'plugin' ? platformTitle(runtime.source) ?? t('projects.deployments.platformLink.platform')
    : t('projects.deployments.platformLink.platform');
  return <DeploymentPlatformCredentialDisclosure principal={principal} provider={provider}
    platform={platform} scope={props.scope} lifetime={props.lifetime} serverId={props.detail.environment.serverId} />;
}
