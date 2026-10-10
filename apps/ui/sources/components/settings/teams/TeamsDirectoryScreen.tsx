import * as React from 'react';
import { Redirect, useLocalSearchParams, useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { EmptyState } from '@/components/ui/empty/EmptyState';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { teamAddressKey } from '@/sync/domains/teams/teamAddress';
import { t } from '@/text';

import { TeamRow } from './TeamRow';
import { teamCredentialCreatePath, teamDetailPath, teamsCreatePath, type TeamCredentialSourceHint } from './teamsRoutes';
import type { TeamsDirectoryRow, TeamsDirectoryUnavailableHome } from './teamsDirectoryViewState';
import { teamsUnavailableHomeReason } from './teamsDirectoryViewState';
import { TeamsCollectionAddButton } from './collection/TeamsCollectionRail';
import {
    readLastVisitedTeamsCollectionTeam,
    readTeamCredentialSourceHint,
    resolveTeamsCollectionLanding,
} from './collection/teamsCollection';
import { useTeamsCollection, type TeamsCollection } from './collection/useTeamsCollection';
import { teamsCreateRefusalText } from './collection/teamsCreateGuidanceText';
import { homeTeamCreationPolicyHref } from '@/components/settings/home/governance/homeTeamsPolicySettings';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

const TEAM_DIRECTORY_CHUNK_SIZE = 12;

type TeamsDirectoryVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

const UnavailableHomes = React.memo(function UnavailableHomes(props: Readonly<{
    homes: readonly TeamsDirectoryUnavailableHome[];
    onRetry: () => void;
    /**
     * Distinguishes the active list's report from the archived list's, because
     * both can name the same Home and a surface that identified them the same
     * way could not say which read a person was being told about.
     */
    testIDPrefix?: string;
    retryTestID?: string;
}>) {
    if (props.homes.length === 0) return null;

    const prefix = props.testIDPrefix ?? 'teams-home-unavailable';
    const retryable = props.homes.some((home) => home.retryable);
    return (
        <ItemGroup title={t('teams.directory.unreachableHomes')} description={t('teams.directory.partialHomes')}>
            {props.homes.map((home) => (
                <Item
                    key={home.serverId}
                    testID={`${prefix}:${home.serverId}`}
                    title={home.homeName}
                    subtitle={teamsUnavailableHomeReason(home)}
                    loading={home.reason === 'loading'}
                    mode="info"
                    showChevron={false}
                />
            ))}
            {retryable ? (
                <Item
                    testID={props.retryTestID ?? 'teams-directory-retry'}
                    title={t('teams.unavailable.retry')}
                    onPress={props.onRetry}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
});

/**
 * No Teams in any Home in view: what a Team is for, then the way to create one — or, when no Home
 * lets this viewer create one, why and whom to ask. An administrator who creates Teams for others is
 * also offered the policy that would let everyone create them.
 */
const TeamsEmptyState = React.memo(function TeamsEmptyState(props: Readonly<{
    collection: TeamsCollection;
    onCreate: () => void;
}>) {
    const router = useRouter();
    const { collection } = props;
    const { refusal, openCreationPolicyServerId } = collection.createGuidance;
    return (
        <EmptyState
            testID="teams-directory-empty"
            layout="page"
            // An invitation to add only when this viewer can create a Team.
            variant={collection.showCreateTeam ? 'add' : 'default'}
            iconName="users"
            title={t('teams.directory.emptyTitle')}
            subtitle={t('teams.directory.emptyBody')}
            primaryAction={collection.showCreateTeam ? {
                label: t('teams.directory.newTeam'),
                onPress: props.onCreate,
                disabled: !collection.canCreateTeam,
                testID: 'teams-directory-empty-create',
            } : undefined}
            secondaryAction={openCreationPolicyServerId ? {
                label: t('teams.directory.letEveryoneCreate'),
                onPress: () => router.push(homeTeamCreationPolicyHref(openCreationPolicyServerId) as never),
                testID: 'teams-directory-open-creation-policy',
            } : undefined}
            actionUnavailableReason={refusal ? teamsCreateRefusalText(refusal) : undefined}
        />
    );
});

/**
 * `/settings/teams`. Beside the Teams rail a Team is always open, so the index lands on one (or,
 * when sharing a credential, asks which Team to share it with); where no rail shows, the index is
 * the Teams page and each row pushes its Team.
 */
export const TeamsDirectoryScreen = React.memo(function TeamsDirectoryScreen() {
    const view = useHappierCollectionIndexView();
    const navigation = useNavigation();
    const params = useLocalSearchParams();
    const sourceHint = React.useMemo(() => readTeamCredentialSourceHint(params), [params]);

    React.useEffect(() => {
        navigation.setOptions({ title: t('teams.title') });
    }, [navigation]);

    if (view === 'pending') return null;
    if (view === 'land') return <TeamsCollectionLanding sourceHint={sourceHint} />;
    return <TeamsDirectoryPage sourceHint={sourceHint} />;
});

/** Beside the rail: land on a Team, or explain the collection when there is none to land on. */
const TeamsCollectionLanding = React.memo(function TeamsCollectionLanding(props: Readonly<{
    sourceHint: TeamCredentialSourceHint | null;
}>) {
    const router = useRouter();
    const collection = useTeamsCollection({ sourceHint: props.sourceHint, query: '' });
    const { active } = collection;

    if (props.sourceHint) {
        // Sharing a credential: the rail beside this page is the choice.
        return (
            <ItemList>
                <PageHeader
                    testID="teams-share-header"
                    title={t('teams.credentials.create.title')}
                    description={t('teams.directory.chooseTeamToShare')}
                />
            </ItemList>
        );
    }

    // Wait for an answer so "first Team" is not a guess. The rail beside this pane shows the one
    // loading state; the pane keeps only its header meanwhile.
    if (active.kind === 'loading' && active.rows.length === 0) {
        return (
            <ItemList>
                <PageHeader testID="teams-directory-header" title={t('teams.title')} description={t('teams.pages.directory')} />
            </ItemList>
        );
    }
    const landing = resolveTeamsCollectionLanding(active.rows, readLastVisitedTeamsCollectionTeam());
    if (landing) return <Redirect href={teamDetailPath(landing) as never} />;

    return (
        <ItemList>
            <PageHeader testID="teams-directory-header" title={t('teams.title')} description={t('teams.pages.directory')} />
            <TeamsEmptyState collection={collection} onCreate={() => router.push(teamsCreatePath() as never)} />
            <UnavailableHomes
                homes={active.unavailableHomes.filter((home) => home.reason !== 'loading')}
                onRetry={active.refresh}
            />
        </ItemList>
    );
});

/** The Teams page where no rail shows (phones, narrow windows): the list is the page. */
const TeamsDirectoryPage = React.memo(function TeamsDirectoryPage(props: Readonly<{
    sourceHint: TeamCredentialSourceHint | null;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { sourceHint } = props;
    const [query, setQuery] = React.useState('');
    const collection = useTeamsCollection({ sourceHint, query });

    const openTeam = React.useCallback(
        (serverId: string, teamId: string) => {
            const address = { serverId, teamId };
            router.push((sourceHint
                ? teamCredentialCreatePath(address, sourceHint)
                : teamDetailPath(address)) as never);
        },
        [router, sourceHint],
    );

    const createTeam = React.useCallback(() => router.push(teamsCreatePath() as never), [router]);
    const rows = useTeamsDirectoryRows({ collection, sourceHint, openTeam, createTeam });

    const renderRow = React.useCallback(
        ({ item }: Readonly<{ item: TeamsDirectoryVirtualizedRow }>) => item.render(),
        [],
    );

    return (
        <ListPresentationProvider value="page">
            <VirtualizedList
                testID="teams-directory-virtualized-list"
                data={rows}
                keyExtractor={(item) => item.key}
                renderItem={renderRow}
                ListHeaderComponent={(
                    <>
                        <PageHeader
                            testID="teams-directory-header"
                            title={sourceHint ? t('teams.credentials.create.title') : t('teams.title')}
                            description={sourceHint ? t('teams.directory.chooseTeamToShare') : t('teams.pages.directory')}
                            actions={collection.showCreateTeam && sourceHint === null ? (
                                <TeamsCollectionAddButton
                                    canCreate={collection.canCreateTeam}
                                    onPress={() => router.push(teamsCreatePath() as never)}
                                />
                            ) : undefined}
                        />
                        {collection.searchable ? (
                            <CompactSearchField
                                testID="teams-directory-search"
                                value={query}
                                onChangeText={setQuery}
                                placeholder={t('teams.directory.searchLoadedPlaceholder')}
                                placement="page"
                            />
                        ) : null}
                    </>
                )}
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
        </ListPresentationProvider>
    );
});

function useTeamsDirectoryRows(input: Readonly<{
    collection: TeamsCollection;
    sourceHint: TeamCredentialSourceHint | null;
    openTeam: (serverId: string, teamId: string) => void;
    createTeam: () => void;
}>): readonly TeamsDirectoryVirtualizedRow[] {
    const { collection, sourceHint, openTeam, createTeam } = input;
    const {
        active,
        archived,
        archivedPending,
        normalizedQuery,
        showArchived,
        toggleArchived,
        visibleActiveRows,
        visibleArchivedRows,
    } = collection;

    return React.useMemo<readonly TeamsDirectoryVirtualizedRow[]>(() => {
        const result: TeamsDirectoryVirtualizedRow[] = [];
        const add = (key: string, render: () => React.ReactElement) => result.push({ key, render });
        const addTeamChunks = (keyPrefix: string, title: string, list: readonly TeamsDirectoryRow[]) => {
            for (let start = 0; start < list.length; start += TEAM_DIRECTORY_CHUNK_SIZE) {
                const chunk = list.slice(start, start + TEAM_DIRECTORY_CHUNK_SIZE);
                const first = start === 0;
                const last = start + TEAM_DIRECTORY_CHUNK_SIZE >= list.length;
                add(`${keyPrefix}:${teamAddressKey(chunk[0]!.address)}`, () => (
                    <ItemGroup title={first ? title : undefined} virtualizedSegment={{ first, last }}>
                        {chunk.map((row) => (
                            <TeamRow
                                key={`${keyPrefix}:${teamAddressKey(row.address)}`}
                                row={row}
                                showHome={active.multiHome}
                                onPress={() => openTeam(row.address.serverId, row.address.teamId)}
                            />
                        ))}
                    </ItemGroup>
                ));
            }
        };

        // Homes still being read are covered by the loading row; only an answer that failed is named.
        const answeredUnavailableHomes = active.unavailableHomes.filter((home) => home.reason !== 'loading');
        if (active.kind === 'loading' && answeredUnavailableHomes.length === 0) {
            add('loading', () => (
                <ItemGroup>
                    <ItemLoadStateRows
                        testID="teams-directory-loading"
                        state={{ kind: 'loading' }}
                        rows={3}
                        accessibilityLabel={t('teams.directory.loading')}
                    />
                </ItemGroup>
            ));
            return result;
        }

        if (active.stale) {
            add('stale', () => (
                <AttentionBanner
                    testID="teams-directory-stale"
                    title={t('teams.stale.label')}
                    accessibilityLiveRegion="polite"
                    action={{ label: t('teams.unavailable.retry'), onPress: active.refresh }}
                />
            ));
        }

        if (active.kind === 'empty') {
            add('empty', () => <TeamsEmptyState collection={collection} onCreate={createTeam} />);
        } else {
            addTeamChunks('active', t('teams.title'), visibleActiveRows);
            if (active.rows.length > 0 && visibleActiveRows.length === 0) {
                add('search-empty', () => (
                    <ItemGroup>
                        <Item
                            testID="teams-directory-search-empty"
                            title={t(collection.activeIncomplete ? 'teams.directory.noLoadedMatches' : 'teams.directory.noMatches')}
                            mode="info"
                            showChevron={false}
                        />
                    </ItemGroup>
                ));
            }
        }

        if (active.hasMore) {
            add('load-more', () => (
                <ItemGroup>
                    <Item testID="teams-directory-load-more" title={t('homeGovernance.loadMore')} onPress={active.loadMore} showChevron={false} />
                </ItemGroup>
            ));
        }

        if (answeredUnavailableHomes.length > 0) {
            add('unavailable-homes', () => (
                <UnavailableHomes homes={answeredUnavailableHomes} onRetry={active.refresh} />
            ));
        }

        if (sourceHint === null && collection.offerArchived) {
            add('toggle-archived', () => (
                <ItemGroup>
                    <Item
                        testID="teams-directory-toggle-archived"
                        title={showArchived ? t('teams.directory.hideArchived') : t('teams.directory.showArchived')}
                        accessibilityExpanded={showArchived}
                        onPress={toggleArchived}
                        showChevron={false}
                    />
                </ItemGroup>
            ));
        }

        if (showArchived && sourceHint === null) {
            if (visibleArchivedRows.length > 0) {
                addTeamChunks('archived', t('teams.directory.archivedSection'), visibleArchivedRows);
            } else if (archivedPending) {
                add('archived-loading', () => (
                    <ItemGroup title={t('teams.directory.archivedSection')}>
                        <Item testID="teams-directory-archived-loading" title={t('teams.directory.archivedSection')} loading mode="info" showChevron={false} />
                    </ItemGroup>
                ));
            } else if (archived.unavailableHomes.length === 0 && normalizedQuery.length === 0) {
                add('archived-empty', () => (
                    <ItemGroup title={t('teams.directory.archivedSection')} description={t('teams.directory.archivedEmptyBody')}>
                        <Item testID="teams-directory-archived-empty" title={t('teams.directory.archivedEmpty')} mode="info" showChevron={false} />
                    </ItemGroup>
                ));
            }

            if (!archivedPending && archived.unavailableHomes.length > 0) {
                add('archived-unavailable-homes', () => (
                    <UnavailableHomes
                        homes={archived.unavailableHomes}
                        onRetry={archived.refresh}
                        testIDPrefix="teams-archived-home-unavailable"
                        retryTestID="teams-directory-archived-retry"
                    />
                ));
            }

            if (archived.hasMore) {
                add('archived-load-more', () => (
                    <ItemGroup>
                        <Item testID="teams-directory-archived-load-more" title={t('homeGovernance.loadMore')} onPress={archived.loadMore} showChevron={false} />
                    </ItemGroup>
                ));
            }
        }

        return result;
    }, [active, archived, archivedPending, collection, createTeam, normalizedQuery, openTeam, showArchived, sourceHint, toggleArchived, visibleActiveRows, visibleArchivedRows]);
}
