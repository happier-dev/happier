import * as React from 'react';
import type { DeploymentTargetCredentialPrincipalV1, DeploymentTargetProviderIdentityV1 } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';

/** The same recorded identity disclosure serves a saved link and the exact provider captured by link recovery. */
export function DeploymentPlatformCredentialDisclosure(props: PrincipalProps & Readonly<{
  provider: DeploymentTargetProviderIdentityV1;
}>) {
  const prefix = props.testIDPrefix ?? 'project-deployments.environment.permissions.platform';
  return <ItemGroup testID={prefix}
    title={t('projects.deployments.platformLink.accessTitle')}>
    <DeploymentPlatformCredentialPrincipal {...props} />
    <Item testID={`${prefix}.providerAccount`} mode="info"
      title={t('projects.deployments.platformLink.providerAccount')} detail={props.provider.providerAccountId} />
    <Item testID={`${prefix}.providerProject`} mode="info"
      title={t('projects.deployments.platformLink.providerProject')} detail={props.provider.providerResourceId} />
    <Item testID={`${prefix}.providerScope`} mode="info"
      title={t('projects.deployments.platformLink.providerScope')} detail={props.provider.providerEnvironment} />
  </ItemGroup>;
}

type PrincipalProps = Readonly<{
  principal: DeploymentTargetCredentialPrincipalV1;
  scope: ServerAccountScope | null;
  lifetime: ServerAccountScopeLifetime | null;
  serverId: string;
  platform: string;
  testIDPrefix?: string;
}>;
export function DeploymentPlatformCredentialPrincipal(props: PrincipalProps) {
  if (props.principal.kind === 'team') return <TeamCredentialPrincipal {...props} principal={props.principal} />;
  if (props.scope) return <AccountCredentialPrincipal {...props} principal={props.principal} scope={props.scope} />;
  const presentation = presentSharePrincipal({ ref: props.principal });
  return <PrincipalRow testIDPrefix={props.testIDPrefix} name={[presentation.displayName, presentation.secondaryLabel].filter(Boolean).join(' · ')}
    platform={props.platform} personal />;
}
function AccountCredentialPrincipal(props: PrincipalProps & Readonly<{
  principal: Extract<DeploymentTargetCredentialPrincipalV1, { kind: 'account' }>;
  scope: ServerAccountScope;
}>) {
  const viewerProfile = useShareViewerProfile(props.scope);
  const profiles = useDiscussionParticipantProfiles({ scope: props.scope, roster: null,
    accountIds: [props.principal.accountId], enabled: true, accountLifetime: props.lifetime });
  const presentation = presentSharePrincipal({ ref: props.principal, viewerAccountId: props.scope.accountId,
    viewerProfile, profile: profiles.accounts.get(props.principal.accountId)?.profile });
  return <PrincipalRow testIDPrefix={props.testIDPrefix} name={[presentation.displayName, presentation.secondaryLabel].filter(Boolean).join(' · ')}
    platform={props.platform} personal />;
}
function TeamCredentialPrincipal(props: PrincipalProps & Readonly<{
  principal: Extract<DeploymentTargetCredentialPrincipalV1, { kind: 'team' }>;
}>) {
  const binding = useTeamBinding(props.serverId, props.principal.teamId);
  const name = binding.kind === 'bound' && binding.state.kind === 'ready' ? binding.state.team.name : null;
  const presentation = presentSharePrincipal({ ref: props.principal, name });
  return <PrincipalRow testIDPrefix={props.testIDPrefix} name={presentation.displayName}
    platform={props.platform} personal={false} />;
}
function PrincipalRow(props: Readonly<{ name: string; platform: string; personal: boolean; testIDPrefix?: string }>) {
  return <Item testID={`${props.testIDPrefix ?? 'project-deployments.environment.permissions.platform'}.principal`} mode="info"
    title={t('projects.deployments.platformLink.deploysUse', { principal: props.name, platform: props.platform })}
    detail={props.name} subtitle={t(props.personal ? 'projects.deployments.platformLink.personalAccessDependency'
      : 'projects.deployments.platformLink.teamAccessDependency')} />;
}
