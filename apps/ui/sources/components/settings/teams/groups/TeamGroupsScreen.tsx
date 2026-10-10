import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import type { TeamGroupV1 } from '@happier-dev/protocol/teams';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { useTeamGroups } from '@/hooks/teams/useTeamGroups';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { groupManagementLabel } from '../teamLabels';
import { teamReadFailureLabel } from '../teamMutationPresentation';
import { teamGroupCreatePath, teamGroupDetailPath } from '../teamsRoutes';

const GROUP_CHUNK_SIZE = 12;

type GroupVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

const GroupRows = React.memo(function GroupRows(props: Readonly<{
    context: TeamSectionContext;
    groups: readonly TeamGroupV1[];
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
            title={props.first ? props.title : undefined}
            virtualizedSegment={{ first: props.first, last: props.last }}
        >
            {props.groups.map((group) => {
                const managedBy = groupManagementLabel(group);
                return (
                    <Item
                        key={group.id}
                        testID={`${props.testIdPrefix}:${group.id}`}
                        title={group.name}
                        subtitle={[t('teams.groups.memberCount', { count: group.memberCount }), managedBy]
                            .filter((part): part is string => part !== null)
                            .join(' · ')}
                        onPress={() => router.push(teamGroupDetailPath(props.context.address, group.id))}
                    />
                );
            })}
        </ItemGroup>
    );
});

const GroupsList = React.memo(function GroupsList(props: Readonly<{
    context: TeamSectionContext;
    header?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { context } = props;
    const [showArchived, setShowArchived] = React.useState(false);

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
        // archived sequence. Once opened, its answer controls whether the
        // affordance remains visible; there is no speculative background read.
        enabled: canRead && showArchived,
    });
    const offerArchived = !showArchived
        || archived.status !== 'ready'
        || !archived.isCurrent
        || archived.rows.length > 0
        || archived.error !== null;

    const rows = React.useMemo<readonly GroupVirtualizedRow[]>(() => {
        const result: GroupVirtualizedRow[] = [];
        const add = (key: string, render: () => React.ReactElement) => result.push({ key, render });
        const addGroupChunks = (
            keyPrefix: string,
            groups: readonly TeamGroupV1[],
            title: string | undefined,
            testIdPrefix: string,
        ) => {
            for (let start = 0; start < groups.length; start += GROUP_CHUNK_SIZE) {
                const chunk = groups.slice(start, start + GROUP_CHUNK_SIZE);
                const first = start === 0;
                const last = start + GROUP_CHUNK_SIZE >= groups.length;
                add(`${keyPrefix}:${chunk[0]!.id}`, () => (
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

        addGroupChunks('active', active.rows, undefined, 'team-groups-row');

        if (active.error) {
            add('retry', () => (
                <AttentionBanner
                    testID="team-groups-unavailable"
                    title={teamReadFailureLabel(active.error!)}
                    action={active.error?.retryable ? {
                        label: t('teams.unavailable.retry'),
                        onPress: () => void active.reload(),
                        testID: 'team-groups-retry',
                    } : undefined}
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
                            title={showArchived ? t('teams.directory.hideArchived') : t('teams.directory.showArchived')}
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
            addGroupChunks('archived', archived.rows, t('teams.groups.archivedSection'), 'team-groups-archived-row');

            if (archived.error) {
                add('archived-retry', () => (
                        <AttentionBanner
                            testID="team-groups-archived-unavailable"
                            title={teamReadFailureLabel(archived.error!)}
                            action={archived.error?.retryable ? {
                                label: t('teams.unavailable.retry'),
                                onPress: () => void archived.reload(),
                                testID: 'team-groups-archived-retry',
                            } : undefined}
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
    }, [active, archived, canCreate, canRead, context, offerArchived, router, showArchived, theme.colors.text.secondary]);

    const renderRow = React.useCallback(
        ({ item }: Readonly<{ item: GroupVirtualizedRow }>) => item.render(),
        [],
    );

    return (
        <VirtualizedList
            testID="team-groups-virtualized-list"
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderRow}
            ListHeaderComponent={props.header === undefined ? null : <>{props.header}</>}
            style={{
                flex: 1,
                backgroundColor: theme.colors.surface.base,
                ...(Platform.OS === 'web' ? { minHeight: 0 } : {}),
            }}
            contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? 34 : 16 }}
            backendPreference="auto"
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
            renderHeaderActions={(context) => context.team.capabilities.manageGroups && context.canMutate ? (
                <NewGroupAction address={context.address} />
            ) : null}
        >
            {(context, header) => <GroupsList context={context} header={header} />}
        </TeamSection>
    );
});
