import * as React from 'react';
import { View } from 'react-native';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import {
    DEFAULT_REORDER_ROW_HEIGHT,
    useListInlineReorder,
} from '@/components/ui/lists/useListInlineReorder';
import {
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { UseQualifiedConnectedAccountGroupsResult } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import {
    MEMBER_PRIORITY_STEP,
    type QualifiedConnectedAccountUiGroup,
    type QualifiedConnectedAccountUiGroupMember,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';
import type {
    ConnectedServiceAuthGroupPolicyV1,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { QualifiedAccountBlock } from '../account/QualifiedAccountBlock';
import {
    PoolMembersSelectField,
    type PoolMembershipCandidate,
} from '../account/PoolMembersSelectField';
import { computePoolMembershipDiff } from '../account/poolMembershipDiff';
import {
    presentQualifiedConnectedAccountTarget,
    type QualifiedConnectedAccountPresentationAccount,
    type QualifiedConnectedAccountTargetPresentation,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountTargetPresentation';
import { PoolMembersDropOverlay } from './PoolMembersDropOverlay';

type GroupStrategy = ConnectedServiceAuthGroupPolicyV1['strategy'];
type GroupRecoveryMode = ConnectedServiceAuthGroupPolicyV1['recoveryMode'];
type SwitchOnKey = keyof ConnectedServiceAuthGroupPolicyV1['switchOn'];

const SWITCH_ON_KEYS: ReadonlyArray<SwitchOnKey> = ['usageLimit', 'authExpired', 'accountChanged', 'refreshFailure'];

const TEST_ID = 'connected-services-pool-detail';
const EMPTY_CONNECTED_ACCOUNT_LABELS: Readonly<Record<string, string | undefined>> = Object.freeze({});

/**
 * Relative container that anchors the absolutely-positioned member drop overlay,
 * mirroring the session list's relative rows container so the overlay's measured
 * geometry resolves to the right insertion boundary. `overflow: 'visible'` keeps
 * the lifted/scaled dragged row from being clipped while it floats.
 */
const MEMBERS_REORDER_CONTAINER_STYLE = { position: 'relative', overflow: 'visible' } as const;

/** An account of this service, eligible for pool membership. */
export type QualifiedPoolDetailAccount = QualifiedConnectedAccountPresentationAccount & Readonly<{
    /** RAW credential status — the account block owns the fail-open usage gate. */
    status?: unknown;
}>;

/**
 * The mutation surface this view drives, modeled on (and satisfied by)
 * `useQualifiedConnectedAccountGroups`. Every mutation returns the UPDATED group
 * or `null`; sequential mutations thread the returned group into the next call
 * because dev's source client owns generation/CAS internally.
 */
export type QualifiedPoolDetailMutations = Pick<
    UseQualifiedConnectedAccountGroupsResult,
    'mutating' | 'patch' | 'patchMember' | 'addMember' | 'removeMember' | 'setActiveAccount' | 'delete'
>;

export type QualifiedPoolDetailViewProps = Readonly<{
    group: QualifiedConnectedAccountUiGroup;
    /** Every account of this service (members and non-members alike). */
    accounts: ReadonlyArray<QualifiedPoolDetailAccount>;
    /** Per-account display label overrides (user labels). */
    accountLabels?: Readonly<Record<string, string | undefined>>;
    /** Applied service descriptor title, shown alongside the pool name in the header. */
    serviceLabel: string;
    mutations: QualifiedPoolDetailMutations;
    /** `false` when the server or runtime cannot honor automatic fallback. */
    fallbackControlsEnabled?: boolean;
    /** Explains why the fallback controls are unavailable. */
    fallbackDisabledSubtitle?: string;
    /**
     * Latest failure reported by the mutation owner. Every mutation here signals
     * failure by returning `null` and setting this, after which the view
     * reconciles to server state — so without surfacing it a rejected change is
     * indistinguishable from one the user never made.
     */
    error?: string | null;
}>;

function parsePromptNumber(raw: string): number | null {
    const value = Number(raw.trim().replace(/%$/, ''));
    return Number.isFinite(value) ? value : null;
}

function formatProbeMinutes(ms: number): string {
    return String(Math.max(1, Math.round(ms / 60_000)));
}

function resolveStrategyTitle(strategy: GroupStrategy): string {
    if (strategy === 'least_limited') return t('connectedServices.detail.groupDetail.strategyLeastLimitedTitle');
    if (strategy === 'manual') return t('connectedServices.detail.groupDetail.strategyManualTitle');
    return t('connectedServices.detail.groupDetail.strategyPriorityTitle');
}

function resolveRecoveryModeSubtitle(mode: GroupRecoveryMode): string {
    if (mode === 'off') return t('connectedServices.detail.groupDetail.recoveryModeOffSubtitle');
    if (mode === 'wait_until_reset') return t('connectedServices.detail.groupDetail.recoveryModeWaitUntilResetSubtitle');
    if (mode === 'switch_then_resume') return t('connectedServices.detail.groupDetail.recoveryModeSwitchThenResumeSubtitle');
    return t('connectedServices.detail.groupDetail.recoveryModeSwitchOrWaitSubtitle');
}

function resolveSwitchOnLabel(key: SwitchOnKey): string {
    if (key === 'usageLimit') return t('connectedServices.pools.behavior.switchOn.usageLimit');
    if (key === 'authExpired') return t('connectedServices.pools.behavior.switchOn.authExpired');
    if (key === 'accountChanged') return t('connectedServices.pools.behavior.switchOn.accountChanged');
    return t('connectedServices.pools.behavior.switchOn.refreshFailure');
}

function isGroupStrategy(value: string): value is GroupStrategy {
    return value === 'priority' || value === 'least_limited' || value === 'manual';
}

function isGroupRecoveryMode(value: string): value is GroupRecoveryMode {
    return value === 'off' || value === 'wait_until_reset' || value === 'switch_then_resume' || value === 'switch_or_wait';
}

function StrategyCheckmark() {
    const { theme } = useUnistyles();
    return <Icon name="check" size={16} color={theme.colors.accent.blue} />;
}

function buildStrategyItems(currentStrategy: GroupStrategy): DropdownMenuItem[] {
    return [
        {
            id: 'priority',
            title: t('connectedServices.detail.groupDetail.strategyPriorityTitle'),
            subtitle: t('connectedServices.detail.groupDetail.strategyPrioritySubtitle'),
            rightElement: currentStrategy === 'priority' ? <StrategyCheckmark /> : null,
        },
        {
            id: 'least_limited',
            title: t('connectedServices.detail.groupDetail.strategyLeastLimitedTitle'),
            subtitle: t('connectedServices.detail.groupDetail.strategyLeastLimitedSubtitle'),
            rightElement: currentStrategy === 'least_limited' ? <StrategyCheckmark /> : null,
        },
        {
            id: 'manual',
            title: t('connectedServices.detail.groupDetail.strategyManualTitle'),
            subtitle: t('connectedServices.detail.groupDetail.strategyManualSubtitle'),
            rightElement: currentStrategy === 'manual' ? <StrategyCheckmark /> : null,
        },
    ];
}

function buildRecoveryModeItems(currentMode: GroupRecoveryMode): DropdownMenuItem[] {
    const modes: ReadonlyArray<GroupRecoveryMode> = ['off', 'wait_until_reset', 'switch_then_resume', 'switch_or_wait'];
    return modes.map((mode) => ({
        id: mode,
        title: resolveRecoveryModeSubtitle(mode),
        rightElement: currentMode === mode ? <StrategyCheckmark /> : null,
    }));
}

/** Fallback order: priority ascending, account id as a stable tiebreak. */
function sortMembersByPriority(
    members: ReadonlyArray<QualifiedConnectedAccountUiGroupMember>,
): ReadonlyArray<QualifiedConnectedAccountUiGroupMember> {
    return [...members].sort((left, right) => (
        left.priority !== right.priority
            ? left.priority - right.priority
            : left.ref.accountId.localeCompare(right.ref.accountId)
    ));
}

/**
 * Rich pool ("auth group") detail: members render as the shared account block
 * (poolMember variant) in fallback order with drag-reorder, accessible Move
 * up/down, per-member enable and active selection; Behavior and Advanced expose
 * every policy control.
 *
 * Presentational-with-local-state: the group, its accounts and the mutation
 * surface arrive as props, so this view never reads a route or owns the
 * qualified-groups hook. Local state is only what a control genuinely owns
 * (open menus, the disclosure, and the optimistic reorder).
 */
export const QualifiedPoolDetailView = React.memo(function QualifiedPoolDetailView(
    props: QualifiedPoolDetailViewProps,
) {
    const { theme } = useUnistyles();
    const { accounts, group, mutations } = props;
    const fallbackControlsEnabled = props.fallbackControlsEnabled ?? true;
    const fallbackDisabledSubtitle = fallbackControlsEnabled ? undefined : props.fallbackDisabledSubtitle;
    const [strategyOpen, setStrategyOpen] = React.useState(false);
    const [recoveryModeOpen, setRecoveryModeOpen] = React.useState(false);
    const [advancedExpanded, setAdvancedExpanded] = React.useState(false);
    /**
     * Account ids in the order a drop just produced, held only while the
     * sequential priority patches run. See `commitOrder`.
     */
    const [optimisticOrder, setOptimisticOrder] = React.useState<ReadonlyArray<string> | null>(null);

    // Numeric overlay shared values for the single list-level drop indicator.
    const overlayVisible = useSharedValue(0);
    const overlayKind = useSharedValue<TreeDropOverlayKind>(TREE_DROP_OVERLAY_KIND_NONE);
    const overlayTop = useSharedValue(0);
    const overlayHeight = useSharedValue(0);
    const overlayLeft = useSharedValue(0);
    const overlayRight = useSharedValue(0);
    const overlayDepth = useSharedValue(0);
    const overlayShared = React.useMemo<TreeDropOverlaySharedValues>(() => ({
        overlayVisible,
        overlayKind,
        overlayTop,
        overlayHeight,
        overlayLeft,
        overlayRight,
        overlayDepth,
    }), [overlayDepth, overlayHeight, overlayKind, overlayLeft, overlayRight, overlayTop, overlayVisible]);

    const accountLabels = props.accountLabels;
    const groupPresentation = React.useMemo(() => presentQualifiedConnectedAccountTarget({
        target: {
            kind: 'group',
            service: group.ref.service,
            groupId: group.ref.groupId,
        },
        accounts,
        groups: [group],
        labelsByKey: EMPTY_CONNECTED_ACCOUNT_LABELS,
        serviceTitle: props.serviceLabel,
    }), [accounts, group, props.serviceLabel]);
    /**
     * One identity per account from the canonical qualified-target presenter:
     * no pool-local label precedence or id fallback remains here.
    */
    const resolveAccountIdentity = React.useCallback((accountId: string): QualifiedConnectedAccountTargetPresentation => {
        return presentQualifiedConnectedAccountTarget({
            target: {
                kind: 'account',
                account: { service: group.ref.service, accountId },
            },
            accounts,
            groups: [group],
            labelsByKey: EMPTY_CONNECTED_ACCOUNT_LABELS,
            accountLabel: accountLabels?.[accountId],
            serviceTitle: props.serviceLabel,
        });
    }, [accountLabels, accounts, group, props.serviceLabel]);
    const resolveAccountTitle = React.useCallback(
        (accountId: string): string => resolveAccountIdentity(accountId).primaryLabel,
        [resolveAccountIdentity],
    );

    const sortedMembers = React.useMemo(() => {
        const byPriority = sortMembersByPriority(group.members);
        if (!optimisticOrder) return byPriority;
        const byAccountId = new Map(byPriority.map((member) => [member.ref.accountId, member]));
        const ordered = optimisticOrder
            .map((accountId) => byAccountId.get(accountId))
            .filter((member): member is QualifiedConnectedAccountUiGroupMember => member != null);
        // Any member the pending order does not mention (a concurrent add) keeps
        // its authoritative slot at the end rather than disappearing.
        const seen = new Set(ordered.map((member) => member.ref.accountId));
        return [...ordered, ...byPriority.filter((member) => !seen.has(member.ref.accountId))];
    }, [group.members, optimisticOrder]);

    const memberItems = React.useMemo(
        () => sortedMembers.map((member) => ({ id: member.ref.accountId })),
        [sortedMembers],
    );
    /** Authoritative membership, in fallback order — the multi-select's baseline. */
    const memberAccountIds = React.useMemo(
        () => sortedMembers.map((member) => member.ref.accountId),
        [sortedMembers],
    );

    /**
     * Persist a new fallback order.
     *
     * The only available mutation patches ONE member's priority at a time, so an
     * order is a SEQUENCE of patches. Re-rendering each intermediate server state
     * would re-sort the list through transient priority ties on every patch (a
     * visible reshuffle), and because the drag ends before the first patch lands
     * the row would briefly snap back to its old slot. So the dropped order is
     * applied locally ONCE, up front and atomically, the patches run in the
     * background threading the group each one returns, and the optimistic order
     * is dropped at the end — reconciling to (or reverting to) server truth.
     */
    const commitOrder = React.useCallback(async (orderedAccountIds: ReadonlyArray<string>) => {
        const byAccountId = new Map(group.members.map((member) => [member.ref.accountId, member]));
        const ordered = orderedAccountIds.filter((accountId) => byAccountId.has(accountId));
        if (ordered.length !== group.members.length) return;
        setOptimisticOrder(ordered);
        try {
            let current = group;
            for (const [index, accountId] of ordered.entries()) {
                const priority = (index + 1) * MEMBER_PRIORITY_STEP;
                const member = current.members.find((candidate) => candidate.ref.accountId === accountId);
                if (!member || member.priority === priority) continue;
                const next = await mutations.patchMember({ group: current, account: member.ref, priority });
                // A null result means the mutation failed and already surfaced
                // its error; stop rather than patching against a stale group.
                if (!next) return;
                current = next;
            }
        } finally {
            setOptimisticOrder(null);
        }
    }, [group, mutations]);

    const reorder = useListInlineReorder({
        items: memberItems,
        enabled: sortedMembers.length > 1,
        overlayShared,
        onCommitOrder: commitOrder,
        fallbackRowHeight: DEFAULT_REORDER_ROW_HEIGHT,
    });

    /** Move a member up/down in fallback order (accessible drag fallback). */
    const moveMember = React.useCallback((accountId: string, direction: -1 | 1) => {
        const order = sortedMembers.map((member) => member.ref.accountId);
        const index = order.indexOf(accountId);
        if (index < 0) return;
        const target = index + direction;
        if (target < 0 || target >= order.length) return;
        const next = [...order];
        next.splice(index, 1);
        next.splice(target, 0, accountId);
        void commitOrder(next);
    }, [commitOrder, sortedMembers]);

    const patchPolicy = React.useCallback(async (
        policy: Partial<ConnectedServiceAuthGroupPolicyV1>,
    ) => {
        if (!fallbackControlsEnabled) return;
        await mutations.patch({ group, policy });
    }, [fallbackControlsEnabled, group, mutations]);

    const editName = React.useCallback(async () => {
        const next = await Modal.prompt(
            t('connectedServices.detail.groupDetail.nameTitle'),
            t('connectedServices.detail.groupDetail.namePromptBody'),
            {
                placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
                defaultValue: group.displayName?.trim() ?? '',
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next !== 'string') return;
        await mutations.patch({ group, displayName: next.trim() || null });
    }, [group, mutations]);

    const editSoftSwitchRemainingPercent = React.useCallback(async () => {
        if (!fallbackControlsEnabled) return;
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptTitle'),
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptBody'),
            {
                defaultValue: String(group.policy.softSwitchRemainingPercent),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof raw !== 'string') return;
        const value = parsePromptNumber(raw);
        if (value === null || value < 0 || value > 100) {
            await Modal.alert(
                t('connectedServices.detail.groupDetail.invalidSoftSwitchThresholdTitle'),
                t('connectedServices.detail.groupDetail.invalidSoftSwitchThresholdBody'),
            );
            return;
        }
        await patchPolicy({ softSwitchRemainingPercent: value });
    }, [fallbackControlsEnabled, group.policy.softSwitchRemainingPercent, patchPolicy]);

    const editProbeIfSnapshotOlderThan = React.useCallback(async () => {
        if (!fallbackControlsEnabled) return;
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.staleProbePromptTitle'),
            t('connectedServices.detail.groupDetail.staleProbePromptBody'),
            {
                defaultValue: formatProbeMinutes(group.policy.probeIfSnapshotOlderThanMs),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof raw !== 'string') return;
        const minutes = parsePromptNumber(raw);
        if (minutes === null || minutes < 1) {
            await Modal.alert(
                t('connectedServices.detail.groupDetail.invalidStaleProbeTitle'),
                t('connectedServices.detail.groupDetail.invalidStaleProbeBody'),
            );
            return;
        }
        await patchPolicy({ probeIfSnapshotOlderThanMs: Math.round(minutes * 60_000) });
    }, [fallbackControlsEnabled, group.policy.probeIfSnapshotOlderThanMs, patchPolicy]);

    const setMemberEnabled = React.useCallback((
        account: QualifiedConnectedAccountRef,
        enabled: boolean,
    ) => {
        void mutations.patchMember({ group, account, enabled });
    }, [group, mutations]);

    const setActiveMember = React.useCallback((account: QualifiedConnectedAccountRef) => {
        // The caller owns runtime-cooldown override prompting: `setActiveAccount`
        // rethrows that error so ONE owner decides whether to retry with an
        // override, rather than two competing prompts.
        void mutations.setActiveAccount({ group, account });
    }, [group, mutations]);

    const removeMember = React.useCallback(async (account: QualifiedConnectedAccountRef) => {
        const ok = await Modal.confirm(
            t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
            t('connectedServices.detail.groupActions.removeMemberConfirmBody', {
                profileId: resolveAccountTitle(account.accountId),
            }),
            {
                confirmText: t('connectedServices.detail.groupActions.removeMember'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!ok) return;
        await mutations.removeMember({ group, account });
    }, [group, mutations, resolveAccountTitle]);

    const membershipCandidates = React.useMemo<ReadonlyArray<PoolMembershipCandidate>>(
        () => accounts.map((account) => {
            const identity = resolveAccountIdentity(account.ref.accountId);
            return {
                accountId: account.ref.accountId,
                title: identity.primaryLabel,
                ...(identity.secondaryLabel ? { subtitle: identity.secondaryLabel } : {}),
            };
        }),
        [accounts, resolveAccountIdentity],
    );

    /**
     * Apply a membership diff from the multi-select: removals first, then adds,
     * threading the group each mutation returns so the next call runs against
     * current server state. The select field already confirmed the removals.
     */
    const commitMembership = React.useCallback(async (
        nextSelectedAccountIds: ReadonlyArray<string>,
    ) => {
        const { toAdd, toRemove } = computePoolMembershipDiff(memberAccountIds, nextSelectedAccountIds);
        let current = group;
        for (const accountId of toRemove) {
            const member = current.members.find((candidate) => candidate.ref.accountId === accountId);
            if (!member) continue;
            const next = await mutations.removeMember({ group: current, account: member.ref });
            if (!next) return;
            current = next;
        }
        for (const accountId of toAdd) {
            const account = accounts.find((candidate) => candidate.ref.accountId === accountId);
            if (!account) continue;
            const next = await mutations.addMember({ group: current, account: account.ref });
            if (!next) return;
            current = next;
        }
    }, [accounts, group, memberAccountIds, mutations]);

    const deletePool = React.useCallback(async () => {
        const ok = await Modal.confirm(
            t('connectedServices.pools.delete.confirmTitle'),
            t('connectedServices.pools.delete.confirmMessage', {
                name: groupPresentation.accessibilityLabel,
            }),
            {
                confirmText: t('connectedServices.pools.delete.title'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!ok) return;
        await mutations.delete(group);
    }, [group, groupPresentation.accessibilityLabel, mutations]);

    const label = groupPresentation.primaryLabel;
    const headerTitle = props.serviceLabel && props.serviceLabel !== label
        ? `${props.serviceLabel} • ${label}`
        : label;
    const enabledCount = group.members.filter((member) => member.enabled).length;
    const autoSwitchSubtitle = fallbackDisabledSubtitle
        ?? (group.policy.autoSwitch
            ? t('connectedServices.detail.groupDetail.autoSwitchEnabledSubtitle')
            : t('connectedServices.detail.groupDetail.autoSwitchDisabledSubtitle'));

    const orderedMembers = reorder.frozenItems
        .map((item) => sortedMembers.find((member) => member.ref.accountId === item.id))
        .filter((member): member is QualifiedConnectedAccountUiGroupMember => member != null);
    const memberCount = orderedMembers.length;

    return (
        <ItemList testID={TEST_ID}>
            <ItemGroup title={headerTitle}>
                <Item
                    testID={`${TEST_ID}:name`}
                    title={t('connectedServices.detail.groupDetail.nameTitle')}
                    subtitle={label}
                    icon={<Icon name="pencil" size={20} color={theme.colors.accent.blue} />}
                    onPress={() => void editName()}
                />
                <Item
                    testID={`${TEST_ID}:summary`}
                    title={t('connectedServices.pools.detail.summaryTitle')}
                    subtitle={t('connectedServices.pools.detail.summary', {
                        count: group.members.length,
                        strategy: resolveStrategyTitle(group.policy.strategy),
                    })}
                    showChevron={false}
                />
                {group.activeAccountId ? (
                    <Item
                        testID={`${TEST_ID}:server-active-status`}
                        title={t('connectedServices.pools.detail.serverActiveStatusTitle')}
                        subtitle={t('connectedServices.pools.detail.serverActiveStatusSubtitle')}
                        icon={<Icon name="cloud-check" size={20} color={theme.colors.accent.blue} />}
                        showChevron={false}
                    />
                ) : null}
            </ItemGroup>

            <ItemGroup
                title={t('connectedServices.pools.detail.membersTitle')}
                footer={t('connectedServices.detail.groupDetail.membersSubtitle', {
                    enabled: enabledCount,
                    total: group.members.length,
                })}
            >
                {memberCount > 0 ? (
                    <View style={MEMBERS_REORDER_CONTAINER_STYLE}>
                        {orderedMembers.map((member, index) => {
                            const accountId = member.ref.accountId;
                            const account = accounts.find(
                                (candidate) => candidate.ref.accountId === accountId,
                            );
                            const identity = resolveAccountIdentity(accountId);
                            const isActive = accountId === group.activeAccountId;
                            const canSetActive = !isActive && fallbackControlsEnabled;
                            const actionId = (suffix: string) =>
                                `connected-services-pool:${group.ref.groupId}:member:${accountId}:action:${suffix}`;
                            const actions: ItemAction[] = [
                                {
                                    id: actionId('move-up'),
                                    title: t('connectedServices.pools.detail.moveUp'),
                                    icon: 'arrow-up',
                                    disabled: index === 0,
                                    onPress: index === 0 ? undefined : () => moveMember(accountId, -1),
                                },
                                {
                                    id: actionId('move-down'),
                                    title: t('connectedServices.pools.detail.moveDown'),
                                    icon: 'arrow-down',
                                    disabled: index === memberCount - 1,
                                    onPress: index === memberCount - 1 ? undefined : () => moveMember(accountId, 1),
                                },
                                {
                                    id: actionId('set-active'),
                                    title: isActive
                                        ? t('connectedServices.detail.groupActions.activeMember')
                                        : t('connectedServices.detail.groupActions.makeActive'),
                                    subtitle: !isActive && !fallbackControlsEnabled
                                        ? fallbackDisabledSubtitle
                                            ?? t('connectedServices.detail.groupActions.accountFallbackDisabled')
                                        : undefined,
                                    icon: isActive ? 'radio-button' : 'circle',
                                    disabled: !canSetActive,
                                    onPress: canSetActive ? () => setActiveMember(member.ref) : undefined,
                                },
                                {
                                    id: actionId('remove'),
                                    title: t('connectedServices.detail.groupActions.removeMember'),
                                    icon: 'minus-circle',
                                    destructive: true,
                                    onPress: () => void removeMember(member.ref),
                                },
                            ];
                            return (
                                <PoolMemberReorderRow
                                    key={accountId}
                                    accountId={accountId}
                                    reorder={reorder}
                                >
                                    <QualifiedAccountBlock
                                        testID={`${TEST_ID}:member:${accountId}`}
                                        account={member.ref}
                                        title={identity.primaryLabel}
                                        identityLabel={identity.secondaryLabel}
                                        status={account?.status}
                                        variant="poolMember"
                                        groupId={group.ref.groupId}
                                        enabled={member.enabled}
                                        onToggleEnabled={(next) => setMemberEnabled(member.ref, next)}
                                        isActive={isActive}
                                        onSetActive={canSetActive ? () => setActiveMember(member.ref) : undefined}
                                        actions={actions}
                                        reorderGesture={reorder.gestureForRow(accountId, index)}
                                        showDivider={index < memberCount - 1}
                                    />
                                </PoolMemberReorderRow>
                            );
                        })}
                        <PoolMembersDropOverlay
                            shared={overlayShared}
                            testID={`${TEST_ID}:drop-overlay`}
                        />
                    </View>
                ) : (
                    <Item
                        testID={`${TEST_ID}:no-members`}
                        title={t('connectedServices.pools.detail.noMembersTitle')}
                        subtitle={t('connectedServices.pools.detail.noMembersSubtitle')}
                        showChevron={false}
                    />
                )}
                <PoolMembersSelectField
                    testID={`${TEST_ID}:members-select`}
                    candidates={membershipCandidates}
                    selectedAccountIds={memberAccountIds}
                    onCommit={(next) => { void commitMembership(next); }}
                    disabled={mutations.mutating}
                />
            </ItemGroup>

            <ItemGroup title={t('connectedServices.pools.detail.behaviorTitle')}>
                <Item
                    testID={`${TEST_ID}:auto-switch`}
                    title={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                    subtitle={autoSwitchSubtitle}
                    icon={<Icon name="arrows-left-right" size={20} color={theme.colors.accent.blue} />}
                    disabled={!fallbackControlsEnabled}
                    rightElement={(
                        <Switch
                            testID={`${TEST_ID}:auto-switch:toggle`}
                            value={group.policy.autoSwitch}
                            onValueChange={fallbackControlsEnabled
                                ? (autoSwitch) => void patchPolicy({ autoSwitch })
                                : undefined}
                            disabled={!fallbackControlsEnabled}
                            accessibilityLabel={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                            compact
                        />
                    )}
                    showChevron={false}
                />
                <DropdownMenu
                    open={strategyOpen}
                    onOpenChange={setStrategyOpen}
                    items={buildStrategyItems(group.policy.strategy)}
                    selectedId={group.policy.strategy}
                    onSelect={(strategy) => {
                        if (!isGroupStrategy(strategy)) return;
                        void patchPolicy({ strategy });
                    }}
                    itemTrigger={{
                        title: t('connectedServices.detail.groupDetail.strategyTitle'),
                        subtitle: resolveStrategyTitle(group.policy.strategy),
                        icon: <Icon name="sliders-horizontal" size={20} color={theme.colors.accent.blue} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        itemProps: {
                            testID: `${TEST_ID}:strategy`,
                            disabled: !fallbackControlsEnabled,
                        },
                    }}
                    rowKind="item"
                    variant="selectable"
                />
                <Item
                    testID={`${TEST_ID}:soft-switch-threshold`}
                    title={t('connectedServices.detail.groupDetail.softSwitchThresholdTitle')}
                    subtitle={fallbackDisabledSubtitle
                        ?? t('connectedServices.detail.groupDetail.softSwitchThresholdSubtitle', {
                            percent: String(group.policy.softSwitchRemainingPercent),
                        })}
                    icon={<Icon name="speedometer" size={20} color={theme.colors.accent.indigo} />}
                    disabled={!fallbackControlsEnabled}
                    onPress={fallbackControlsEnabled ? () => void editSoftSwitchRemainingPercent() : undefined}
                />
            </ItemGroup>

            <ItemGroup>
                <ExpandableItem
                    testID={`${TEST_ID}:advanced`}
                    expanded={advancedExpanded}
                    onExpandedChange={setAdvancedExpanded}
                    header={(state) => (
                        <Item
                            testID={`${TEST_ID}:advanced:header`}
                            {...state.headerProps}
                            title={t('connectedServices.pools.detail.advancedTitle')}
                            subtitle={t('connectedServices.pools.detail.advancedSubtitle')}
                            icon={<Icon name="wrench" size={20} color={theme.colors.text.secondary} />}
                            rightElement={(
                                <Icon
                                    name={state.expanded ? 'caret-down' : 'caret-right'}
                                    size={16}
                                    color={theme.colors.text.secondary}
                                />
                            )}
                            showChevron={false}
                        />
                    )}
                >
                    <ItemGroup>
                        <Item
                            testID={`${TEST_ID}:auto-restore-primary`}
                            title={t('connectedServices.pools.behavior.autoRestorePrimaryTitle')}
                            subtitle={t('connectedServices.pools.behavior.autoRestorePrimarySubtitle')}
                            icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.indigo} />}
                            disabled={!fallbackControlsEnabled}
                            rightElement={(
                                <Switch
                                    testID={`${TEST_ID}:auto-restore-primary:toggle`}
                                    value={group.policy.autoRestorePrimaryWhenReset}
                                    onValueChange={fallbackControlsEnabled
                                        ? (autoRestorePrimaryWhenReset) =>
                                            void patchPolicy({ autoRestorePrimaryWhenReset })
                                        : undefined}
                                    disabled={!fallbackControlsEnabled}
                                    accessibilityLabel={t('connectedServices.pools.behavior.autoRestorePrimaryTitle')}
                                    compact
                                />
                            )}
                            showChevron={false}
                        />
                        {SWITCH_ON_KEYS.map((key) => (
                            <Item
                                key={key}
                                testID={`${TEST_ID}:switch-on:${key}`}
                                title={resolveSwitchOnLabel(key)}
                                subtitle={t('connectedServices.pools.behavior.switchOnGroupSubtitle')}
                                icon={<Icon name="git-branch" size={20} color={theme.colors.text.secondary} />}
                                disabled={!fallbackControlsEnabled}
                                rightElement={(
                                    <Switch
                                        testID={`${TEST_ID}:switch-on:${key}:toggle`}
                                        value={group.policy.switchOn[key]}
                                        onValueChange={fallbackControlsEnabled
                                            ? (next) => void patchPolicy({
                                                switchOn: { ...group.policy.switchOn, [key]: next },
                                            })
                                            : undefined}
                                        disabled={!fallbackControlsEnabled}
                                        accessibilityLabel={resolveSwitchOnLabel(key)}
                                        compact
                                    />
                                )}
                                showChevron={false}
                            />
                        ))}
                        <Item
                            testID={`${TEST_ID}:stale-probe-after`}
                            title={t('connectedServices.detail.groupDetail.staleProbeTitle')}
                            subtitle={fallbackDisabledSubtitle
                                ?? t('connectedServices.detail.groupDetail.staleProbeSubtitle', {
                                    minutes: formatProbeMinutes(group.policy.probeIfSnapshotOlderThanMs),
                                })}
                            icon={<Icon name="arrows-clockwise" size={20} color={theme.colors.accent.indigo} />}
                            disabled={!fallbackControlsEnabled}
                            onPress={fallbackControlsEnabled ? () => void editProbeIfSnapshotOlderThan() : undefined}
                        />
                        <Item
                            testID={`${TEST_ID}:switch-budget`}
                            title={t('connectedServices.detail.groupDetail.switchBudgetTitle')}
                            subtitle={t('connectedServices.detail.groupDetail.switchBudgetSubtitle', {
                                perTurn: String(group.policy.maxSwitchesPerTurn),
                                perHour: String(group.policy.maxSwitchesPerSessionHour),
                            })}
                            icon={<Icon name="repeat" size={20} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                        <DropdownMenu
                            open={recoveryModeOpen}
                            onOpenChange={setRecoveryModeOpen}
                            items={buildRecoveryModeItems(group.policy.recoveryMode)}
                            selectedId={group.policy.recoveryMode}
                            onSelect={(mode) => {
                                if (!isGroupRecoveryMode(mode)) return;
                                void patchPolicy({ recoveryMode: mode });
                            }}
                            itemTrigger={{
                                title: t('connectedServices.detail.groupDetail.recoveryModeTitle'),
                                subtitle: resolveRecoveryModeSubtitle(group.policy.recoveryMode),
                                icon: <Icon name="first-aid-kit" size={20} color={theme.colors.text.secondary} />,
                                showSelectedDetail: false,
                                showSelectedSubtitle: false,
                                itemProps: {
                                    testID: `${TEST_ID}:recovery-mode`,
                                    disabled: !fallbackControlsEnabled,
                                },
                            }}
                            rowKind="item"
                            variant="selectable"
                        />
                        <Item
                            testID={`${TEST_ID}:recovery-prompt`}
                            title={t('connectedServices.detail.groupDetail.recoveryPromptTitle')}
                            subtitle={t('connectedServices.detail.groupDetail.recoveryPromptSubtitle')}
                            icon={<Icon name="chat-circle-dots" size={20} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                    </ItemGroup>
                </ExpandableItem>
            </ItemGroup>

            <ItemGroup>
                <Item
                    testID={`${TEST_ID}:delete`}
                    title={t('connectedServices.pools.delete.title')}
                    subtitle={t('connectedServices.pools.delete.subtitle')}
                    icon={<Icon name="trash" size={20} color={theme.colors.state.danger.foreground} />}
                    destructive
                    onPress={() => void deletePool()}
                />
            </ItemGroup>

            {props.error ? (
                <ItemGroup>
                    <Item
                        testID="connected-services-pool-detail:error"
                        title={t('common.error')}
                        subtitle={props.error}
                        icon={<Icon name="warning" size={20} color={theme.colors.state.danger.foreground} />}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </ItemList>
    );
});

/**
 * Wraps a member row in the reorder transform + layout reporter so the inline
 * drag math measures each row's real height. Kept local: it is the only consumer
 * and carries no reusable domain meaning.
 */
const PoolMemberReorderRow = React.memo(function PoolMemberReorderRow(props: Readonly<{
    accountId: string;
    reorder: ReturnType<typeof useListInlineReorder<{ id: string }>>;
    children: React.ReactNode;
}>) {
    const { accountId, reorder } = props;
    const onLayout = React.useCallback(
        (event: Parameters<typeof reorder.onRowLayout>[1]) => reorder.onRowLayout(accountId, event),
        [accountId, reorder],
    );
    return (
        <Animated.View style={reorder.animatedStyleForRow(accountId)} onLayout={onLayout}>
            {props.children}
        </Animated.View>
    );
});
