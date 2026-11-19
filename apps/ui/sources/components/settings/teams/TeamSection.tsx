import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import type { PageColumn } from '@/components/ui/layout/contentWidthMode';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HomeCredentialUnreadableCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { useMountedRef } from '@/hooks/ui/useMountedRef';
import { Modal } from '@/modal';
import { serverAccountScopedTeamKey } from '@/sync/domains/teams/teamAddress';
import { presentTeamEntryUnavailableReason } from '@/components/teams/entry/teamAuthenticationFailure';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import { t } from '@/text';

import { teamPageHeaderMeta, type TeamSectionContext } from './teamSectionContext';
import { teamSettingsPath } from './teamsRoutes';
import { teamReadFailureLabel } from './teamMutationPresentation';
import { useTeamReadFailureAction } from './useTeamReadFailureAction';
import { isApprovalRequestV2InFlightStatus } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { HomeDomainFailure } from '@/sync/api/home/homeServerActionTransport';
import type { ScopedSnapshotError } from '@/sync/domains/scope/scopedSnapshotFacts';

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
    homeName?: string;
}>): React.ReactElement {
    return <PageHeader
        testID="team-page-header"
        title={props.title}
        description={props.description}
        actions={props.actions}
        alwaysShowTitle={props.alwaysShowTitle}
        meta={teamPageHeaderMeta({ pageTitle: props.title, teamName: props.teamName, homeName: props.homeName })}
    />;
}

/**
 * A condition that occupies the page because there is genuinely nothing else truthful to show.
 * The page header stays above it, so the page does not change shape when the Team arrives.
 */
const TeamStateCard = React.memo(function TeamStateCard(props: Readonly<{
    kind: 'loading' | 'unavailable' | 'error' | 'warning';
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
            accessibilitySemantics={props.kind === 'loading' ? 'status' : 'alert'}
        />
    );
});

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
    /**
     * The page's known sections, holding their rows as skeletons while the Team is read, so the
     * page keeps its shape when the Team arrives. Without it the wait is one state under the header.
     */
    renderLoading?: () => React.ReactNode;
    /** Quiet actions at the head of a sub-page whose content has no section title to carry them. */
    renderHeaderActions?: (context: TeamSectionContext) => React.ReactNode;
    /**
     * `renderHeader` is for a page that reads more than the Team (a Group and its roster): it passes
     * those reads so one outage is one notice, not one per read.
     */
    children: (context: TeamSectionContext, header: React.ReactNode | undefined, renderHeader: TeamSectionRenderHeader) => React.ReactNode;
}>) {
    const navigation = useNavigation();
    const router = useRouter();
    const readFailureAction = useTeamReadFailureAction();
    const binding = useTeamBinding(props.serverId, props.teamId);
    const projection = binding.kind === 'bound' ? binding : binding.kind === 'resolving' ? binding.retained : undefined;
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
    const resolvedTitle = props.title ?? readyTeamName ?? t('teams.title');

    // An entity page (the Team, a member, a Group) names itself in its own header, and the
    // collection layout leaves the phone header untitled for it, as every Settings page. Its
    // condition states keep the page title for the same reason.
    const headsItself = props.renderHeader !== undefined || props.childRendersHeader === true;
    const embedded = props.presentation === 'embedded';
    React.useEffect(() => {
        if (embedded) return;
        navigation.setOptions({ title: resolvedTitle });
    }, [embedded, navigation, resolvedTitle]);

    const renderPlainHeader = (actions?: React.ReactNode) => (
        <TeamSectionPageHeader
            title={resolvedTitle}
            description={props.description}
            actions={actions}
            alwaysShowTitle={headsItself}
            teamName={readyTeamName}
            homeName={projection?.homeName ?? ('homeName' in binding ? binding.homeName : undefined)}
        />
    );
    const plainHeader = renderPlainHeader();

    // A page with nothing to show but its condition: the header, then the condition.
    const conditionPage = (condition: React.ReactNode) => embedded ? condition : (
        <ItemList pageColumn={props.pageColumn}>
            {plainHeader}
            {condition}
        </ItemList>
    );

    if (!projection) {
        switch (binding.kind) {
            case 'resolving':
                return conditionPage(props.renderLoading?.() ?? <TeamStateCard kind="loading" title={t('teams.loading')} testID="team-resolving" />);
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
        return conditionPage(props.renderLoading?.() ?? <TeamStateCard kind="loading" title={t('teams.loading')} testID="team-loading" />);
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
        const denied = state.error.kind === 'forbidden' || state.error.kind === 'unauthorized';
        return conditionPage(
            <TeamStateCard
                kind={denied ? 'unavailable' : 'error'}
                title={denied ? t('teams.denied.title') : t('teams.unavailable.title')}
                body={teamReadFailureLabel(state.error)}
                action={readFailureAction(state.error, { onPress: refresh })}
                testID="team-unavailable"
            />,
        );
    }

    const context: TeamSectionContext = {
        scope: state.scope,
        address,
        homeName,
        team: state.team,
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
    const { stale: teamStale, error: teamError, archived: teamArchived } = state;
    const renderHeader: TeamSectionRenderHeader = (pageReads = NO_PAGE_READS) => {
        // One outage is one notice: the Team's own read and the page's reads that are not current
        // share it, it names the first failure, and its one retry asks every one of them again.
        const staleReads: readonly TeamPageStaleRead[] = teamStale
            ? [{ failure: teamError ?? null, retry: refresh }, ...pageReads]
            : pageReads;
        const failure = staleReads.find((read) => read.failure !== null)?.failure ?? null;
        const retryAll = () => {
            for (const read of staleReads) read.retry();
        };
        const retry = { label: t('teams.unavailable.retry'), onPress: retryAll, testID: 'team-stale-retry' };
        const staleAction = failure === null
            ? retry
            // The Team's own stale read always offers Retry, as it did; a page read follows the
            // shared read-failure rule (the Action settings repair, Retry, or nothing for a refusal).
            : readFailureAction(failure, { onPress: retryAll, testIDPrefix: 'team-stale' }) ?? (teamStale ? retry : null);
        return (
        <>
            {embedded || props.childRendersHeader ? null : props.renderHeader ? props.renderHeader(context) : renderPlainHeader(props.renderHeaderActions?.(context))}
            {approvalId ? (
                <AttentionBanner
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
        <ItemList pageColumn={props.pageColumn}>
            {props.childRendersHeader ? null : header}

            <React.Fragment key={scopeKey}>
                {props.children(context, props.childRendersHeader ? header : undefined, renderHeader)}
            </React.Fragment>
        </ItemList>
    );
});
