import * as React from 'react';
import { TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1, type TeamMembershipV1 } from '@happier-dev/protocol/teams';
import { useUnistyles } from 'react-native-unistyles';
import { HAPPIER_COLLECTION_LIST_METRICS, HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { useTeamsDirectoryRow } from '@/hooks/teams/useTeamsDirectoryRow';
import {
  CollectionList,
  collectionListStyles,
  collectionRailRowKey,
  estimateCollectionRailRowHeight,
  renderCollectionRailRow,
  type CollectionRailRow,
} from '@/components/ui/lists/collection/CollectionList';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { t, usePreferredLanguage } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { teamReadFailureLabel } from '../teamMutationPresentation';
import { teamMemberDetailPath } from '../teamsRoutes';
import { TeamMemberAddAction } from './TeamMemberAddAction';
import { teamMemberRowSubtitle } from './teamMemberPresentation';

/** Fits the rail's mark box, so names align with the rest of the rail. */
/** The column's identity-mark box, so names align with the rest of the rail. */
const MEMBER_RAIL_AVATAR_SIZE = HAPPIER_COLLECTION_LIST_METRICS.markSize;

const MemberRailRow = React.memo(function MemberRailRow(props: Readonly<{
  membership: TeamMembershipV1;
  viewerAccountId?: string;
  selected: boolean;
  language: string;
  onOpen: (membershipId: string) => void;
}>) {
  const { membership } = props;
  const { theme } = useUnistyles();
  const person = resolveAccountDisplayName({ profile: membership.account, accountId: membership.accountId, viewerAccountId: props.viewerAccountId });
  return <Item
    rowRole="catalogRow"
    testID={`team-members-rail-row:${membership.id}`}
    title={person.name}
    // Suspension leads the rail's one subtitle line instead of squeezing the name with a pill.
    subtitle={membership.status === 'suspended'
      ? `${t('teams.status.suspended')} · ${teamMemberRowSubtitle(membership, person)}`
      : teamMemberRowSubtitle(membership, person)}
    subtitleLeading={membership.status === 'suspended' ? <StatusDot size={6} color={theme.colors.state.warning.foreground} /> : undefined}
    icon={<HappierCollectionListMark rowRole="catalogRow"><Avatar id={membership.accountId} size={MEMBER_RAIL_AVATAR_SIZE} imageUrl={membership.account.avatarUrl} monogram={person.named ? person.name : null} /></HappierCollectionListMark>}
    selected={props.selected}
    density="compact"
    showChevron={false}
    pressableStyle={collectionListStyles.row}
    onPress={() => props.onOpen(membership.id)}
  />;
});

/**
 * The Members rail beside an open person (lab `tsMembers-A`, the Home People pattern): everyone in
 * this Team with their role, the viewer marked "you", a directory-managed person named by their
 * source, a suspended one flagged, a search that asks the Home, and the one "+" that adds people.
 * Selection comes from the route; picking someone replaces the shown person rather than stacking
 * history. It reads the same roster the Members page reads, through the same owner.
 */
export const TeamMembersCollectionRail = React.memo(
  function TeamMembersCollectionRail(
    props: Readonly<{
      address: TeamAddress;
      selectedMembershipId: string | null;
    }>,
  ) {
    const router = useRouter();
    const { theme } = useUnistyles();
    const binding = useTeamBinding(props.address.serverId, props.address.teamId);
    // A return mounts the rail again while the Home's credential re-resolves: the projection this device already
    // holds paints the Team's people at once (reads only; a write waits for the bound credential).
    const projection = binding.kind === 'bound' ? binding : binding.kind === 'resolving' ? binding.retained : undefined;
    const ready = projection?.state.kind === 'ready' ? projection : null;
    const team = ready?.state.kind === 'ready' ? ready.state.team : null;
    const state = ready?.state.kind === 'ready' ? ready.state : null;
    const canRead = team?.capabilities.viewRoster === true;
    const [query, setQuery] = React.useState('');
    const roster = useTeamMembersRoster({
      scope: state?.scope ?? null,
      address: ready?.address ?? null,
      filter: 'all',
      query: query.trim(),
      enabled: canRead,
    });
    const searching = query.trim().length > 0;
    const language = usePreferredLanguage();
    const addressServerId = props.address.serverId;
    const teamId = props.address.teamId;

    const open = React.useCallback(
      (membershipId: string) => {
        const result = runGuardedNavigation(() =>
          router.replace(
            teamMemberDetailPath({ serverId: addressServerId, teamId }, membershipId) as never,
          ),
        );
        if (result !== true)
          fireAndForget(result, { tag: 'TeamMembersCollectionRail.open' });
      },
      [addressServerId, teamId, router],
    );

    const rows: CollectionRailRow[] = [];
    const add = (key: string, render: () => React.ReactElement, estimatedHeightPx?: number) =>
      rows.push({ key, render, estimatedHeightPx });
    // While the first page is read, the people the Team summary counts hold their place in the rail's own rows (the
    // avatar, the name and role); an unknown count, or a search, reserves nothing rather than a guess.
    // While the Team itself is read, the row the Teams directory already holds counts them; on a person's own route at
    // least that person is there, so their place is held rather than an empty rail.
    const teamPending = projection
      ? projection.state.kind === 'loading' || projection.state.kind === 'unobserved'
      : binding.kind === 'resolving';
    const directoryRow = useTeamsDirectoryRow(projection?.scope ?? null, teamId);
    const knownMembers = (team ?? directoryRow)?.counts?.members
      ?? (teamPending && props.selectedMembershipId ? 1 : 0);
    const reservedPeople = searching ? 0 : Math.min(knownMembers, TEAM_MEMBERS_PAGE_LIMIT_DEFAULT_V1);
    if ((teamPending || roster.status === 'loading') && roster.rows.length === 0 && reservedPeople > 0) {
      add('loading', () => (
        <ItemLoadStateRows
          testID="team-members-rail-loading"
          state={{ kind: 'loading' }}
          rows={reservedPeople}
          rowRole="catalogRow"
          leadingMark="avatar"
          accessibilityLabel={t('teams.loading')}
        />
      ), reservedPeople * HAPPIER_COLLECTION_LIST_METRICS.describedRowMinHeight);
    }
    if (searching && roster.status === 'ready' && roster.rows.length === 0) {
      add('search-empty', () => (
        <Item
          testID="team-members-rail-search-empty"
          title={t('teams.members.emptyTitle')}
          mode="info"
          density="compact"
        />
      ));
    }
    for (const membership of roster.rows) {
      add(`member:${membership.id}`, () => (
        <MemberRailRow
          membership={membership}
          viewerAccountId={state?.scope.accountId}
          language={language}
          selected={props.selectedMembershipId === membership.id}
          onOpen={open}
        />
      ), HAPPIER_COLLECTION_LIST_METRICS.describedRowMinHeight);
    }
    if (roster.error) {
      const failure = roster.error;
      add('failed', () => (
        <ItemLoadStateRows
          testID="team-members-rail-failed"
          state={{
            kind: 'failed',
            reason: teamReadFailureLabel(failure),
            onRetry: failure.retryable ? roster.reload : undefined,
          }}
        />
      ));
    } else if (roster.hasMore && roster.rows.length > 0) {
      add('load-more', () => (
        <Item
          testID="team-members-rail-load-more"
          title={t('homeGovernance.loadMore')}
          density="compact"
          loading={roster.status === 'loading_more'}
          showChevron={false}
          pressableStyle={collectionListStyles.row}
          onPress={roster.loadMore}
        />
      ));
    }

    return (
      <CollectionList
        testID="team-members-rail"
        title={t('teams.tabs.members')}
        count={
          roster.hasMore || searching || roster.status !== 'ready'
            ? null
            : roster.rows.length
        }
        headerAction={
          ready && team && state ? (
            <TeamMemberAddAction
              presentation="rail"
              context={{
                address: ready.address,
                homeName: ready.homeName,
                team,
                archived: state.archived,
                approvalPending: false,
                canMutate: state.mutationsAvailable && !state.archived,
              }}
            />
          ) : undefined
        }
        search={
          canRead
            ? {
                testID: 'team-members-rail-search',
                value: query,
                onChangeText: setQuery,
                placeholder: t('teams.members.searchPlaceholder'),
              }
            : null
        }
        scrollContent={
          <VirtualizedList
            testID="team-members-rail-list"
            data={rows}
            keyExtractor={collectionRailRowKey}
            renderItem={renderCollectionRailRow}
            getEstimatedItemSize={estimateCollectionRailRowHeight}
            extraData={props.selectedMembershipId}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ paddingBottom: theme.space.s16 }}
            maintainVisibleContentPosition
          />
        }
      />
    );
  },
);
