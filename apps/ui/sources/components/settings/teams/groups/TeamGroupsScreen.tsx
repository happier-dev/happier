import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { TeamGroupV1 } from '@happier-dev/protocol/teams';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CollectionRows } from '@/components/ui/lists/collection/CollectionList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { useTeamGroupDisplayNames } from '@/hooks/teams/useTeamGroupDisplayNames';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { groupManagementLabel } from '../teamLabels';
import { teamReadFailureLabel } from '../teamMutationPresentation';
import { useTeamReadFailureAction } from '../useTeamReadFailureAction';
import { teamGroupCreatePath, teamGroupDetailPath } from '../teamsRoutes';
import { presentTeamGroups, type TeamGroupPresentation } from './teamGroupPresentation';

const GROUP_CHUNK_SIZE = 12;

type GroupVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

type GroupPresentation = TeamGroupPresentation<TeamGroupV1>;

const GroupRows = React.memo(function GroupRows(props: Readonly<{
    context: TeamSectionContext;
    groups: readonly GroupPresentation[];
    /** Only a second list on the page (archived) is titled; the page's own list is not. */
    title?: string;
    testIdPrefix: string;
    first: boolean;
    last: boolean;
}>) {
    const router = useRouter();
    if (props.groups.length === 0) return null;
    return (
        <ItemGroup
            surface="none"
            title={props.first ? props.title : undefined}
            virtualizedSegment={{ first: props.first, last: props.last }}
        >
            {/* A browse list lies flat, its rows parted by the one list-row rule (LISTS-BUILD). */}
            <CollectionRows continued={!props.last}>
            {props.groups.map((row) => {
                const { group } = row;
                const managedBy = groupManagementLabel(group);
                return (
                    <Item
                        key={group.id}
                        testID={`${props.testIdPrefix}:${group.id}`}
                        title={row.name ?? t('common.unavailable')}
                        subtitle={[t('teams.groups.memberCount', { count: group.memberCount }), managedBy]
                            .filter((part): part is string => part !== null)
                            .join(' · ')}
                        onPress={() => router.push(teamGroupDetailPath(props.context.address, group.id))}
                    />
                );
            })}
            </CollectionRows>
        </ItemGroup>
    );
});

