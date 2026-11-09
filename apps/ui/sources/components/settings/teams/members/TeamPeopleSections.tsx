import * as React from 'react';
import { TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1 } from '@happier-dev/protocol/teams';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { LazyMountOnScreen } from '@/components/ui/performance/LazyMountOnScreen';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getPreferredLanguage, t } from '@/text';

import { teamViewerStandingLabel } from '../teamLabels';
import type { TeamsDirectoryRow } from '../teamsDirectoryViewState';
import { teamsUnavailableHomeReason } from '../teamsDirectoryViewState';
import {
  teamMemberDetailPath,
  teamMembersPath,
  teamsCreatePath,
} from '../teamsRoutes';
import { TeamMemberRow } from './TeamMemberRow';

/**
 * The People page's teammates: one section per Team you belong to, drawn from the same Teams
 * directory and roster owners the Members page reads. Roles, encryption and membership changes stay
 * on the Members page and each person's page, which every row and section opens.
 */
export const TeamPeopleSections = React.memo(function TeamPeopleSections() {
  const router = useRouter();
  const directory = useTeamsDirectory();
  // No Home the viewer can reach offers Teams: there is nothing to invite them to here.
  if (directory.scopes.length === 0 && directory.unavailableHomes.length === 0)
    return null;

  if (directory.kind === 'loading') {
    return (
      <ItemGroup title={t('teams.title')}>
        <SurfaceStateCard
          testID="people-teams-loading"
          kind="loading"
          size="line"
          title={t('teams.directory.loading')}
        />
      </ItemGroup>
    );
  }

  const unavailable = directory.unavailableHomes.filter(
    (home) => home.reason !== 'loading',
  );
  const unavailableLines =
    unavailable.length > 0 ? (
      <ItemGroup
        title={directory.rows.length === 0 ? t('teams.title') : undefined}
      >
        {unavailable.map((home) => (
          <SurfaceStateCard
            key={home.serverId}
            testID={`people-teams-unavailable:${home.serverId}`}
            kind="unavailable"
            size="line"
            title={
              directory.multiHome ? home.homeName : t('teams.unavailable.title')
            }
            reason={teamsUnavailableHomeReason(home)}
            action={
              home.retryable
                ? { label: t('common.retry'), onPress: directory.refresh }
                : undefined
            }
          />
        ))}
      </ItemGroup>
    ) : null;

  if (directory.kind === 'empty' && directory.rows.length === 0) {
    return (
      unavailableLines ?? (
        <ItemGroup title={t('teams.title')}>
          <EmptyState
            testID="people-teams-empty"
            layout="line"
            title={t('friends.peopleTeamsEmpty')}
            primaryAction={{
              label: t('friends.peopleCreateTeam'),
              onPress: () => router.push(teamsCreatePath() as never),
            }}
          />
        </ItemGroup>
      )
    );
  }

  return (
    <>
      {directory.rows.map((row) => {
        const scope =
          directory.scopes.find(
            (candidate) => candidate.serverId === row.address.serverId,
          ) ?? null;
        return (
          <TeamPeopleSection
            key={`${row.address.serverId}:${row.address.teamId}`}
            row={row}
            scope={scope}
            showHome={directory.multiHome}
          />
        );
      })}
      {unavailableLines}
    </>
  );
});

/** A section's rows wait for the Home: placeholders in the rows' shape, never a text line. */
const ROSTER_LOADING = Object.freeze({ kind: 'loading' as const });

/**
 * The others on a Team, as its count knows them: every membership but the viewer's own (whose role
 * the section line already says). `null` when the Team gives no count.
 */
function teamOthersCount(team: TeamsDirectoryRow['team']): number | null {
  if (!team.counts) return null;
  return Math.max(0, team.counts.members - (team.viewerRole ? 1 : 0));
}

