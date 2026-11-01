import * as React from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import Animated, { useSharedValue } from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';

import { AccountBlock } from '@/components/settings/connectedServices/account/AccountBlock';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { ExpandableItem } from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import {
    TREE_DROP_OVERLAY_KIND_NONE,
    type TreeDropOverlayKind,
    type TreeDropOverlaySharedValues,
} from '@/components/ui/treeDragDrop';
import {
    DEFAULT_REORDER_ROW_HEIGHT,
    useListInlineReorder,
} from '@/components/ui/lists/useListInlineReorder';
import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    addConnectedServiceAuthGroupMemberV3,
    deleteConnectedServiceAuthGroupV3,
    listConnectedServiceAuthGroupsV3,
    patchConnectedServiceAuthGroupMemberV3,
    patchConnectedServiceAuthGroupV3,
    removeConnectedServiceAuthGroupMemberV3,
    setConnectedServiceAuthGroupActiveProfileV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import { PoolMembersSelectField, type PoolMembershipCandidate } from './PoolMembersSelectField';
import { PoolQuotaLimitsSelectField } from './PoolQuotaLimitsSelectField';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { t } from '@/text';
import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceAuthGroupStrategyV1Schema,
    ConnectedServiceIdSchema,
    isConnectedServiceCredentialHealthStatusUsable,
    normalizeConnectedServiceCredentialHealthStatus,
    type ConnectedServiceAuthGroupPolicyPatchV1,
    type ConnectedServiceAuthGroupPolicyV1,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
    isConnectedServiceRuntimeCooldownError,
    resolveConnectedServiceRuntimeCooldownOverridePrompt,
    resolveConnectedServiceSettingsErrorMessage,
} from '../errors/connectedServiceSettingsErrors';
import {
    CONNECTED_SERVICE_GROUP_DEFAULT_POLICY,
    normalizeConnectedServiceGroupMember,
    resolveConnectedServiceGroupMemberCredentialHealthStatus,
    resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs,
    resolveConnectedServiceGroupMemberIdentity,
    resolveConnectedServiceGroupProfileTitle,
    resolveConnectedServiceGroupStrategyLabel,
    resolveConnectedServiceGroupRecoveryMode,
    resolveConnectedServiceGroupSoftSwitchRemainingPercent,
    resolveConnectedServiceGroupSwitchBudget,
    type ConnectedServiceGroupProfileLike,
} from '../model/connectedServiceGroupViewModel';
import { resolveConnectedServiceRuntimeGroupCapability } from '../model/connectedServiceRuntimeFallbackCapability';
import { resolveConnectedServiceDisplayName } from '../model/resolveConnectedServiceDisplayName';
import { commitPoolMemberReorder, computePoolMemberPriorities, type ReorderableGroup } from './commitPoolMemberReorder';
import type { DragHapticsOutcome } from '@/components/ui/treeDragDrop/createDragHapticsSession';
import { commitPoolMembershipBatch } from './commitPoolMembershipBatch';
import { PoolMembersDropOverlay } from './PoolMembersDropOverlay';
import { Icon } from '@/components/ui/icons/Icon';
import { useConnectedServiceQuotaSnapshots } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshots';
import { useConnectedServiceAuthGroupsQuery } from '@/hooks/server/connectedServices/useConnectedServiceAuthGroupsQuery';
import { connectedServiceProfileKey } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { resolveConnectedServiceProjectionSignature } from '@/sync/domains/connectedServices/resolveConnectedServiceProjectionSignature';
import { invalidateConnectedServiceGroupsRefreshSignal } from '@/sync/domains/connectedServices/connectedServiceGroupsRefreshSignal';

type GroupStrategy = ConnectedServiceAuthGroupPolicyV1['strategy'];
type GroupRecoveryMode = ConnectedServiceAuthGroupPolicyV1['recoveryMode'];
type SwitchOnKey = keyof ConnectedServiceAuthGroupPolicyV1['switchOn'];
const SWITCH_ON_KEYS: ReadonlyArray<SwitchOnKey> = ['usageLimit', 'authExpired', 'accountChanged', 'refreshFailure'];

/**
 * Relative container that anchors the absolutely-positioned member drop overlay.
 * Mirrors the session list's relative rows container so the overlay's measured
 * geometry resolves to the right insertion boundary.
 */
// `overflow: 'visible'` so the lifted/scaled dragged row is never clipped by this
// reorder container while it floats above its siblings.
const MEMBERS_REORDER_CONTAINER_STYLE = { position: 'relative', overflow: 'visible' } as const;

function asStringParam(value: unknown): string {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
    return typeof value === 'string' ? value : '';
}

function formatProbeMinutes(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    return String(minutes);
}

function parsePromptNumber(raw: string): number | null {
    const value = Number(raw.trim().replace(/%$/, ''));
    return Number.isFinite(value) ? value : null;
}

