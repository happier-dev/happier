import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { HomeGovernanceErrorV1Schema, type HomeAccountDetailV1, type HomeRoleV1 } from '@happier-dev/protocol/home/governance';
import type { ManagedResourceDispositionV1 } from '@happier-dev/protocol/machines/managed/managedDependencyV1';

import { confirmForCapturedAccount } from '@/components/settings/apiTokens/confirmForCapturedAccount';
import { reviewManagedResourceRemoval } from '@/components/settings/machines/managed/reviewManagedResourceRemoval';
import { teamRoleLabel } from '@/components/settings/teams/teamLabels';
import { teamDetailPath } from '@/components/settings/teams/teamsRoutes';
import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { formatRelativeTimeShort } from '@/components/ui/selectionList/formatRelativeTimeShort';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useHomeAccountDetail } from '@/hooks/home/useHomeAccountDetail';
import { Modal } from '@/modal';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import {
    resolveHomeAccountAdministrationActions,
    type HomeAccountActionAvailability,
} from '@/sync/domains/home/governance/homeAccountAdministration';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
    deleteHomeAccount,
    disableHomeAccount,
    enableHomeAccount,
    setHomeAccountRole,
    signOutHomeAccountEverywhere,
    type HomeGovernanceMutationOutcome,
} from '@/sync/ops/home/homeGovernanceOperations';
import { t } from '@/text';

import { HomeActivityRow } from './HomeAdministrationActivityScreen';
import { HomeAdministrationSection } from './HomeAdministrationSection';
import { HomeConsoleBackScope } from './HomeConsoleNavigation';
import type { HomeAdministrationContext } from './homeAdministrationContext';
import { homeAdministrationPeoplePath, homeAdministrationPersonActivityPath } from './homeAdministrationRoutes';
import {
    homeAccountStatusLabel,
    homeActionUnavailableReasonLabel,
    homeGovernanceFailureNotice,
    homeRoleLabel,
} from './homeGovernanceLabels';

const TEAM_MARK_SIZE = 28;

type PendingAction = Readonly<
    | { kind: 'role'; role: HomeRoleV1 }
    | { kind: 'disable' | 'enable' | 'delete' | 'signOutEverywhere' }
>;

/** The reason an entitled-but-blocked action gives instead of an inert control. */
function unavailableReason(availability: HomeAccountActionAvailability): string | undefined {
    return availability.state === 'unavailable'
        ? homeActionUnavailableReasonLabel(availability.reason)
        : undefined;
}

function pendingActionLabel(action: PendingAction): string {
    switch (action.kind) {
        case 'role':
            return `${t('homeGovernance.changeRole')}: ${homeRoleLabel(action.role)}`;
        case 'disable':
            return t('homeGovernance.disable');
        case 'enable':
            return t('homeGovernance.enable');
        case 'delete':
            return t('homeGovernance.deleteAccount');
        case 'signOutEverywhere':
            return t('homeGovernance.person.signOutEverywhereDone');
    }
}

/** Method and provider ids named the way this Home names its sign-in methods; an unnamed id stays as is. */
function useMethodLabels(context: HomeAdministrationContext): (ids: readonly string[]) => string[] {
    const methods = context.projection.authenticationOptions.methods;
    return React.useCallback((ids: readonly string[]) => {
        const labelById = new Map(methods.flatMap((method) => {
            const label = method.displayName?.trim();
            return label ? [[method.id, label] as const] : [];
        }));
        return [...new Set(ids.map((id) => labelById.get(id) ?? id))];
    }, [methods]);
}

