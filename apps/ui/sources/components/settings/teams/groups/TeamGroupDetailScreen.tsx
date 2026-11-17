import * as React from 'react';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { useNavigation, useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    TEAM_GROUP_NAME_MAX_LENGTH_V1,
    validateTeamGroupDescriptionV1,
    validateTeamGroupNameV1,
    type SessionHistoryAccessV1,
    type TeamGroupMemberMutationResultV1,
    type TeamGroupMemberV1,
    type TeamGroupV1,
} from '@happier-dev/protocol/teams';
import { useUnistyles } from 'react-native-unistyles';

import { Avatar } from '@/components/ui/avatar/Avatar';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { PageHeaderMarkIcon } from '@/components/ui/layout/PageHeaderMarkSlot';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { CollectionRows } from '@/components/ui/lists/collection/CollectionList';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemLoadStateRows } from '@/components/ui/lists/ItemLoadStateRows';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { VirtualizedItemList } from '@/components/ui/lists/VirtualizedItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useTeamGroup, useTeamGroupMembers } from '@/hooks/teams/useTeamGroups';
import { useOpenedPrivateLabels } from '@/sync/ops/privateLabels/useOpenedPrivateLabels';
import { useTeamMembersRoster } from '@/hooks/teams/useTeamMembersRoster';
import { resolveAccountDisplayName } from '@/sync/domains/account/formatAccountDisplayName';
import { createPrivateLabelClient } from '@/sync/ops/privateLabels/privateLabelClient';
import { teamGroupLabelBinding, TEAM_GROUP_LABEL_READ_POLICY } from '@/sync/ops/teams/teamGroupLabels';
import {
    addTeamGroupMember,
    archiveTeamGroup,
    removeTeamGroupMember,
    restoreTeamGroup,
    updateTeamGroup,
    type TeamGroupOutcome,
} from '@/sync/ops/teams/teamGroupOperations';
import {
    isTeamActionApprovalPendingError,
} from '@/sync/ops/teams/teamActionClient';
import { t } from '@/text';
import { useUnsavedDraftNavigationGuard } from '@/utils/navigation/useUnsavedDraftNavigationGuard';

import { TeamSection, type TeamPageStaleRead, type TeamSectionRenderHeader } from '../TeamSection';
import { useEditedMetadataDraft } from '../useEditedMetadataDraft';
import type { TeamSectionContext } from '../teamSectionContext';
import { teamMutationFailureLabel, teamReadFailureLabel } from '../teamMutationPresentation';
import { groupManagementLabel } from '../teamLabels';
import { sessionHistoryChoiceOptions } from '../teamPolicyPresentation';
import {
    teamDirectorySourcePath,
    teamGroupMemberDetailPath,
    teamIdentityConnectionPath,
} from '../teamsRoutes';
import { TeamMemberDefaultsSection } from '../defaults/TeamMemberDefaultsSection';
import { memberDefaultsAccess } from '../defaults/memberDefaults';

const GROUP_DETAIL_CHUNK_SIZE = 12;

/**
 * The page's one mutation notice, said where the person acted: under the roster for a roster
 * change, in the archived notice for Restore, beneath Archive for Archive. Each attempt clears it,
 * so an earlier refusal never outlives a later success. A declined approval has no message.
 */
type GroupNotice = Readonly<{ place: 'roster' | 'restore' | 'archive'; message: string | null }>;

type GroupDetailVirtualizedRow = Readonly<{
    key: string;
    render: () => React.ReactElement;
}>;

/**
 * Why this person is in this Group, in the words a manager can act on.
 *
 * A native contribution alongside an external one is what makes a native remove
 * *not* a removal, so the row says where the remaining contribution comes from
 * rather than presenting a control whose effect would surprise.
 */
function contributionLabel(member: TeamGroupMemberV1): string | null {
    const external = member.contributions.external;
    if (external.length === 0) return null;
    return t('teams.groups.managedBy', {
        source: external.map((entry) => entry.label).join(', '),
    });
}

/**
 * Editing a Group's own name and description.
 *
 * A directory-created Group keeps native archive authority but not necessarily
 * metadata authority, so the section is offered only when the server's own
 * `updateMetadata` capability backs it rather than inferred from `management`.
 */