function resolveStrategyTitle(strategy: GroupStrategy): string {
    return resolveConnectedServiceGroupStrategyLabel(strategy);
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

function StrategyCheckmark() {
    const { theme } = useUnistyles();
    return <Icon name="check" size={16} color={theme.colors.accent.blue} />;
}

function buildStrategyItems(currentStrategy: GroupStrategy, expiryFirstSupported: boolean): DropdownMenuItem[] {
    return [
        ...(expiryFirstSupported || currentStrategy === 'expiry_first' ? [{
            id: 'expiry_first',
            title: resolveStrategyTitle('expiry_first'),
            subtitle: t('connectedServices.detail.groupDetail.strategyExpiryFirstSubtitle'),
            rightElement: currentStrategy === 'expiry_first' ? <StrategyCheckmark /> : null,
            disabled: !expiryFirstSupported,
        }] : []),
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

function isGroupStrategy(value: string): value is GroupStrategy {
    return ConnectedServiceAuthGroupStrategyV1Schema.safeParse(value).success;
}

function isGroupRecoveryMode(value: string): value is GroupRecoveryMode {
    return value === 'off' || value === 'wait_until_reset' || value === 'switch_then_resume' || value === 'switch_or_wait';
}

/** Sorts members by fallback order (priority asc, profileId tiebreak). */
function sortMembersByPriority(
    members: ConnectedServiceAuthGroupV1['members'],
): ConnectedServiceAuthGroupV1['members'] {
    return members.slice().sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.profileId.localeCompare(b.profileId);
    });
}

function readProfileId(profile: ConnectedServiceGroupProfileLike): string {
    return typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
}

function isConnectedProfile(profile: ConnectedServiceGroupProfileLike): boolean {
    return isConnectedServiceCredentialHealthStatusUsable(
        normalizeConnectedServiceCredentialHealthStatus((profile as { status?: unknown }).status),
    );
}

/**
 * Pool ("auth group") detail view. The new canonical replacement for
 * `ConnectedServiceGroupDetailView`: members render as the shared
 * `AccountBlock` (poolMember variant) in fallback order with drag-reorder +
 * accessible Move up/down + per-member enable, and the Behavior section
 * surfaces EVERY policy control (including the two previously-hidden knobs
 * `autoRestorePrimaryWhenReset` + `switchOn.*`). All wire symbols stay
 * `group`/`AuthGroup`/`groupId` and every mutation threads `expectedGeneration`.
 */
export const PoolDetailView = React.memo(function PoolDetailView() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const auth = useAuth();
    const profile = useProfile();
    const settings = useSettings();
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const accountFallbackEnabled = useFeatureEnabled('connectedServices.accountFallback');
    const autoQuotaResetEnabled = useFeatureEnabled('connectedServices.autoQuotaReset');
    const autoDisablePlanInvalidEnabled = useFeatureEnabled('connectedServices.autoDisablePlanInvalid');
    const poolQuotaLimitSelectionEnabled = useFeatureEnabled('connectedServices.poolQuotaLimitSelection');
    const poolExpiryFirstEnabled = useFeatureEnabled('connectedServices.poolExpiryFirst');
    const [strategyOpen, setStrategyOpen] = React.useState(false);
    const [recoveryModeOpen, setRecoveryModeOpen] = React.useState(false);
    const [advancedExpanded, setAdvancedExpanded] = React.useState(false);

    const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
    const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
    const rawGroupId = asStringParam((params as Record<string, unknown>).groupId).trim();
    const parsedGroupId = ConnectedServiceAuthGroupIdSchema.safeParse(rawGroupId);
    const groupId = parsedGroupId.success ? parsedGroupId.data : '';
    const credentials = auth.credentials ?? null;
    const serviceLabel = serviceId ? resolveConnectedServiceDisplayName(serviceId, t) : t('connectedServices.fallbackName');
    const svc = serviceId ? (profile.connectedServicesV2.find((candidate) => candidate.serviceId === serviceId) ?? null) : null;
    const profiles = (svc?.profiles ?? []) as ReadonlyArray<ConnectedServiceGroupProfileLike>;
    const authGroups = useConnectedServiceAuthGroupsQuery({
        serviceId,
        enabled: connectedServicesEnabled && accountGroupsEnabled,
        serviceProjectionSignature: resolveConnectedServiceProjectionSignature(svc),
    });
    const groups = authGroups.groups;
    const groupsLoadStatus = authGroups.loadStatus;
    const group = groups.find((candidate) => candidate.serviceId === serviceId && candidate.groupId === groupId) ?? null;
    const quotaProfileRefs = React.useMemo(() => {
        if (!serviceId || !group) return [];
        const profileById = new Map(profiles.map((candidate) => [readProfileId(candidate), candidate]));
        return group.members
            .filter((member) => member.enabled)
            .map((member) => ({
                serviceId,
                profileId: member.profileId,
                credentialHealthStatus: (profileById.get(member.profileId) as { status?: unknown } | undefined)?.status,
            }));
    }, [group, profiles, serviceId]);
    const quotaSnapshots = useConnectedServiceQuotaSnapshots(quotaProfileRefs);
    const poolQuotaSnapshotList = React.useMemo(
        () => quotaProfileRefs.map((entry) => quotaSnapshots.snapshotsByKey[connectedServiceProfileKey(entry)] ?? null),
        [quotaProfileRefs, quotaSnapshots.snapshotsByKey],
    );
    const poolQuotaLoadingProfileCount = React.useMemo(
        () => quotaProfileRefs.reduce(
            (count, entry) => count + (quotaSnapshots.loadingByKey[connectedServiceProfileKey(entry)] ? 1 : 0),
            0,
        ),
        [quotaProfileRefs, quotaSnapshots.loadingByKey],
    );

    const runtimeGroupCapability = React.useMemo(
        () => serviceId
            ? resolveConnectedServiceRuntimeGroupCapability(serviceId)
            : {
                groupConfigurationSupported: false,
                runtimeFallbackSupported: false,
                quotaResetSupported: false,
                groupConfigurationSupportingAgentIds: [],
                runtimeFallbackSupportingAgentIds: [],
            },
        [serviceId],
    );
    const runtimeGroupFallbackSupported = runtimeGroupCapability.runtimeFallbackSupported;
    const fallbackControlsEnabled = accountFallbackEnabled && runtimeGroupFallbackSupported;
    const fallbackDisabledSubtitle = !runtimeGroupFallbackSupported
        ? t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')
        : accountFallbackEnabled
            ? undefined
            : t('connectedServices.detail.groupActions.accountFallbackDisabled');
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

    const ensureCredentials = () => {
        if (!auth.credentials) {
            throw new Error('Not authenticated');
        }
        return auth.credentials;
    };

    const loadGroups = authGroups.refresh;
    const upsertGroup = authGroups.upsertGroup;

    const runGroupMutation = React.useCallback(async (
        mutation: () => Promise<ConnectedServiceAuthGroupV1>,
        opts?: Readonly<{ onError?: (error: unknown) => Promise<boolean> }>,
    ) => {
        try {
            const nextGroup = await mutation();
            upsertGroup(nextGroup);
            invalidateConnectedServiceGroupsRefreshSignal();
            await sync.refreshProfile().catch(() => undefined);
        } catch (e: unknown) {
            if (await opts?.onError?.(e)) return;
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        }
    }, [upsertGroup]);

    const patchPolicy = React.useCallback(async (policy: ConnectedServiceAuthGroupPolicyPatchV1) => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy, expectedGeneration: group.generation },
        }));
    }, [fallbackControlsEnabled, group, runGroupMutation, serviceId]);

    const handleEditName = async () => {
        if (!serviceId || !group) return;
        const next = await Modal.prompt(
            t('connectedServices.detail.groupDetail.nameTitle'),
            t('connectedServices.detail.groupDetail.namePromptBody'),
            {
                placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
                defaultValue: group.displayName ?? group.groupId,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next !== 'string') return;
        const displayName = next.trim() || null;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { displayName },
        }));
    };

    const handleSetAutoSwitch = (autoSwitch: boolean) => void patchPolicy({ autoSwitch });
    const handleSetAutoQuotaReset = (autoUseQuotaResetsWhenExhausted: boolean) => {
        if (autoQuotaResetEnabled && runtimeGroupCapability.quotaResetSupported) {
            void patchPolicy({ autoUseQuotaResetsWhenExhausted });
        }
    };
    const handleSetAutoDisablePlanInvalid = (autoDisablePlanInvalidAccounts: boolean) => {
        if (autoDisablePlanInvalidEnabled && fallbackControlsEnabled) {
            void patchPolicy({ autoDisablePlanInvalidAccounts });
        }
    };
    const handleSetQuotaLimitSelection = (quotaLimitSelection: NonNullable<ConnectedServiceAuthGroupPolicyV1['quotaLimitSelection']>) => {
        if (poolQuotaLimitSelectionEnabled && fallbackControlsEnabled) {
            void patchPolicy({ quotaLimitSelection });
        }
    };

    const handleSetStrategy = (strategy: string) => {
        if (!isGroupStrategy(strategy)) return;
        if (strategy === 'expiry_first' && !poolExpiryFirstEnabled) return;
        void patchPolicy({ strategy });
    };

    const handleSetRecoveryMode = (mode: string) => {
        if (!isGroupRecoveryMode(mode)) return;
        void patchPolicy({ recoveryMode: mode });
    };

    const handleSetAutoRestorePrimary = (autoRestorePrimaryWhenReset: boolean) =>
        void patchPolicy({ autoRestorePrimaryWhenReset });

    const handleToggleSwitchOn = (key: SwitchOnKey, next: boolean) => {
        if (!group) return;
        void patchPolicy({ switchOn: { ...group.policy.switchOn, [key]: next } });
    };

    const handleEditSoftSwitchRemainingPercent = async () => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        const current = resolveConnectedServiceGroupSoftSwitchRemainingPercent(group);
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptTitle'),
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptBody'),
            {
                placeholder: String(CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.softSwitchRemainingPercent),
                defaultValue: String(current),
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
    };

    const handleEditProbeIfSnapshotOlderThan = async () => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        const currentMinutes = formatProbeMinutes(resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs(group));
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.staleProbePromptTitle'),
            t('connectedServices.detail.groupDetail.staleProbePromptBody'),
            {
                placeholder: formatProbeMinutes(CONNECTED_SERVICE_GROUP_DEFAULT_POLICY.probeIfSnapshotOlderThanMs),
                defaultValue: currentMinutes,
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
    };

    const handleSetMemberEnabled = React.useCallback(async (profileId: string, enabled: boolean) => {
        if (!serviceId || !group) return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            patch: { enabled, expectedGeneration: group.generation },
        }));
    }, [group, runGroupMutation, serviceId]);

    const handleRemoveMember = React.useCallback(async (profileId: string) => {
        if (!serviceId || !group) return;
        const ok = await Modal.confirm(
            t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
            t('connectedServices.detail.groupActions.removeMemberConfirmBody', { profileId }),
            { confirmText: t('connectedServices.detail.groupActions.removeMember'), cancelText: t('common.cancel'), destructive: true },
        );
        if (!ok) return;
        await runGroupMutation(() => removeConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            expectedGeneration: group.generation,
        }));
    }, [group, runGroupMutation, serviceId]);

    /**
     * All profiles eligible for pool membership: current members (kept so they can
     * be unchecked) plus any connectable profile not yet a member. Feeds the
     * searchable batch membership editor.
     */
    const membershipCandidates = React.useMemo<ReadonlyArray<PoolMembershipCandidate>>(() => {
        if (!group || !serviceId) return [];
        const memberProfileIds = new Set(group.members.map((member) => member.profileId));
        return profiles
            .filter((candidate) => {
                const profileId = readProfileId(candidate);
                return profileId.length > 0
                    && (memberProfileIds.has(profileId) || isConnectedProfile(candidate));
            })
            .map((candidate) => {
                const profileId = readProfileId(candidate);
                const identity = resolveConnectedServiceGroupMemberIdentity({
                    serviceId,
                    profileId,
                    labelsByKey: settings.connectedServicesProfileLabelByKey,
                    profiles,
                });
                return {
                    profileId,
                    title: resolveConnectedServiceGroupProfileTitle({
                        serviceId,
                        profileId,
                        labelsByKey: settings.connectedServicesProfileLabelByKey,
                        profiles,
                    }),
                    subtitle: identity.secondaryLabel ?? undefined,
                };
            });
    }, [group, profiles, serviceId, settings.connectedServicesProfileLabelByKey]);

    /**
     * Batch-apply a membership diff from the editor: reuse the canonical
     * add/remove member mutations, threaded through `commitPoolMembershipBatch`
     * so the bumped `expectedGeneration` chains across the sequential calls (no
     * batch endpoint exists) and a generation conflict refetches + retries. The
     * authoritative reconcile happens once at the end via profile + group reload.
     */
    const handleCommitMembership = React.useCallback(async (
        nextSelectedProfileIds: ReadonlyArray<string>,
    ) => {
        if (!serviceId || !group) return;
        const startGroup = group;
        const toLean = (candidate: ConnectedServiceAuthGroupV1) => ({
            generation: candidate.generation,
            members: candidate.members.map((member) => ({ profileId: member.profileId, priority: member.priority })),
        });
        try {
            await commitPoolMembershipBatch({
                group: toLean(startGroup),
                nextSelectedProfileIds,
                addMember: async ({ profileId, priority, expectedGeneration }) => toLean(
                    await addConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
                        serviceId,
                        groupId: startGroup.groupId,
                        profileId,
                        priority,
                        enabled: true,
                        expectedGeneration,
                    }),
                ),
                removeMember: async ({ profileId, expectedGeneration }) => toLean(
                    await removeConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
                        serviceId,
                        groupId: startGroup.groupId,
                        profileId,
                        expectedGeneration,
                    }),
                ),
                refetchGroup: async () => {
                    const refreshed = await listConnectedServiceAuthGroupsV3(ensureCredentials(), { serviceId });
                    const next = refreshed.find((candidate) => candidate.groupId === startGroup.groupId);
                    if (next) {
                        upsertGroup(next);
                        return toLean(next);
                    }
                    return toLean(startGroup);
                },
            });
            await sync.refreshProfile().catch(() => undefined);
            await loadGroups().catch(() => undefined);
        } catch (e: unknown) {
            await loadGroups().catch(() => undefined);
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        }
    }, [group, loadGroups, serviceId, upsertGroup]);

    const handleSetActiveMember = React.useCallback(async (profileId: string) => {
        if (!serviceId || !group || !fallbackControlsEnabled) return;
        const commitServerActive = (overrideRuntimeCooldown: boolean) =>
            setConnectedServiceAuthGroupActiveProfileV3(ensureCredentials(), {
                serviceId,
                groupId: group.groupId,
                profileId,
                expectedGeneration: group.generation,
                ...(overrideRuntimeCooldown ? { overrideRuntimeCooldown: true } : {}),
            });

        // Phase 1 — server CAS commit. A failure here means NOTHING committed (no divergence): reconcile
        // to server truth and surface generically. Runtime-cooldown offers an explicit override retry.
        let serverGroup: ConnectedServiceAuthGroupV1;
        try {
            serverGroup = await commitServerActive(false);
        } catch (error) {
            if (isConnectedServiceRuntimeCooldownError(error)) {
                const prompt = resolveConnectedServiceRuntimeCooldownOverridePrompt(error);
                const ok = await Modal.confirm(prompt.title, prompt.body, {
                    confirmText: prompt.confirmText,
                    cancelText: prompt.cancelText,
                });
                if (!ok) return;
                try {
                    serverGroup = await commitServerActive(true);
                } catch (retryError) {
                    await loadGroups().catch(() => undefined);
                    await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
                    return;
                }
            } else {
                await loadGroups().catch(() => undefined);
                await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(error));
                return;
            }
        }

        // The server CAS is the sole user-action owner. Its account projection is consumed durably by
        // every daemon, including daemons that are offline now and reconnect later. The UI must never
        // add a second best-effort delivery path to one currently reachable machine.
        upsertGroup(serverGroup);
        await Promise.all([
            sync.refreshProfile().catch(() => undefined),
            loadGroups().catch(() => undefined),
        ]);
    }, [fallbackControlsEnabled, group, loadGroups, serviceId, upsertGroup]);

    /**
     * Commit a new member fallback order. Threads the bumped `expectedGeneration`
     * through each sequential priority patch and refetches on a generation
     * conflict — the single owner is `commitPoolMemberReorder`.
     */
    const commitOrder = React.useCallback(async (orderedProfileIds: ReadonlyArray<string>): Promise<DragHapticsOutcome> => {
        if (!serviceId || !group) return 'refused';
        const startGroup = group;
        const currentOrder = sortMembersByPriority(startGroup.members).map((member) => member.profileId);
        if (currentOrder.length === orderedProfileIds.length && currentOrder.every((id, index) => id === orderedProfileIds[index])) return 'unchanged';
        const reorderable: ReorderableGroup = {
            generation: startGroup.generation,
            members: startGroup.members.map((member) => ({ profileId: member.profileId, priority: member.priority })),
        };
        // Optimistic, atomic reorder: reflect the dropped order in ONE local update
        // before any network patch. The only available endpoint patches a single
        // member's priority at a time, so persisting the order means a SEQUENCE of
        // patches — re-upserting each intermediate server state would re-sort the
        // list through transient priority ties on every patch (a visible chaotic
        // reshuffle), and because the drag ends before the first patch lands the row
        // would briefly snap back to its old slot. Instead we reprice locally up
        // front, persist in the background, and reconcile/​revert once at the end.
        const targetPriorities = computePoolMemberPriorities(
            orderedProfileIds,
            new Set(startGroup.members.map((member) => member.profileId)),
        );
        upsertGroup({
            ...startGroup,
            members: startGroup.members.map((member) => ({
                ...member,
                priority: targetPriorities.get(member.profileId) ?? member.priority,
            })),
        });
        try {
            const committed = await commitPoolMemberReorder({
                group: reorderable,
                orderedProfileIds,
                patchMember: async ({ profileId, priority, expectedGeneration }) => {
                    const updated = await patchConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
                        serviceId,
                        groupId: startGroup.groupId,
                        profileId,
                        patch: { priority, expectedGeneration },
                    });
                    // Thread the bumped generation only — do NOT upsert this
                    // intermediate server state (it carries only the priorities
                    // patched so far, which would reintroduce the per-patch
                    // reshuffle the optimistic update exists to prevent). The
                    // authoritative reconcile happens once, after the loop.
                    return { generation: updated.generation, members: updated.members };
                },
                refetchGroup: async () => {
                    const refreshed = await listConnectedServiceAuthGroupsV3(ensureCredentials(), { serviceId });
                    const next = refreshed.find((candidate) => candidate.groupId === startGroup.groupId);
                    if (next) {
                        upsertGroup(next);
                        return { generation: next.generation, members: next.members };
                    }
                    return reorderable;
                },
            });
            await sync.refreshProfile().catch(() => undefined);
            await loadGroups().catch(() => undefined);
            return committed.patchedProfileIds.length > 0 ? 'applied' : 'unchanged';
        } catch (e: unknown) {
            // Revert the optimistic order to authoritative server truth, then surface.
            await loadGroups().catch(() => undefined);
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
            return 'unknown';
        }
    }, [group, loadGroups, serviceId, upsertGroup]);

    const handleDeletePool = async () => {
        if (!serviceId || !group) return;
        const ok = await Modal.confirm(
            t('connectedServices.pools.delete.confirmTitle'),
            t('connectedServices.pools.delete.confirmMessage', { name: group.displayName ?? group.groupId }),
            { confirmText: t('common.delete'), cancelText: t('common.cancel') },
        );
        if (!ok) return;
        try {
            await deleteConnectedServiceAuthGroupV3(ensureCredentials(), { serviceId, groupId: group.groupId });
            await sync.refreshProfile().catch(() => undefined);
            await loadGroups().catch(() => undefined);
        } catch (e: unknown) {
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        }
    };

    const sortedMembers = React.useMemo(
        () => (group ? sortMembersByPriority(group.members) : []),
        [group],
    );
    const memberItems = React.useMemo(
        () => sortedMembers.map((member) => ({ id: member.profileId })),
        [sortedMembers],
    );
    /** Authoritative membership, in fallback order — the multi-select's baseline. */
    const memberProfileIds = React.useMemo(
        () => sortedMembers.map((member) => member.profileId),
        [sortedMembers],
    );

    const reorder = useListInlineReorder({
        items: memberItems,
        enabled: Boolean(group) && sortedMembers.length > 1,
        overlayShared,
        onCommitOrder: commitOrder,
        fallbackRowHeight: DEFAULT_REORDER_ROW_HEIGHT,
    });

    /** Move a member up/down in fallback order (accessible drag fallback). */
    const handleMoveMember = React.useCallback((profileId: string, direction: -1 | 1) => {
        const order = sortedMembers.map((member) => member.profileId);
        const index = order.indexOf(profileId);
        if (index < 0) return;
        const target = index + direction;
        if (target < 0 || target >= order.length) return;
        const next = order.slice();
        next.splice(index, 1);
        next.splice(target, 0, profileId);
        void commitOrder(next);
    }, [commitOrder, sortedMembers]);

    if (!connectedServicesEnabled || !accountGroupsEnabled) {
        return (
            <ItemList>
                <ItemGroup title={t('settings.connectedAccounts')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>{t('settings.connectedAccountsDisabled')}</Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    if (!serviceId || !groupId) {
        return (
            <ItemList>
                <ItemGroup title={t('connectedServices.title')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.oauthPaste.invalidConfig')}</Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    if (!group && (groupsLoadStatus === 'loading' || groupsLoadStatus === 'refreshing')) {
        return <ItemList testID="connected-services-pool-detail:loading">{null}</ItemList>;
    }

    if (!group) {
        return (
            <ItemList>
                <ItemGroup title={t('connectedServices.detail.groupDetail.missingTitle')}>
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>
                            {t('connectedServices.detail.groupDetail.missingBody', { service: serviceLabel, groupId })}
                        </Text>
                    </View>
                </ItemGroup>
            </ItemList>
        );
    }

    const label = group.displayName ?? group.groupId;
    const enabledCount = group.members.filter((member) => member.enabled).length;
    const softSwitchRemainingPercent = resolveConnectedServiceGroupSoftSwitchRemainingPercent(group);
    const staleProbeMinutes = formatProbeMinutes(resolveConnectedServiceGroupProbeIfSnapshotOlderThanMs(group));
    const switchBudget = resolveConnectedServiceGroupSwitchBudget(group);
    const recoveryMode = resolveConnectedServiceGroupRecoveryMode(group);
    const autoSwitchSubtitle = fallbackDisabledSubtitle
        ? fallbackDisabledSubtitle
        : group.policy.autoSwitch
            ? t('connectedServices.detail.groupDetail.autoSwitchEnabledSubtitle')
            : t('connectedServices.detail.groupDetail.autoSwitchDisabledSubtitle');

    const orderedMembers = reorder.frozenItems
        .map((item) => sortedMembers.find((member) => member.profileId === item.id))
        .filter((member): member is (typeof sortedMembers)[number] => member != null);
    const memberCount = orderedMembers.length;

    return (
        <ItemList testID="connected-services-pool-detail">
            <ItemGroup title={`${serviceLabel} • ${label}`}>
                <Item
                    testID="connected-services-pool-detail:name"
                    title={t('connectedServices.detail.groupDetail.nameTitle')}
                    subtitle={label}
                    icon={<Icon name="pencil" size={20} color={theme.colors.accent.blue} />}
                    onPress={() => void handleEditName()}
                />
                <Item
                    testID="connected-services-pool-detail:summary"
                    title={t('connectedServices.pools.detail.summaryTitle')}
                    subtitle={t('connectedServices.pools.detail.summary', {
                        count: group.members.length,
                        strategy: resolveStrategyTitle(group.policy.strategy),
                    })}
                    showChevron={false}
                />
                {group.activeProfileId ? (
                    <Item
                        testID="connected-services-pool-detail:server-active-status"
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
                {memberCount > 0
                    ? (
                        // `position: 'relative'` anchors the absolutely-positioned
                        // drop overlay over the member rows so its measured
                        // `overlayTop` (cumulative row heights from the first row's
                        // top) lands at the right insertion boundary — mirroring the
                        // session list's relative rows container.
                        <View style={MEMBERS_REORDER_CONTAINER_STYLE}>
                            {orderedMembers.map((member, index) => {
                        const memberModel = normalizeConnectedServiceGroupMember(member);
                        if (!memberModel) return null;
                        const memberTitle = resolveConnectedServiceGroupProfileTitle({
                            serviceId,
                            profileId: memberModel.profileId,
                            labelsByKey: settings.connectedServicesProfileLabelByKey,
                            profiles,
                        });
                        const memberIdentity = resolveConnectedServiceGroupMemberIdentity({
                            serviceId,
                            profileId: memberModel.profileId,
                            labelsByKey: settings.connectedServicesProfileLabelByKey,
                            profiles,
                        });
                        const isActive = memberModel.profileId === group.activeProfileId;
                        const memberHealthStatus = resolveConnectedServiceGroupMemberCredentialHealthStatus({
                            member: memberModel,
                            profiles,
                        });
                        const canSetActiveMember = !isActive && fallbackControlsEnabled;
                        // Bind the inline-reorder pan gesture for this row. The gesture
                        // is created once per row here and handed to `AccountBlock`,
                        // which renders the GestureDetector INLINE (mirroring
                        // SessionItem — the only pattern proven on web under React 19 +
                        // RNGH 2.28). When reorder is disabled (single member) the
                        // gesture is undefined and no handle renders. Commit happens on
                        // drag-end via `commitOrder`.
                        const reorderGesture = reorder.gestureForRow(memberModel.profileId, index);
                        const memberActions: ItemAction[] = [
                            {
                                id: `connected-services-pool:${group.groupId}:member:${memberModel.profileId}:action:move-up`,
                                title: t('connectedServices.pools.detail.moveUp'),
                                icon: 'arrow-up',
                                disabled: index === 0,
                                onPress: index === 0 ? undefined : () => handleMoveMember(memberModel.profileId, -1),
                            },
                            {
                                id: `connected-services-pool:${group.groupId}:member:${memberModel.profileId}:action:move-down`,
                                title: t('connectedServices.pools.detail.moveDown'),
                                icon: 'arrow-down',
                                disabled: index === memberCount - 1,
                                onPress: index === memberCount - 1 ? undefined : () => handleMoveMember(memberModel.profileId, 1),
                            },
                            {
                                id: `connected-services-pool:${group.groupId}:member:${memberModel.profileId}:action:set-active`,
                                title: isActive
                                    ? t('connectedServices.detail.groupActions.activeMember')
                                    : t('connectedServices.detail.groupActions.makeActive'),
                                subtitle: !isActive
                                    ? !fallbackControlsEnabled
                                        ? fallbackDisabledSubtitle ?? t('connectedServices.detail.groupActions.accountFallbackDisabled')
                                        : undefined
                                    : undefined,
                                icon: isActive ? 'radio-button' : 'circle',
                                disabled: !canSetActiveMember,
                                onPress: canSetActiveMember
                                    ? () => void handleSetActiveMember(memberModel.profileId)
                                    : undefined,
                            },
                            {
                                id: `connected-services-pool:${group.groupId}:member:${memberModel.profileId}:action:remove`,
                                title: t('connectedServices.detail.groupActions.removeMember'),
                                icon: 'minus-circle',
                                destructive: true,
                                onPress: () => void handleRemoveMember(memberModel.profileId),
                            },
                        ];
                        return (
                            <ExpandableItemReorderRow
                                key={memberModel.profileId}
                                profileId={memberModel.profileId}
                                index={index}
                                reorder={reorder}
                            >
                                <AccountBlock
                                    testID={`connected-services-pool-detail:member:${memberModel.profileId}`}
                                    serviceId={serviceId}
                                    profileId={memberModel.profileId}
                                    title={memberTitle}
                                    identityLabel={memberIdentity.secondaryLabel ?? null}
                                    status={memberHealthStatus}
                                    variant="poolMember"
                                    groupId={group.groupId}
                                    enabled={memberModel.enabled}
                                    onToggleEnabled={(next) => void handleSetMemberEnabled(memberModel.profileId, next)}
                                    isActive={isActive}
                                    onSetActive={canSetActiveMember
                                        ? () => void handleSetActiveMember(memberModel.profileId)
                                        : undefined}
                                    actions={memberActions}
                                    reorderGesture={reorderGesture}
                                    showDivider={index < memberCount - 1}
                                    quotaLimitSelection={group.policy.quotaLimitSelection}
                                />
                            </ExpandableItemReorderRow>
                                );
                            })}
                            <PoolMembersDropOverlay
                                shared={overlayShared}
                                testID="connected-services-pool-detail:drop-overlay"
                            />
                        </View>
                    )
                    : (
                        <Item
                            testID="connected-services-pool-detail:no-members"
                            title={t('connectedServices.pools.detail.noMembersTitle')}
                            subtitle={t('connectedServices.pools.detail.noMembersSubtitle')}
                            showChevron={false}
                        />
                    )}
                <PoolMembersSelectField
                    testID="connected-services-pool-detail:members-select"
                    candidates={membershipCandidates}
                    selectedProfileIds={memberProfileIds}
                    onCommit={(next) => { void handleCommitMembership(next); }}
                />
            </ItemGroup>

            <ItemGroup title={t('connectedServices.pools.detail.behaviorTitle')}>
                <Item
                    testID="connected-services-pool-detail:auto-switch"
                    title={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                    subtitle={autoSwitchSubtitle}
                    icon={<Icon name="arrows-left-right" size={20} color={theme.colors.accent.blue} />}
                    disabled={!fallbackControlsEnabled}
                    rightElement={(
                        <Switch
                            testID="connected-services-pool-detail:auto-switch:toggle"
                            value={group.policy.autoSwitch}
                            onValueChange={fallbackControlsEnabled ? handleSetAutoSwitch : undefined}
                            disabled={!fallbackControlsEnabled}
                            accessibilityLabel={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                            compact
                        />
                    )}
                    showChevron={false}
                />
                {autoDisablePlanInvalidEnabled ? (
                    <Item
                        testID="connected-services-pool-detail:auto-disable-plan-invalid"
                        title={t('connectedServices.detail.groupDetail.autoDisablePlanInvalidTitle')}
                        subtitle={t('connectedServices.detail.groupDetail.autoDisablePlanInvalidSubtitle')}
                        disabled={!fallbackControlsEnabled}
                        rightElement={(
                            <Switch
                                testID="connected-services-pool-detail:auto-disable-plan-invalid:toggle"
                                value={group.policy.autoDisablePlanInvalidAccounts === true}
                                onValueChange={fallbackControlsEnabled ? handleSetAutoDisablePlanInvalid : undefined}
                                disabled={!fallbackControlsEnabled}
                                accessibilityLabel={t('connectedServices.detail.groupDetail.autoDisablePlanInvalidTitle')}
                                compact
                            />
                        )}
                        showChevron={false}
                    />
                ) : null}
                {autoQuotaResetEnabled && runtimeGroupCapability.quotaResetSupported ? (
                    <Item
                        testID="connected-services-pool-detail:auto-quota-reset"
                        title={t('connectedServices.detail.groupDetail.autoQuotaResetTitle')}
                        subtitle={t('connectedServices.detail.groupDetail.autoQuotaResetSubtitle')}
                        rightElement={(
                            <Switch
                                testID="connected-services-pool-detail:auto-quota-reset:toggle"
                                value={group.policy.autoUseQuotaResetsWhenExhausted === true}
                                onValueChange={handleSetAutoQuotaReset}
                                accessibilityLabel={t('connectedServices.detail.groupDetail.autoQuotaResetTitle')}
                                compact
                            />
                        )}
                        showChevron={false}
                    />
                ) : null}
                {poolQuotaLimitSelectionEnabled ? (
                    <PoolQuotaLimitsSelectField
                        snapshots={poolQuotaSnapshotList}
                        selection={group.policy.quotaLimitSelection}
                        onChange={handleSetQuotaLimitSelection}
                        loadingProfileCount={poolQuotaLoadingProfileCount}
                        disabled={!fallbackControlsEnabled}
                    />
                ) : null}
                <DropdownMenu
                    open={strategyOpen}
                    onOpenChange={setStrategyOpen}
                    items={buildStrategyItems(group.policy.strategy, poolExpiryFirstEnabled)}
                    selectedId={group.policy.strategy}
                    onSelect={handleSetStrategy}
                    itemTrigger={{
                        title: t('connectedServices.detail.groupDetail.strategyTitle'),
                        subtitle: resolveStrategyTitle(group.policy.strategy),
                        icon: <Icon name="sliders-horizontal" size={20} color={theme.colors.accent.blue} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        itemProps: {
                            testID: 'connected-services-pool-detail:strategy',
                            disabled: !fallbackControlsEnabled,
                        },
                    }}
                    rowKind="item"
                    variant="selectable"
                />
                <Item
                    testID="connected-services-pool-detail:soft-switch-threshold"
                    title={t('connectedServices.detail.groupDetail.softSwitchThresholdTitle')}
                    subtitle={fallbackDisabledSubtitle ?? t('connectedServices.detail.groupDetail.softSwitchThresholdSubtitle', { percent: String(softSwitchRemainingPercent) })}
                    icon={<Icon name="speedometer" size={20} color={theme.colors.accent.indigo} />}
                    disabled={!fallbackControlsEnabled}
                    onPress={fallbackControlsEnabled ? () => void handleEditSoftSwitchRemainingPercent() : undefined}
                />
            </ItemGroup>

            <ItemGroup>
                <ExpandableItem
                    testID="connected-services-pool-detail:advanced"
                    expanded={advancedExpanded}
                    onExpandedChange={setAdvancedExpanded}
                    header={(state) => (
                        <Item
                            testID="connected-services-pool-detail:advanced:header"
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
                            testID="connected-services-pool-detail:auto-restore-primary"
                            title={t('connectedServices.pools.behavior.autoRestorePrimaryTitle')}
                            subtitle={t('connectedServices.pools.behavior.autoRestorePrimarySubtitle')}
                            icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.indigo} />}
                            disabled={!fallbackControlsEnabled}
                            rightElement={(
                                <Switch
                                    testID="connected-services-pool-detail:auto-restore-primary:toggle"
                                    value={group.policy.autoRestorePrimaryWhenReset}
                                    onValueChange={fallbackControlsEnabled ? handleSetAutoRestorePrimary : undefined}
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
                                testID={`connected-services-pool-detail:switch-on:${key}`}
                                title={resolveSwitchOnLabel(key)}
                                subtitle={t('connectedServices.pools.behavior.switchOnGroupSubtitle')}
                                icon={<Icon name="git-branch" size={20} color={theme.colors.text.secondary} />}
                                disabled={!fallbackControlsEnabled}
                                rightElement={(
                                    <Switch
                                        testID={`connected-services-pool-detail:switch-on:${key}:toggle`}
                                        value={group.policy.switchOn[key]}
                                        onValueChange={fallbackControlsEnabled ? (next) => handleToggleSwitchOn(key, next) : undefined}
                                        disabled={!fallbackControlsEnabled}
                                        accessibilityLabel={resolveSwitchOnLabel(key)}
                                        compact
                                    />
                                )}
                                showChevron={false}
                            />
                        ))}
                        <Item
                            testID="connected-services-pool-detail:stale-probe-after"
                            title={t('connectedServices.detail.groupDetail.staleProbeTitle')}
                            subtitle={fallbackDisabledSubtitle ?? t('connectedServices.detail.groupDetail.staleProbeSubtitle', { minutes: staleProbeMinutes })}
                            icon={<Icon name="arrows-clockwise" size={20} color={theme.colors.accent.indigo} />}
                            disabled={!fallbackControlsEnabled}
                            onPress={fallbackControlsEnabled ? () => void handleEditProbeIfSnapshotOlderThan() : undefined}
                        />
                        <Item
                            testID="connected-services-pool-detail:switch-budget"
                            title={t('connectedServices.detail.groupDetail.switchBudgetTitle')}
                            subtitle={t('connectedServices.detail.groupDetail.switchBudgetSubtitle', {
                                perTurn: String(switchBudget.perTurn),
                                perHour: String(switchBudget.perSessionHour),
                            })}
                            icon={<Icon name="repeat" size={20} color={theme.colors.text.secondary} />}
                            showChevron={false}
                        />
                        <DropdownMenu
                            open={recoveryModeOpen}
                            onOpenChange={setRecoveryModeOpen}
                            items={buildRecoveryModeItems(recoveryMode)}
                            selectedId={recoveryMode}
                            onSelect={handleSetRecoveryMode}
                            itemTrigger={{
                                title: t('connectedServices.detail.groupDetail.recoveryModeTitle'),
                                subtitle: resolveRecoveryModeSubtitle(recoveryMode),
                                icon: <Icon name="first-aid-kit" size={20} color={theme.colors.text.secondary} />,
                                showSelectedDetail: false,
                                showSelectedSubtitle: false,
                                itemProps: {
                                    testID: 'connected-services-pool-detail:recovery-mode',
                                    disabled: !fallbackControlsEnabled,
                                },
                            }}
                            rowKind="item"
                            variant="selectable"
                        />
                        <Item
                            testID="connected-services-pool-detail:recovery-prompt"
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
                    testID="connected-services-pool-detail:delete"
                    title={t('connectedServices.pools.delete.title')}
                    subtitle={t('connectedServices.pools.delete.subtitle')}
                    icon={<Icon name="trash" size={20} color={theme.colors.state.danger.foreground} />}
                    destructive
                    onPress={() => void handleDeletePool()}
                />
            </ItemGroup>
        </ItemList>
    );
});

/**
 * Wraps an `AccountBlock` member row in the reorder transform + layout reporter
 * so the inline drag math measures each row's real height. Kept local: it is the
 * only consumer and carries no reusable domain meaning.
 */
const ExpandableItemReorderRow = React.memo(function ExpandableItemReorderRow(props: Readonly<{
    profileId: string;
    index: number;
    reorder: ReturnType<typeof useListInlineReorder>;
    children: React.ReactNode;
}>) {
    const { profileId, reorder } = props;
    const onLayout = React.useCallback(
        (event: Parameters<typeof reorder.onRowLayout>[1]) => reorder.onRowLayout(profileId, event),
        [profileId, reorder],
    );
    return (
        <Animated.View style={reorder.animatedStyleForRow(profileId)} onLayout={onLayout}>
            {props.children}
        </Animated.View>
    );
});
