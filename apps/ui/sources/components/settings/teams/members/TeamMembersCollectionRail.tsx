import * as React from 'react';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import {
  CollectionList,
  collectionListStyles,
} from '@/components/ui/lists/collection/CollectionList';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { teamReadFailureLabel } from '../teamMutationPresentation';
import { teamMemberDetailPath } from '../teamsRoutes';
import { TeamMemberAddAction } from './TeamMemberAddAction';
import { teamMemberRowSubtitle } from './teamMemberPresentation';

/** Fits the rail's mark box, so names align with the rest of the rail. */
const MEMBER_RAIL_AVATAR_SIZE = 28;

type RailRow = Readonly<{ key: string; render: () => React.ReactElement }>;
const railRowKey = (row: RailRow) => row.key;
const renderRailRow = ({ item }: Readonly<{ item: RailRow }>) => item.render();

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
      selectedMembershipId: string;
    }>,
  ) {
    const router = useRouter();
    const binding = useTeamBinding(props.address.serverId, props.address.teamId);
    const ready =
      binding.kind === 'bound' && binding.state.kind === 'ready' ? binding : null;
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

    const open = React.useCallback(
      (membershipId: string) => {
        const result = runGuardedNavigation(() =>
          router.replace(
            teamMemberDetailPath(props.address, membershipId) as never,
          ),
        );
        if (result !== true)
          fireAndForget(result, { tag: 'TeamMembersCollectionRail.open' });
      },
      [props.address, router],
    );

    const rows: RailRow[] = [];
    const add = (key: string, render: () => React.ReactElement) =>
      rows.push({ key, render });
    if (roster.status === 'loading' && roster.rows.length === 0) {
      add('loading', () => (
        <ItemLoadStateRows
          testID="team-members-rail-loading"
          state={{ kind: 'loading' }}
          rows={4}
          accessibilityLabel={t('teams.loading')}
        />
      ));
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
      const person = resolveAccountDisplayName({
        profile: membership.account,
        accountId: membership.accountId,
        viewerAccountId: state?.scope.accountId,
      });
      add(`member:${membership.id}`, () => (
        <Item
          testID={`team-members-rail-row:${membership.id}`}
          title={person.name}
          subtitle={teamMemberRowSubtitle(membership, person)}
          icon={
            <HappierCollectionListMark>
              <Avatar
                id={membership.accountId}
                size={MEMBER_RAIL_AVATAR_SIZE}
                imageUrl={membership.account.avatarUrl}
              />
            </HappierCollectionListMark>
          }
          rightElement={
            membership.status === 'suspended' ? (
              <StatusPill
                variant="warning"
                label={t('teams.status.suspended')}
                labelVariant="phrase"
              />
            ) : undefined
          }
          selected={props.selectedMembershipId === membership.id}
          density="compact"
          showChevron={false}
          pressableStyle={collectionListStyles.row}
          onPress={() => open(membership.id)}
        />
      ));
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
            keyExtractor={railRowKey}
            renderItem={renderRailRow}
            extraData={props.selectedMembershipId}
            style={{ flex: 1, minHeight: 0 }}
            contentContainerStyle={{ paddingBottom: 16 }}
            maintainVisibleContentPosition
          />
        }
      />
    );
  },
);