const TeamPeopleSection = React.memo(function TeamPeopleSection(
  props: Readonly<{
    row: TeamsDirectoryRow;
    scope: ServerAccountScope | null;
    showHome: boolean;
  }>,
) {
  const router = useRouter();
  const { row, scope } = props;
  const canRead = row.team.capabilities.viewRoster;
  const others = teamOthersCount(row.team);
  // Nobody but the viewer: the line says so, and there is no roster to read or sheet to draw.
  const onlyYou = others === 0 && Boolean(row.team.viewerRole);
  const openMembers = React.useCallback(
    () => router.push(teamMembersPath(row.address) as never),
    [router, row.address],
  );

  const counts = row.team.counts;
  const description = [
    teamViewerStandingLabel(row.team) ?? '',
    onlyYou
      ? t('friends.peopleTeamOnlyYou')
      : counts
        ? t('teams.groups.memberCount', {
            count: counts.members - counts.suspendedMembers,
          })
        : '',
    props.showHome ? row.homeName : '',
  ]
    .filter((part) => part.length > 0)
    .join(' · ');

  const teamKey = `${row.address.serverId}:${row.address.teamId}`;
  const frame = (children: React.ReactNode, surface?: 'none') => (
    <ItemGroup
      testID={`people-team:${teamKey}`}
      title={row.team.name}
      description={description.length > 0 ? description : undefined}
      surface={surface}
      action={
        canRead ? (
          <SectionActionButton
            testID={`people-team-members:${teamKey}`}
            title={t('friends.peopleTeamMembers')}
            destination
            onPress={openMembers}
          />
        ) : undefined
      }
    >
      {children}
    </ItemGroup>
  );

  if (!canRead) {
    return frame(
      <SurfaceStateCard
        testID={`people-team-denied:${teamKey}`}
        kind="denied"
        size="line"
        title={t('teams.denied.title')}
      />,
    );
  }
  if (others === 0 || scope === null) return frame(null, 'none');

  // Reads ∝ need: a Team's roster is read once its section nears the screen. Until then, and while
  // the read is out, the rows the count expects are reserved (at most the roster's first page).
  const reserved = Math.min(others ?? 2, TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1);
  const loadingRows = (
    <ItemLoadStateRows
      testID={`people-team-loading:${teamKey}`}
      state={ROSTER_LOADING}
      rows={reserved}
      lines={2}
      accessibilityLabel={t('friends.peopleTeamMembersLoading')}
    />
  );
  return (
    <LazyMountOnScreen placeholder={frame(loadingRows)}>
      <TeamPeopleRoster
        row={row}
        scope={scope}
        teamKey={teamKey}
        frame={frame}
        loadingRows={loadingRows}
      />
    </LazyMountOnScreen>
  );
});

/** A Team section on screen: its roster from the shared roster owner, without the viewer's own row. */
const TeamPeopleRoster = React.memo(function TeamPeopleRoster(
  props: Readonly<{
    row: TeamsDirectoryRow;
    scope: ServerAccountScope;
    teamKey: string;
    frame: (children: React.ReactNode, surface?: 'none') => React.ReactNode;
    loadingRows: React.ReactNode;
  }>,
) {
  const router = useRouter();
  const { row, scope } = props;
  const roster = useTeamMembersRoster({
    scope,
    address: row.address,
    filter: 'all',
    enabled: true,
  });
  const language = getPreferredLanguage();
  const openMember = React.useCallback(
    (membershipId: string) => {
      router.push(teamMemberDetailPath(row.address, membershipId) as never);
    },
    [router, row.address],
  );
  const others = roster.rows.filter(
    (membership) => membership.accountId !== scope.accountId,
  );

  if (roster.rows.length === 0) {
    if (roster.error) {
      return props.frame(
        <ItemLoadStateRows
          testID={`people-team-error:${props.teamKey}`}
          state={{
            kind: 'failed',
            reason: t('friends.peopleTeamMembersFailed'),
            onRetry: roster.reload,
            homeServerIds: [row.address.serverId],
          }}
        />,
      );
    }
    if (roster.status === 'loading') return props.frame(props.loadingRows);
  }
  if (others.length === 0) return props.frame(null, 'none');
  return props.frame(
    others.map((membership) => (
      <TeamMemberRow
        key={membership.id}
        membership={membership}
        viewerAccountId={scope.accountId}
        language={language}
        onOpen={openMember}
      />
    )),
  );
});
