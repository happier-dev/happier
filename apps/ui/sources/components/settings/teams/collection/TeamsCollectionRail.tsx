import * as React from 'react';
import { useGlobalSearchParams, usePathname, useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { View } from 'react-native';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { teamAddressKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { TeamRow, teamRailRowHasSubtitle } from '../TeamRow';
import { teamCredentialCreatePath, teamDetailPath, teamsCreatePath } from '../teamsRoutes';
import type { TeamsDirectoryUnavailableHome } from '../teamsDirectoryViewState';
import { teamsUnavailableHomeReason, teamsUnavailableHomeSettingsAction, teamsUnavailableHomeStateKind } from '../teamsDirectoryViewState';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useCollectionDraftTitle } from '@/components/ui/lists/collection/CollectionDraftTitle';
import {
    readTeamCredentialSourceHint,
    resolveSelectedTeamAddress,
} from './teamsCollection';
import { useTeamsCollection } from './useTeamsCollection';
import {
    CollectionDraftRow,
    CollectionList,
    CollectionListGroupLabel,
    collectionListStyles,
    collectionRailRowKey,
    estimateCollectionRailRowHeight,
    renderCollectionRailRow,
    type CollectionRailRow,
} from '@/components/ui/lists/collection/CollectionList';
import { ITEM_COMPACT_MIN_HEIGHT_PX } from '@/components/ui/lists/itemDensityMetrics';
import { HAPPIER_COLLECTION_LIST_METRICS, HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';

/**
 * The collection's "+": a new Team, shown only where a Home in view offers creation to this viewer,
 * and disabled until that answer is current.
 */
export const TeamsCollectionAddButton = React.memo(function TeamsCollectionAddButton(props: Readonly<{
    canCreate: boolean;
    onPress: () => void;
}>) {
    return (
        <IconButton
            testID="teams-directory-new"
            iconName="plus"
            accessibilityLabel={t('teams.directory.newTeam')}
            tooltip={t('teams.directory.newTeam')}
            variant="plain"
            disabled={!props.canCreate}
            onPress={props.onPress}
        />
    );
});

/** The new Team being set up in the detail pane, titled as its name is typed. */
const TeamDraftRow = React.memo(function TeamDraftRow() {
    const teamCreateDraftName = useCollectionDraftTitle();
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
            rowRole="item"
            testID="teams-collection-draft"
            titles={teamCreateDraftName}
            placeholder={t('teams.create.title')}
            mark={(
                <HappierCollectionListMark>
                    <Icon name="users" size={18} color={theme.colors.text.secondary} />
                </HappierCollectionListMark>
            )}
        />
    );
});

/**
 * The Teams rail beside the open Team: every Team across the Homes in view, the new Team being
 * set up, the Homes that could not answer, and the archived Teams on request. Selection comes from
 * the route; switching Teams replaces the shown detail rather than stacking history.
 */
export const TeamsCollectionRail = React.memo(function TeamsCollectionRail() {
    const router = useRouter();
    const pathname = usePathname().replace(/\/+$/, '');
    const params = useGlobalSearchParams();
    const sourceHint = React.useMemo(
        () => (pathname === '/settings/teams' ? readTeamCredentialSourceHint(params) : null),
        [params, pathname],
    );
    const [query, setQuery] = React.useState('');
    const selected = React.useMemo(() => resolveSelectedTeamAddress(pathname), [pathname]);
    const collection = useTeamsCollection({ sourceHint, query, selectedAddress: selected });
    const { active } = collection;

    const selectedKey = selected ? teamAddressKey(selected) : null;

    const open = React.useCallback((href: string) => {
        // The index is not a detail of its own (it lands on a Team), so the first pick replaces it too.
        const result = runGuardedNavigation(() => router.replace(href as never));
        if (result !== true) fireAndForget(result, { tag: 'TeamsCollectionRail.open' });
    }, [router]);
    const openTeam = React.useCallback((address: TeamAddress) => {
        open(sourceHint ? teamCredentialCreatePath(address, sourceHint) : teamDetailPath(address));
    }, [open, sourceHint]);

    // The new Team's row appears only where a Home offers this viewer creation; a refused create
    // page explains itself, and the rail adds no draft that cannot become a Team.
    const drafting = pathname === '/settings/teams/new' && collection.showCreateTeam;
    const total = collection.activeRows.length;
    const searchable = collection.searchable;
    const noMatches = total > 0 && collection.visibleActiveRows.length === 0;

    const rows: CollectionRailRow[] = [];
    const add = (key: string, render: () => React.ReactElement, estimatedHeightPx?: number) => rows.push({ key, render, estimatedHeightPx });
    const addTeams = (prefix: string, teams: typeof collection.visibleActiveRows) => {
        for (const row of teams) {
            const estimatedHeight = teamRailRowHasSubtitle(row, collection.multiHome)
                ? HAPPIER_COLLECTION_LIST_METRICS.describedRowMinHeight
                : ITEM_COMPACT_MIN_HEIGHT_PX;
            add(`${prefix}:${teamAddressKey(row.address)}`, () => (
                <TeamRow row={row} variant="rail" selected={selectedKey === teamAddressKey(row.address)}
                    showHome={collection.multiHome} onPress={openTeam} />
            ), estimatedHeight);
        }
    };
    if (drafting) add('draft', () => <TeamDraftRow />);
    // Until the directory answers, its set of Teams is unknown: one line waits, and nothing that belongs under the
    // rows (the archived toggle) is drawn beneath it, to be pushed down when the rows arrive.
    const activeUnknown = active.kind === 'loading' && total === 0;
    if (activeUnknown) {
        // How many Teams there are is the directory's answer: one quiet line waits, and no rows are guessed.
        add('loading', () => <View style={collectionListStyles.stateLine}>
            <SurfaceStateCard testID="teams-directory-loading" size="line" kind="loading" title={t('teams.directory.loading')}
                accessibilitySemantics="status" />
        </View>);
    }
    // An empty collection is said once, by its page beside the rail (DR-19); the rail adds no line.
    if (noMatches) {
        add('search-empty', () => <Item testID="teams-directory-search-empty"
            title={t(collection.activeIncomplete ? 'teams.directory.noLoadedMatches' : 'teams.directory.noMatches')}
            mode="info" density="compact" />);
    }
    addTeams('active', collection.visibleActiveRows);
    if (active.hasMore) {
        add('load-more', () => <Item testID="teams-directory-load-more" title={t('homeGovernance.loadMore')}
            density="compact" showChevron={false} pressableStyle={collectionListStyles.row} onPress={active.loadMore} />);
    }
    const unavailableHomes = active.unavailableHomes.filter((home) => home.reason !== 'loading');
    if (unavailableHomes.length > 0) {
        add('unavailable-homes', () => <UnavailableHomesRail homes={unavailableHomes} onRetry={active.refresh} />);
    }
    if (sourceHint === null && collection.offerArchived && !activeUnknown) {
        add('toggle-archived', () => (
            <Item testID="teams-directory-toggle-archived"
                title={collection.showArchived ? t('teams.directory.hideArchived') : t('teams.directory.showArchived')}
                titleStyle={collectionListStyles.dimmedTitle} accessibilityExpanded={collection.showArchived}
                density="compact" showChevron={false} pressableStyle={collectionListStyles.row} onPress={collection.toggleArchived} />
        ), ITEM_COMPACT_MIN_HEIGHT_PX);
        if (collection.showArchived || collection.visibleArchivedRows.length > 0) {
            if (collection.visibleArchivedRows.length > 0) {
                add('archived-heading', () => <CollectionListGroupLabel title={t('teams.directory.archivedSection')} />,
                    HAPPIER_COLLECTION_LIST_METRICS.groupLabelHeight);
            }
            addTeams('archived', collection.visibleArchivedRows);
            if (collection.visibleArchivedRows.length === 0 && collection.archivedPending) {
                add('archived-loading', () => <Item testID="teams-directory-archived-loading" title={t('teams.directory.archivedSection')}
                    loading mode="info" density="compact" />);
            }
            if (collection.visibleArchivedRows.length === 0 && !collection.archivedPending
                && collection.archived.unavailableHomes.length === 0 && collection.normalizedQuery.length === 0) {
                add('archived-empty', () => <Item testID="teams-directory-archived-empty" title={t('teams.directory.archivedEmpty')}
                    mode="info" density="compact" />);
            }
            if (collection.showArchived && !collection.archivedPending && collection.archived.unavailableHomes.length > 0) {
                add('archived-unavailable', () => <UnavailableHomesRail homes={collection.archived.unavailableHomes}
                    onRetry={collection.archived.refresh} testIDPrefix="teams-archived-home-unavailable" />);
            }
            if (collection.showArchived && collection.archived.hasMore) {
                add('archived-load-more', () => <Item testID="teams-directory-archived-load-more" title={t('homeGovernance.loadMore')}
                    density="compact" showChevron={false} pressableStyle={collectionListStyles.row} onPress={collection.archived.loadMore} />);
            }
        }
    }

    return (
        <CollectionList
            testID="teams-collection-rail"
            title={t('teams.title')}
            count={collection.activeCount}
            headerAction={collection.showCreateTeam && sourceHint === null ? (
                <TeamsCollectionAddButton canCreate={collection.canCreateTeam} onPress={() => open(teamsCreatePath())} />
            ) : undefined}
            search={searchable ? {
                testID: 'teams-directory-search',
                value: query,
                onChangeText: setQuery,
                placeholder: t('teams.directory.searchLoadedPlaceholder'),
            } : null}
            scrollContent={(
                <VirtualizedList
                    testID="teams-collection-virtualized-list"
                    data={rows}
                    keyExtractor={collectionRailRowKey}
                    renderItem={renderCollectionRailRow}
                    getEstimatedItemSize={estimateCollectionRailRowHeight}
                    extraData={selectedKey}
                    style={{ flex: 1, minHeight: 0 }}
                    contentContainerStyle={{ paddingBottom: 16 }}
                    maintainVisibleContentPosition
                />
            )}
        />
    );
});

/**
 * Homes that could not answer, named with their reason so a partial list never reads as the whole
 * one. Only trouble gets a dot; the retry asks every such Home again.
 */
const UnavailableHomesRail = React.memo(function UnavailableHomesRail(props: Readonly<{
    homes: readonly TeamsDirectoryUnavailableHome[];
    onRetry: () => void;
    testIDPrefix?: string;
}>) {
    const router = useRouter();
    if (props.homes.length === 0) return null;
    const prefix = props.testIDPrefix ?? 'teams-home-unavailable';
    return (
        <>
            <CollectionListGroupLabel title={t('teams.directory.unreachableHomes')} count={props.homes.length} />
            {props.homes.map((home, index) => (
                <SurfaceStateCard
                    key={home.serverId}
                    testID={`${prefix}:${home.serverId}`}
                    title={home.homeName}
                    reason={teamsUnavailableHomeReason(home)}
                    kind={teamsUnavailableHomeStateKind(home)}
                    size="line"
                    action={home.retryable ? {
                        testID: index === 0 ? `${prefix}-retry` : `${prefix}:${home.serverId}:retry`,
                        label: t('teams.unavailable.retry'),
                        onPress: props.onRetry,
                    } : teamsUnavailableHomeSettingsAction(home, (href) => router.push(href as Href))}
                />
            ))}
        </>
    );
});