const GroupsList = React.memo(function GroupsList(props: Readonly<{
    context: TeamSectionContext;
    header?: React.ReactNode;
}>) {
    const router = useRouter();
    const readFailureAction = useTeamReadFailureAction();
    const { context } = props;
    const [showArchived, setShowArchived] = React.useState(false);
    const [query, setQuery] = React.useState('');

    // The Home authorizes both Group sequences on `viewRoster`; `manageGroups`
    // gates only the writes. A viewer who may read a Team may see which Groups
    // it has, which is also what makes a Group-derived audience explicable.
    const canRead = context.team.capabilities.viewRoster;
    const canCreate = context.team.capabilities.manageGroups && context.canMutate;
    const active = useTeamGroups({
        scope: context.scope,
        address: context.address,
        archived: 'active',
        enabled: canRead,
    });
    // The archived sequence is only asked for once the viewer opens that section.
    const archived = useTeamGroups({
        scope: context.scope,
        address: context.address,
        archived: 'archived',
        // The first affordance is the explicit user's request to read the
        // archived sequence; there is no speculative background read.
        enabled: canRead && showArchived,
    });
    const activeNames = useTeamGroupDisplayNames({ scope: context.scope, groups: active.rows });
    const archivedNames = useTeamGroupDisplayNames({ scope: context.scope, groups: archived.rows });
    const archivedCount = context.team.counts?.archivedGroups ?? 0;
    const offerArchived = archivedCount > 0;
    const activeRows = React.useMemo(
        () => presentTeamGroups(active.rows, activeNames, query),
        [active.rows, activeNames, query],
    );
    const archivedRows = React.useMemo(
        () => presentTeamGroups(archived.rows, archivedNames, query),
        [archived.rows, archivedNames, query],
    );
    // Search filters the active Groups; archived Groups alone are a short list that needs none.
    const searchable = active.rows.length > 0;
    const loadedRows = active.rows.length + (showArchived ? archived.rows.length : 0);
    const visibleRows = activeRows.length + (showArchived ? archivedRows.length : 0);
    const queryHasNoVisibleRows = query.trim() !== '' && loadedRows > 0 && visibleRows === 0;
    const moreRowsMayMatch = active.hasMore || (showArchived && archived.hasMore);

    const rows = React.useMemo<readonly GroupVirtualizedRow[]>(() => {
        const result: GroupVirtualizedRow[] = [];
        const add = (key: string, render: () => React.ReactElement) => result.push({ key, render });
        const addGroupChunks = (
            keyPrefix: string,
            groups: readonly GroupPresentation[],
            title: string | undefined,
            testIdPrefix: string,
        ) => {
            for (let start = 0; start < groups.length; start += GROUP_CHUNK_SIZE) {
                const chunk = groups.slice(start, start + GROUP_CHUNK_SIZE);
                const first = start === 0;
                const last = start + GROUP_CHUNK_SIZE >= groups.length;
                add(`${keyPrefix}:${chunk[0]!.group.id}`, () => (
                    <GroupRows
                        context={context}
                        groups={chunk}
                        title={title}
                        testIdPrefix={testIdPrefix}
                        first={first}
                        last={last}
                    />
                ));
            }
        };

        if (!canRead) {
            add('forbidden', () => (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-groups-forbidden"
                        kind="denied"
                        size="line"
                        title={t('teams.denied.title')}
                    />
                </ItemGroup>
            ));
            return result;
        }

        // One sheet, with no title repeating the page's (lab `tsGroups-A`). Its rows hold their
        // place while the first page is read.
        if (active.status === 'loading' && active.rows.length === 0) {
            add('loading', () => (
                <ItemGroup>
                    <ItemLoadStateRows
                        testID="team-groups-loading"
                        state={{ kind: 'loading' }}
                        rows={3}
                        accessibilityLabel={t('teams.loading')}
                    />
                </ItemGroup>
            ));
        }

        // No Groups yet (lab `tsGroups-E`): what a Group is for, and the one action that starts.
        if (active.rows.length === 0 && active.status === 'ready') {
            add('empty', () => (
                <SurfaceStateCard
                    testID="team-groups-empty"
                    kind="empty"
                    iconName="tree-structure"
                    scene="treeClean"
                    title={t('teams.groups.emptyTitle')}
                    reason={t('teams.groups.emptyBody')}
                    action={canCreate ? {
                        label: t('teams.groups.create'),
                        testID: 'team-groups-empty-create',
                        onPress: () => router.push(teamGroupCreatePath(context.address)),
                    } : undefined}
                />
            ));
        }

        addGroupChunks('active', activeRows, undefined, 'team-groups-row');

        if (queryHasNoVisibleRows) {
            add('search-empty', () => (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-groups-search-empty"
                        kind="empty"
                        size="line"
                        title={moreRowsMayMatch ? t('teams.groups.noLoadedMatches') : t('common.noMatches')}
                    />
                </ItemGroup>
            ));
        }

        if (active.error) {
            add('retry', () => (
                <AttentionBanner
                    testID="team-groups-unavailable"
                    title={teamReadFailureLabel(active.error!)}
                    action={readFailureAction(active.error!, { onPress: () => void active.reload(), testIDPrefix: 'team-groups' })}
                />
            ));
        } else if (active.hasMore && active.rows.length > 0) {
            add('load-more', () => (
                <ItemGroup>
                    <Item
                        testID="team-groups-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={active.status === 'loading_more'}
                        disabled={active.status === 'loading_more'}
                        onPress={() => void active.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ));
        }

        if (offerArchived) {
            add('toggle-archived', () => (
                // A quiet button under the list (lab `tsGroups-A`), not a row among the Groups.
                <ItemGroup surface="none">
                    <SectionButtonRow>
                        <RoundButton
                            testID="team-groups-toggle-archived"
                            size="small"
                            display="inverted"
                            title={[
                                showArchived ? t('teams.directory.hideArchived') : t('teams.directory.showArchived'),
                                archivedCount,
                            ].filter((part) => part !== null).join(' · ')}
                            expanded={showArchived}
                            onPress={() => setShowArchived((current) => !current)}
                        />
                    </SectionButtonRow>
                </ItemGroup>
            ));
        }

        if (showArchived) {
            if (archived.status === 'loading' && archived.rows.length === 0) {
                add('archived-loading', () => (
                    <ItemGroup title={t('teams.groups.archivedSection')}>
                        <ItemLoadStateRows
                            testID="team-groups-archived-loading"
                            state={{ kind: 'loading' }}
                            rows={1}
                            accessibilityLabel={t('teams.groups.archivedSection')}
                        />
                    </ItemGroup>
                ));
            }
            if (archived.status === 'ready' && archived.rows.length === 0) {
                add('archived-empty', () => (
                    <ItemGroup title={t('teams.groups.archivedSection')}>
                        <SurfaceStateCard testID="team-groups-archived-empty" kind="empty" size="line" title={t('teams.groups.emptyTitle')} />
                    </ItemGroup>
                ));
            }
            addGroupChunks('archived', archivedRows, t('teams.groups.archivedSection'), 'team-groups-archived-row');

            if (archived.error) {
                add('archived-retry', () => (
                        <AttentionBanner
                            testID="team-groups-archived-unavailable"
                            title={teamReadFailureLabel(archived.error!)}
                            action={readFailureAction(archived.error!, { onPress: () => void archived.reload(), testIDPrefix: 'team-groups-archived' })}
                        />
                ));
            } else if (archived.hasMore && archived.rows.length > 0) {
                add('archived-load-more', () => (
                        <ItemGroup>
                            <Item
                                testID="team-groups-archived-load-more"
                                title={t('homeGovernance.loadMore')}
                                loading={archived.status === 'loading_more'}
                                disabled={archived.status === 'loading_more'}
                                onPress={() => void archived.loadMore()}
                                showChevron={false}
                            />
                        </ItemGroup>
                ));
            }
        }

        return result;
    }, [active, activeRows, archived, archivedCount, archivedRows, canCreate, canRead, context, moreRowsMayMatch, offerArchived, queryHasNoVisibleRows, router, showArchived]);

    const renderRow = React.useCallback(
        ({ item }: Readonly<{ item: GroupVirtualizedRow }>) => item.render(),
        [],
    );

    return (
        <VirtualizedItemList
            testID="team-groups-virtualized-list"
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderRow}
            ListHeaderComponent={(
                <>
                    {props.header}
                    {searchable ? (
                        <CompactSearchField
                            testID="team-groups-search"
                            value={query}
                            onChangeText={setQuery}
                            placeholder={t('teams.groups.searchLoadedPlaceholder')}
                            placement="page"
                        />
                    ) : null}
                </>
            )}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={120}
            maintainVisibleContentPosition
        />
    );
});

const NewGroupAction = React.memo(function NewGroupAction(props: Readonly<{ address: TeamSectionContext['address'] }>) {
    const router = useRouter();
    return (
        <SectionActionButton
            testID="team-groups-create"
            icon="plus"
            title={t('teams.groups.create')}
            onPress={() => router.push(teamGroupCreatePath(props.address))}
        />
    );
});

export const TeamGroupsScreen = React.memo(function TeamGroupsScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.tabs.groups')}
            description={t('teams.pages.groups')}
            presentation="virtualized-list"
            // Adding happens at the head of the collection (lab `tsGroups-A`): the list has no
            // section title of its own to carry a "+".
            // With no Groups yet the empty state's New Group is the page's one way to start (lab
            // `tsGroups-E`), so the header does not offer it a second time.
            renderHeaderActions={(context) => context.team.capabilities.manageGroups && context.canMutate
                && context.team.counts?.groups !== 0 ? (
                <NewGroupAction address={context.address} />
            ) : null}
        >
            {(context, header) => <GroupsList context={context} header={header} />}
        </TeamSection>
    );
});
