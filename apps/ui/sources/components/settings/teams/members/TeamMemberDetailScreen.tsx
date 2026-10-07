import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { Pressable } from 'react-native';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    type TeamMembershipV1,
    type TeamRoleV1,
} from '@happier-dev/protocol/teams';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { teamReadFailureLabel } from '@/components/settings/teams/teamMutationPresentation';
import { useTeamMemberGroups } from '@/hooks/teams/useTeamMemberGroups';
import { restoreFocusToBestTarget } from '@/keyboard/focusReturn';
import { Modal } from '@/modal';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import {
    getTeamMember,
    reactivateTeamMember,
    removeTeamMember,
    setTeamMemberManagement,
    setTeamMemberRole,
    suspendTeamMember,
} from '@/sync/ops/teams/teamMemberOperations';
import {
    isTeamActionApprovalPendingError,
    type HomeDomainFailure,
} from '@/sync/ops/teams/teamActionClient';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isAuthoritativeScopedSnapshotRefusalKind } from '@/sync/domains/scope/scopedSnapshotFacts';
import { t } from '@/text';

import { TeamSection } from '../TeamSection';
import type { TeamSectionContext } from '../teamSectionContext';
import {
    groupManagementLabel,
    membershipManagementLabel,
    teamRoleDescription,
    teamRoleLabel,
} from '../teamLabels';
import { teamMutationFailureLabel } from '../teamMutationPresentation';
import { teamDirectorySourcePath, teamGroupDetailPath, teamIdentityConnectionPath } from '../teamsRoutes';
import { useDirectoryAdministration } from '../identity/useDirectoryAdministration';
import type { TeamMemberSectionRenderer } from './teamMemberSectionContext';
import { Icon } from '@/components/ui/icons/Icon';

const MEMBER_HEADER_AVATAR_SIZE = 44;

type MembershipLoad =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'ready'; membership: TeamMembershipV1 }>;

const LOADING: MembershipLoad = Object.freeze({ kind: 'loading' as const });
const UNAVAILABLE: MembershipLoad = Object.freeze({ kind: 'unavailable' as const });

/**
 * A refused role, suspension, or reactivation in the Home's own terms.
 *
 * The typed code carries the reason a bare kind cannot: the final-owner guard
 * is an actionable governance fact, not a generic conflict, and a
 * directory-owned lifetime is read-only at its source. Only after those exact
 * reasons does the transport kind decide the message, so a race, a permission
 * loss, and an unreachable Home never read as the same failure.
 */
/**
 * The Groups this membership is effectively in.
 *
 * Read-only and offered to every viewer the Home answers: a person's Group
 * membership explains where their access comes from, and hiding it from a
 * non-manager would leave the roster unable to answer its own question. Each row
 * opens the same Group destination the Group list opens.
 */
