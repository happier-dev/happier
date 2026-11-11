import * as React from 'react';
import type { TeamAddress } from '@/sync/domains/teams/teamAddress';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { TeamRow } from '@/components/settings/teams/TeamRow';
import { teamDetailPath, teamsCreatePath } from '@/components/settings/teams/teamsRoutes';
import { useTeamsDirectory } from '@/hooks/teams/useTeamsDirectory';
import { t } from '@/text';

import { HomeAdministrationSection } from './HomeAdministrationSection';
import { canInvitePeople, presentHomeInvitePeople } from './HomeInvitePeopleDialog';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { segmentHomeAdministrationRows } from './homeAdministrationVirtualizedSegments';
import { TeamCreationPolicyEditor, TeamsVisibilityPolicyEditor } from './HomeTeamsPolicySections';
import { homeAdministrationFeaturesPath } from './homeAdministrationRoutes';

type HomeTeamsVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

const HOME_TEAMS_CHUNK_SIZE = 12;

/**
 * The Teams a Home administrator governs on one exact Home.
 *
 * This is the governance scope, not the viewer's own membership list: a Home
 * owner administers Teams they have never joined, and joining is not what put
 * them here. It therefore asks for `administered` — which the Home authorizes
 * against `manageAllTeams` — restricted to this Home alone, even when the app is
 * showing several Homes elsewhere.
 *
 * Administering a Team is not access to its Sessions, and nothing here implies
 * otherwise. Team detail, membership and settings remain the Team surface's own
 * destinations, reached by the Home-qualified address.
 */