const GroupMetadataSection = React.memo(function GroupMetadataSection(props: Readonly<{
    context: TeamSectionContext;
    group: TeamGroupV1;
    /** Recipient-opened Group name; unavailable content is never overwritten. */
    name: string | null;
    /** Recipient-opened description; null wire content is an intentionally empty field. */
    description: string | null;
    /**
     * Whether this Group's own projection is current. A retained Group whose
     * point read failed keeps its content on screen, but its capabilities are
     * last-known, so writing through them is withheld until it answers again.
     */
    current: boolean;
}>) {
    const { context, group, current, name: publishedName, description: publishedDescription } = props;
    const navigation = useNavigation();
    const [saving, setSaving] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);
    const saveInFlightRef = React.useRef(false);

    React.useEffect(() => () => {
        saveInFlightRef.current = false;
    }, []);

    // The Home's answer stays authoritative when the Group moves under the
    // editor, but it never erases an unfinished draft: this is the same editor
    // owner the Team's own identity section uses.
    const draft = useEditedMetadataDraft({
        name: publishedName ?? '',
        description: publishedDescription ?? '',
    });
    const { name, description, conflict } = draft;
    useUnsavedDraftNavigationGuard({
        navigation,
        isDirty: draft.isDirty,
        onDiscard: draft.reset,
        tag: 'TeamGroupDetailScreen.beforeRemove',
    });

    const nameValidation = validateTeamGroupNameV1(name);
    const validatedName = nameValidation.status === 'ok' ? nameValidation.name : null;
    const descriptionValidation = validateTeamGroupDescriptionV1(description);
    const archived = group.archivedAt !== null;
    const editable = context.canMutate && current && !archived;
    const nameChanged = publishedName !== null
        && validatedName !== null
        && validatedName !== publishedName;
    const descriptionAvailable = group.description === null || publishedDescription !== null;
    const descriptionChanged = descriptionAvailable && descriptionValidation.status === 'ok'
        && (descriptionValidation.description ?? '') !== (publishedDescription ?? '');
    const mustSaveName = nameChanged || (group.name.kind === 'available' && group.name.label.legacyPlaintext === true);
    const mustSaveDescription = descriptionChanged || (descriptionAvailable
        && group.description?.kind === 'available' && group.description.label.legacyPlaintext === true);
    const changed = (publishedName === null || validatedName !== null)
        && descriptionValidation.status === 'ok' && (nameChanged || descriptionChanged);

    if (!group.capabilities.updateMetadata) return null;

    const save = async () => {
        if (saveInFlightRef.current
            || (publishedName !== null && validatedName === null)
            || descriptionValidation.status !== 'ok') return;
        saveInFlightRef.current = true;
        setSaving(true);
        setError(null);
        let outcome: Awaited<ReturnType<typeof updateTeamGroup>>;
        try {
            if (mustSaveName && validatedName === null) {
                saveInFlightRef.current = false;
                setSaving(false);
                return;
            }
            outcome = await updateTeamGroup({
                scope: context.scope,
                address: context.address,
                groupId: group.id,
                ...(mustSaveName && validatedName !== null ? { name: validatedName } : {}),
                ...(mustSaveDescription ? { description: descriptionValidation.description } : {}),
            });
        } catch (cause) {
            saveInFlightRef.current = false;
            setSaving(false);
            if (isTeamActionApprovalPendingError(cause)) {
                context.requestApproval(cause.artifactId);
            } else {
                setError(t('teams.errors.generic'));
            }
            return;
        }
        saveInFlightRef.current = false;
        setSaving(false);
        if (outcome.kind === 'failed') {
            setError(teamMutationFailureLabel(outcome.failure));
            return;
        }
        draft.commit({
            name: nameChanged && validatedName !== null ? validatedName : name,
            description: mustSaveDescription ? descriptionValidation.description ?? '' : description,
        });
    };

    return (
        <>
            {conflict ? (
                <AttentionBanner
                    testID="team-group-identity-conflict-notice"
                    title={t('teams.errors.conflict')}
                    description={[publishedName ?? t('common.unavailable'), descriptionAvailable ? publishedDescription ?? '' : t('common.unavailable')].filter(Boolean).join('\n')}
                    accessibilityLiveRegion="assertive"
                    action={{
                        label: t('common.continue'),
                        onPress: draft.acceptPublished,
                        disabled: saving,
                        testID: 'team-group-identity-conflict',
                    }}
                />
            ) : null}
            <ItemGroup title={t('teams.groups.detailsSection')}>
                <Item
                    title={t('teams.groups.nameLabel')}
                    accessoryLayout="adaptive"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="team-group-name"
                            value={name}
                            onChangeText={draft.setName}
                            placeholder={publishedName === null ? t('common.unavailable') : t('teams.groups.namePlaceholder')}
                            accessibilityLabel={t('teams.groups.nameLabel')}
                            maxLength={TEAM_GROUP_NAME_MAX_LENGTH_V1}
                            editable={editable && publishedName !== null}
                        />
                    )}
                />
                <Item
                    title={t('teams.create.descriptionLabel')}
                    accessoryLayout="stacked"
                    showChevron={false}
                    rightElement={(
                        <FieldTextInput
                            testID="team-group-description"
                            value={description}
                            onChangeText={draft.setDescription}
                            placeholder={descriptionAvailable ? t('teams.groups.descriptionPlaceholder') : t('common.unavailable')}
                            accessibilityLabel={t('teams.create.descriptionLabel')}
                            multiline
                            minLines={2}
                            editable={editable && descriptionAvailable}
                            error={descriptionValidation.status !== 'ok' ? t('teams.errors.invalidDescription') : null}
                        />
                    )}
                />
            </ItemGroup>
            <ItemGroup surface="none">
                <SectionButtonRow footnote={error} footnoteTone="danger" footnoteTestID="team-group-identity-error">
                    <RoundButton
                        testID="team-group-save"
                        size="small"
                        title={t('common.save')}
                        loading={saving}
                        disabled={!changed
                            || conflict
                            || descriptionValidation.status !== 'ok'
                            || saving
                            || !editable}
                        onPress={() => void save()}
                    />
                </SectionButtonRow>
            </ItemGroup>
        </>
    );
});

