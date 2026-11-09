import * as React from 'react';
import { Redirect, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';
import { useFocusEffect } from '@/components/appShell/workspace/destinationRoute';
import type { TeamMembersListFilterV1 } from '@happier-dev/protocol/teams';
import { useUnistyles } from 'react-native-unistyles';

import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { useTeamMembersRoster, type TeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { getPreferredLanguage, t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamMemberDetailPath } from '../teamsRoutes';
import { TeamOwnerRequiredNotice } from './TeamOwnerRequiredNotice';
import { TeamMemberAddAction } from './TeamMemberAddAction';
import { TeamMemberRow } from './TeamMemberRow';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { teamReadFailureLabel } from '../teamMutationPresentation';
import { useTeamReadFailureAction } from '../useTeamReadFailureAction';

const MEMBER_CHUNK_SIZE = 12;

type MemberVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

const FILTERS: readonly TeamMembersListFilterV1[] = Object.freeze([
    'all',
    'owners_admins',
    'members',
    'guests',
    'suspended',
]);

function filterLabel(filter: TeamMembersListFilterV1): string {
    switch (filter) {
        case 'all':
            return t('teams.members.filterAll');
        case 'owners_admins':
            return t('teams.members.filterOwnersAndAdmins');
        case 'members':
            return t('teams.members.filterMembers');
        case 'guests':
            return t('teams.members.filterGuests');
        case 'suspended':
            return t('teams.members.filterSuspended');
    }
}

/** Narrows the roster by role or status: one choice among several, so a field select. */
const MemberFilterRow = React.memo(function MemberFilterRow(props: Readonly<{
    filter: TeamMembersListFilterV1;
    onChange: (filter: TeamMembersListFilterV1) => void;
}>) {
    const [open, setOpen] = React.useState(false);
    const items = React.useMemo(() => FILTERS.map((candidate) => ({
        id: candidate,
        title: filterLabel(candidate),
        testID: `team-members-filter:${candidate}`,
    })), []);
    return (
        <DropdownMenu
            testID="team-members-filter"
            open={open}
            onOpenChange={setOpen}
            selectedId={props.filter}
            items={items}
            onSelect={(id) => {
                setOpen(false);
                const next = FILTERS.find((candidate) => candidate === id);
                if (next) props.onChange(next);
            }}
            itemTrigger={{ title: t('teams.members.filterLabel') }}
        />
    );
});

/** The complete roster presentation; the route retains authenticated reads and focus refresh. */
export const TeamMembersView = React.memo(function TeamMembersView(props: Readonly<{
    context: TeamSectionContext;
    header?: React.ReactNode;
    roster: TeamMembersRoster;
    filter: TeamMembersListFilterV1;
    setFilter: (filter: TeamMembersListFilterV1) => void;
    query: string;
    setQuery: (query: string) => void;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const readFailureAction = useTeamReadFailureAction();
    const view = useHappierCollectionIndexView();
    const { context, roster, filter, setFilter, query, setQuery } = props;
    const language = getPreferredLanguage();
    const addressServerId = context.address.serverId;
    const teamId = context.address.teamId;
    const openMember = React.useCallback((membershipId: string) => {
        router.push(teamMemberDetailPath({ serverId: addressServerId, teamId }, membershipId));
    }, [router, addressServerId, teamId]);
    const canRead = context.team.capabilities.viewRoster;
    const searchTerm = query.trim();

    // The recovery candidates are exactly the rows the Home says may be given a
    // role — never a role comparison made here. "No candidate" is claimed only
    // once the whole sequence has been read: an unread page proves nothing.
    const ownerCandidateAvailable = roster.rows.some((membership) => membership.capabilities.setRole);
    const noOwnerCandidate = context.team.recovery?.kind === 'owner_required'
        && context.team.recovery.canAppointOwner
        && !ownerCandidateAvailable
        // A narrowed filter hides rows rather than proving they do not exist.
        && filter === 'all'
        // A lookup hides rows exactly as a narrowed filter does.
        && searchTerm === ''
        && !roster.hasMore
        && roster.status === 'ready'
        && roster.error === null;

    const rows = React.useMemo<readonly MemberVirtualizedRow[]>(() => {
        const result: MemberVirtualizedRow[] = [];
        const add = (key: string, render: () => React.ReactElement) => result.push({ key, render });

        if (!canRead) {
            add('forbidden', () => (
                <ItemGroup>
                    <SurfaceStateCard
                        testID="team-members-forbidden"
                        kind="denied"
                        size="line"
                        title={t('teams.denied.title')}
                    />
                </ItemGroup>
            ));
            return result;
        }

        if (context.team.recovery?.kind === 'owner_required') {
            add('owner-required', () => (
                <TeamOwnerRequiredNotice context={context} noCandidate={noOwnerCandidate} />
            ));
        }

        // The roster section opens with its own controls — find someone, narrow by role — and
        // continues into the member chunks as one sheet.
        add('controls', () => (
            <ItemGroup
                title={t('teams.tabs.members')}
                action={<TeamMemberAddAction context={context} presentation="section" />}
                virtualizedSegment={{ first: true, last: roster.rows.length === 0 && roster.status !== 'loading' && roster.status !== 'ready' }}
            >
                <SectionContentRow>
                    <CompactSearchField
                        testID="team-members-search"
                        value={query}
                        onChangeText={setQuery}
                        placeholder={t('teams.members.searchPlaceholder')}
                    />
                </SectionContentRow>
                <MemberFilterRow filter={filter} onChange={setFilter} />
            </ItemGroup>
        ));

        // The roster's known rows hold their place while the first page is read; an answered
        // roster with nobody to show says so on one line, where the rows would be.
        if (roster.status === 'loading' && roster.rows.length === 0) {
            add('loading', () => (
                <ItemGroup virtualizedSegment={{ first: false, last: true }}>
                    <ItemLoadStateRows
                        testID="team-members-loading"
                        state={{ kind: 'loading' }}
                        rows={4}
                        accessibilityLabel={t('teams.loading')}
                    />
                </ItemGroup>
            ));
        }

        if (roster.rows.length === 0 && roster.status === 'ready') {
            add('empty', () => (
                <ItemGroup virtualizedSegment={{ first: false, last: true }}>
                    <SurfaceStateCard
                        testID="team-members-empty"
                        kind="empty"
                        size="line"
                        title={t('teams.members.emptyTitle')}
                        reason={t('teams.members.emptyBody')}
                    />
                </ItemGroup>
            ));
        }

        for (let start = 0; start < roster.rows.length; start += MEMBER_CHUNK_SIZE) {
            const chunk = roster.rows.slice(start, start + MEMBER_CHUNK_SIZE);
            const last = start + MEMBER_CHUNK_SIZE >= roster.rows.length;
            add(`members:${chunk[0]!.id}`, () => (
                <ItemGroup virtualizedSegment={{ first: false, last }}>
                    {chunk.map((membership) => {
                        const leavesOwnMembership = membership.accountId === context.scope.accountId && context.team.capabilities.leave;
                        return (
                            <TeamMemberRow
                                key={membership.id}
                                membership={membership}
                                viewerAccountId={context.scope.accountId}
                                language={language}
                                leaveContext={leavesOwnMembership ? context : undefined}
                                onOpen={openMember}
                            />
                        );
                    })}
                </ItemGroup>
            ));
        }

        if (roster.error) {
            add('retry', () => (
                <AttentionBanner
                    testID="team-members-unavailable"
                    title={teamReadFailureLabel(roster.error!)}
                    action={readFailureAction(roster.error!, { onPress: roster.reload, testIDPrefix: 'team-members' })}
                />
            ));
        } else if (roster.hasMore && roster.rows.length > 0) {
            add('load-more', () => (
                <ItemGroup>
                    <Item
                        testID="team-members-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={roster.status === 'loading_more'}
                        disabled={roster.status === 'loading_more'}
                        onPress={roster.loadMore}
                        showChevron={false}
                    />
                </ItemGroup>
            ));
        }

        return result;
    }, [
        canRead,
        context,
        filter,
        setFilter,
        noOwnerCandidate,
        query,
        setQuery,
        roster,
        openMember,
        language,
        theme.colors.text.secondary,
    ]);

    const renderRow = React.useCallback(
        ({ item }: Readonly<{ item: MemberVirtualizedRow }>) => item.render(),
        [],
    );

    if (view === 'pending') return null;
    if (view === 'land') {
        const firstMember = roster.rows[0];
        if (canRead && firstMember) return <Redirect href={teamMemberDetailPath(context.address, firstMember.id) as never} />;
        return (
            <ItemList>
                {props.header}
                {!canRead ? (
                    <SurfaceStateCard kind="denied" size="line" title={t('teams.denied.title')} />
                ) : roster.error ? (
                    <SurfaceStateCard kind={roster.error.retryable ? 'error' : 'denied'} size="line"
                        title={teamReadFailureLabel(roster.error)}
                        action={readFailureAction(roster.error, { onPress: roster.reload, testIDPrefix: 'team-members' })} />
                ) : roster.status === 'ready' ? (
                    <SurfaceStateCard kind="empty" size="line" title={t('teams.members.emptyTitle')}
                        reason={t('teams.members.emptyBody')} />
                ) : null}
            </ItemList>
        );
    }

    return (
        <VirtualizedItemList
            testID="team-members-virtualized-list"
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderRow}
            ListHeaderComponent={props.header === undefined ? null : <>{props.header}</>}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={120}
            maintainVisibleContentPosition
        />
    );
});

const MemberRoster = React.memo(function MemberRoster(props: Readonly<{
    context: TeamSectionContext;
    header?: React.ReactNode;
}>) {
    const { context } = props;
    const [filter, setFilter] = React.useState<TeamMembersListFilterV1>('all');
    const [query, setQuery] = React.useState('');

    // The Home authorizes this roster on `viewTeam`, so every viewer it would
    // answer sees it. Management is a separate question, asked per control and
    // per row below: an ordinary member reads the roster and is offered nothing.
    const roster = useTeamMembersRoster({
        scope: context.scope,
        address: context.address,
        filter,
        query: query.trim(),
        enabled: context.team.capabilities.viewRoster,
    });
    const hasFocused = React.useRef(false);

    // The Add member route sits above this roster in the navigation stack. Its
    // successful mutation returns a canonical membership and then comes back;
    // re-reading this retained pager on that focus transition makes the new row
    // visible without waiting for the independent AccountChange catch-up. The
    // first focus is already covered by the pager's initial read, so it does not
    // issue a duplicate request.
    useFocusEffect(React.useCallback(() => {
        if (!hasFocused.current) {
            hasFocused.current = true;
            return;
        }
        void roster.reload();
    }, [roster.reload]));

    return <TeamMembersView {...props} roster={roster} filter={filter} setFilter={setFilter}
        query={query} setQuery={setQuery} />;
});

export const TeamMembersScreen = React.memo(function TeamMembersScreen(props: Readonly<{
    serverId: string;
    teamId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.tabs.members')}
            description={t('teams.pages.members')}
            presentation="virtualized-list"
        >
            {(context, header) => <MemberRoster context={context} header={header} />}
        </TeamSection>
    );
});
