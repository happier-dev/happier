import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import {
    type TeamMembershipV1,
    type TeamRoleV1,
} from '@happier-dev/protocol/teams';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { teamReadFailureLabel } from '@/components/settings/teams/teamMutationPresentation';
import { useTeamMemberGroups, type TeamMemberGroups } from '@/hooks/teams/useTeamMemberGroups';
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
import { getPreferredLanguage, t } from '@/text';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';

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
import {
    resolveTeamMemberManagementChoices,
    teamMemberRemovalLines,
    type TeamMemberManagementChoiceId,
} from './teamMemberPresentation';

const MEMBER_HEADER_AVATAR_SIZE = 44;

type MembershipLoad =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'ready'; membership: TeamMembershipV1 }>;

const LOADING: MembershipLoad = Object.freeze({ kind: 'loading' as const });
const UNAVAILABLE: MembershipLoad = Object.freeze({ kind: 'unavailable' as const });

/** The fixed order roles are offered in, most authority first. */
const ROLE_ORDER: readonly TeamRoleV1[] = Object.freeze(['owner', 'admin', 'member', 'guest']);

/** A segmented control holds two to four choices; past that the same choice is a field select. */
const SEGMENTED_CHOICE_LIMIT = 4;

/**
 * The Groups this membership is effectively in.
 *
 * Read-only and offered to every viewer the Home answers: a person's Group
 * membership explains where their access comes from, and hiding it from a
 * non-manager would leave the roster unable to answer its own question. Each row
 * opens the same Group destination the Group list opens. The read belongs to the
 * person page, which also names these Groups when it confirms a removal.
 */
const MemberGroupsSection = React.memo(function MemberGroupsSection(props: Readonly<{
    context: TeamSectionContext;
    groups: TeamMemberGroups;
}>) {
    const router = useRouter();
    const { context, groups } = props;

    if (!context.team.capabilities.viewRoster) return null;

    // A still-loading list is not an empty one, and an unreachable Home is not an empty one
    // either: each says exactly what it knows, in the section's own place.
    const failure = groups.error ? (
        <SurfaceStateCard
            testID="team-member-groups-unavailable"
            kind="error"
            size="line"
            title={teamReadFailureLabel(groups.error)}
            action={groups.error.retryable ? {
                label: t('teams.unavailable.retry'),
                onPress: () => void groups.reload(),
                testID: 'team-member-groups-retry',
            } : undefined}
            accessibilitySemantics="alert"
        />
    ) : null;

    return (
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
            {/* Rows already read stay on screen through a failure. */}
            {failure ?? (groups.rows.length > 0 ? null : groups.status === 'ready' ? (
                <SurfaceStateCard
                    testID="team-member-groups-empty"
                    kind="empty"
                    size="line"
                    title={t('teams.members.detailGroupsEmpty')}
                />
            ) : (
                <ItemLoadStateRows
                    testID="team-member-groups-loading"
                    state={{ kind: 'loading' }}
                    rows={2}
                    accessibilityLabel={t('teams.members.detailGroups')}
                />
            ))}
            {!groups.error && groups.hasMore ? (
                <Item
                    testID="team-member-groups-load-more"
                    title={t('homeGovernance.loadMore')}
                    loading={groups.status === 'loading_more'}
                    disabled={groups.status === 'loading_more'}
                    onPress={() => void groups.loadMore()}
                    showChevron={false}
                />
            ) : null}
        </ItemGroup>
    );
});

/**
 * Who manages this membership (lab `tsMembers-D`): the directory that owns it, or Happier.
 *
 * It renders only behind the Home's own `setManagement` capability, which is
 * false when the conversion would refuse by construction — there is no local
 * reconstruction of whether a source could take this person over. Returning to
 * native management names no source; binding names the exact one, because a
 * vague "manage externally" would let the client pick a source it did not
 * choose. The transfer preserves the lifetime, role, status and horizon, which
 * is what the line beneath says.
 */
