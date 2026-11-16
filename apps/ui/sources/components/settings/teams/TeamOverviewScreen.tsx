import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { presentHomeInvitePeople, teamInvitePeopleAction } from '@/components/settings/home/governance/HomeInvitePeopleDialog';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { AvatarStack } from '@/components/ui/avatar/AvatarStack';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SetupSteps, type SetupStep } from '@/components/ui/setupBlocks/SetupSteps';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { useTeamInvitations } from '@/hooks/teams/useTeamInvitations';
import { useTeamManagerNames } from '@/hooks/teams/useTeamManagerNames';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { t } from '@/text';

import { askTeamManagersText } from './collection/teamsCreateGuidanceText';
import { directorySourcePresentationState } from './identity/directoryAdministrationPresentation';
import { useDirectoryAdministration } from './identity/useDirectoryAdministration';
import { TeamSection } from './TeamSection';
import { useTeamCredentialsProjection } from './credentials/useTeamCredentialsProjection';
import { TeamSharedSessionsSection } from './TeamSharedSessionsSection';
import { TeamSharedWorkflowsSection } from './TeamSharedWorkflowsSection';
import type { TeamSectionContext } from './teamSectionContext';
import { isTeamViewerSuspended, teamViewerStandingLabel } from './teamLabels';
import { TeamOwnerRequiredNotice } from './members/TeamOwnerRequiredNotice';
import { TeamLeaveAction } from './members/TeamLeaveAction';
import { TeamSuspendedNotice } from './members/TeamSuspendedNotice';
import {
  teamAuthenticationPath,
  teamCredentialsPath,
  teamDirectorySourcePath,
  teamGroupsPath,
  teamInvitationsPath,
  teamMembersPath,
  teamSettingsPath,
} from './teamsRoutes';
import { resolveTeamOverviewDestinationIds } from './teamOverviewDestinations';
import { resolveTeamSetupSteps, type TeamSetupStep } from './teamOverviewSetup';
import {
  resolveTeamOverviewAttention,
  teamOverviewAuthenticationSummary,
  teamOverviewCredentialsSummary,
  teamOverviewGroupsSummary,
  teamOverviewInvitationsSummary,
  teamOverviewMembersSummary,
  teamOverviewSettingsSummary,
  type TeamOverviewAttentionItem,
} from './teamOverviewSummary';
import { Icon } from '@/components/ui/icons/Icon';

/** The size of an entity mark at the head of its page. */
const TEAM_HEADER_AVATAR_SIZE = 44;
/** The Members row shows this many faces before its chevron (lab `tsOverview-A`). */
const MEMBER_PREVIEW_COUNT = 4;
const MEMBER_PREVIEW_AVATAR_SIZE = 22;

/** Whether this viewer may invite to the Team right now, by the Team's own projected capability. */
function canInvite(context: TeamSectionContext): boolean {
  return context.team.capabilities.manageInvitations && context.canMutate;
}

function openInvite(context: TeamSectionContext): void {
  presentHomeInvitePeople({
    serverId: context.address.serverId,
    teamId: context.address.teamId,
  });
}

/**
 * The shared-credentials entry, offered only once this exact Home has said both
 * that it has the feature and that this viewer may administer resources or
 * offer one of their own there. The row says how many are shared.
 *
 * The capability is not in the Team projection — it deliberately carries no
 * resource authority — so it comes from the resource projection itself. That
 * read is the same one the destination uses, so opening it costs nothing extra,
 * and a viewer the Home has denied never sees an entry it would refuse.
 */
const CredentialsDestination = React.memo(function CredentialsDestination(
  props: Readonly<{
    context: TeamSectionContext;
  }>,
) {
  const router = useRouter();
  const { context } = props;
  const { featureEnabled, projection, totalCount } = useTeamCredentialsProjection(context);

  if (
    !featureEnabled ||
    (projection.viewer?.manageCredentials !== true &&
      projection.viewer?.offerOwnCredential !== true)
  )
    return null;

  return (
    <Item
      testID="team-overview-credentials"
      icon={<Icon name="key" />}
      title={t('teams.credentials.title')}
      subtitle={teamOverviewCredentialsSummary(totalCount)}
      onPress={() => router.push(teamCredentialsPath(context.address))}
    />
  );
});

/**
 * The Team's own identity heads its page, the same lockup the directory row and the join screen
 * show, so somebody arriving from either recognizes where they are. The avatar owner derives the
 * monogram and accent from the immutable Team id, never from the name — two Teams may share a name.
 * Inviting people is the Team's most frequent owner job, so it is the page's one primary action
 * (DR-06): it opens the one Invite people dialog with this Team already chosen.
 */
