import * as React from 'react';
import type { HomeAccountRowV1 } from '@happier-dev/protocol/home/governance';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { CollectionList, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { useHomeAccountRoster } from '@/hooks/home/useHomeAccountRoster';
import { useHomeAccountSearch } from '@/hooks/home/useHomeAccountSearch';
import { useHomeAdministration } from '@/hooks/home/useHomeAdministration';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { t, usePreferredLanguage, type SupportedLanguage } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { HomeAccountStatusGlyph } from './HomeAccountStatusPill';
import { homeAdministrationAccountPath } from './homeAdministrationRoutes';
import { homeRoleLabel } from './homeGovernanceLabels';

/** Fits the rail's mark box, so names align with the rest of the rail. */
const PERSON_RAIL_AVATAR_SIZE = 28;

type RailRow = Readonly<{ key: string; render: () => React.ReactElement }>;
const railRowKey = (row: RailRow) => row.key;
const renderRailRow = ({ item }: Readonly<{ item: RailRow }>) => item.render();

/** Formatting and row elements are produced only for the recycler's mounted window. */
const PeopleRailRosterRow = React.memo(function PeopleRailRosterRow(props: Readonly<{
    row: HomeAccountRowV1;
    viewerAccountId: string | undefined;
    selected: boolean;
    onOpen: (accountId: string) => void;
    locale: SupportedLanguage;
}>) {
    const { row, viewerAccountId, onOpen } = props;
    const open = React.useCallback(() => onOpen(row.accountId), [onOpen, row.accountId]);
    const person = resolveAccountDisplayName({
        profile: row.profile,
        accountId: row.accountId,
        signInEmail: row.authentication.signInEmail,
        viewerAccountId,
    });
    return (
        <Item
            rowRole="catalogRow"
            testID={`home-people-rail-row:${row.accountId}`}
            title={person.name}
            subtitle={[homeRoleLabel(row.homeRole), person.viewer && person.named ? t('homeGovernance.person.you') : null, person.hint]
                .filter((part): part is string => part !== null).join(' · ')}
            icon={<PersonMark rowRole="catalogRow" accountId={row.accountId} avatarUrl={row.profile.avatarUrl ?? null} monogram={person.named ? person.name : null} />}
            rightElement={row.status === 'active' ? undefined : <HomeAccountStatusGlyph row={row} locale={props.locale} />}
            selected={props.selected}
            density="compact"
            showChevron={false}
            pressableStyle={collectionListStyles.row}
            onPress={open}
        />
    );
});

/**
 * The People rail beside an open person (plan §3.12, lab `hcPeople-D`): everyone on this Home with
 * their role, the viewer marked "you", a disabled or retired person flagged, and a search that asks
 * the Home. Selection comes from the route; picking someone replaces the shown person rather than
 * stacking history.
 */
export const HomePeopleCollectionRail = React.memo(function HomePeopleCollectionRail(props: Readonly<{
    serverId: string;
    selectedAccountId: string | null;
}>) {
    const router = useRouter();
    const locale = usePreferredLanguage();
    const binding = useHomeAdministration(props.serverId);
    const scope = binding.kind === 'bound' ? binding.scope : null;
    const canList = binding.kind === 'bound'
        && binding.state.kind === 'ready'
        && binding.state.projection.capabilities.manageAccounts;
    const [query, setQuery] = React.useState('');
    const roster = useHomeAccountRoster(scope, canList);
    const search = useHomeAccountSearch(scope, query, canList);
    const searching = query.trim().length > 0;

    const open = React.useCallback((accountId: string) => {
        const result = runGuardedNavigation(() => router.replace(
            homeAdministrationAccountPath(props.serverId, accountId) as never,
        ));
        if (result !== true) fireAndForget(result, { tag: 'HomePeopleCollectionRail.open' });
    }, [props.serverId, router]);

    const rows: RailRow[] = [];
    const add = (key: string, render: () => React.ReactElement) => rows.push({ key, render });
    if (searching) {
        if (search.rows.length === 0) {
            // Searching holds the result rows' place; a failed or empty answer is one quiet line.
            add('search-state', () => search.searching ? (
                <ItemLoadStateRows testID="home-people-rail-search-loading" state={{ kind: 'loading' }} rows={3}
                    accessibilityLabel={t('homeGovernance.loading')} />
            ) : search.failure ? (
                <ItemLoadStateRows
                    testID="home-people-rail-search-failed"
                    state={{
                        kind: 'failed',
                        reason: t('homeGovernance.searchFailed'),
                        onRetry: search.failure.retryable ? search.retry : undefined,
                        homeServerIds: [props.serverId],
                    }}
                />
            ) : (
                <SurfaceStateCard testID="home-people-rail-search-empty" kind="empty" size="line" title={t('homeGovernance.searchEmpty')} />
            ));
        }
        for (const row of search.rows) {
            const person = resolveAccountDisplayName({ profile: row.profile, accountId: row.accountId, viewerAccountId: scope?.accountId });
            add(`search:${row.accountId}`, () => (
                <Item
                    rowRole="item"
                    testID={`home-people-rail-row:${row.accountId}`}
                    title={person.name}
                    subtitle={person.hint ?? undefined}
                    icon={<PersonMark rowRole="item" accountId={row.accountId} avatarUrl={row.profile.avatarUrl ?? null} monogram={person.named ? person.name : null} />}
                    selected={props.selectedAccountId === row.accountId}
                    density="compact"
                    showChevron={false}
                    pressableStyle={collectionListStyles.row}
                    onPress={() => open(row.accountId)}
                />
            ));
        }
    } else {
        if (roster.status === 'loading' && roster.rows.length === 0) {
            add('loading', () => (
                <ItemLoadStateRows testID="home-people-rail-loading" state={{ kind: 'loading' }} rows={4}
                    accessibilityLabel={t('homeGovernance.loading')} />
            ));
        }
        for (const row of roster.rows) {
            add(`roster:${row.accountId}`, () => (
                <PeopleRailRosterRow row={row} viewerAccountId={scope?.accountId}
                    selected={props.selectedAccountId === row.accountId} onOpen={open} locale={locale} />
            ));
        }
        if (roster.error) {
            add('retry', () => (
                <ItemLoadStateRows
                    testID="home-people-rail"
                    state={{
                        kind: 'failed',
                        reason: t('homeGovernance.overviewPage.peopleFailed'),
                        onRetry: roster.reload,
                        homeServerIds: [props.serverId],
                    }}
                />
            ));
        } else if (roster.hasMore) {
            add('load-more', () => (
                <Item testID="home-people-rail-load-more" title={t('homeGovernance.loadMore')} density="compact"
                    loading={roster.status === 'loading_more'} showChevron={false}
                    pressableStyle={collectionListStyles.row} onPress={roster.loadMore} />
            ));
        }
    }

    return (
        <CollectionList
            testID="home-people-rail"
            title={t('homeGovernance.people')}
            count={roster.hasMore ? null : roster.rows.length}
            search={canList ? {
                testID: 'home-people-rail-search',
                value: query,
                onChangeText: setQuery,
                placeholder: t('homeGovernance.searchPlaceholder'),
            } : null}
            scrollContent={(
                <VirtualizedList
                    testID="home-people-rail-list"
                    data={rows}
                    keyExtractor={railRowKey}
                    renderItem={renderRailRow}
                    extraData={props.selectedAccountId}
                    style={{ flex: 1, minHeight: 0 }}
                    contentContainerStyle={{ paddingBottom: 16 }}
                    maintainVisibleContentPosition
                />
            )}
        />
    );
});

const PersonMark = React.memo(function PersonMark(props: Readonly<{ accountId: string; avatarUrl: string | null; monogram: string | null; rowRole: 'catalogRow' | 'item' }>) {
    return (
        <HappierCollectionListMark rowRole={props.rowRole}>
            <Avatar id={props.accountId} size={PERSON_RAIL_AVATAR_SIZE} imageUrl={props.avatarUrl} monogram={props.monogram} />
        </HappierCollectionListMark>
    );
});
