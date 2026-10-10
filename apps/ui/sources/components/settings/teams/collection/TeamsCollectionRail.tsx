import * as React from 'react';
import { View } from 'react-native';
import { useGlobalSearchParams, usePathname, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { teamAddressKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { TeamRow } from '../TeamRow';
import { teamCredentialCreatePath, teamDetailPath, teamsCreatePath } from '../teamsRoutes';
import type { TeamsDirectoryUnavailableHome } from '../teamsDirectoryViewState';
import { teamsUnavailableHomeReason } from '../teamsDirectoryViewState';
import { teamCreateDraftName } from './teamCreateDraftName';
import {
    readTeamCredentialSourceHint,
    resolveSelectedTeamAddress,
} from './teamsCollection';
import { useTeamsCollection } from './useTeamsCollection';
import { CollectionDraftRow, CollectionList, CollectionListGroupLabel, collectionListStyles } from '@/components/ui/lists/collection/CollectionList';
import { HappierCollectionListMark } from '@happier-dev/plugin-ui/presentation';


type CollectionRow = Readonly<{ key: string; render: () => React.ReactElement }>;
const collectionRowKey = (row: CollectionRow) => row.key;
const renderCollectionRow = ({ item }: Readonly<{ item: CollectionRow }>) => item.render();

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
    const { theme } = useUnistyles();
    return (
        <CollectionDraftRow
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

    const drafting = pathname === '/settings/teams/new';
    const total = collection.activeRows.length;
    const searchable = collection.searchable;
    const noMatches = total > 0 && collection.visibleActiveRows.length === 0;

    const rows: Array<Readonly<{ key: string; render: () => React.ReactElement }>> = [];
    const add = (key: string, render: () => React.ReactElement) => rows.push({ key, render });
    const addTeams = (prefix: string, teams: typeof collection.visibleActiveRows) => {
        for (const row of teams) {
            add(`${prefix}:${teamAddressKey(row.address)}`, () => (
                <TeamRow row={row} variant="rail" selected={selectedKey === teamAddressKey(row.address)}
                    showHome={collection.multiHome} onPress={() => openTeam(row.address)} />
            ));
        }
    };
    if (drafting) add('draft', () => <TeamDraftRow />);
    if (active.kind === 'loading' && total === 0) {
        add('loading', () => <ItemLoadStateRows testID="teams-directory-loading" state={{ kind: 'loading' }} rows={3}
            accessibilityLabel={t('teams.directory.loading')} />);
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
    if (sourceHint === null && collection.offerArchived) {
        add('toggle-archived', () => (
            <Item testID="teams-directory-toggle-archived"
                title={collection.showArchived ? t('teams.directory.hideArchived') : t('teams.directory.showArchived')}
                titleStyle={collectionListStyles.dimmedTitle} accessibilityExpanded={collection.showArchived}
                density="compact" showChevron={false} pressableStyle={collectionListStyles.row} onPress={collection.toggleArchived} />
        ));
        if (collection.showArchived) {
            if (collection.visibleArchivedRows.length > 0) {
                add('archived-heading', () => <CollectionListGroupLabel title={t('teams.directory.archivedSection')} />);
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
            if (!collection.archivedPending && collection.archived.unavailableHomes.length > 0) {
                add('archived-unavailable', () => <UnavailableHomesRail homes={collection.archived.unavailableHomes}
                    onRetry={collection.archived.refresh} testIDPrefix="teams-archived-home-unavailable" />);
            }
            if (collection.archived.hasMore) {
                add('archived-load-more', () => <Item testID="teams-directory-archived-load-more" title={t('homeGovernance.loadMore')}
                    density="compact" showChevron={false} pressableStyle={collectionListStyles.row} onPress={collection.archived.loadMore} />);
            }
        }
    }

    return (
        <CollectionList
            testID="teams-collection-rail"
            title={t('teams.title')}
            count={collection.activeIncomplete ? null : total}
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
                    keyExtractor={collectionRowKey}
                    renderItem={renderCollectionRow}
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
    const { theme } = useUnistyles();
    if (props.homes.length === 0) return null;
    const prefix = props.testIDPrefix ?? 'teams-home-unavailable';
    const retryable = props.homes.some((home) => home.retryable);
    return (
        <>
            <CollectionListGroupLabel title={t('teams.directory.unreachableHomes')} count={props.homes.length} />
            {props.homes.map((home) => (
                <Item
                    key={home.serverId}
                    testID={`${prefix}:${home.serverId}`}
                    title={home.homeName}
                    subtitle={teamsUnavailableHomeReason(home)}
                    subtitleLeading={home.reason === 'loading' ? undefined : <View style={collectionListStyles.troubleDot} />}
                    icon={(
                        <HappierCollectionListMark>
                            <Icon name="house" size={18} color={theme.colors.text.secondary} />
                        </HappierCollectionListMark>
                    )}
                    loading={home.reason === 'loading'}
                    mode="info"
                    density="compact"
                />
            ))}
            {retryable ? (
                <Item
                    testID={`${prefix}-retry`}
                    title={t('teams.unavailable.retry')}
                    density="compact"
                    showChevron={false}
                    pressableStyle={collectionListStyles.row}
                    onPress={props.onRetry}
                />
            ) : null}
        </>
    );
});
