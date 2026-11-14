import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { presentSharePrincipal } from '@/components/sharing/sharePrincipalPresentation';
import { useShareViewerProfile } from '@/components/sharing/useShareViewerProfile';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { useTeamGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useTeamGroup } from '@/hooks/teams/useTeamGroups';
import { useDiscussionParticipantProfiles } from '@/components/discussions/useDiscussionParticipantProfiles';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import type { DeploymentEnvironmentDeployerPrincipalV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';

import { TeamCredentialAudiencePicker, type TeamCredentialAudiencePrincipal } from '@/components/settings/teams/credentials/TeamCredentialAudiencePicker';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import type { ServerAccountScopeLifetime, ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createTeamAddress, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { t } from '@/text';

type DeployerMode = DeploymentEnvironmentReadDetailV1['environment']['deployerMode'];
type Principal = DeploymentEnvironmentDeployerPrincipalV1;
const principalKey = (principal: Principal) => JSON.stringify([principal.principalKind, principal.principalId]);

/** The same deployer controls author a draft and edit an existing Environment. Admission stays with the Action. */
export function DeploymentDeployerFields(props: Readonly<{
  mode: DeployerMode;
  principals: readonly Principal[];
  scope: ServerAccountScope | null;
  lifetime: ServerAccountScopeLifetime | null;
  source: ProjectSourceV1 | null;
  owner?: DeploymentEnvironmentReadDetailV1['environment']['owner'];
  editable: boolean;
  disabled: boolean;
  onModeChange: (mode: DeployerMode) => void;
  onChangePrincipals: (principals: readonly Principal[]) => void;
}>) {
  // Source references provide the choices; the Action owns admission of a selected Account or Group.
  const candidates = React.useMemo(() => {
    const owner = props.source?.owner ?? (props.source
      ? { kind: 'account' as const, accountId: props.source.createdByAccountId } : props.owner);
    const refs = [...(owner ? [owner] : []), ...(props.source?.audience.map(grant => grant.principal) ?? [])];
    const teams = new Map<string, TeamAddress>();
    const direct = new Map<string, ReturnType<typeof presentSharePrincipal>>();
    for (const ref of refs) {
      if (ref.kind === 'team') {
        const address = props.scope && createTeamAddress(props.scope.serverId, ref.teamId);
        if (address) teams.set(ref.teamId, address);
      } else {
        const presentation = presentSharePrincipal({ ref, viewerAccountId: props.scope?.accountId });
        direct.set(presentation.key, presentation);
      }
    }
    return { teams: [...teams.values()], direct: [...direct.values()] };
  }, [props.source, props.owner, props.scope]);
  return <>
    {props.editable ? <DeployersChoice mode={props.mode}
      chosenAvailable={candidates.teams.length > 0 || (props.source?.audience.length ?? 0) > 0 || props.mode === 'chosen'} disabled={props.disabled}
      onChoose={props.onModeChange} /> : <Item title={t('projects.deployments.deployers')}
      detail={deployersLabel(props.mode)} mode="info" />}
    {props.mode === 'chosen' && props.scope ? <ChosenPeople
      scope={props.scope} lifetime={props.lifetime} teams={candidates.teams} direct={candidates.direct} principals={props.principals}
      editable={props.editable && !props.disabled}
      onAdd={principal => props.onChangePrincipals([...props.principals, principal])}
      onRemove={principal => props.onChangePrincipals(props.principals.filter(item => principalKey(item) !== principalKey(principal)))}
    /> : null}
  </>;
}

/**
 * Chosen people are offered for a shared Source, and stay visible while they are the current setting.
 */
function DeployersChoice(
  props: Readonly<{ mode: DeployerMode; chosenAvailable: boolean; disabled: boolean; onChoose: (mode: DeployerMode) => void }>,
) {
  const options = React.useMemo((): SegmentedChoiceOption<DeployerMode>[] => [
    { id: 'managers', label: deployersLabel('managers') },
    { id: 'members', label: deployersLabel('members') },
    ...(props.chosenAvailable ? [{ id: 'chosen' as const, label: deployersLabel('chosen') }] : []),
  ], [props.chosenAvailable]);
  return (
    <SegmentedChoiceItem
      testID="project-deployments.environment.permissions.deployers"
      testIDPrefix="project-deployments.environment.permissions.deployers"
      title={t('projects.deployments.deployers')}
      options={options}
      value={props.mode}
      disabled={props.disabled}
      onChange={(next) => {
        if (next !== props.mode) props.onChoose(next);
      }}
    />
  );
}

/** Direct Source principals and each Source Team use the existing sharing presentation and people picker. */
function ChosenPeople(
  props: Readonly<{
    scope: ServerAccountScope;
    lifetime: ServerAccountScopeLifetime | null;
    teams: readonly TeamAddress[];
    direct: readonly ReturnType<typeof presentSharePrincipal>[];
    principals: readonly Principal[];
    editable: boolean;
    onAdd: (principal: Principal) => void;
    onRemove: (principal: Principal) => void;
  }>,
) {
  const { theme } = useUnistyles();
  const viewerProfile = useShareViewerProfile(props.scope);
  const accountIds = [...new Set([
    ...props.direct.flatMap(candidate => candidate.ref.kind === 'account' ? [candidate.ref.accountId] : []),
    ...props.principals.flatMap(principal => principal.principalKind === 'account' ? [principal.principalId] : []),
  ])];
  const profiles = useDiscussionParticipantProfiles({ scope: props.scope, roster: null, accountIds,
    enabled: true, accountLifetime: props.lifetime });
  // Picked names read immediately; acknowledged profiles name saved selections from every Source Team.
  const [picked, setPicked] = React.useState<ReadonlyMap<string, string>>(new Map());
  const names = React.useMemo(() => {
    const map = new Map(props.direct.map(principal => {
      const key = principalKey({ principalKind: principal.ref.kind === 'account' ? 'account' : 'teamGroup',
        principalId: principal.ref.kind === 'account' ? principal.ref.accountId : principal.ref.kind === 'group' ? principal.ref.groupId : '' });
      return [key, presentSharePrincipal({ ref: principal.ref, viewerAccountId: props.scope.accountId, viewerProfile,
        profile: principal.ref.kind === 'account' ? profiles.accounts.get(principal.ref.accountId)?.profile : null }).displayName] as const;
    }));
    for (const [accountId, actor] of profiles.accounts) {
      const presentation = presentSharePrincipal({ ref: { kind: 'account', accountId }, profile: actor.profile,
        viewerAccountId: props.scope.accountId, viewerProfile });
      map.set(principalKey({ principalKind: 'account', principalId: accountId }), presentation.displayName);
    }
    for (const [key, name] of picked) map.set(key, name);
    return map;
  }, [picked, profiles.accounts, props.direct, props.scope.accountId, viewerProfile]);
  const choose = (chosen: TeamCredentialAudiencePrincipal) => {
    const principal: Principal = chosen.kind === 'member'
      ? { principalKind: 'account', principalId: chosen.accountId }
      : { principalKind: 'teamGroup', principalId: chosen.id };
    if (props.principals.some(item => principalKey(item) === principalKey(principal))) return;
    setPicked(current => new Map(current).set(principalKey(principal), chosen.name));
    props.onAdd(principal);
  };
  const prefix = 'project-deployments.environment.permissions.chosen';
  return (
    <>
      {props.principals.length === 0 ? (
        <Item testID={`${prefix}.empty`} title={t('projects.deployments.editors.chosenEmpty')} mode="info" />
      ) : props.principals.map(principal => {
        const key = principalKey(principal);
        const group = principal.principalKind === 'teamGroup';
        const name = names.get(key) ?? (group ? t('projects.deployments.editors.chosenGroup') : t('projects.deployments.editors.chosenUnknown'));
        const render = (displayName: string) => (
          <Item
            key={key}
            testID={`${prefix}.${principal.principalKind}.${principal.principalId}`}
            icon={<Icon name={group ? 'users' : 'user-circle'} size={18} color={theme.colors.text.secondary} />}
            title={displayName}
            subtitle={group ? t('projects.deployments.editors.chosenGroup') : undefined}
            mode="info"
            rightElement={props.editable ? (
              <IconButton
                testID={`${prefix}.${principal.principalKind}.${principal.principalId}.remove`}
                iconName="x"
                variant="plain"
                accessibilityLabel={`${t('projects.deployments.editors.chosenRemove')} ${displayName}`}
                onPress={() => props.onRemove(principal)}
              />
            ) : undefined}
          />
        );
        const sourceGroup = group ? props.direct.find(candidate => candidate.ref.kind === 'group' && candidate.ref.groupId === principal.principalId)?.ref : undefined;
        return sourceGroup?.kind === 'group' ? <SourceGroupName key={key} scope={props.scope} principal={sourceGroup}>{render}</SourceGroupName> : render(name);
      })}
      {props.editable ? <>
        {props.direct.map(candidate => {
          const ref = candidate.ref;
          if (ref.kind === 'team') return null;
          const principal: Principal = ref.kind === 'account'
            ? { principalKind: 'account', principalId: ref.accountId }
            : { principalKind: 'teamGroup', principalId: ref.groupId };
          if (props.principals.some(item => principalKey(item) === principalKey(principal))) return null;
          const presentation = presentSharePrincipal({ ref, viewerAccountId: props.scope.accountId, viewerProfile,
            profile: ref.kind === 'account' ? profiles.accounts.get(ref.accountId)?.profile : null });
          const render = (name: string) => <Item key={candidate.key} testID={`${prefix}.add.${principal.principalKind}.${principal.principalId}`}
            title={name} subtitle={presentation.secondaryLabel}
            accessibilityLabel={name}
            icon={<Icon name={ref.kind === 'group' ? 'users' : 'user-circle'} size={18} color={theme.colors.text.secondary} />}
            rightElement={<Icon name="plus" size={18} color={theme.colors.text.secondary} />}
            onPress={() => props.onAdd(principal)} />;
          return ref.kind === 'group' ? <SourceGroupName key={candidate.key} scope={props.scope} principal={ref}>{render}</SourceGroupName> : render(presentation.displayName);
        })}
        {props.teams.map((team, index) => <TeamDeployerPicker key={team.teamId}
          testID={index === 0 ? `${prefix}.add` : `${prefix}.add.${team.teamId}`}
          scope={props.scope} address={team} multiple={props.teams.length > 1}
          excludedGroupIds={props.principals.flatMap(item => item.principalKind === 'teamGroup' ? [item.principalId] : [])}
          onChoose={choose} />)}
      </> : null}
    </>
  );
}

function SourceGroupName(props: Readonly<{
  scope: ServerAccountScope;
  principal: Extract<PrincipalRefV1, { kind: 'group' }>;
  children: (name: string) => React.ReactNode;
}>) {
  const address = React.useMemo(() => createTeamAddress(props.scope.serverId, props.principal.teamId),
    [props.scope.serverId, props.principal.teamId]);
  const detail = useTeamGroup({ scope: props.scope, address, groupId: props.principal.groupId, enabled: true });
  const openedGroupDisplayNames = useTeamGroupDisplayNames({
    scope: props.scope,
    groups: detail.group ? [detail.group] : [],
  });
  return props.children(detail.group
    ? openedGroupDisplayNames.get(detail.group.id) ?? t('common.unavailable')
    : t('projects.deployments.editors.chosenGroup'));
}

function TeamDeployerPicker(props: Readonly<{
  scope: ServerAccountScope;
  address: TeamAddress;
  multiple: boolean;
  testID: string;
  excludedGroupIds: readonly string[];
  onChoose: (principal: TeamCredentialAudiencePrincipal) => void;
}>) {
  const binding = useTeamBinding(props.address.serverId, props.address.teamId);
  const name = binding.kind === 'bound' && binding.state.kind === 'ready' ? binding.state.team.name : t('shareSheet.team');
  const label = t('projects.deployments.editors.chosenAdd');
  return <TeamCredentialAudiencePicker scope={props.scope} address={props.address} testID={props.testID}
    excludedGroupIds={props.excludedGroupIds} excludedMemberIds={[]}
    label={props.multiple ? `${label} · ${name}` : label} disabled={false} onChoose={props.onChoose} />;
}

function deployersLabel(mode: DeployerMode): string {
  switch (mode) {
    case 'managers':
      return t('projects.deployments.deployersManagers');
    case 'members':
      return t('projects.deployments.deployersMembers');
    case 'chosen':
      return t('projects.deployments.deployersChosen');
  }
}
