import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { useCurrentUiContextLocalCommands } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { PageColumn } from '@/components/ui/layout/contentWidthMode';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList, type ItemListProps } from '@/components/ui/lists/ItemList';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HomeCredentialUnreadableCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { useTeamsDirectoryRow } from '@/hooks/teams/useTeamsDirectoryRow';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { Modal } from '@/modal';
import { serverAccountScopedTeamKey } from '@/sync/domains/teams/teamAddress';
import { presentTeamEntryUnavailableReason } from '@/components/teams/entry/teamAuthenticationFailure';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import { t } from '@/text';

import { teamPageHeaderMeta, type TeamSectionContext } from './teamSectionContext';
import { teamSettingsPath, teamsDirectoryPath } from './teamsRoutes';
import { teamReadFailureLabel } from './teamMutationPresentation';
import { useTeamReadFailureAction } from './useTeamReadFailureAction';
import { isApprovalRequestV2InFlightStatus } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

/**
 * A read the page makes itself (a Group, its roster) that is not current: the page keeps what it
 * had, and the one stale notice says so with one retry for every such read.
 */
export type TeamPageStaleRead = Readonly<{
    failure: HomeDomainFailure<string> | ScopedSnapshotError | null;
    retry: () => void;
}>;

/** Builds the Team page's header and condition banners, folding the page's own stale reads in. */
export type TeamSectionRenderHeader = (pageReads?: readonly TeamPageStaleRead[]) => React.ReactNode;

const NO_PAGE_READS: readonly TeamPageStaleRead[] = Object.freeze([]);
/** A virtualized Team page's condition is its one row. */
const CONDITION_ROWS: readonly string[] = Object.freeze(['condition']);
const conditionRowKey = (row: string) => row;

/**
 * The page head of a Team destination: a sub-page names itself (`title`, `description`); an entity
 * page (the Team itself, a member, a Group) renders its own identity header once the Team is known.
 */
export type TeamSectionHeader = Readonly<{
    /** Sub-page title ("Members"). Also titles the page while the Team is still being read. */
    title?: string;
    /** One sentence saying what the page is for. */
    description?: string;
    /** An entity header built from the Team, replacing the title/description header once it exists. */
    render?: (context: TeamSectionContext) => React.ReactNode;
}>;

/** The Team shell's page identity, shared with local presentation-only stage readers. */
export function TeamSectionPageHeader(props: Readonly<{
    title: string;
    description?: string;
    actions?: React.ReactNode;
    alwaysShowTitle?: boolean;
    teamName: string | null;
    /** The Team is still being read and no row names it yet: its name holds its place as a pending fact. */
    teamNamePending?: boolean;
    homeName?: string;
}>): React.ReactElement {
    return <PageHeader
        testID="team-page-header"
        title={props.title}
        description={props.description}
        actions={props.actions}
        alwaysShowTitle={props.alwaysShowTitle}
        meta={teamPageHeaderMeta({ pageTitle: props.title, teamName: props.teamName, teamNamePending: props.teamNamePending, homeName: props.homeName })}
    />;
}

/**
 * A condition that occupies the page because there is genuinely nothing else truthful to show.
 * The page header stays above it, so the page does not change shape when the Team arrives.
 */
const TeamStateCard = React.memo(function TeamStateCard(props: Readonly<{
    kind: 'unavailable' | 'error' | 'warning';
    title: string;
    body?: string;
    action?: Readonly<{ label: string; onPress: () => void }>;
    testID: string;
}>) {
    return (
        <SurfaceStateCard
            testID={props.testID}
            kind={props.kind}
            title={props.title}
            reason={props.body}
            action={props.action}
            accessibilitySemantics="alert"
        />
    );
});

function TeamApprovalBanner(props: React.ComponentProps<typeof AttentionBanner> & Readonly<{
    action: NonNullable<React.ComponentProps<typeof AttentionBanner>['action']>;
}>) {
    useCurrentUiContextLocalCommands([{
        key: 'approval.review.open', title: props.action.label, invoke: props.action.onPress,
    }], { contextKey: props.testID });
    return <AttentionBanner {...props} />;
}

/**
 * The one place a Team destination decides how its Team's condition is shown.
 *
 * Overview, Members, Groups, Invitations and Settings all render through this,
 * so the freshness notice, the offline explanation, the archived read-only
 * notice and the retry cannot drift between them. Sections receive the Team only
 * once it exists, so no section defends itself against a Home that has not
 * answered — and none of them re-derives whether a write may be offered.
 *
 * Every Team destination is a configuration page: the page header comes first in every state, then
 * any condition banner (approval, stale, archived), then the destination's own sections.
 */