const TeamOverviewHeader = React.memo(function TeamOverviewHeader(
  props: Readonly<{
    context: TeamSectionContext;
  }>,
) {
  const { team, address, homeName } = props.context;
  const standing = teamViewerStandingLabel(team);
  const invite = team.capabilities.manageInvitations && !props.context.archived && resolveTeamSetupSteps(team) === null;
  return (
    <PageHeader
      testID="team-overview-identity"
      alwaysShowTitle
      title={team.name}
      description={team.description ?? undefined}
      leading={
        <Avatar
          id={address.teamId}
          monogram={team.name}
          square
          size={TEAM_HEADER_AVATAR_SIZE}
          imageUrl={team.logo?.url ?? null}
          thumbhash={team.logo?.thumbhash ?? null}
        />
      }
      meta={[
        ...(standing
          ? [
              {
                key: 'role',
                testID: 'team-overview-role',
                text: standing,
              },
            ]
          : []),
        {
          key: 'home',
          testID: 'team-overview-home',
          icon: 'house' as const,
          text: homeName,
        },
      ]}
      primaryAction={
        invite
          ? teamInvitePeopleAction({
              serverId: address.serverId,
              teamId: address.teamId,
              testID: 'team-overview-invite',
              disabled: !props.context.canMutate,
            })
          : undefined
      }
    />
  );
});

/**
 * "Get {Team} ready" (lab `tsOverview-E`): a just-created Team's setup as the one numbered-step
 * anatomy (`SetupSteps`, the same the WorkOS connection setup uses). Each step's operation sits at
 * its end; only the current step's is the filled primary, the rest are bordered. The section leaves
 * as soon as the Team is in use.
 */
const TeamSetupSection = React.memo(function TeamSetupSection(
  props: Readonly<{
    context: TeamSectionContext;
    steps: readonly TeamSetupStep[];
  }>,
) {
  const router = useRouter();
  const { context } = props;
  const steps = props.steps.map((step): SetupStep => {
    const state = step.current ? 'current' : 'upcoming';
    switch (step.id) {
      case 'invite':
        return {
          key: step.id,
          state,
          testID: 'team-overview-setup-invite',
          title: t('homeGovernance.invite.action'),
          detail: t('teams.overview.setup.inviteBody'),
          action: (
            <RoundButton
              testID="team-overview-setup-invite-action"
              size="small"
              display={step.current ? 'default' : 'secondary'}
              title={t('homeGovernance.invite.action')}
              disabled={!canInvite(context)}
              onPress={() => openInvite(context)}
            />
          ),
        };
      case 'sign_in':
        return {
          key: step.id,
          state,
          testID: 'team-overview-setup-sign-in',
          title: t('teams.overview.setup.signInTitle'),
          detail: t('teams.overview.setup.signInBody'),
          action: (
            <RoundButton
              testID="team-overview-setup-sign-in-action"
              size="small"
              display={step.current ? 'default' : 'secondary'}
              title={t('teams.overview.setup.signInAction')}
              onPress={() => router.push(teamAuthenticationPath(context.address))}
            />
          ),
        };
      case 'share':
        return {
          key: step.id,
          state,
          testID: 'team-overview-setup-share',
          title: t('teams.overview.setup.shareTitle'),
          detail: t('teams.overview.setup.shareBody'),
        };
    }
  });
  return (
    <ItemGroup
      title={t('teams.overview.setup.title')}
      description={t('teams.overview.setup.description')}
    >
      <SectionContentRow>
        <SetupSteps testID="team-overview-setup" steps={steps} />
      </SectionContentRow>
    </ItemGroup>
  );
});

/**
 * "Needs your attention" (lab `tsOverview-T`): only trouble speaks, and each line carries the way
 * to deal with it. Healthy, the section is absent.
 */