const MemberManagementRow = React.memo(function MemberManagementRow(props: Readonly<{
    context: TeamSectionContext;
    membership: TeamMembershipV1;
    busy: boolean;
    onTransfer: (
        management: Readonly<{ kind: 'native' }> | Readonly<{ kind: 'directory_source'; directorySourceId: string }>,
    ) => Promise<void>;
}>) {
    const { context, membership } = props;
    const [open, setOpen] = React.useState(false);

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
    const choices = React.useMemo(
        () => resolveTeamMemberManagementChoices(membership, sources),
        [membership, sources],
    );

    if (!membership.capabilities.setManagement) return null;

    const enabled = context.canMutate && !props.busy;
    const choose = (id: TeamMemberManagementChoiceId) => {
        if (id === choices.selectedId) return;
        void props.onTransfer(id === 'native'
            ? { kind: 'native' }
            : { kind: 'directory_source', directorySourceId: id });
    };

    if (choices.options.length > SEGMENTED_CHOICE_LIMIT) {
        return (
            <DropdownMenu
                testID="team-member-management"
                open={open}
                onOpenChange={setOpen}
                selectedId={choices.selectedId}
                items={choices.options.map((option) => ({
                    id: option.id,
                    title: option.label,
                    testID: `team-member-management:${option.id}`,
                    disabled: !enabled,
                }))}
                onSelect={(id) => {
                    setOpen(false);
                    choose(id);
                }}
                itemTrigger={{
                    title: t('teams.members.detailManagedBy'),
                    subtitle: t('teams.members.managementHelp'),
                    showSelectedSubtitle: false,
                }}
            />
        );
    }

    return (
        <SegmentedChoiceItem<TeamMemberManagementChoiceId>
            testID="team-member-management"
            title={t('teams.members.detailManagedBy')}
            subtitle={t('teams.members.managementHelp')}
            subtitleLines={0}
            options={choices.options}
            value={choices.selectedId}
            onChange={choose}
            disabled={!enabled}
            testIDPrefix="team-member-management"
        />
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

    const groups = useTeamMemberGroups({
        scope: context.scope,
        address: context.address,
        membershipId,
        enabled: context.team.capabilities.viewRoster,
    });

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
                {/* The page's known first section holds its place while the person is read. */}
                <ItemGroup title={t('teams.members.roleLabel')}>
                    <ItemLoadStateRows
                        testID="team-member-loading"
                        state={{ kind: 'loading' }}
                        rows={1}
                        accessibilityLabel={t('teams.loading')}
                    />
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
    // Withheld rather than offered and refused; the section says why.
    const ownerWithheld = membership.capabilities.setRole
        && context.team.capabilities.manageMembers
        && !context.team.capabilities.manageOwners;
    // The Home's answer, not the whole enum: a role it would refuse is not offered. When the
    // current role is not among them (the owner-required recovery), no choice is marked and the
    // row names the current role beneath its label instead.
    const roleOptions = ROLE_ORDER
        .filter((role) => assignableRoles.includes(role))
        .map((role) => ({ id: role, label: teamRoleLabel(role), description: teamRoleDescription(role) }));

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

    const remove = async () => {
        // The consequence in the manager's terms (lab `tsMembers-X`): what ends, the Groups by
        // name, and what stays.
        const confirmed = await Modal.confirm(
            t('teams.members.removal.title', { name: displayName, team: context.team.name }),
            teamMemberRemovalLines({
                groupNames: groups.rows.map((group) => group.name),
                moreGroups: groups.hasMore || groups.status !== 'ready',
            }).join('\n'),
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
    };

    const management = membership.management;
    const canOpenSource = management.kind !== 'native' && context.team.capabilities.manageAuthentication;
    const hasLifecycleActions = membership.capabilities.suspend
        || membership.capabilities.reactivate
        || membership.capabilities.remove;

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
                    { key: 'role', text: teamRoleLabel(membership.role) },
                    ...(person.viewer && person.named
                        ? [{ key: 'you', text: t('teams.members.you') }]
                        : []),
                    ...(membership.status === 'suspended'
                        ? [{ key: 'status', testID: 'team-member-status', text: t('teams.status.suspended') }]
                        : []),
                    {
                        key: 'joined',
                        text: t('teams.members.joined', {
                            when: formatWithCachedDateTimeFormatter(new Date(membership.joinedAt), getPreferredLanguage(), { dateStyle: 'medium' }),
                        }),
                    },
                    ...(managedBy ? [{ key: 'managed', testID: 'team-member-managed-by', text: managedBy }] : []),
                    // The exact Team and Home this person is a member of, as every Team page says.
                    { key: 'team', text: context.team.name },
                    { key: 'home', icon: 'house' as const, text: context.homeName },
                ]}
            />
            {props.banners}
            {notice ? (
                <AttentionBanner
                    testID="team-member-notice"
                    title={t('homeGovernance.changeFailedTitle')}
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

            {/* Role (lab `tsMembers-A`/`D`/`R`): a manager chooses among the roles the Home would
                accept, each with its one sentence of consequence; anyone else reads the role and
                who changes it. A directory-managed membership says where its role is set. */}
            <ItemGroup
                title={t('teams.members.roleLabel')}
                description={managedBy
                    ? t('teams.members.managedReadOnly')
                    : ownerWithheld ? t('teams.members.ownerOnlyAction') : undefined}
            >
                {assignableRoles.length > 0 ? (
                    <SegmentedChoiceItem<TeamRoleV1>
                        testID="team-member-role"
                        title={t('teams.members.roleLabel')}
                        subtitle={teamRoleLabel(membership.role)}
                        subtitleLines={0}
                        options={roleOptions}
                        value={membership.role}
                        onChange={(role) => {
                            if (role === membership.role) return;
                            void run(() => setTeamMemberRole({
                                scope: context.scope,
                                address: context.address,
                                membershipId: membership.id,
                                role,
                            }));
                        }}
                        disabled={!canAct}
                        testIDPrefix="team-member-role"
                    />
                ) : (
                    <Item
                        testID="team-member-role"
                        title={teamRoleLabel(membership.role)}
                        subtitle={management.kind === 'native'
                            ? `${teamRoleDescription(membership.role)} ${t('teams.members.roleReadOnly', { team: context.team.name })}`
                            : t('teams.members.roleSetBy', { source: management.label })}
                        subtitleLines={0}
                        mode="info"
                        showChevron={false}
                    />
                )}
                {/* Where an externally owned membership is owned (lab `tsMembers-D`). The source id
                    is navigation, not authority: the directory destination re-checks its own
                    capability, so the row is offered only to a viewer who can reach it. */}
                {management.kind !== 'native' && canOpenSource ? (
                    <Item
                        testID="team-member-open-source"
                        icon={<Icon name="tree-structure" />}
                        title={management.label}
                        onPress={() => router.push(
                            management.kind === 'directory_source'
                                ? teamDirectorySourcePath(context.address, management.directorySourceId)
                                : teamIdentityConnectionPath(context.address, management.identityConnectionId),
                        )}
                    />
                ) : null}
                <MemberManagementRow
                    context={context}
                    membership={membership}
                    busy={busy}
                    onTransfer={(next) => transferManagement(membership, next)}
                />
            </ItemGroup>

            <MemberGroupsSection context={context} groups={groups} />

            <ItemGroup title={t('teams.members.accessSection')}>
                <Item
                    testID="team-member-history"
                    title={t('teams.history.label')}
                    subtitle={membership.historyAccess === 'all_existing'
                        ? t('teams.history.allExisting')
                        : t('teams.history.fromMembership')}
                    subtitleLines={0}
                    mode="info"
                    showChevron={false}
                />
            </ItemGroup>

            {/* Contributed sections mount here with the host's own resolved
                Home, Team, membership and readiness. */}
            {props.renderEncryptionSection?.(memberContext) ?? null}

            {/* The page closes with the quiet leave-and-destroy row: suspension on the left, the
                irreversible removal at the far edge, their consequences beneath. Any further
                destructive action on this membership (the member leaving) belongs in this row. */}
            {hasLifecycleActions ? (
                <ItemGroup surface="none">
                    <SectionButtonRow
                        footnote={t('teams.members.lifecycleFootnote')}
                        trailing={membership.capabilities.remove ? (
                            <RoundButton
                                testID="team-member-remove"
                                size="small"
                                display="destructive"
                                title={t('teams.members.removal.action', { team: context.team.name })}
                                disabled={!canAct}
                                onPress={remove}
                            />
                        ) : undefined}
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