export const TeamSection = React.memo(function TeamSection(props: Readonly<{
    serverId: string;
    teamId: string;
    /** Falls back to the Team's own name once the Home has answered. */
    title?: string;
    /** The sub-page's purpose line. */
    description?: string;
    /** An entity header rendered from the Team once it exists (the Team overview). */
    renderHeader?: (context: TeamSectionContext) => React.ReactNode;
    /**
     * The page is about something the child loads itself (a member, a Group): once the Team exists
     * the child renders its own `PageHeader` first and then the condition banners it receives as
     * the second argument of `children`, so the banners always sit under the page's identity.
     */
    childRendersHeader?: boolean;
    /** The page itself says the Team is archived and offers restore (Settings), so no second notice is drawn here. */
    restoresHere?: boolean;
    /**
     * `embedded`: the section lives inside another surface (the Home console's Invite people dialog),
     * which owns the title and the scroll container. Conditions render without a page header, the
     * banners sit above the child, and the screen title is left alone.
     * `virtualized-list`: the child draws the page with a `VirtualizedItemList` (the page scroller owns the page
     * scope) and receives the header and conditions to place in its list header.
     */
    presentation?: 'item-list' | 'virtualized-list' | 'embedded';
    /** The page column (`ItemList`); a page with an aside beside its sections reads in the wide one. */
    pageColumn?: PageColumn;
    listScroll?: Pick<ItemListProps, 'onScroll' | 'scrollEventThrottle'>;
    /**
     * The page's known sections, holding their rows as skeletons while the Team is read, so the
     * page keeps its shape when the Team arrives. Without it the wait is one state under the header. `known.row` is
     * the Team's row as the Teams directory already holds it (the row the rail draws), or `null` when this device has
     * not read it: a page may draw what that row already says instead of reserving it.
     */
    renderLoading?: (known: Readonly<{
        row: TeamSectionContext['team'] | null;
        scope: ServerAccountScope | null;
        address: TeamSectionContext['address'] | null;
        homeName: string | undefined;
    }>) => React.ReactNode;
    /**
     * An entity page's own header while the Team is read: what is already known of it (its mark, its Home), so
     * the header that arrives stands where this one stood. Without it the page title stands above the wait.
     */
    renderLoadingHeader?: (known: Readonly<{ homeName: string | undefined; scope: ServerAccountScope | null }>) => React.ReactNode;
    /** Quiet actions at the head of a sub-page whose content has no section title to carry them. */
    renderHeaderActions?: (context: TeamSectionContext) => React.ReactNode;
    /**
     * `renderHeader` is for a page that reads more than the Team (a Group and its roster): it passes
     * those reads so one outage is one notice, not one per read.
     */
    children: (context: TeamSectionContext, header: React.ReactNode | undefined, renderHeader: TeamSectionRenderHeader) => React.ReactNode;
}>) {
    const router = useRouter();
    const binding = useTeamBinding(props.serverId, props.teamId);
    const projection = binding.kind === 'bound' ? binding : binding.kind === 'resolving' ? binding.retained : undefined;
    const readFailureAction = useTeamReadFailureAction(projection?.address);
    const scopeKey = projection
        ? serverAccountScopedTeamKey(projection.scope, projection.address)
        : `unbound:${props.serverId}:${props.teamId}`;
    const mounted = useMountedRef();
    const currentScopeKey = React.useRef(scopeKey);
    currentScopeKey.current = scopeKey;
    const settleLeave = React.useCallback<TeamSectionContext['settleLeave']>((outcome) => {
        if (!mounted.current || currentScopeKey.current !== scopeKey) return;
        if (outcome.kind === 'succeeded') router.replace('/settings/teams');
        else if (outcome.message !== null) Modal.alert(t('homeGovernance.changeFailedTitle'), outcome.message);
    }, [mounted, router, scopeKey]);
    const approvalRefresh = React.useCallback(() => {
        if (binding.kind === 'bound') binding.refresh();
    }, [binding]);
    const {
        approvalId,
        approvalStatus,
        approvalPending,
        isLoading: approvalLoading,
        error: approvalError,
        requestApproval,
    } = useActionApprovalContinuation({
        scopeKey,
        serverId: props.serverId,
        onExecuted: approvalRefresh,
    });

    const readyTeamName = projection?.state.kind === 'ready' ? projection.state.team.name : null;
    // While the Team is read, the row the Teams rail already draws names it, so the header that arrives stands
    // where this one stood. One key-scoped subscription to that row.
    const directoryRow = useTeamsDirectoryRow(projection?.scope ?? null, props.teamId);
    const resolvedTitle = props.title ?? readyTeamName ?? t('teams.title');

    // An entity page (the Team, a member, a Group) names itself in its own header, and the
    // collection layout leaves the phone header untitled for it, as every Settings page. Its
    // condition states keep the page title for the same reason.
    const headsItself = props.renderHeader !== undefined || props.childRendersHeader === true;
    // The phone bar above the page is the settings registry's (Back alone): the page names itself, so it hands the
    // navigator no title of its own, however the page was entered.
    const embedded = props.presentation === 'embedded';

    const renderPlainHeader = (actions?: React.ReactNode, reading = false) => (
        <TeamSectionPageHeader
            title={resolvedTitle}
            description={props.description}
            actions={actions}
            alwaysShowTitle={headsItself}
            teamName={readyTeamName ?? (reading ? directoryRow?.name ?? null : null)}
            teamNamePending={reading && readyTeamName === null && directoryRow === null}
            homeName={projection?.homeName ?? ('homeName' in binding ? binding.homeName : undefined)}
        />
    );
    const plainHeader = renderPlainHeader();

    // A page with nothing to show but its condition: the header, then the condition, in the same list the loaded
    // page draws, so its header (and its Back) is measured against the same pane and keeps its place on arrival.
    const conditionPage = (condition: React.ReactNode, header: React.ReactNode = plainHeader) => embedded ? condition
        : props.presentation === 'virtualized-list' ? (
            <VirtualizedItemList
                data={CONDITION_ROWS}
                keyExtractor={conditionRowKey}
                renderItem={() => <ItemGroup surface="none">{condition}</ItemGroup>}
                ListHeaderComponent={<>{header}</>}
            />
        ) : (
            <ItemList pageColumn={props.pageColumn}>
                {header}
                {condition}
            </ItemList>
        );
    // While the Team is read, one quiet line waits where the page's sections begin (as on the Team's Overview).
    const loadingPage = (testID: string) => {
        const body = props.renderLoading?.({
            row: directoryRow,
            scope: projection?.scope ?? null,
            address: projection?.address ?? null,
            homeName: projection?.homeName ?? ('homeName' in binding ? binding.homeName : undefined),
        }) ?? <SurfaceStateCard testID={testID} size="line" kind="loading" title={t('teams.loading')} accessibilitySemantics="status" />;
        const loadingHeader = props.renderLoadingHeader?.({
            homeName: projection?.homeName ?? ('homeName' in binding ? binding.homeName : undefined),
            scope: projection?.scope ?? null,
        }) ?? renderPlainHeader(undefined, true);
        if (embedded || props.presentation === 'virtualized-list' || props.childRendersHeader) return conditionPage(body, loadingHeader);
        // The loaded page's own structure (its header slot, then its body under the Team's key), so a header and a
        // body that render the loaded page's own elements stay mounted when the Team answers: no remount, no lost focus.
        return (
            <ItemList pageColumn={props.pageColumn} {...props.listScroll}>
                <>{loadingHeader}</>
                <React.Fragment key={scopeKey}>{body}</React.Fragment>
            </ItemList>
        );
    };

    if (!projection) {
        switch (binding.kind) {
            case 'resolving':
                return loadingPage('team-resolving');
            case 'signed_out':
                return conditionPage(<TeamStateCard kind="unavailable" title={t('homeGovernance.signedOutTitle')} testID="team-signed-out" />);
            case 'credential_unreadable':
                return conditionPage(<HomeCredentialUnreadableCard serverId={binding.serverId} testID="team-credential-unreadable" />);
            default:
                return conditionPage(<TeamStateCard kind="unavailable" title={t('teams.errors.notFound')} testID="team-unknown-home" />);
        }
    }

    const { state, homeName, address, refresh } = projection;

    if (state.kind === 'unobserved' || state.kind === 'loading') {
        return loadingPage('team-loading');
    }

    if (state.kind === 'unavailable' && state.error.code === 'team_authentication_required') {
        // The Home recognised this member but the current sign-in does not
        // satisfy this Team's authentication. The recovery is the canonical
        // exact-Home Team entry for this route's own Home (L03/02 §8.2), never a
        // generic denial and never an automatic retry of the refused read.
        const presentation = presentTeamEntryUnavailableReason('sso_required');
        return conditionPage(
            <TeamStateCard
                kind="warning"
                title={presentation?.title ?? t('teams.denied.title')}
                body={presentation?.body}
                action={{
                    label: t('teams.entry.signInToTeam'),
                    onPress: () => router.push(teamSignInReturnPath({
                        teamId: props.teamId,
                        serverId: props.serverId,
                    })),
                }}
                testID="team-authentication-required"
            />,
        );
    }

    if (state.kind === 'unavailable') {
        // `forbidden`/`unauthorized` are the Home's settled answers about this
        // Account and `unsupported` is its settled answer about itself. None of
        // them is offered a retry that would ask the same question again.
        // A Team this link cannot open (stale, malformed, or one the viewer is not in) is one state: its title says
        // the Team is not available and Teams is the way on; the role title stays for a real role refusal.
        const denied = state.error.kind === 'forbidden' || state.error.kind === 'unauthorized';
        const invalidLink = state.error.code === 'invalid_team_input';
        const openTeams = invalidLink || state.error.code === 'team_not_found';
        return conditionPage(
            <TeamStateCard
                kind={denied || openTeams ? 'unavailable' : 'error'}
                title={openTeams ? t('teams.errors.notFound') : denied ? t('teams.denied.title') : t('teams.unavailable.title')}
                body={invalidLink ? t('teams.errors.invalidTeamLink') : openTeams ? undefined : teamReadFailureLabel(state.error)}
                action={openTeams
                    ? { label: t('teams.title'), onPress: () => router.push(teamsDirectoryPath()) }
                    : readFailureAction(state.error, { onPress: refresh })}
                testID="team-unavailable"
            />,
        );
    }

    const context: TeamSectionContext = {
        scope: state.scope,
        address,
        homeName,
        team: state.team,
        staleReadFailure: state.stale ? state.error ?? null : null,
        // An archived Team is read-only for everyone; restore stays available to
        // the viewers whose projected capability actually backs it.
        mutationsAvailable: state.mutationsAvailable,
        archived: state.archived,
        canMutate: state.mutationsAvailable && !state.archived && !approvalPending,
        approvalPending,
        refresh,
        requestApproval,
        settleLeave,
    };

    // Restore lives in the Team's Settings; the archived notice leads there, except on Settings itself.
    const canRestore = state.team.capabilities.restoreTeam
        && state.mutationsAvailable;

    // The Team's own read state, read once here so the header builder below closes over plain values.
    const { stale: teamStale, archived: teamArchived } = state;
    const renderHeader: TeamSectionRenderHeader = (pageReads = NO_PAGE_READS) => {
        // One outage is one notice: the Team's own read and the page's reads that are not current
        // share it, it names the first failure, and its one retry asks every one of them again.
        const staleReads: readonly TeamPageStaleRead[] = teamStale
            ? [{ failure: context.staleReadFailure ?? null, retry: refresh }, ...pageReads]
            : pageReads;
        const failure = staleReads.find((read) => read.failure !== null)?.failure ?? null;
        const retryAll = () => {
            for (const read of staleReads) read.retry();
        };
        const retry = { label: t('teams.unavailable.retry'), onPress: retryAll, testID: 'team-stale-retry' };
        const staleAction = failure === null
            ? retry
            : readFailureAction(failure, { onPress: retryAll, testIDPrefix: 'team-stale' });
        return (
        <>
            {embedded || props.childRendersHeader ? null : props.renderHeader ? props.renderHeader(context) : renderPlainHeader(props.renderHeaderActions?.(context))}
            {approvalId ? (
                <TeamApprovalBanner
                    testID="team-approval"
                    tone="neutral"
                    title={t('approvals.title')}
                    description={approvalError
                        ? t('approvals.loadError')
                        : approvalLoading || isApprovalRequestV2InFlightStatus(approvalStatus)
                            ? t('approvals.status.open')
                            : undefined}
                    accessibilityLiveRegion={approvalError ? 'assertive' : 'polite'}
                    action={{
                        label: t('approvals.details'),
                        onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(props.serverId)}`),
                    }}
                />
            ) : null}
            {staleReads.length > 0 ? (
                <AttentionBanner
                    testID="team-stale"
                    title={failure ? teamReadFailureLabel(failure) : t('teams.stale.label')}
                    description={failure ? t('teams.stale.label') : undefined}
                    accessibilityLiveRegion="polite"
                    action={staleAction}
                />
            ) : null}

            {teamArchived && props.restoresHere !== true ? (
                <AttentionBanner
                    testID="team-archived"
                    tone="neutral"
                    title={t('teams.directory.archivedBadge')}
                    description={t('teams.archive.readOnly')}
                    action={canRestore ? {
                        label: t('teams.archive.openSettings'),
                        onPress: () => router.push(teamSettingsPath(address)),
                    } : null}
                />
            ) : null}
        </>
        );
    };
    const header = renderHeader();

    if (embedded) {
        return (
            <React.Fragment key={scopeKey}>
                {header}
                {props.children(context, undefined, renderHeader)}
            </React.Fragment>
        );
    }

    if (props.presentation === 'virtualized-list') {
        return (
            <React.Fragment key={scopeKey}>
                {props.children(context, header, renderHeader)}
            </React.Fragment>
        );
    }

    return (
        <ItemList pageColumn={props.pageColumn} {...props.listScroll}>
            {props.childRendersHeader ? null : header}

            <React.Fragment key={scopeKey}>
                {props.children(context, props.childRendersHeader ? header : undefined, renderHeader)}
            </React.Fragment>
        </ItemList>
    );
});