const TeamAttentionSection = React.memo(function TeamAttentionSection(
  props: Readonly<{
    context: TeamSectionContext;
    items: readonly TeamOverviewAttentionItem[];
  }>,
) {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { address } = props.context;
  if (props.items.length === 0) return null;
  return (
    <ItemGroup title={t('homeGovernance.overviewPage.attention')}>
      {props.items.map((item) =>
        item.kind === 'directory_failed' ? (
          <Item
            key={`directory:${item.sourceId}`}
            testID={`team-overview-attention-directory:${item.sourceId}`}
            icon={
              <Icon
                name="warning"
                color={theme.colors.state.danger.foreground}
              />
            }
            title={t('teams.overview.attention.directoryFailedTitle', {
              name: item.name,
            })}
            subtitle={t('teams.overview.attention.directoryFailedBody')}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={
              <RoundButton
                testID={`team-overview-attention-directory-review:${item.sourceId}`}
                size="small"
                display="secondary"
                title={t('homeGovernance.overviewPage.review')}
                onPress={() =>
                  router.push(teamDirectorySourcePath(address, item.sourceId))
                }
              />
            }
          />
        ) : (
          <Item
            key={`invitation:${item.invitationId}`}
            testID={`team-overview-attention-invitation:${item.invitationId}`}
            icon={
              <Icon
                name="envelope"
                color={theme.colors.state.warning.foreground}
              />
            }
            title={t('teams.overview.attention.invitationUndeliveredTitle')}
            subtitle={t('teams.overview.attention.invitationUndeliveredBody', {
              recipient: item.recipient,
            })}
            subtitleLines={0}
            mode="info"
            showChevron={false}
            accessoryLayout="adaptive"
            rightElement={
              <RoundButton
                testID={`team-overview-attention-invitation-review:${item.invitationId}`}
                size="small"
                display="secondary"
                title={t('homeGovernance.overviewPage.review')}
                onPress={() => router.push(teamInvitationsPath(address))}
              />
            }
          />
        ),
      )}
    </ItemGroup>
  );
});

/**
 * The Team's destinations, each stating where things stand before its chevron (DR-12, lab
 * `tsOverview-A`). The facts come from the Team projection and from the reads the destinations
 * themselves use — the roster's first faces, the directory's sources, the invitations' deliveries —
 * each asked only of a viewer the Home would answer. A fact that cannot be read is left out of its
 * row rather than guessed.
 */
const TeamOverviewBody = React.memo(function TeamOverviewBody(
  props: Readonly<{ context: TeamSectionContext }>,
) {
  const router = useRouter();
  const { context } = props;
  const { team, address } = context;
  const capabilities = team.capabilities;
  const destinations = resolveTeamOverviewDestinationIds(capabilities);
  const setupSteps = resolveTeamSetupSteps(team);
  // A viewer who manages nobody is told who does, by name (lab `tsOverview-M`).
  const manages = capabilities.manageMembers || capabilities.manageInvitations;
  const managerNames = useTeamManagerNames(context, !manages);

  const roster = useTeamMembersRoster({
    scope: context.scope,
    address,
    filter: 'all',
    enabled: capabilities.viewRoster,
  });
  const directory = useDirectoryAdministration(
    context.scope,
    address.teamId,
    capabilities.manageAuthentication,
  );
  const invitations = useTeamInvitations({
    scope: context.scope,
    address,
    state: 'active',
    enabled: capabilities.manageInvitations,
  });

  const sources = React.useMemo(
    () =>
      capabilities.manageAuthentication && directory.state.kind === 'ready'
        ? directory.state.items.map((source) => {
            const state = directorySourcePresentationState(source);
            return {
              id: source.id,
              displayName: source.displayName,
              failed: state === 'failed' || state === 'needs_attention',
            };
          })
        : [],
    [capabilities.manageAuthentication, directory.state],
  );
  const attention = React.useMemo(
    () =>
      resolveTeamOverviewAttention({
        sources,
        invitations: capabilities.manageInvitations ? invitations.rows : [],
        // Expiry is the Home's fact on these rows; nothing here ticks a clock.
        now: 0,
      }),
    [capabilities.manageInvitations, invitations.rows, sources],
  );
  const undeliveredInvitations = attention.filter(
    (item) => item.kind === 'invitation_undelivered',
  ).length;
  const directoryNames = sources.map((source) => source.displayName);
  const faces = roster.rows.slice(0, MEMBER_PREVIEW_COUNT);

  // A just-created Team's page is its setup: only the destinations the steps lead to stay.
  const shown = (id: (typeof destinations)[number]) =>
    destinations.includes(id) &&
    (setupSteps === null ||
      id === 'members' ||
      id === 'authentication' ||
      id === 'settings');

  return (
    <>
      {/* The Team's own condition, published by the Home. The
          recovery itself happens on the roster, which is the
          only surface that knows who may be promoted. */}
      <TeamOwnerRequiredNotice
        context={context}
        onChooseOwner={() => router.push(teamMembersPath(address))}
      />

      <TeamAttentionSection context={context} items={attention} />

      {setupSteps ? (
        <TeamSetupSection context={context} steps={setupSteps} />
      ) : (
        <>
          <TeamSharedSessionsSection context={context} />
          <TeamSharedWorkflowsSection context={context} />
        </>
      )}

      <ItemGroup
        title={t('teams.overview.teamSection')}
        description={
          manages
            ? undefined
            // The first sentence already says who to ask; only real names add to it.
            : managerNames.length > 0
              ? `${t('teams.overview.managedBy')} ${askTeamManagersText(managerNames)}`
              : t('teams.overview.managedBy')
        }
      >
        {shown('members') ? (
          <Item
            testID="team-overview-members"
            icon={<Icon name="users" />}
            title={t('teams.tabs.members')}
            subtitle={teamOverviewMembersSummary(team)}
            rightElement={
              faces.length > 1 ? (
                <AvatarStack
                  testID="team-overview-members-faces"
                  size={MEMBER_PREVIEW_AVATAR_SIZE}
                  entries={faces.map((membership) => ({
                    key: membership.id,
                    content: (
                      <Avatar
                        id={membership.accountId}
                        size={MEMBER_PREVIEW_AVATAR_SIZE}
                        imageUrl={membership.account.avatarUrl}
                      />
                    ),
                  }))}
                />
              ) : undefined
            }
            // The faces sit beside the chevron, as on every other row that opens a page (tsOverview-A).
            keepChevronWithRightElement
            onPress={() => router.push(teamMembersPath(address))}
          />
        ) : null}
        {shown('groups') ? (
          <Item
            testID="team-overview-groups"
            icon={<Icon name="tree-structure" />}
            title={t('teams.tabs.groups')}
            subtitle={teamOverviewGroupsSummary(team, directoryNames)}
            onPress={() => router.push(teamGroupsPath(address))}
          />
        ) : null}
        {shown('invitations') ? (
          <Item
            testID="team-overview-invitations"
            icon={<Icon name="envelope" />}
            title={t('teams.tabs.invitations')}
            subtitle={teamOverviewInvitationsSummary(
              team,
              undeliveredInvitations,
            )}
            onPress={() => router.push(teamInvitationsPath(address))}
          />
        ) : null}
        {shown('authentication') ? (
          <Item
            testID="team-overview-authentication"
            icon={<Icon name="fingerprint" />}
            title={t('teams.tabs.authentication')}
            subtitle={teamOverviewAuthenticationSummary(team, directoryNames)}
            onPress={() => router.push(teamAuthenticationPath(address))}
          />
        ) : null}
        {setupSteps === null ? (
          <CredentialsDestination context={context} />
        ) : null}
        {shown('settings') ? (
          <Item
            testID="team-overview-settings"
            icon={<Icon name="gear" />}
            title={t('teams.tabs.settings')}
            subtitle={teamOverviewSettingsSummary(team)}
            onPress={() => router.push(teamSettingsPath(address))}
          />
        ) : null}
      </ItemGroup>

    </>
  );
});