const HomeTeams = React.memo(function HomeTeams(
    props: Readonly<{ context: HomeAdministrationContext; header?: React.ReactNode }>,
) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const openTeam = React.useCallback((address: TeamAddress) => router.push(teamDetailPath(address)), [router]);
    const { context } = props;
    const serverId = context.scope.serverId;
    const [showArchived, setShowArchived] = React.useState(false);

    const mayGovern = context.projection.capabilities.manageAllTeams;
    const teamsEnabled = context.projection.teamsEnabled;
    // A Home that has told us it has no Teams is not asked for them, and a
    // viewer with no Team-governance authority is not asked on their behalf.
    const enabled = mayGovern && teamsEnabled;

    const serverIds = React.useMemo(() => [serverId], [serverId]);
    const directory = useTeamsDirectory({ scope: 'administered', serverIds, enabled });
    const archived = useTeamsDirectory({
        scope: 'administered',
        serverIds,
        archived: 'archived',
        // The explicit toggle is the user's request to read the archive. Once
        // opened, the answer controls whether the affordance remains visible.
        enabled: enabled && showArchived,
    });
    const archivedRetryable = archived.unavailableHomes.some((home) => home.retryable);
    const archivedLoading = archived.kind === 'loading'
        && archived.unavailableHomes.some((home) => home.reason === 'loading');
    const offerArchived = !showArchived
        || archived.kind === 'loading'
        || archived.archivedRows.length > 0
        || archived.stale
        || archived.unavailableHomes.some((home) => home.reason !== 'loading');
    const rows = React.useMemo<readonly HomeTeamsVirtualizedRow[]>(() => {
        const result: HomeTeamsVirtualizedRow[] = [];
        const add = (key: string, render: () => React.ReactElement) => result.push({ key, render });

        if (!teamsEnabled) {
            add('disabled', () => (
                // One message, and the way to change it (lab `hcPolicies-*` teams off).
                <ItemGroup>
                    <SurfaceStateCard
                        testID="home-teams-disabled"
                        kind="unavailable"
                        size="line"
                        title={t('homeGovernance.teamsDisabled')}
                        action={context.projection.capabilities.viewAdministration ? {
                            label: t('homeGovernance.teamsDisabledAction'),
                            onPress: () => router.push(homeAdministrationFeaturesPath(context.scope.serverId) as never),
                            testID: 'home-teams-disabled-features',
                        } : undefined}
                    />
                </ItemGroup>
            ));
            return result;
        }
        // Who creates Teams, and who sees them, head the Teams page (DR-09, lab `hcTeams-A`).
        add('policies', () => (
            <>
                <TeamCreationPolicyEditor context={context} />
                <TeamsVisibilityPolicyEditor context={context} />
            </>
        ));
        if (!mayGovern) {
            add('forbidden', () => (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="home-teams-forbidden"
                        kind="denied"
                        size="line"
                        title={t('homeGovernance.forbiddenTitle')}
                        reason={t('homeGovernance.forbiddenBody')}
                    />
                </ItemGroup>
            ));
            return result;
        }

        // Adding happens at the head of the Teams collection, in every state it can be in.
        const createAction = context.projection.capabilities.createTeam ? (
            <SectionActionButton
                testID="home-teams-create"
                icon="plus"
                title={t('teams.directory.newTeam')}
                onPress={() => router.push(teamsCreatePath({ administrationServerId: serverId }))}
            />
        ) : undefined;

        // Still loading only while the Home has not failed to answer; a failed first read is
        // stated inside the section below instead of a spinner that never resolves.
        const directoryRetryable = directory.unavailableHomes.some((home) => home.retryable);
        if (
            directory.kind === 'loading'
            && directory.rows.length === 0
            && directory.unavailableHomes.every((home) => home.reason === 'loading')
        ) {
            add('loading', () => (
                <ItemGroup title={t('homeGovernance.teams')} action={createAction}>
                    <ItemLoadStateRows testID="home-teams-loading" state={{ kind: 'loading' }} rows={3} accessibilityLabel={t('homeGovernance.teams')} />
                </ItemGroup>
            ));
            return result;
        }

        if (directory.rows.length === 0 && directory.partial) {
            // The Home could not list its Teams: the section and its create action stay, and the
            // unknown list says so with its next action, never as an empty Home.
            add('unavailable', () => (
                <ItemGroup
                    title={t('homeGovernance.teams')}
                    description={t('homeGovernance.unavailableBody')}
                    action={createAction}
                >
                    <SurfaceStateCard
                        testID="home-teams-unavailable"
                        kind="error"
                        size="line"
                        title={t('homeGovernance.unavailableTitle')}
                        action={directoryRetryable
                            ? { testID: 'home-teams-retry', label: t('homeGovernance.retry'), onPress: directory.refresh }
                            : undefined}
                    />
                </ItemGroup>
            ));
        } else if (directory.rows.length === 0) {
            add('empty', () => (
                <ItemGroup title={t('homeGovernance.teams')} action={createAction}>
                    <SurfaceStateCard testID="home-teams-empty" kind="empty" size="line" title={t('homeGovernance.teamsEmpty')} />
                </ItemGroup>
            ));
        } else {
            for (const segment of segmentHomeAdministrationRows(directory.rows, HOME_TEAMS_CHUNK_SIZE)) {
                const chunk = segment.items;
                const { first, last } = segment;
                add(`active:${chunk[0]!.address.teamId}`, () => (
                    <ItemGroup
                        title={first ? t('homeGovernance.teams') : undefined}
                        action={first ? createAction : undefined}
                        virtualizedSegment={{ first, last }}
                    >
                        {chunk.map((row) => (
                            <TeamRow
                                key={row.address.teamId}
                                row={row}
                                showHome={false}
                                onPress={openTeam}
                            />
                        ))}
                    </ItemGroup>
                ));
            }
        }

        if (offerArchived) {
            add('toggle-archived', () => (
                // A quiet button under the list, as on a Team's Groups (lab `tsGroups-A`), not a row.
                <ItemGroup surface="none">
                    <SectionButtonRow>
                        <RoundButton
                            testID="home-teams-toggle-archived"
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
            if (archivedLoading && archived.archivedRows.length === 0) {
                add('archived-loading', () => (
                    <ItemGroup title={t('teams.directory.archivedSection')}>
                        <ItemLoadStateRows testID="home-teams-archived-loading" state={{ kind: 'loading' }} rows={2} accessibilityLabel={t('teams.directory.archivedSection')} />
                    </ItemGroup>
                ));
            }
            for (const segment of segmentHomeAdministrationRows(archived.archivedRows, HOME_TEAMS_CHUNK_SIZE)) {
                const chunk = segment.items;
                const { first, last } = segment;
                add(`archived:${chunk[0]!.address.teamId}`, () => (
                    <ItemGroup
                        title={first ? t('teams.directory.archivedSection') : undefined}
                        virtualizedSegment={{ first, last }}
                    >
                        {chunk.map((row) => (
                            <TeamRow
                                key={`archived:${row.address.teamId}`}
                                row={row}
                                showHome={false}
                                onPress={openTeam}
                            />
                        ))}
                    </ItemGroup>
                ));
            }
            if (archived.partial && !archivedLoading) {
                add('archived-failure', () => (
                    <ItemGroup title={archived.archivedRows.length === 0 ? t('teams.directory.archivedSection') : undefined}>
                        <ItemLoadStateRows
                            testID="home-teams-archived"
                            state={{
                                kind: 'failed',
                                reason: t('homeGovernance.unavailableBody'),
                                onRetry: archivedRetryable ? archived.refresh : undefined,
                                homeServerIds: [serverId],
                            }}
                        />
                    </ItemGroup>
                ));
            }
        }

        if (directory.partial && directory.rows.length > 0) {
            add('retry', () => (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="home-teams-partial"
                        kind="error"
                        size="line"
                        title={t('homeGovernance.unavailableBody')}
                        action={{ testID: 'home-teams-retry', label: t('homeGovernance.retry'), onPress: directory.refresh }}
                    />
                </ItemGroup>
            ));
        } else if (directory.hasMore) {
            add('load-more', () => (
                <ItemGroup surface="none">
                    <SectionButtonRow>
                        <RoundButton testID="home-teams-load-more" size="small" display="inverted" title={t('homeGovernance.loadMore')} onPress={directory.loadMore} />
                    </SectionButtonRow>
                </ItemGroup>
            ));
        }
        return result;
    }, [archived, archivedLoading, archivedRetryable, context, directory, mayGovern, offerArchived, openTeam, router, serverId, showArchived, teamsEnabled, theme.colors.text.secondary]);

    const renderRow = React.useCallback(({ item }: Readonly<{ item: HomeTeamsVirtualizedRow }>) => item.render(), []);

    return (
        <VirtualizedItemList
            testID="home-teams-virtualized-list"
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderRow}
            ListHeaderComponent={props.header == null ? null : <>{props.header}</>}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={120}
            maintainVisibleContentPosition
        />
    );
});

export const HomeAdministrationTeamsScreen = React.memo(function HomeAdministrationTeamsScreen(
    props: Readonly<{ serverId: string }>,
) {
    return (
        <HomeAdministrationSection
            serverId={props.serverId}
            title={t('homeGovernance.teams')}
            description={t('homeGovernance.pages.teams')}
            presentation="virtualized-list"
            // Teams is where people are admitted, so Invite people is its primary (lab `hcTeams-A`).
            pageActions={(context) => (canInvitePeople(context)
                ? {
                    primaryAction: {
                        title: t('homeGovernance.invite.action'),
                        testID: 'home-teams-invite',
                        onPress: () => { presentHomeInvitePeople({ serverId: context.scope.serverId }); },
                    },
                }
                : {})}
        >
            {(context, header) => <HomeTeams context={context} header={header} />}
        </HomeAdministrationSection>
    );
});
