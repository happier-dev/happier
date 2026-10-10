import * as React from 'react';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';

import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { HomeCredentialUnreadableCard } from '@/components/sessions/access/UnboundSessionHomeScopeCard';
import { useTeamBinding } from '@/hooks/teams/useTeamBinding';
import { serverAccountScopedTeamKey } from '@/sync/domains/teams/teamAddress';
import { presentTeamEntryUnavailableReason } from '@/components/teams/entry/teamAuthenticationFailure';
import { teamSignInReturnPath } from '@/components/teams/entry/teamSignInHome';
import { t } from '@/text';

import type { TeamSectionContext } from './teamSectionContext';
import { teamSettingsPath } from './teamsRoutes';

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
     */
    presentation?: 'item-list' | 'virtualized-list' | 'embedded';
    /**
     * The page's known sections, holding their rows as skeletons while the Team is read, so the
     * page keeps its shape when the Team arrives. Without it the wait is one state under the header.
     */
    renderLoading?: () => React.ReactNode;
    /** Quiet actions at the head of a sub-page whose content has no section title to carry them. */
    renderHeaderActions?: (context: TeamSectionContext) => React.ReactNode;
    children: (context: TeamSectionContext, header?: React.ReactNode) => React.ReactNode;
}>) {
    const navigation = useNavigation();
    const router = useRouter();
    const binding = useTeamBinding(props.serverId, props.teamId);
    const scopeKey = binding.kind === 'bound'
        ? serverAccountScopedTeamKey(binding.scope, binding.address)
        : `unbound:${props.serverId}:${props.teamId}`;
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

    const readyTeamName = binding.kind === 'bound' && binding.state.kind === 'ready' ? binding.state.team.name : null;
    const resolvedTitle = props.title ?? readyTeamName ?? t('teams.title');

    // An entity page (the Team, a member, a Group) names itself in its own header, and the
    // collection layout leaves the phone header untitled for it (registry `headsItself`). Its
    // condition states keep the page title for the same reason.
    const headsItself = props.renderHeader !== undefined || props.childRendersHeader === true;
    const embedded = props.presentation === 'embedded';
    React.useEffect(() => {
        if (embedded) return;
        navigation.setOptions({ title: resolvedTitle });
    }, [embedded, navigation, resolvedTitle]);

    const renderPlainHeader = (actions?: React.ReactNode) => (
        <PageHeader
            testID="team-page-header"
            title={resolvedTitle}
            description={props.description}
            actions={actions}
            alwaysShowTitle={headsItself}
            meta={[
                ...(readyTeamName && readyTeamName !== resolvedTitle ? [{ key: 'team', text: readyTeamName }] : []),
                ...('homeName' in binding ? [{ key: 'home', icon: 'house' as const, text: binding.homeName }] : []),
            ]}
        />
    );
    const plainHeader = renderPlainHeader();

    // A page with nothing to show but its condition: the header, then the condition.
    const conditionPage = (condition: React.ReactNode) => embedded ? condition : (
        <ItemList>
            {plainHeader}
            {condition}
        </ItemList>
    );

    if (binding.kind === 'resolving') {
        return conditionPage(props.renderLoading?.() ?? <TeamStateCard kind="loading" title={t('teams.loading')} testID="team-resolving" />);
    }

    if (binding.kind === 'invalid_address' || binding.kind === 'unknown_home') {
        return conditionPage(
            <TeamStateCard kind="unavailable" title={t('teams.errors.notFound')} testID="team-unknown-home" />,
        );
    }

    if (binding.kind === 'signed_out') {
        return conditionPage(
            <TeamStateCard
                kind="unavailable"
                title={t('homeGovernance.signedOutTitle')}
                testID="team-signed-out"
            />,
        );
    }

    if (binding.kind === 'credential_unreadable') {
        return conditionPage(
            <HomeCredentialUnreadableCard serverId={binding.serverId} testID="team-credential-unreadable" />,
        );
    }

    const { state, homeName, address, refresh } = binding;

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
        const unsupported = state.error.kind === 'unsupported';
        return conditionPage(
            <TeamStateCard
                kind={denied ? 'unavailable' : 'error'}
                title={denied ? t('teams.denied.title') : t('teams.unavailable.title')}
                body={denied
                    ? t('teams.errors.forbidden')
                    : unsupported
                        ? t('teams.unavailable.updateRequired')
                        : t('teams.unavailable.offline')}
                action={state.retryable ? { label: t('teams.unavailable.retry'), onPress: refresh } : undefined}
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
    };

    // Restore lives in the Team's Settings; the archived notice leads there, except on Settings itself.
    const canRestore = state.team.capabilities.restoreTeam
        && state.mutationsAvailable;

    const header = (
        <>
            {embedded || props.childRendersHeader ? null : props.renderHeader ? props.renderHeader(context) : renderPlainHeader(props.renderHeaderActions?.(context))}
            {approvalId ? (
                <AttentionBanner
                    testID="team-approval"
                    tone="neutral"
                    title={t('approvals.title')}
                    description={approvalError
                        ? t('approvals.loadError')
                        : approvalLoading || approvalStatus === 'open' || approvalStatus === 'approved' || approvalStatus === 'executing'
                            ? t('approvals.status.open')
                            : undefined}
                    accessibilityLiveRegion={approvalError ? 'assertive' : 'polite'}
                    action={{
                        label: t('approvals.details'),
                        onPress: () => router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(props.serverId)}`),
                    }}
                />
            ) : null}
            {state.stale ? (
                <AttentionBanner
                    testID="team-stale"
                    title={state.error ? t('teams.unavailable.offline') : t('teams.stale.label')}
                    description={state.error ? t('teams.stale.label') : undefined}
                    accessibilityLiveRegion="polite"
                    action={{ label: t('teams.unavailable.retry'), onPress: refresh }}
                />
            ) : null}

            {state.archived && props.restoresHere !== true ? (
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

    if (embedded) {
        return (
            <React.Fragment key={scopeKey}>
                {header}
                {props.children(context)}
            </React.Fragment>
        );
    }

    if (props.presentation === 'virtualized-list') {
        return (
            <ListPresentationProvider value="page">
                <React.Fragment key={scopeKey}>
                    {props.children(context, header)}
                </React.Fragment>
            </ListPresentationProvider>
        );
    }

    return (
        <ItemList>
            {props.childRendersHeader ? null : header}

            <React.Fragment key={scopeKey}>
                {props.childRendersHeader ? props.children(context, header) : props.children(context)}
            </React.Fragment>
        </ItemList>
    );
});