/** The Overview's known sections, holding their rows while the Team is read (lab `tsOverview-L`). */
function TeamOverviewLoading() {
  return (
    <>
      <ItemGroup title={t('teams.overview.sharedSessions')}>
        <ItemLoadStateRows
          state={{ kind: 'loading' }}
          rows={1}
          accessibilityLabel={t('teams.loading')}
        />
      </ItemGroup>
      <ItemGroup title={t('teams.overview.teamSection')}>
        <ItemLoadStateRows
          testID="team-loading"
          state={{ kind: 'loading' }}
          rows={5}
          accessibilityLabel={t('teams.loading')}
        />
      </ItemGroup>
    </>
  );
}

/**
 * The Team entry surface.
 *
 * It answers "which Team am I in, on which Home, as what" before offering any
 * destination, and it offers only the destinations this viewer's server-projected
 * capabilities actually back — an absent producer or a withheld capability omits
 * the row rather than rendering a control that would fail. Each destination row
 * says where things stand there, so the page is a summary rather than a list of links.
 */
export const TeamOverviewScreen = React.memo(function TeamOverviewScreen(
  props: Readonly<{
    serverId: string;
    teamId: string;
  }>,
) {
  return (
    <TeamSection
      serverId={props.serverId}
      teamId={props.teamId}
      renderHeader={(context) => <TeamOverviewHeader context={context} />}
      renderLoading={TeamOverviewLoading}
    >
      {(context) => (
        <>
          {context.team.capabilities.viewTeam ? <TeamOverviewBody context={context} /> : null}
          {isTeamViewerSuspended(context.team) ? <TeamSuspendedNotice /> : null}
          {/* Leave-only viewers retain the Team identity and self-removal without mounting
              the content's readers or ordinary member guidance. */}
          {!context.team.capabilities.manageMembers && !context.team.capabilities.manageInvitations ? (
            <TeamLeaveAction context={context} testID="team-overview-leave" />
          ) : null}
        </>
      )}
    </TeamSection>
  );
});