const GroupDetail = React.memo(function GroupDetail(props: Readonly<{
    context: TeamSectionContext;
    groupId: string;
    renderHeader: TeamSectionRenderHeader;
}>) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const { context, groupId } = props;
    const [busy, setBusy] = React.useState(false);
    const [notice, setNotice] = React.useState<GroupNotice | null>(null);
    const rosterNotice = notice?.place === 'roster' ? notice.message : null;
    const [picking, setPicking] = React.useState(false);
    /** The person whose add is in flight, so their row shows it until the Home answers. */
    const [addingAccountId, setAddingAccountId] = React.useState<string | null>(null);
    const mutationInFlightRef = React.useRef(false);

    React.useEffect(() => () => {
        mutationInFlightRef.current = false;
    }, []);
    /**
     * The Group's own history intent, independent of any Team horizon.
     *
     * The membership owner consumes it only when this membership's first
     * contribution mints a horizon and never widens a retained one, so copying a
     * person's existing Team horizon here would silently answer a different
     * question than the one the manager is being asked.
     */
    const [groupHistoryAccess, setGroupHistoryAccess] = React.useState<SessionHistoryAccessV1>(
        context.team.policy.defaultSessionHistoryAccess,
    );
    const detail = useTeamGroup({
        scope: context.scope,
        address: context.address,
        groupId,
        enabled: true,
    });

    const members = useTeamGroupMembers({
        scope: context.scope,
        address: context.address,
        groupId,
        enabled: detail.group !== null,
    });

    // Group candidates are the Team's own members: a Group is a subset of the
    // Team, so the Team roster is the right source rather than a Home-wide search.
    const candidates = useTeamMembersRoster({
        scope: context.scope,
        address: context.address,
        filter: 'all',
        enabled: picking,
    });

    // Candidate exclusion is only truthful once every Group-member page has
    // contributed its native Account ids. Complete that bounded read while the
    // picker is open; showing Team candidates sooner can offer someone whose
    // native contribution sits on a later Group page.
    React.useEffect(() => {
        if (!picking || members.error || !members.hasMore) return;
        if (members.status === 'loading' || members.status === 'loading_more') return;
        void members.loadMore();
    }, [picking, members.error, members.hasMore, members.status, members.loadMore]);

    // Every hook below runs on the loading and unavailable renders too. A Group
    // that arrives after the first paint is the ordinary cold path, so the
    // rendered branch may not change how many hooks this component calls.
    const group = detail.group;
    const labelRequests = React.useMemo(() => group === null ? [] : [
        { key: 'name', binding: teamGroupLabelBinding(group.id, 'name'),
            label: group.name.kind === 'available' ? group.name.label : null, readPolicy: TEAM_GROUP_LABEL_READ_POLICY },
        { key: 'description', binding: teamGroupLabelBinding(group.id, 'description'),
            label: group.description?.kind === 'available' ? group.description.label : null, readPolicy: TEAM_GROUP_LABEL_READ_POLICY },
    ], [group]);
    const openedLabels = useOpenedPrivateLabels({ scope: context.scope, requests: labelRequests });
    const groupName = openedLabels.name ?? null;
    const groupDescription = openedLabels.description ?? null;
    const archived = group !== null && group.archivedAt !== null;
    const managedBy = group === null ? null : groupManagementLabel(group);
    /**
     * This Group's own currentness, which is not the Team's.
     *
     * A Group point-refresh can fail beside a Team read that succeeded. The
     * retained Group stays on screen — losing it would be worse — but its
     * capabilities are then last-known rather than current, so the Group's own
     * writes are withheld and its own failure is named with its own retry
     * instead of being presented as a current Group nobody can explain.
     */
    const groupCurrent = detail.isCurrent;
    const groupStale = group !== null && !groupCurrent;
    // Whether this viewer edits the roster at all; a change in flight only pauses it, so the roster's
    // controls keep their place instead of disappearing for the length of a request.
    const rosterEditable = group !== null
        && group.capabilities.manageNativeMembers
        && context.canMutate
        && groupCurrent
        && !archived;
    const canEditRoster = rosterEditable && !busy;
    const nativeAccountIds = React.useMemo(() => new Set(
        members.rows.filter((member) => member.contributions.native).map((member) => member.accountId),
    ), [members.rows]);
    const nativeRosterReady = !members.error
        && !members.hasMore
        && members.status !== 'loading'
        && members.status !== 'loading_more';

    /**
     * One settlement for the immediate roster answer and the approved one.
     *
     * A native removal that leaves an external contribution is not a removal;
     * saying so is the difference between a truthful roster and a lie, and an
     * approved mutation owes the same truth as an immediate one.
     */
    const settleRosterChange = React.useCallback((
        result: TeamGroupMemberMutationResultV1,
        externalLabel: string | null,
    ) => {
        if (result.status === 'contribution_removed') {
            setNotice({
                place: 'roster',
                message: externalLabel
                    ? t('teams.groups.externalOnlyBody', { source: externalLabel })
                    : t('teams.groups.externalOnlyTitle'),
            });
        }
        void members.reload();
        void detail.reload();
    }, [detail.reload, members.reload]);

    const runRosterChange = React.useCallback(async (
        operation: () => Promise<TeamGroupOutcome<TeamGroupMemberMutationResultV1>>,
        externalLabel: string | null,
    ) => {
        if (mutationInFlightRef.current) return;
        mutationInFlightRef.current = true;
        setBusy(true);
        setNotice(null);
        let outcome: Awaited<ReturnType<typeof operation>>;
        try {
            outcome = await operation();
        } catch (cause) {
            if (isTeamActionApprovalPendingError(cause)) {
                // The roster change was deferred, not lost. Registering this
                // exact request is what lets its approved answer settle here;
                // settlement never redispatches, because the Home performs the
                // mutation when the approval is granted.
                context.requestApproval(cause.registration);
            } else {
                setNotice({ place: 'roster', message: t('teams.errors.generic') });
            }
            setBusy(false);
            mutationInFlightRef.current = false;
            return;
        }
        setBusy(false);
        mutationInFlightRef.current = false;
        if (outcome.kind === 'failed') {
            setNotice({ place: 'roster', message: teamMutationFailureLabel(outcome.failure) });
            if (outcome.failure.kind === 'outcome_unknown') {
                void members.reload();
                void detail.reload();
            }
            return;
        }
        settleRosterChange(outcome.value, externalLabel);
        return outcome;
    }, [context, detail.reload, members.reload, settleRosterChange]);

    /**
     * Including existing history is an instruction, not just a stored policy, so the
     * journey continues at that member's detail where the one preparation operation
     * lives. Future-only membership stays on the roster: there is nothing to prepare.
     */
    const addNative = React.useCallback(async (member: Readonly<{ accountId: string; membershipId: string }>) => {
        // The instruction this exact contribution carries, captured before the
        // await so a later Group-history change cannot retarget an approved
        // answer that was requested under the previous one.
        const includeHistory = groupHistoryAccess === 'all_existing';
        const continueHistoryPreparation = (result: TeamGroupMemberMutationResultV1) => {
            if (result.status !== 'added' || !includeHistory) return;
            router.push(teamGroupMemberDetailPath(
                context.address,
                member.membershipId,
                groupId,
                member.accountId,
                { prepareHistory: true },
            ));
        };
        const outcome = await runRosterChange(
            () => addTeamGroupMember({
                scope: context.scope,
                address: context.address,
                groupId,
                accountId: member.accountId,
                historyAccess: groupHistoryAccess,
                // An approved contribution is the same contribution and carries
                // the same instruction, so it settles the roster and continues
                // the preparation journey rather than ending as "reload".
                onApprovalSucceeded: (result) => {
                    settleRosterChange(result, null);
                    continueHistoryPreparation(result);
                },
                onApprovalFailed: (code) => setNotice({ place: 'roster', message: teamMutationFailureLabel({ kind: 'unknown', code, retryable: false }) }),
            }),
            null,
        );
        if (outcome?.kind !== 'succeeded') return;
        continueHistoryPreparation(outcome.value);
    }, [
        context.address,
        context.scope,
        groupHistoryAccess,
        groupId,
        router,
        runRosterChange,
        settleRosterChange,
    ]);

    const eligibleCandidates = React.useMemo(
        () => nativeRosterReady
            ? candidates.rows.filter((membership) => !nativeAccountIds.has(membership.accountId))
            : [],
        [candidates.rows, nativeAccountIds, nativeRosterReady],
    );

    const rows = React.useMemo<readonly GroupDetailVirtualizedRow[]>(() => {
        const result: GroupDetailVirtualizedRow[] = [];
        if (group === null) return result;
        const add = (key: string, render: () => React.ReactElement) => result.push({ key, render });
        // Adding happens in the roster: its section carries the "+", which opens the picker below.
        const addMemberAction = rosterEditable ? (
            <SectionActionButton
                testID="team-group-add-member"
                icon="plus"
                title={t('teams.groups.addMember')}
                expanded={picking}
                disabled={busy}
                onPress={() => setPicking((current) => !current)}
            />
        ) : undefined;

        if (archived) {
            const restoreGroup = async () => {
                if (mutationInFlightRef.current) return;
                mutationInFlightRef.current = true;
                setBusy(true);
                setNotice(null);
                try {
                    const outcome = await restoreTeamGroup({
                        scope: context.scope,
                        address: context.address,
                        groupId,
                    });
                    if (outcome.kind === 'failed') {
                        setNotice({ place: 'restore', message: teamMutationFailureLabel(outcome.failure) });
                        if (outcome.failure.kind === 'outcome_unknown') void detail.reload();
                    }
                } catch (cause) {
                    if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
                    else setNotice({ place: 'restore', message: t('teams.errors.generic') });
                } finally {
                    mutationInFlightRef.current = false;
                    setBusy(false);
                }
            };
            // One notice, one cause and its one action: Restore is the archived notice's own button,
            // and a refused Restore is said here, where it was pressed.
            const restoreFailure = notice?.place === 'restore' ? notice.message : null;
            add('archived', () => (
                <AttentionBanner
                    testID="team-group-archived"
                    tone={restoreFailure ? 'danger' : 'neutral'}
                    title={t('teams.directory.archivedBadge')}
                    description={restoreFailure ?? t('teams.groups.archivedReadOnly')}
                    accessibilityLiveRegion={restoreFailure ? 'assertive' : undefined}
                    action={group.capabilities.restore ? {
                        testID: 'team-group-restore',
                        label: t('teams.groups.restoreAction'),
                        // Restore is legitimate *because* the Group is archived, so it gates on host
                        // readiness rather than on the ordinary-write rule — but an unresolved approval
                        // for this exact restore is still custody the shell holds, and offering the
                        // control again would request one restore twice. Same expression as the Team's
                        // own restore in `TeamSettingsScreen`.
                        disabled: busy || !context.mutationsAvailable || context.approvalPending || !groupCurrent,
                        onPress: () => { void restoreGroup(); },
                    } : null}
                />
            ));
        }

        if (managedBy) {
            add('management', () => (
                <ItemGroup>
                {managedBy ? (() => {
                    const management = group.management;
                    const managementPath = management.kind === 'directory_created'
                        ? management.owner.kind === 'directory_source'
                            ? teamDirectorySourcePath(context.address, management.owner.directorySourceId)
                            : teamIdentityConnectionPath(
                                context.address,
                                management.owner.teamIdentityConnectionId,
                            )
                        : null;
                    return (
                    <Item
                        testID="team-group-managed-by"
                        mode="info"
                        title={t('teams.members.detailManagedBy')}
                        detail={managedBy}
                        subtitle={t('teams.groups.managedReadOnly')}
                        onPress={managementPath !== null
                            ? () => router.push(managementPath)
                            : undefined}
                        showChevron={managementPath !== null}
                    />
                    );
                })() : null}
                </ItemGroup>
            ));
        }

        // Keep the roster section visible while its first page is in flight. The
        // shared pager owns the request lifetime; this surface only presents its
        // canonical loading state and preserves any rows during refresh.
        if (members.status === 'loading' && members.rows.length === 0) {
            add('members-loading', () => (
                <ItemGroup
                    title={t('teams.groups.membersSection')}
                    action={addMemberAction}
                    virtualizedSegment={{ first: true, last: true }}
                >
                    <ItemLoadStateRows
                        testID="team-group-members-loading"
                        state={{ kind: 'loading' }}
                        rows={Math.min(Math.max(1, group.memberCount), GROUP_DETAIL_CHUNK_SIZE)}
                        accessibilityLabel={t('teams.loading')}
                    />
                </ItemGroup>
            ));
        }

        for (let start = 0; start < members.rows.length; start += GROUP_DETAIL_CHUNK_SIZE) {
            const chunk = members.rows.slice(start, start + GROUP_DETAIL_CHUNK_SIZE);
            const first = start === 0;
            const last = start + GROUP_DETAIL_CHUNK_SIZE >= members.rows.length;
            add(`members:${chunk[0]!.membershipId}`, () => (
                <ItemGroup
                    surface="none"
                    title={first ? t('teams.groups.membersSection') : undefined}
                    action={first ? addMemberAction : undefined}
                    description={first ? rosterNotice ?? undefined : undefined}
                    virtualizedSegment={{ first, last }}
                >
                    {/* A roster is a browse list: flat, rows parted by the one list-row rule across chunks (LISTS-BUILD). */}
                    <CollectionRows continued={!last}>
                    {chunk.map((member) => {
                        const person = resolveAccountDisplayName({ profile: member.account, accountId: member.accountId, viewerAccountId: context.scope.accountId });
                        const displayName = person.name;
                        const external = contributionLabel(member);
                        const isNative = member.contributions.native;
                        const rowActions: ItemAction[] = [
                            ...(rosterEditable ? [isNative ? {
                                id: 'remove-from-group',
                                title: t('teams.groups.removeNative'),
                                icon: 'user-minus' as const,
                                destructive: true,
                                disabled: busy,
                                onPress: () => {
                                    void runRosterChange(
                                        () => removeTeamGroupMember({
                                            scope: context.scope,
                                            address: context.address,
                                            groupId,
                                            accountId: member.accountId,
                                            // `contribution_removed` is not
                                            // `removed`; an approved removal
                                            // owes that distinction too.
                                            onApprovalSucceeded: (result) =>
                                                settleRosterChange(result, external),
                                            onApprovalFailed: (code) => setNotice({
                                                place: 'roster',
                                                message: teamMutationFailureLabel({ kind: 'unknown', code, retryable: false }),
                                            }),
                                        }),
                                        external,
                                    );
                                },
                            } : {
                                id: 'add-to-group',
                                title: t('teams.groups.addMember'),
                                icon: 'user-plus' as const,
                                disabled: busy,
                                onPress: () => { void addNative(member); },
                            }] : []),
                            ...member.contributions.external.map((contribution) => ({
                                id: `open-external-source:${contribution.bindingId}`,
                                title: `${t('common.open')}: ${contribution.label}`,
                                icon: 'arrow-square-out' as const,
                                onPress: () => router.push(contribution.owner.kind === 'directory_source'
                                    ? teamDirectorySourcePath(
                                        context.address,
                                        contribution.owner.directorySourceId,
                                    )
                                    : teamIdentityConnectionPath(
                                        context.address,
                                        contribution.owner.teamIdentityConnectionId,
                                    )),
                            })),
                        ];
                        return (
                            <Item
                                key={member.membershipId}
                                testID={`team-group-member:${member.accountId}`}
                                title={displayName}
                                subtitle={[external, person.hint].filter((part): part is string => Boolean(part)).join(' · ') || undefined}
                                leftElement={(
                                    <Avatar
                                        id={member.accountId}
                                        size={PAGE_LIST_METRICS.rowIdentityMarkPx}
                                        imageUrl={member.account.avatarUrl}
                                        monogram={person.named ? person.name : null}
                                    />
                                )}
                                // A person row opens the person, like every other roster. Changes to this
                                // Group's roster live in the row's menu, behind the Action's own confirmation.
                                // An external-only row is not read-only: a native contribution can be added so
                                // the person keeps Group access if that source stops supplying them.
                                rightElement={rowActions.length > 0 ? (
                                    <ItemRowActions
                                        title={displayName}
                                        overflowOnly
                                        actions={rowActions}
                                        overflowTriggerTestID={`team-group-member-actions:${member.accountId}`}
                                    />
                                ) : undefined}
                                rightElementOutsidePressable
                                onPress={() => router.push(teamGroupMemberDetailPath(
                                    context.address,
                                    member.membershipId,
                                    groupId,
                                    member.accountId,
                                ))}
                                showChevron={false}
                            />
                        );
                    })}
                    </CollectionRows>
                </ItemGroup>
            ));
        }

        // An archived Group has no effective members; its banner already says why, so its roster
        // is not called empty "yet".
        if (members.rows.length === 0 && members.status === 'ready' && !archived) {
            add('members-empty', () => (
                <ItemGroup
                    title={t('teams.groups.membersSection')}
                    action={addMemberAction}
                    description={rosterNotice ?? undefined}
                >
                    <Item
                        testID="team-group-members-empty"
                        title={t('teams.groups.emptyRosterTitle')}
                        subtitle={t('teams.groups.emptyBody')}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ));
        }

        // A failed roster read is said once, in the page's stale notice (see `pageReads`).
        if (!members.error && members.hasMore && members.rows.length > 0) {
            add('members-load-more', () => (
                <ItemGroup>
                    <Item
                        testID="team-group-members-load-more"
                        title={t('homeGovernance.loadMore')}
                        loading={members.status === 'loading_more'}
                        disabled={members.status === 'loading_more'}
                        onPress={() => void members.loadMore()}
                        showChevron={false}
                    />
                </ItemGroup>
            ));
        }

        if (picking) {
            for (let start = 0; start < eligibleCandidates.length; start += GROUP_DETAIL_CHUNK_SIZE) {
                const chunk = eligibleCandidates.slice(start, start + GROUP_DETAIL_CHUNK_SIZE);
                const first = start === 0;
                const last = start + GROUP_DETAIL_CHUNK_SIZE >= eligibleCandidates.length;
                add(`candidates:${chunk[0]!.id}`, () => (
                    <ItemGroup
                        title={first ? t('teams.members.personLabel') : undefined}
                        virtualizedSegment={{ first, last }}
                    >
                        {chunk.map((membership) => {
                            const person = resolveAccountDisplayName({ profile: membership.account, accountId: membership.accountId, viewerAccountId: context.scope.accountId });
                            return (
                                <Item
                                    key={membership.id}
                                    testID={`team-group-candidate:${membership.accountId}`}
                                    title={person.name}
                                    subtitle={person.hint ?? undefined}
                                    leftElement={(
                                        <Avatar
                                            id={membership.accountId}
                                            size={PAGE_LIST_METRICS.rowIdentityMarkPx}
                                            imageUrl={membership.account.avatarUrl}
                                            // Initials only for a named Account, like the roster above.
                                            monogram={person.named ? person.name : null}
                                        />
                                    )}
                                    disabled={!canEditRoster}
                                    loading={addingAccountId === membership.accountId}
                                    onPress={async () => {
                                        // The picker stays open on this person, marked in progress, until the
                                        // Home answers (or hands the add to an approval).
                                        setAddingAccountId(membership.accountId);
                                        try {
                                            await addNative({
                                                accountId: membership.accountId,
                                                membershipId: membership.id,
                                            });
                                        } finally {
                                            setAddingAccountId(null);
                                            setPicking(false);
                                        }
                                    }}
                                    showChevron={false}
                                />
                            );
                        })}
                    </ItemGroup>
                ));
            }

            if (!nativeRosterReady
                || (candidates.status === 'loading' && candidates.rows.length === 0)) {
                add('candidates-loading', () => (
                    <ItemGroup title={eligibleCandidates.length === 0 ? t('teams.members.personLabel') : undefined}>
                            <Item
                                testID="team-group-candidates-loading"
                                title={t('teams.members.personLabel')}
                                loading
                                showChevron={false}
                            />
                    </ItemGroup>
                ));
            }

            const candidatesError = candidates.error;
            if (candidatesError) {
                add('candidates-error', () => (
                    <ItemGroup title={eligibleCandidates.length === 0 ? t('teams.members.personLabel') : undefined}>
                        {candidatesError.retryable ? (
                                <Item
                                    testID="team-group-candidates-retry"
                                    title={t('teams.unavailable.retry')}
                                    subtitle={teamReadFailureLabel(candidatesError)}
                                    onPress={() => void candidates.reload()}
                                    showChevron={false}
                                />
                            ) : (
                                <Item
                                    testID="team-group-candidates-unavailable"
                                    title={teamReadFailureLabel(candidatesError)}
                                    showChevron={false}
                                />
                            )}
                    </ItemGroup>
                ));
            }

            if (nativeRosterReady && candidates.status === 'ready' && eligibleCandidates.length === 0) {
                add('candidates-empty', () => (
                    <ItemGroup title={t('teams.members.personLabel')}>
                                <Item
                                    testID="team-group-candidates-empty"
                                    mode="info"
                                    title={t('teams.groups.noEligibleCandidatesTitle')}
                                    subtitle={t('teams.groups.noEligibleCandidatesBody')}
                                    showChevron={false}
                                />
                    </ItemGroup>
                ));
            }

            // The Team roster is paged; a Group add must be able to reach a
            // member who is not on its first page.
            if (candidates.status !== 'loading' && candidates.hasMore) {
                add('candidates-load-more', () => (
                        <ItemGroup>
                            <Item
                                testID="team-group-candidates-load-more"
                                title={t('homeGovernance.loadMore')}
                                loading={candidates.status === 'loading_more'}
                                disabled={candidates.status === 'loading_more'}
                                onPress={() => void candidates.loadMore()}
                                showChevron={false}
                            />
                        </ItemGroup>
                ));
            }

            // The Group's own history intent for this add, after the person it applies to.
            add('history', () => (
                <ItemGroup>
                    <SegmentedChoiceItem<SessionHistoryAccessV1>
                        testID="team-group-history"
                        testIDPrefix="team-group-history"
                        title={t('teams.history.label')}
                        subtitleLines={0}
                        options={sessionHistoryChoiceOptions('group')}
                        value={groupHistoryAccess}
                        onChange={setGroupHistoryAccess}
                    />
                </ItemGroup>
            ));
        }

        if (group.capabilities.updateMetadata) {
            add('metadata', () => (
                <GroupMetadataSection
                    context={context}
                    group={group}
                    name={groupName}
                    description={groupDescription}
                    current={groupCurrent}
                />
            ));
        }

        // What this Group's members' new sessions start with; an archived Group sets none.
        if (!archived) {
            const scope = { kind: 'group' as const, groupId };
            add('member-defaults', () => (
                <TeamMemberDefaultsSection
                    testID="team-group-member-defaults"
                    context={context}
                    scope={scope}
                    access={memberDefaultsAccess(scope, context.team.capabilities, group.capabilities)}
                    writable={context.canMutate && groupCurrent}
                />
            ));
        }

        if (group.capabilities.archive && !archived) {
            const archiveFailure = notice?.place === 'archive' ? notice.message : null;
            add('archive', () => (
                // Archive closes the page the way a Team's does: the destructive button at the far edge
                // with its consequence beneath it (one placement for both).
                <ItemGroup surface="none">
                    <SectionButtonRow
                        // A refused Archive is said beneath the button that was pressed.
                        footnote={archiveFailure ?? t('teams.groups.archiveBody')}
                        footnoteTone={archiveFailure ? 'danger' : undefined}
                        footnoteTestID={archiveFailure ? 'team-group-archive-error' : undefined}
                        trailing={(
                            <RoundButton
                                testID="team-group-archive"
                                size="small"
                                display="destructive"
                                title={t('teams.groups.archiveAction')}
                                titleNumberOfLines="complete"
                                disabled={busy || !context.canMutate || !groupCurrent}
                                onPress={async () => {
                                    if (mutationInFlightRef.current) return;
                                    mutationInFlightRef.current = true;
                                    setBusy(true);
                                    setNotice(null);
                                    try {
                                        const outcome = await archiveTeamGroup({
                                            scope: context.scope,
                                            address: context.address,
                                            groupId,
                                        });
                                        if (outcome.kind === 'succeeded') router.back();
                                        else {
                                            setNotice({ place: 'archive', message: teamMutationFailureLabel(outcome.failure) });
                                            if (outcome.failure.kind === 'outcome_unknown') void detail.reload();
                                        }
                                    } catch (cause) {
                                        if (isTeamActionApprovalPendingError(cause)) context.requestApproval(cause.artifactId);
                                        else setNotice({ place: 'archive', message: t('teams.errors.generic') });
                                    } finally {
                                        mutationInFlightRef.current = false;
                                        setBusy(false);
                                    }
                                }}
                            />
                        )}
                    >
                        {null}
                    </SectionButtonRow>
                </ItemGroup>
            ));
        }

        return result;
    }, [
        addNative,
        addingAccountId,
        archived,
        busy,
        canEditRoster,
        candidates,
        context,
        detail,
        eligibleCandidates,
        group,
        groupCurrent,
        groupHistoryAccess,
        groupId,
        groupName,
        groupDescription,
        managedBy,
        members,
        notice,
        picking,
        rosterEditable,
        router,
        runRosterChange,
        settleRosterChange,
        theme.colors.state.warning.foreground,
        theme.colors.text.secondary,
    ]);

    const renderRow = React.useCallback(
        ({ item }: Readonly<{ item: GroupDetailVirtualizedRow }>) => item.render(),
        [],
    );

    if (group === null) {
        const failure = detail.error;
        const message = failure ? teamReadFailureLabel(failure) : t('teams.errors.notFound');
        return (
            <ItemList>
                <PageHeader testID="team-group-header" title={t('teams.tabs.groups')} alwaysShowTitle meta={[
                    { key: 'team', text: context.team.name },
                    { key: 'home', icon: 'house', text: context.homeName },
                ]} />
                {props.renderHeader()}
                {detail.status === 'loading' ? (
                    <ItemGroup>
                        <Item testID="team-group-loading" title={t('teams.loading')} loading mode="info" showChevron={false} />
                    </ItemGroup>
                ) : (
                    <SurfaceStateCard
                        testID="team-group-unavailable"
                        kind="unavailable"
                        title={message}
                        action={failure?.retryable
                            ? { label: t('teams.unavailable.retry'), onPress: () => void detail.reload() }
                            : undefined}
                        accessibilitySemantics="alert"
                    />
                )}
            </ItemList>
        );
    }

    // The Group's own read and its roster's are this page's reads beside the Team's: when they
    // are not current, the page's one stale notice says so and retries them.
    const pageReads: TeamPageStaleRead[] = [];
    if (groupStale) pageReads.push({ failure: detail.error, retry: () => void detail.reload() });
    if (members.error) pageReads.push({ failure: members.error, retry: () => void members.reload() });
    // The count says what the roster shows once the roster is whole; until then, the Home's count.
    const rosterWhole = !members.hasMore && (members.rows.length > 0 || members.status === 'ready');
    const memberCount = rosterWhole ? members.rows.length : group.memberCount;

    const pageHeader = (
        <>
            <PageHeader
                testID="team-group-header"
                alwaysShowTitle
                title={groupName ?? t('common.unavailable')}
                description={group.description === null ? undefined : groupDescription ?? t('common.unavailable')}
                leading={(
                    <PageHeaderMarkIcon name="users" />
                )}
                meta={[
                    { key: 'team', text: context.team.name },
                    { key: 'home', icon: 'house', text: context.homeName },
                    {
                        key: 'members',
                        testID: 'team-group-member-count',
                        // An archived Group's effective membership is zero by contract; its kept members return
                        // on restore, so the fact says that rather than "0 members".
                        text: archived
                            ? t('teams.groups.archivedMemberCount')
                            : t('teams.groups.memberCount', { count: memberCount }),
                    },
                    ...(managedBy ? [{ key: 'managed', text: managedBy }] : []),
                ]}
            />
            {props.renderHeader(pageReads)}
        </>
    );

    return (
        <VirtualizedItemList
            testID="team-group-detail-virtualized-list"
            data={rows}
            keyExtractor={(item) => item.key}
            renderItem={renderRow}
            ListHeaderComponent={pageHeader}
            initialNumToRender={6}
            maxToRenderPerBatch={4}
            windowSize={7}
            estimatedItemSize={120}
            maintainVisibleContentPosition
        />
    );
});

export const TeamGroupDetailScreen = React.memo(function TeamGroupDetailScreen(props: Readonly<{
    serverId: string;
    teamId: string;
    groupId: string;
}>) {
    return (
        <TeamSection
            serverId={props.serverId}
            teamId={props.teamId}
            title={t('teams.tabs.groups')}
            presentation="virtualized-list"
            childRendersHeader
        >
            {(context, _header, renderHeader) => <GroupDetail context={context} groupId={props.groupId} renderHeader={renderHeader} />}
        </TeamSection>
    );
});