const MemberGroupsSection = React.memo(function MemberGroupsSection(props: Readonly<{
    context: TeamSectionContext;
    membershipId: string;
}>) {
    const router = useRouter();
    const { context, membershipId } = props;
    const groups = useTeamMemberGroups({
        scope: context.scope,
        address: context.address,
        membershipId,
        enabled: context.team.capabilities.viewTeam,
    });

    if (!context.team.capabilities.viewTeam) return null;

    if (groups.rows.length === 0) {
        // A still-loading list is not an empty one, and an unreachable Home is
        // not an empty one either: each says exactly what it knows.
        if (groups.error) {
            return (
                <ItemGroup title={t('teams.members.detailGroups')} description={teamReadFailureLabel(groups.error)}>
                    {groups.error.retryable ? <Item
                        testID="team-member-groups-retry"
                        title={t('teams.unavailable.retry')}
                        onPress={() => void groups.reload()}
                        showChevron={false}
                    /> : null}
                </ItemGroup>
            );
        }
        return (
            <ItemGroup title={t('teams.members.detailGroups')}>
                <Item
                    testID={groups.status === 'ready' ? 'team-member-groups-empty' : 'team-member-groups-loading'}
                    title={groups.status === 'ready'
                        ? t('teams.members.detailGroupsEmpty')
                        : t('teams.members.detailGroups')}
                    loading={groups.status !== 'ready'}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    return (
        <>
            <ItemGroup title={t('teams.members.detailGroups')}>
                {groups.rows.map((group) => {
                    const managedBy = groupManagementLabel(group);
                    const archived = group.archivedAt !== null;
                    return (
                        <Item
                            key={group.id}
                            testID={`team-member-group:${group.id}`}
                            title={group.name}
                            subtitle={[managedBy, archived ? t('teams.directory.archivedBadge') : null]
                                .filter((part): part is string => part !== null)
                                .join(' · ') || undefined}
                            onPress={() => router.push(teamGroupDetailPath(context.address, group.id))}
                        />
                    );
                })}
            </ItemGroup>
            {/* Rows already read stay on screen through a failure. */}
            {groups.error ? (
                <ItemGroup description={teamReadFailureLabel(groups.error)}>
                    {groups.error.retryable ? (
                        <Item
                            testID="team-member-groups-retry"
                            title={t('teams.unavailable.retry')}
                            onPress={() => void groups.reload()}
                            showChevron={false}
                        />
                    ) : null}
                </ItemGroup>
            ) : groups.hasMore ? (
                <ItemGroup>
                    <Item
                        testID="team-member-groups-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={groups.status === 'loading_more'}
                        disabled={groups.status === 'loading_more'}
                        onPress={() => void groups.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    );
});

/**
 * The explicit management-source transfer.
 *
 * It renders only behind the Home's own `setManagement` capability, which is
 * false when the conversion would refuse by construction — there is no local
 * reconstruction of whether a source could take this person over. Returning to
 * native management names no source; binding names the exact one, because a
 * vague "manage externally" would let the client pick a source it did not
 * choose. The transfer preserves the lifetime, role, status and horizon, which
 * is what the confirmation says.
 */
const MemberManagementSection = React.memo(function MemberManagementSection(props: Readonly<{
    context: TeamSectionContext;
    membership: TeamMembershipV1;
    busy: boolean;
    onTransfer: (
        management: Readonly<{ kind: 'native' }> | Readonly<{ kind: 'directory_source'; directorySourceId: string }>,
    ) => Promise<void>;
}>) {
    const { context, membership } = props;
    const [expanded, setExpanded] = React.useState(false);
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable> | null>(null);

    // Directory sources are read from the destination that owns them, and only
    // when this viewer may reach that destination at all.
    const canReadSources = context.team.capabilities.manageAuthentication;
    const directory = useDirectoryAdministration(
        context.scope,
        context.address.teamId,
        membership.capabilities.setManagement && canReadSources,
    );
    const sources = canReadSources && directory.state.kind === 'ready'
        ? directory.state.items
        : [];

    const close = React.useCallback(() => {
        setExpanded(false);
        restoreFocusToBestTarget(triggerRef);
    }, []);

    if (!membership.capabilities.setManagement) return null;

    const nativeSelected = membership.management.kind === 'native';
    const boundSourceId = membership.management.kind === 'directory_source'
        ? membership.management.directorySourceId
        : null;
    const enabled = context.canMutate && !props.busy;

    return (
        <>
            <ItemGroup title={t('teams.members.managementTitle')} description={t('teams.members.managementHelp')}>
                <Item
                    testID="team-member-management"
                    title={t('teams.members.detailManagedBy')}
                    detail={membership.management.kind === 'native'
                        ? t('teams.members.managementNative')
                        : membership.management.label}
                    pressableRef={triggerRef}
                    accessibilityExpanded={expanded}
                    disabled={!enabled}
                    onPress={() => (expanded ? close() : setExpanded(true))}
                    showChevron={false}
                />
            </ItemGroup>

            {expanded ? (
                <ItemGroup
                    title={t('teams.members.managementTitle')}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('teams.members.managementTitle')}
                >
                    <Item
                        testID="team-member-management:native"
                        title={t('teams.members.managementNative')}
                        accessibilityRole="radio"
                        webRole="radio"
                        accessibilityChecked={nativeSelected}
                        selected={nativeSelected}
                        disabled={!enabled || nativeSelected}
                        onPress={async () => {
                            close();
                            await props.onTransfer({ kind: 'native' });
                        }}
                        showChevron={false}
                    />
                    {sources.map((source) => (
                        <Item
                            key={source.id}
                            testID={`team-member-management:${source.id}`}
                            title={source.displayName}
                            accessibilityRole="radio"
                            webRole="radio"
                            accessibilityChecked={source.id === boundSourceId}
                            selected={source.id === boundSourceId}
                            disabled={!enabled || source.id === boundSourceId}
                            onPress={async () => {
                                close();
                                await props.onTransfer({
                                    kind: 'directory_source',
                                    directorySourceId: source.id,
                                });
                            }}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}
        </>
    );
});

const MemberDetail = React.memo(function MemberDetail(props: Readonly<{
    context: TeamSectionContext;
    membershipId: string;
    renderEncryptionSection?: TeamMemberSectionRenderer;
    /** The Team's condition banners; they sit under this page's identity header. */
    banners?: React.ReactNode;
}>) {
    const router = useRouter();
    const { context, membershipId } = props;
    const [load, setLoad] = React.useState<MembershipLoad>(LOADING);
    const [readFailure, setReadFailure] = React.useState<HomeDomainFailure | null>(null);
    const [busy, setBusy] = React.useState(false);
    const transitionInFlightRef = React.useRef(false);
    /** The Home's own refusal, kept until the next attempt clears it. */
    const [notice, setNotice] = React.useState<string | null>(null);
    const generation = React.useRef(0);

    const serverId = context.scope.serverId;
    const accountId = context.scope.accountId;
    const teamId = context.address.teamId;

    const reload = React.useCallback(() => {
        const currentGeneration = (generation.current += 1);
        void (async () => {
            const outcome = await getTeamMember({
                scope: { serverId, accountId },
                address: { serverId, teamId },
                membershipId,
            });
            if (currentGeneration !== generation.current) return;
            if (outcome.kind === 'succeeded') {
                setReadFailure(null);
                setLoad(Object.freeze({ kind: 'ready' as const, membership: outcome.value }));
                return;
            }
            setReadFailure(outcome.failure);
            // A transient refresh failure cannot erase a member the Home
            // already projected. An authoritative refusal does withdraw it.
            setLoad((current) => isAuthoritativeScopedSnapshotRefusalKind(outcome.failure.kind)
                ? UNAVAILABLE
                : current.kind === 'ready'
                    ? current
                    : UNAVAILABLE);
        })();
    }, [serverId, accountId, teamId, membershipId]);

    React.useEffect(() => {
        reload();
        return () => {
            generation.current += 1;
        };
    }, [reload]);

    // Point detail has no separate cache: a content-free Team change wakes this
    // exact Home reader and the Home remains the sole source of the membership.
    // This covers changes made by another device or an external source while
    // the detail stays mounted.
    React.useEffect(() => subscribeHomeAccountChange((event) => {
        if (event.serverId !== serverId) return;
        if (event.entityIds !== undefined
            && !event.entityIds.includes(TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1)) return;
        reload();
    }), [serverId, reload]);

    /**
     * One place where a membership transition is run. A refused transition
     * reports the Home's own reason and then re-reads rather than guessing:
     * the refusal usually means this screen's projection is already behind,
     * and silence would leave a manager believing a change landed when nothing
     * moved. The loaded member stays on screen throughout.
     */
    const run = React.useCallback(async (
        operation: () => Promise<Readonly<{ kind: 'succeeded'; value?: unknown } | { kind: 'failed'; failure: HomeDomainFailure }>>,
    ) => {
        // The `busy` disabled state only takes effect on the next render, so the
        // ref is what actually closes the same-frame double-activation window on
        // fast pointer/touch. A membership transition is not something to send
        // twice because a control had not repainted yet.
        if (transitionInFlightRef.current) return;
        transitionInFlightRef.current = true;
        setNotice(null);
        setBusy(true);
        try {
            const outcome = await operation();
            if (outcome.kind === 'failed') setNotice(teamMutationFailureLabel(outcome.failure));
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
            else throw cause;
        } finally {
            transitionInFlightRef.current = false;
            setBusy(false);
        }
        reload();
        context.refresh();
    }, [reload, context]);

    /**
     * The management transfer, confirmed once and then executed.
     *
     * A refusal is reported in the Home's own terms rather than as a generic
     * failure: `management_conflict` means the named source holds no identity
     * this membership could be bound to, which is an actionable fact about the
     * source, not a permission problem.
     */
    const transferManagement = React.useCallback(async (
        membership: TeamMembershipV1,
        management:
            | Readonly<{ kind: 'native' }>
            | Readonly<{ kind: 'directory_source'; directorySourceId: string }>,
    ) => {
        const confirmed = await Modal.confirm(
            t('teams.members.managementTitle'),
            t('teams.members.managementHelp'),
            { confirmText: t('teams.members.managementTitle') },
        );
        if (!confirmed) return;
        if (transitionInFlightRef.current) return;
        transitionInFlightRef.current = true;
        setNotice(null);
        setBusy(true);
        let outcome: Awaited<ReturnType<typeof setTeamMemberManagement>>;
        try {
            outcome = await setTeamMemberManagement({
                scope: context.scope,
                address: context.address,
                membershipId: membership.id,
                management,
            });
        } catch (cause) {
            transitionInFlightRef.current = false;
            setBusy(false);
            if (isTeamActionApprovalPendingError(cause)) {
                context.requestApproval(cause.artifactId);
                return;
            }
            throw cause;
        }
        transitionInFlightRef.current = false;
        setBusy(false);
        if (outcome.kind === 'failed') {
            setNotice(teamMutationFailureLabel(outcome.failure));
        }
        // The Home's answer is authoritative either way: a refusal usually means
        // this projection is already behind.
        reload();
        context.refresh();
    }, [context, reload]);

    if (load.kind === 'loading') {
        return (
            <>
                <PageHeader testID="team-member-header" title={t('teams.tabs.members')} alwaysShowTitle meta={[
                    { key: 'team', text: context.team.name },
                    { key: 'home', icon: 'house', text: context.homeName },
                ]} />
                {props.banners}
                <ItemGroup>
                    <Item testID="team-member-loading" title={t('teams.tabs.members')} loading mode="info" showChevron={false} />
                </ItemGroup>
            </>
        );
    }

    if (load.kind === 'unavailable') {
        return (
            <>
                <PageHeader testID="team-member-header" title={t('teams.tabs.members')} alwaysShowTitle meta={[
                    { key: 'team', text: context.team.name },
                    { key: 'home', icon: 'house', text: context.homeName },
                ]} />
                {props.banners}
                <SurfaceStateCard
                    testID="team-member-unavailable"
                    kind="unavailable"
                    title={readFailure ? teamReadFailureLabel(readFailure) : t('teams.errors.notFound')}
                    action={readFailure?.retryable ? { label: t('teams.unavailable.retry'), onPress: reload } : undefined}
                    accessibilitySemantics="alert"
                />
            </>
        );
    }

    const { membership } = load;
    const person = resolveAccountDisplayName({ profile: membership.account, accountId: membership.accountId, viewerAccountId: context.scope.accountId });
    const displayName = person.name;
    const managedBy = membershipManagementLabel(membership);
    // Every control is gated by the host's readiness *and* the server's own
    // per-membership capability. Neither alone is sufficient.
    const canAct = context.canMutate && !busy;
    const assignableRoles = membership.capabilities.assignableRoles;
    // Withheld rather than offered and refused; the footer says why.
    const ownerWithheld = membership.capabilities.setRole
        && context.team.capabilities.manageMembers
        && !context.team.capabilities.manageOwners;

    const memberContext = {
        scope: context.scope,
        address: context.address,
        team: context.team,
        membership,
        mutationsAvailable: canAct,
        refresh: () => {
            reload();
            context.refresh();
        },
    };

    const removeButton = (
        <RoundButton
            testID="team-member-remove"
            size="small"
            display="destructive"
            title={t('teams.members.remove')}
            disabled={!canAct}
            onPress={async () => {
                const confirmed = await Modal.confirm(
                    t('teams.members.removeTitle', { name: displayName }),
                    t('teams.members.removeBody'),
                    { confirmText: t('teams.members.remove'), destructive: true },
                );
                if (!confirmed) return;
                if (transitionInFlightRef.current) return;
                transitionInFlightRef.current = true;
                setNotice(null);
                setBusy(true);
                let outcome: Awaited<ReturnType<typeof removeTeamMember>>;
                try {
                    outcome = await removeTeamMember({
                        scope: context.scope,
                        address: context.address,
                        membershipId: membership.id,
                    });
                } catch (cause) {
                    transitionInFlightRef.current = false;
                    setBusy(false);
                    if (isTeamActionApprovalPendingError(cause)) {
                        context.requestApproval(cause.artifactId);
                        return;
                    }
                    throw cause;
                }
                transitionInFlightRef.current = false;
                setBusy(false);
                context.refresh();
                // A removed lifetime no longer addresses anything,
                // so success leaves. A refusal keeps the member
                // on screen with the Home's own reason.
                if (outcome.kind === 'succeeded') router.back();
                else {
                    setNotice(teamMutationFailureLabel(outcome.failure));
                    reload();
                }
            }}
        />
    );

    return (
        <>
            <PageHeader
                testID="team-member-identity"
                alwaysShowTitle
                title={displayName}
                leading={(
                    <Avatar
                        id={membership.accountId}
                        size={MEMBER_HEADER_AVATAR_SIZE}
                        imageUrl={membership.account.avatarUrl}
                    />
                )}
                meta={[
                    { key: 'team', text: context.team.name },
                    { key: 'home', icon: 'house', text: context.homeName },
                    { key: 'role', text: teamRoleLabel(membership.role) },
                    ...(person.viewer && person.named
                        ? [{ key: 'you', text: t('teams.members.you') }]
                        : []),
                ]}
            />
            {props.banners}
            {notice ? (
                <AttentionBanner
                    testID="team-member-notice"
                    title={t('teams.members.managementTitle')}
                    description={notice}
                    accessibilityLiveRegion="polite"
                />
            ) : null}
            {readFailure ? (
                <AttentionBanner
                    testID="team-member-read-failure"
                    title={teamReadFailureLabel(readFailure)}
                    action={readFailure.retryable ? {
                        label: t('teams.unavailable.retry'),
                        onPress: reload,
                        testID: 'team-member-retry',
                    } : undefined}
                />
            ) : null}

            <ItemGroup
                title={t('teams.members.membershipSection')}
                description={managedBy ? t('teams.members.managedReadOnly') : undefined}
            >
                <Item
                    testID="team-member-status"
                    title={t('teams.authentication.detail.status')}
                    detail={membership.status === 'suspended'
                        ? t('teams.status.suspended')
                        : t('teams.status.active')}
                    showChevron={false}
                />
                <Item
                    testID="team-member-history"
                    title={t('teams.history.label')}
                    detail={membership.historyAccess === 'all_existing'
                        ? t('teams.history.allExisting')
                        : t('teams.history.fromMembership')}
                    showChevron={false}
                />
                {managedBy ? (
                    <Item
                        testID="team-member-managed-by"
                        title={t('teams.members.detailManagedBy')}
                        detail={managedBy}
                        showChevron={false}
                    />
                ) : null}
                {/* An externally owned lifetime is read-only here and says where
                    it is owned. The source id is navigation, not authority: the
                    directory destination re-checks its own capability, so the
                    row is offered only to a viewer who can reach it. */}
                {membership.management.kind !== 'native'
                    && context.team.capabilities.manageAuthentication ? (() => {
                        const management = membership.management;
                        return (
                        <Item
                            testID="team-member-open-source"
                            icon={<Icon name="tree-structure" />}
                            title={t('teams.members.detailOpenSource')}
                            detail={management.label}
                            onPress={() => router.push(
                                management.kind === 'directory_source'
                                    ? teamDirectorySourcePath(
                                        context.address,
                                        management.directorySourceId,
                                    )
                                    : teamIdentityConnectionPath(
                                        context.address,
                                        management.identityConnectionId,
                                    ),
                            )}
                        />
                        );
                    })() : null}
            </ItemGroup>

            {/* Every offered role carries its one sentence of consequence, and
                the set itself is the Home's answer rather than the whole enum:
                a control the Home would refuse is not rendered. */}
            {assignableRoles.length > 0 ? (
                <ItemGroup
                    title={t('teams.members.roleLabel')}
                    description={ownerWithheld ? t('teams.members.ownerOnlyAction') : undefined}
                    accessibilityRole="radiogroup"
                    accessibilityLabel={t('teams.members.roleLabel')}
                >
                    {assignableRoles.map((role) => (
                        <Item
                            key={role}
                            testID={`team-member-role:${role}`}
                            title={teamRoleLabel(role)}
                            subtitle={teamRoleDescription(role)}
                            accessibilityRole="radio"
                            webRole="radio"
                            accessibilityChecked={role === membership.role}
                            selected={role === membership.role}
                            disabled={!canAct || role === membership.role}
                            onPress={() => void run(() => setTeamMemberRole({
                                scope: context.scope,
                                address: context.address,
                                membershipId: membership.id,
                                role,
                            }))}
                            showChevron={false}
                        />
                    ))}
                </ItemGroup>
            ) : null}

            <MemberManagementSection
                context={context}
                membership={membership}
                busy={busy}
                onTransfer={(management) => transferManagement(membership, management)}
            />

            <MemberGroupsSection context={context} membershipId={membership.id} />

            {/* Contributed sections mount here with the host's own resolved
                Home, Team, membership and readiness. */}
            {props.renderEncryptionSection?.(memberContext) ?? null}

            {membership.capabilities.suspend || membership.capabilities.reactivate
                || membership.capabilities.remove ? (
                <ItemGroup surface="none">
                    <SectionButtonRow
                        trailing={membership.capabilities.remove ? removeButton : undefined}
                    >
                    {membership.capabilities.suspend ? (
                        <RoundButton
                            testID="team-member-suspend"
                            size="small"
                            display="secondary"
                            title={t('teams.members.suspend')}
                            disabled={!canAct}
                            onPress={async () => {
                                const confirmed = await Modal.confirm(
                                    t('teams.members.suspendTitle', { name: displayName }),
                                    t('teams.members.suspendBody'),
                                    { confirmText: t('teams.members.suspend') },
                                );
                                if (!confirmed) return;
                                await run(() => suspendTeamMember({
                                    scope: context.scope,
                                    address: context.address,
                                    membershipId: membership.id,
                                }));
                            }}
                        />
                    ) : null}
                    {membership.capabilities.reactivate ? (
                        <RoundButton
                            testID="team-member-reactivate"
                            size="small"
                            display="secondary"
                            title={t('teams.members.reactivate')}
                            disabled={!canAct}
                            onPress={async () => {
                                const confirmed = await Modal.confirm(
                                    t('teams.members.reactivateTitle', { name: displayName }),
                                    t('teams.members.reactivateBody'),
                                    { confirmText: t('teams.members.reactivate') },
                                );
                                if (!confirmed) return;
                                await run(() => reactivateTeamMember({
                                    scope: context.scope,
                                    address: context.address,
                                    membershipId: membership.id,
                                }));
                            }}
                        />
                    ) : null}
                    </SectionButtonRow>
                </ItemGroup>
            ) : null}
        </>
    );
});

/**
 * One Team membership.
 *
 * This is the single host for member-detail sections. Contributions mount
 * through `renderEncryptionSection` with the resolved
 * {@link TeamMemberSectionContext}; they never resolve their own Home, Account,
 * Team or membership, and never decide readiness for themselves.
 */
export const TeamMemberDetailScreen = React.memo(function TeamMemberDetailScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    membershipId: string;
    renderEncryptionSection?: TeamMemberSectionRenderer;
}>) {
    return (
        <TeamSection serverId={props.serverId} teamId={props.teamId} title={t('teams.tabs.members')} childRendersHeader>
            {(context, banners) => (
                <MemberDetail
                    context={context}
                    membershipId={props.membershipId}
                    renderEncryptionSection={props.renderEncryptionSection}
                    banners={banners}
                />
            )}
        </TeamSection>
    );
});