const PersonDetail = React.memo(function PersonDetail(props: Readonly<{
    /** The Home's condition banners, under this person's identity header. */
    banners?: React.ReactNode;
    context: HomeAdministrationContext;
    detail: HomeAccountDetailV1;
    onChanged: () => void;
}>) {
    const router = useRouter();
    const { context, detail, onChanged } = props;
    const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null);
    const operationInFlightRef = React.useRef(false);
    const busy = pendingAction !== null;
    const labelMethods = useMethodLabels(context);

    const actions = React.useMemo(() => resolveHomeAccountAdministrationActions({
        target: detail,
        mutationsAvailable: context.mutationsAvailable,
    }), [context.mutationsAvailable, detail]);

    const person = resolveAccountDisplayName({
        profile: detail.profile,
        accountId: detail.accountId,
        signInEmail: detail.authentication.signInEmail,
        viewerAccountId: context.scope.accountId,
    });
    const name = person.name;

    const run = React.useCallback(async (
        action: PendingAction,
        operation: () => Promise<HomeGovernanceMutationOutcome | null>,
    ): Promise<HomeGovernanceMutationOutcome | null> => {
        // The visible disabled state follows on the next render; this ref also
        // closes the same-frame double-activation window on fast pointer/touch.
        if (operationInFlightRef.current) return null;
        operationInFlightRef.current = true;
        setPendingAction(action);
        try {
            const outcome = await operation();
            if (!outcome) return null;
            if (outcome.kind === 'succeeded') {
                announceAccessibilityMessage(`${pendingActionLabel(action)}. ${t('common.success')}`);
                onChanged();
                return outcome;
            }
            if (outcome.kind === 'incomplete') {
                // Access is gone but cleanup is not finished. This is reported as
                // a failure with a retry, never as a completed deletion.
                await Modal.alertAsync(
                    t('homeGovernance.deleteIncompleteTitle'),
                    t('homeGovernance.deleteIncompleteBody'),
                );
                onChanged();
                return outcome;
            }
            if (outcome.kind === 'approval_pending') {
                context.requestApproval?.(outcome.artifactId);
                return outcome;
            }
            const notice = homeGovernanceFailureNotice(outcome.failure);
            await Modal.alertAsync(notice.title, notice.body);
            // The refusal is itself evidence this Home moved under us.
            context.refresh();
            onChanged();
            return outcome;
        } finally {
            operationInFlightRef.current = false;
            setPendingAction(null);
        }
    }, [context, onChanged]);

    /**
     * Every People action changes someone's access, so each one is confirmed and bound to the Home
     * and Account current when its confirmation opened: a credential change while it is open aborts
     * it instead of acting as someone else. The mutation then runs for exactly that captured scope.
     */
    const confirmThenRun = React.useCallback(async (
        action: PendingAction,
        confirm: () => Promise<boolean>,
        operation: (scope: ServerAccountScope, target: ServerAccountScopeLifetime) => Promise<HomeGovernanceMutationOutcome | null>,
    ): Promise<HomeGovernanceMutationOutcome | null> => {
        if (operationInFlightRef.current) return null;
        const target = await confirmForCapturedAccount(
            { captureDestructiveTarget: () => context.captureDestructiveTarget?.() ?? null },
            confirm,
        );
        if (!target) return null;
        return await run(action, () => operation(target.scope, target));
    }, [context, run]);

    const changeRole = React.useCallback((nextRole: HomeRoleV1) => {
        if (nextRole === detail.homeRole || detail.mutationCapabilities.setRole[nextRole].status !== 'available') return;
        void confirmThenRun(
            { kind: 'role', role: nextRole },
            () => Modal.confirm(
                t('homeGovernance.person.roleChangeTitle', { account: name, role: homeRoleLabel(nextRole) }),
                t('homeGovernance.person.roleChangeBody'),
                { confirmText: t('homeGovernance.person.roleChangeConfirm') },
            ),
            (scope) => setHomeAccountRole({ scope, accountId: detail.accountId, homeRole: nextRole }),
        );
    }, [confirmThenRun, detail, name]);

    const confirmSignOutEverywhere = React.useCallback(() => {
        void confirmThenRun(
            { kind: 'signOutEverywhere' },
            () => Modal.confirm(
                t('homeGovernance.person.signOutEverywhereTitle', { account: name }),
                t('homeGovernance.person.signOutEverywhereBody'),
                { confirmText: t('homeGovernance.person.signOutEverywhere') },
            ),
            (scope) => signOutHomeAccountEverywhere({ scope, accountId: detail.accountId }),
        );
    }, [confirmThenRun, detail.accountId, name]);

    const confirmDisable = React.useCallback(() => {
        void confirmThenRun(
            { kind: 'disable' },
            () => Modal.confirm(
                t('homeGovernance.disableTitle', { account: name }),
                t('homeGovernance.disableBody'),
                { confirmText: t('homeGovernance.disableConfirm'), destructive: true },
            ),
            (scope) => disableHomeAccount({ scope, accountId: detail.accountId }),
        );
    }, [confirmThenRun, detail.accountId, name]);

    const confirmEnable = React.useCallback(() => {
        void confirmThenRun(
            { kind: 'enable' },
            () => Modal.confirm(
                t('homeGovernance.enableTitle', { account: name }),
                t('homeGovernance.enableBody'),
                { confirmText: t('homeGovernance.enableConfirm') },
            ),
            (scope) => enableHomeAccount({ scope, accountId: detail.accountId }),
        );
    }, [confirmThenRun, detail.accountId, name]);

    const confirmDelete = React.useCallback(async () => {
        const outcome = await confirmThenRun(
            { kind: 'delete' },
            () => Modal.confirm(
                t('homeGovernance.deleteTitle', { account: name }),
                t('homeGovernance.deleteBody', { home: context.homeName }),
                { confirmText: t('homeGovernance.deleteConfirm'), destructive: true },
            ),
            async (scope, target) => {
                const abort = new AbortController();
                const retirement = target.onRetire(() => abort.abort());
                let managedResourceDispositions: readonly ManagedResourceDispositionV1[] | undefined;
                try {
                    while (target.isCurrent() && !abort.signal.aborted) {
                        const result = await deleteHomeAccount({ scope, accountId: detail.accountId, signal: abort.signal,
                            ...(managedResourceDispositions ? { managedResourceDispositions } : {}),
                            ...(context.requestApproval ? { onApprovalPending: context.requestApproval } : {}),
                        });
                        if (!target.isCurrent() || abort.signal.aborted) return null;
                        if (result.kind !== 'failed') return result;
                        const review = HomeGovernanceErrorV1Schema.safeParse(result.failure.details);
                        if (!review.success || review.data.error !== 'account_erasure_managed_resources_review_required') return result;
                        const resources = review.data.resources;
                        let reviewed: readonly ManagedResourceDispositionV1[] | null = null;
                        const current = await confirmForCapturedAccount({ captureDestructiveTarget: () => target }, async () => {
                            reviewed = await reviewManagedResourceRemoval(resources);
                            return reviewed !== null;
                        });
                        if (!current || !reviewed) return null;
                        managedResourceDispositions = reviewed;
                    }
                    return null;
                } finally { retirement.dispose(); }
            },
        );
        // Only a finished deletion removes the person this page is about.
        if (outcome?.kind === 'succeeded') router.back();
    }, [confirmThenRun, context.homeName, context.requestApproval, detail.accountId, name, router]);

    // A Retired Account whose deletion did not finish is retried with the same
    // authorized operation, so the destructive verb stays honest.
    const deleteTitle = detail.status === 'disabled'
        ? t('homeGovernance.retryDeletion')
        : t('homeGovernance.deleteAccount');

    const now = Date.now();
    const methodLabels = labelMethods(detail.authentication.usableMethodIds);
    const providerLabels = labelMethods(detail.authentication.linkedProviderIds);
    const accessActions = [actions.enable, actions.disable, actions.delete].filter((action) => action.state !== 'hidden');
    const accessActionsAllBlocked = accessActions.length > 0 && accessActions.every((action) => action.state === 'unavailable');

    return (
        <>
            <PageHeader
                testID="home-account-header"
                alwaysShowTitle
                title={name}
                leading={<Avatar id={detail.accountId} size={44} imageUrl={detail.profile.avatarUrl ?? null} />}
                meta={[
                    ...(person.hint ? [{ key: 'hint', text: person.hint }] : []),
                    ...(detail.profile.username ? [{ key: 'username', text: `@${detail.profile.username}` }] : []),
                    { key: 'role', text: homeRoleLabel(detail.homeRole) },
                    { key: 'status', text: homeAccountStatusLabel(detail.status) },
                ]}
            />
            {props.banners}

            {actions.setRole.state === 'available' ? (
                <ItemGroup title={t('homeGovernance.roleSheetTitle')}>
                    <Item
                        testID="home-account-role"
                        title={t('homeGovernance.roleSheetTitle')}
                        subtitle={t('homeGovernance.person.roleDescription')}
                        subtitleLines={0}
                        showChevron={false}
                        mode="info"
                        accessoryLayout="adaptive"
                        rightElement={(
                            <SegmentedTabBar<HomeRoleV1>
                                role="radiogroup"
                                tabs={actions.assignableRoles.map((role) => ({
                                    id: role,
                                    label: homeRoleLabel(role),
                                    disabled: busy || (role !== detail.homeRole
                                        && detail.mutationCapabilities.setRole[role].status !== 'available'),
                                }))}
                                activeTabId={pendingAction?.kind === 'role' ? pendingAction.role : detail.homeRole}
                                onSelectTab={changeRole}
                                slidingThumb
                                segmentSizing="content"
                                disabled={busy}
                                accessibilityLabel={t('homeGovernance.changeRole')}
                                testIDPrefix="home-account-role"
                            />
                        )}
                    />
                </ItemGroup>
            ) : actions.setRole.state === 'unavailable' ? (
                <ItemGroup title={t('homeGovernance.roleSheetTitle')}>
                    <Item
                        testID="home-account-role"
                        title={t('homeGovernance.roleSheetTitle')}
                        subtitle={`${homeRoleLabel(detail.homeRole)} · ${unavailableReason(actions.setRole)}`}
                        subtitleLines={0}
                        showChevron={false}
                        mode="info"
                    />
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('homeGovernance.person.signIn')} description={t('homeGovernance.person.signInDescription')}>
                <Item
                    testID="home-account-sign-in-email"
                    title={t('settingsAccount.nativePassword.signInEmail')}
                    detail={detail.authentication.signInEmail ?? t('settingsAccount.nativePassword.signInEmailNotSet')}
                    mode="info"
                    showChevron={false}
                />
                <Item
                    testID="home-account-sign-in-methods"
                    title={t('homeGovernance.person.methods')}
                    detail={methodLabels.length > 0
                        ? methodLabels.join(' · ')
                        : t('settingsAccount.nativePassword.notEligible')}
                    mode="info"
                    showChevron={false}
                />
                <Item
                    testID="home-account-linked-providers"
                    title={t('homeGovernance.person.linkedProviders')}
                    detail={providerLabels.length > 0 ? providerLabels.join(' · ') : t('homeGovernance.person.none')}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>

            <ItemGroup title={t('homeGovernance.person.teams')}>
                {detail.teams.length === 0 ? (
                    <Item testID="home-account-teams-empty" title={t('homeGovernance.person.noTeams')} mode="info" showChevron={false} />
                ) : detail.teams.map((team) => (
                    <Item
                        key={team.teamId}
                        testID={`home-account-team:${team.teamId}`}
                        title={team.name}
                        subtitle={[
                            teamRoleLabel(team.role),
                            team.status === 'suspended' ? t('homeGovernance.person.teamSuspended') : null,
                            team.archived ? t('homeGovernance.person.teamArchived') : null,
                        ].filter((part): part is string => part !== null).join(' · ')}
                        icon={<Avatar id={team.teamId} square size={TEAM_MARK_SIZE} />}
                        onPress={() => router.push(teamDetailPath({ serverId: context.scope.serverId, teamId: team.teamId }) as never)}
                    />
                ))}
            </ItemGroup>

            <ItemGroup title={t('homeGovernance.person.access')} description={t('homeGovernance.person.accessDescription')}>
                <Item
                    testID="home-account-machines"
                    title={t('homeGovernance.person.machines')}
                    detail={String(detail.machines.count)}
                    mode="info"
                    showChevron={false}
                />
                <Item
                    testID="home-account-api-tokens"
                    title={t('homeGovernance.person.apiTokens')}
                    subtitle={detail.apiTokens.count === 0
                        ? undefined
                        : detail.apiTokens.lastUsedAt === null
                            ? t('homeGovernance.person.apiTokensNeverUsed')
                            : t('homeGovernance.person.apiTokensLastUsed', {
                                time: formatRelativeTimeShort(detail.apiTokens.lastUsedAt, now),
                            })}
                    detail={String(detail.apiTokens.count)}
                    mode="info"
                    showChevron={false}
                />
                {actions.signOutEverywhere.state !== 'hidden' ? (
                    <Item
                        testID="home-account-sign-out-everywhere"
                        title={t('homeGovernance.person.signOutEverywhere')}
                        subtitle={unavailableReason(actions.signOutEverywhere)
                            ?? t('homeGovernance.person.signOutEverywhereDescription')}
                        subtitleLines={0}
                        showChevron={false}
                        mode="info"
                        accessoryLayout="adaptive"
                        rightElement={actions.signOutEverywhere.state === 'available' ? (
                            <RoundButton
                                testID="home-account-sign-out-everywhere-button"
                                size="small"
                                display="secondary"
                                title={t('homeGovernance.person.signOutEverywhere')}
                                disabled={busy}
                                loading={pendingAction?.kind === 'signOutEverywhere'}
                                onPress={busy ? undefined : confirmSignOutEverywhere}
                            />
                        ) : undefined}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup
                title={t('homeGovernance.person.recentActivity')}
                action={detail.recentEvents.length > 0 ? (
                    <SectionActionButton
                        testID="home-account-activity-all"
                        icon="clock-counter-clockwise"
                        title={t('homeGovernance.person.showAllActivity')}
                        onPress={() => router.push(homeAdministrationPersonActivityPath(context.scope.serverId, detail.accountId) as never)}
                    />
                ) : undefined}
            >
                {detail.recentEvents.length === 0 ? (
                    <Item testID="home-account-activity-empty" title={t('homeGovernance.person.noRecentActivity')} mode="info" showChevron={false} />
                ) : detail.recentEvents.map((event) => <HomeActivityRow key={event.id} event={event} now={now} viewerAccountId={context.scope.accountId} />)}
            </ItemGroup>

            {accessActions.length === 0 ? null : accessActionsAllBlocked ? (
                <ItemGroup title={t('homeGovernance.accountSection')}>
                    <Item
                        testID="home-account-access-unavailable"
                        title={t('homeGovernance.person.disableOrDelete')}
                        subtitle={accessActions.map(unavailableReason).find((reason): reason is string => reason !== undefined)}
                        subtitleLines={0}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : (
                <ItemGroup surface="none" description={t('homeGovernance.person.dangerFootnote')}>
                    <SectionButtonRow
                        footnote={accessActions.map(unavailableReason)
                            .find((reason): reason is string => reason !== undefined) ?? null}
                        trailing={actions.delete.state === 'available' ? (
                            <RoundButton
                                testID="home-account-delete"
                                size="small"
                                display="destructive"
                                title={deleteTitle}
                                titleNumberOfLines="complete"
                                disabled={busy}
                                loading={pendingAction?.kind === 'delete'}
                                onPress={busy ? undefined : () => { void confirmDelete(); }}
                            />
                        ) : undefined}
                    >
                        {actions.enable.state === 'available' ? (
                            <RoundButton
                                testID="home-account-enable"
                                size="small"
                                display="secondary"
                                title={t('homeGovernance.enable')}
                                disabled={busy}
                                loading={pendingAction?.kind === 'enable'}
                                onPress={busy ? undefined : confirmEnable}
                            />
                        ) : null}
                        {actions.disable.state === 'available' ? (
                            <RoundButton
                                testID="home-account-disable"
                                size="small"
                                display="secondary"
                                title={t('homeGovernance.disable')}
                                disabled={busy}
                                loading={pendingAction?.kind === 'disable'}
                                onPress={busy ? undefined : confirmDisable}
                            />
                        ) : null}
                    </SectionButtonRow>
                </ItemGroup>
            )}
        </>
    );
});

const PersonLookup = React.memo(function PersonLookup(props: Readonly<{
    context: HomeAdministrationContext;
    accountId: string;
    banners?: React.ReactNode;
}>) {
    const { context, accountId } = props;
    const canView = context.projection.capabilities.viewAdministration;
    const person = useHomeAccountDetail(context.scope, accountId, canView);

    if (canView && person.detail) {
        return <PersonDetail context={context} detail={person.detail} onChanged={person.reload} banners={(
            <>
                {props.banners}
                {person.error ? (
                    <SurfaceFreshnessLine
                        testID="home-account-refresh-error"
                        tone="warning"
                        reason={homeGovernanceFailureNotice(person.error, { effect: 'read' }).body}
                        action={person.error.retryable ? { label: t('homeGovernance.retry'), onPress: person.reload } : undefined}
                    />
                ) : null}
            </>
        )} />;
    }

    // Until the person is read the page is titled by its destination, with the Home's banners.
    const withHeader = (content: React.ReactNode) => (
        <>
            <PageHeader testID="home-account-header" title={t('homeGovernance.people')} meta={[
                { key: 'home', icon: 'house', text: context.homeName },
            ]} />
            {props.banners}
            {content}
        </>
    );

    if (!canView) {
        return withHeader(
            <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                <Item testID="home-admin-viewer-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
            </ItemGroup>,
        );
    }

    if (person.error) {
        if (person.error.kind === 'forbidden' || person.error.kind === 'unauthorized') {
            return withHeader(
                <ItemGroup description={t('homeGovernance.forbiddenBody')}>
                    <Item testID="home-account-forbidden" title={t('homeGovernance.forbiddenTitle')} mode="info" showChevron={false} />
                </ItemGroup>,
            );
        }
        if (person.error.code === 'home_account_not_found') {
            return withHeader(
                <ItemGroup description={t('homeGovernance.accountUnavailableBody')}>
                    <Item testID="home-account-unavailable" title={t('homeGovernance.errorAccountNotFound')} mode="info" showChevron={false} />
                </ItemGroup>,
            );
        }
        const unsupported = person.error.kind === 'unsupported';
        return withHeader(
            <ItemGroup description={unsupported ? t('homeGovernance.rosterUnavailableBody') : t('homeGovernance.unavailableBody')}>
                <Item
                    testID={unsupported ? 'home-account-unsupported' : 'home-account-error'}
                    title={unsupported ? t('homeGovernance.rosterUnavailableTitle') : t('homeGovernance.unavailableTitle')}
                    mode="info"
                    showChevron={false}
                />
                {person.error.retryable ? (
                    <Item testID="home-account-retry" title={t('homeGovernance.retry')} onPress={person.reload} showChevron={false} />
                ) : null}
            </ItemGroup>,
        );
    }

    return withHeader(
        <ItemGroup>
            <Item testID="home-account-loading" title={t('homeGovernance.loading')} loading mode="info" showChevron={false} />
        </ItemGroup>,
    );
});

/**
 * One person on one Home (plan §3.12, lab `hcPeople-D/O/S/PD`): who they are, their role, what they
 * can sign in with, their Teams, what access they hold and the latest administration about them, read
 * in one `home.accounts.get`. Unavailable actions say why instead of rendering an inert control.
 */
export const HomeAdministrationAccountScreen = React.memo(function HomeAdministrationAccountScreen(
    props: Readonly<{ serverId: string; accountId: string }>,
) {
    return (
        // Beside People's rail the person's page needs no way back to that list.
        <HomeConsoleBackScope parentPathname={homeAdministrationPeoplePath(props.serverId)} shownBy="peopleRail">
            <HomeAdministrationSection serverId={props.serverId} title={t('homeGovernance.people')} childRendersHeader>
                {/* The shell discards this section when the Home/Account scope
                    changes; this key covers the other identity dimension, the exact
                    person being administered. */}
                {(context, banners) => (
                    <PersonLookup
                        key={props.accountId}
                        context={context}
                        accountId={props.accountId}
                        banners={banners}
                    />
                )}
            </HomeAdministrationSection>
        </HomeConsoleBackScope>
    );
});
