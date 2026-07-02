import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { ItemList } from '@/components/ui/lists/ItemList';
import { Text } from '@/components/ui/text/Text';
import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { Modal } from '@/modal';
import {
    addConnectedServiceAuthGroupMemberV3,
    listConnectedServiceAuthGroupsV3,
    patchConnectedServiceAuthGroupMemberV3,
    patchConnectedServiceAuthGroupV3,
    removeConnectedServiceAuthGroupMemberV3,
    setConnectedServiceAuthGroupActiveProfileV3,
} from '@/sync/api/account/apiConnectedServiceAuthGroupsV3';
import { resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { sync } from '@/sync/sync';
import { useProfile, useSettings } from '@/sync/store/hooks';
import { t } from '@/text';
import {
    ConnectedServiceAuthGroupIdSchema,
    ConnectedServiceAuthGroupPolicyV1Schema,
    ConnectedServiceIdSchema,
    type ConnectedServiceAuthGroupV1,
    type ConnectedServiceId,
} from '@happier-dev/protocol';

import {
    isConnectedServiceRuntimeCooldownError,
    resolveConnectedServiceRuntimeCooldownOverrideBody,
    resolveConnectedServiceSettingsErrorMessage,
} from '../connectedServiceSettingsErrors';
import { formatConnectedServiceGroupMemberSubtitle } from '../model/connectedServiceGroupMemberSubtitle';
import { isConnectedServiceRuntimeGroupFallbackSupported } from '../model/connectedServiceRuntimeFallbackCapability';
import { resolveConnectedServiceDisplayName } from '../model/resolveConnectedServiceDisplayName';

type ConnectedServiceProfileLike = Readonly<{
    profileId?: string;
    providerEmail?: string | null;
}>;

type GroupStrategy = ConnectedServiceAuthGroupV1['policy']['strategy'];
type GroupMember = ConnectedServiceAuthGroupV1['members'][number];

const DEFAULT_GROUP_POLICY = ConnectedServiceAuthGroupPolicyV1Schema.parse({});
const PROBE_INTERVAL_MS_PER_MINUTE = 60_000;

function resolveSoftSwitchRemainingPercent(group: ConnectedServiceAuthGroupV1): number {
    const value = group.policy.softSwitchRemainingPercent;
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : DEFAULT_GROUP_POLICY.softSwitchRemainingPercent;
}

function resolveProbeIfSnapshotOlderThanMs(group: ConnectedServiceAuthGroupV1): number {
    const value = group.policy.probeIfSnapshotOlderThanMs;
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : DEFAULT_GROUP_POLICY.probeIfSnapshotOlderThanMs;
}

function formatProbeMinutes(ms: number): string {
    const minutes = Math.max(1, Math.round(ms / PROBE_INTERVAL_MS_PER_MINUTE));
    return String(minutes);
}

function parsePromptNumber(raw: string): number | null {
    const value = Number(raw.trim().replace(/%$/, ''));
    return Number.isFinite(value) ? value : null;
}

function asStringParam(value: unknown): string {
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : '';
    return typeof value === 'string' ? value : '';
}

function resolveProfileTitle(params: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    labelsByKey: Readonly<Record<string, string>>;
}>): string {
    return resolveConnectedServiceProfileLabel({
        labelsByKey: params.labelsByKey,
        serviceId: params.serviceId,
        profileId: params.profileId,
    }) ?? params.profileId;
}

function resolveStrategyTitle(strategy: GroupStrategy): string {
    if (strategy === 'least_limited') return t('connectedServices.detail.groupDetail.strategyLeastLimitedTitle');
    if (strategy === 'manual') return t('connectedServices.detail.groupDetail.strategyManualTitle');
    return t('connectedServices.detail.groupDetail.strategyPriorityTitle');
}

function buildMemberActions(params: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    member: GroupMember;
    accountFallbackEnabled: boolean;
    accountFallbackDisabledSubtitle?: string;
    onSetActiveMember: (profileId: string) => void;
    onSetMemberEnabled: (enabled: boolean) => void;
    onEditMemberPriority: () => void;
    onRemoveMember: () => void;
}>): ItemAction[] {
    const isActive = params.member.profileId === params.group.activeProfileId;
    const canSetActive = !isActive && params.accountFallbackEnabled;
    return [
        {
            id: `connected-services-group:${params.group.groupId}:member:${params.member.profileId}:action:set-active`,
            title: isActive
                ? t('connectedServices.detail.groupActions.activeMember')
                : t('connectedServices.detail.groupActions.makeActive'),
            subtitle: !isActive && !params.accountFallbackEnabled
                ? params.accountFallbackDisabledSubtitle
                : undefined,
            icon: isActive ? 'radio-button-on-outline' : 'radio-button-off-outline',
            disabled: !canSetActive,
            onPress: canSetActive
                ? () => params.onSetActiveMember(params.member.profileId)
                : undefined,
        },
        {
            id: params.member.enabled
                ? `connected-services-group:${params.group.groupId}:member:${params.member.profileId}:action:disable`
                : `connected-services-group:${params.group.groupId}:member:${params.member.profileId}:action:enable`,
            title: params.member.enabled
                ? t('connectedServices.detail.groupActions.disableMember')
                : t('connectedServices.detail.groupActions.enableMember'),
            icon: params.member.enabled ? 'pause-circle-outline' : 'play-circle-outline',
            onPress: () => params.onSetMemberEnabled(!params.member.enabled),
        },
        {
            id: `connected-services-group:${params.group.groupId}:member:${params.member.profileId}:action:priority`,
            title: t('connectedServices.detail.groupActions.editPriority'),
            icon: 'reorder-three-outline',
            onPress: params.onEditMemberPriority,
        },
        {
            id: `connected-services-group:${params.group.groupId}:member:${params.member.profileId}:action:remove`,
            title: t('connectedServices.detail.groupActions.removeMember'),
            icon: 'remove-circle-outline',
            destructive: true,
            onPress: params.onRemoveMember,
        },
    ];
}

function StrategyCheckmark() {
    const { theme } = useUnistyles();
    return <Ionicons name="checkmark" size={18} color={theme.colors.accent.blue} />;
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

export const ConnectedServiceGroupDetailView = React.memo(function ConnectedServiceGroupDetailView() {
    const { theme } = useUnistyles();
    const params = useLocalSearchParams();
    const auth = useAuth();
    const profile = useProfile();
    const settings = useSettings();
    const connectedServicesEnabled = useFeatureEnabled('connectedServices');
    const accountGroupsEnabled = useFeatureEnabled('connectedServices.accountGroups');
    const accountFallbackEnabled = useFeatureEnabled('connectedServices.accountFallback');
    const [groups, setGroups] = React.useState<ReadonlyArray<ConnectedServiceAuthGroupV1>>([]);
    const [membersOpen, setMembersOpen] = React.useState(false);
    const [strategyOpen, setStrategyOpen] = React.useState(false);

    const rawServiceId = asStringParam((params as Record<string, unknown>).serviceId).trim();
    const parsedServiceId = ConnectedServiceIdSchema.safeParse(rawServiceId);
    const serviceId: ConnectedServiceId | null = parsedServiceId.success ? parsedServiceId.data : null;
    const rawGroupId = asStringParam((params as Record<string, unknown>).groupId).trim();
    const parsedGroupId = ConnectedServiceAuthGroupIdSchema.safeParse(rawGroupId);
    const groupId = parsedGroupId.success ? parsedGroupId.data : '';
    const credentials = auth.credentials ?? null;
    const serviceLabel = serviceId ? resolveConnectedServiceDisplayName(serviceId, t) : t('connectedServices.fallbackName');
    const svc = serviceId ? (profile.connectedServicesV2.find((candidate) => candidate.serviceId === serviceId) ?? null) : null;
    const profiles = (svc?.profiles ?? []) as ReadonlyArray<ConnectedServiceProfileLike>;
    const group = groups.find((candidate) => candidate.groupId === groupId) ?? null;
    const runtimeGroupFallbackSupported = serviceId
        ? isConnectedServiceRuntimeGroupFallbackSupported(serviceId)
        : false;
    const fallbackControlsEnabled = accountFallbackEnabled && runtimeGroupFallbackSupported;
    const fallbackDisabledSubtitle = !runtimeGroupFallbackSupported
        ? t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')
        : accountFallbackEnabled
            ? undefined
            : t('connectedServices.detail.groupActions.accountFallbackDisabled');

    const ensureCredentials = () => {
        if (!auth.credentials) throw new Error('Not authenticated');
        return auth.credentials;
    };

    const loadGroups = React.useCallback(async () => {
        if (!serviceId || !credentials || !connectedServicesEnabled || !accountGroupsEnabled) {
            setGroups([]);
            return [];
        }
        const result = await listConnectedServiceAuthGroupsV3(credentials, { serviceId });
        setGroups(result.groups);
        return result.groups;
    }, [accountGroupsEnabled, connectedServicesEnabled, credentials, serviceId]);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const nextGroups = await loadGroups();
                if (!cancelled) setGroups(nextGroups);
            } catch {
                if (!cancelled) setGroups([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [loadGroups]);

    const upsertGroup = React.useCallback((nextGroup: ConnectedServiceAuthGroupV1) => {
        setGroups((prev) => {
            const index = prev.findIndex((candidate) => candidate.groupId === nextGroup.groupId);
            if (index === -1) return [...prev, nextGroup];
            const next = [...prev];
            next[index] = nextGroup;
            return next;
        });
    }, []);

    const runGroupMutation = async (mutation: () => Promise<{ group: ConnectedServiceAuthGroupV1 }>) => {
        try {
            const result = await mutation();
            upsertGroup(result.group);
            await Promise.resolve(sync.refreshProfile()).catch(() => undefined);
            await loadGroups().catch(() => undefined);
        } catch (e: unknown) {
            await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
        }
    };

    const handleEditName = async () => {
        if (!serviceId || !group) return;
        const next = await Modal.prompt(
            t('connectedServices.detail.groupDetail.nameTitle'),
            t('connectedServices.detail.groupDetail.namePromptBody'),
            {
                placeholder: t('connectedServices.detail.groupDetail.nameTitle'),
                defaultValue: group.displayName ?? group.groupId,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next !== 'string') return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { displayName: next.trim() || null },
        }));
    };

    const handleSetAutoSwitch = async (autoSwitch: boolean) => {
        if (!serviceId || !group) return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { ...group.policy, autoSwitch }, expectedGeneration: group.generation },
        }));
    };

    const handleSetStrategy = async (strategy: string) => {
        if (!serviceId || !group) return;
        if (strategy !== 'priority' && strategy !== 'least_limited' && strategy !== 'manual') return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { ...group.policy, strategy }, expectedGeneration: group.generation },
        }));
    };

    const handleEditSoftSwitchRemainingPercent = async () => {
        if (!serviceId || !group) return;
        const current = resolveSoftSwitchRemainingPercent(group);
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptTitle'),
            t('connectedServices.detail.groupDetail.softSwitchThresholdPromptBody'),
            {
                placeholder: String(DEFAULT_GROUP_POLICY.softSwitchRemainingPercent),
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
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { ...group.policy, softSwitchRemainingPercent: value }, expectedGeneration: group.generation },
        }));
    };

    const handleEditProbeIfSnapshotOlderThan = async () => {
        if (!serviceId || !group) return;
        const currentMinutes = formatProbeMinutes(resolveProbeIfSnapshotOlderThanMs(group));
        const raw = await Modal.prompt(
            t('connectedServices.detail.groupDetail.staleProbePromptTitle'),
            t('connectedServices.detail.groupDetail.staleProbePromptBody'),
            {
                placeholder: formatProbeMinutes(DEFAULT_GROUP_POLICY.probeIfSnapshotOlderThanMs),
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
        await runGroupMutation(() => patchConnectedServiceAuthGroupV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            patch: { policy: { ...group.policy, probeIfSnapshotOlderThanMs: Math.round(minutes * PROBE_INTERVAL_MS_PER_MINUTE), }, expectedGeneration: group.generation },
        }));
    };

    const handleSetActiveMember = async (profileId: string) => {
        if (!serviceId || !group) return;
        const applyActiveMember = async (overrideRuntimeCooldown: boolean) => {
            const result = await setConnectedServiceAuthGroupActiveProfileV3(ensureCredentials(), {
                serviceId,
                groupId: group.groupId,
                profileId,
                expectedGeneration: group.generation,
                ...(overrideRuntimeCooldown ? { overrideRuntimeCooldown } : {}),
            });
            upsertGroup(result.group);
            await Promise.resolve(sync.refreshProfile()).catch(() => undefined);
            await loadGroups().catch(() => undefined);
        };

        try {
            await applyActiveMember(false);
        } catch (e: unknown) {
            if (!isConnectedServiceRuntimeCooldownError(e)) {
                await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(e));
                return;
            }
            const ok = await Modal.confirm(
                t('connectedServices.errors.runtimeCooldownOverrideTitle'),
                resolveConnectedServiceRuntimeCooldownOverrideBody(e),
                {
                    confirmText: t('connectedServices.errors.runtimeCooldownOverrideConfirm'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!ok) return;
            try {
                await applyActiveMember(true);
            } catch (retryError: unknown) {
                await Modal.alert(t('common.error'), resolveConnectedServiceSettingsErrorMessage(retryError));
            }
        }
    };

    const handleSetMemberEnabled = async (profileId: string, enabled: boolean) => {
        if (!serviceId || !group) return;
        await runGroupMutation(() => patchConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            patch: { enabled, expectedGeneration: group.generation },
        }));
    };

    const handleEditMemberPriority = async (member: GroupMember) => {
        if (!serviceId || !group) return;
        const next = await Modal.prompt(
            t('connectedServices.detail.groupActions.priorityTitle'),
            t('connectedServices.detail.groupActions.priorityBody'),
            {
                placeholder: String(member.priority),
                defaultValue: String(member.priority),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof next !== 'string') return;
        const priority = Number.parseInt(next.trim(), 10);
        if (!Number.isFinite(priority)) {
            await Modal.alert(
                t('connectedServices.detail.groupActions.invalidPriorityTitle'),
                t('connectedServices.detail.groupActions.invalidPriorityBody'),
            );
            return;
        }
        await runGroupMutation(() => patchConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId: member.profileId,
            patch: { priority, expectedGeneration: group.generation },
        }));
    };

    const handleToggleMember = async (profileId: string) => {
        if (!serviceId || !group) return;
        const existing = group.members.some((member) => member.profileId === profileId);
        if (existing) {
            const ok = await Modal.confirm(
                t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
                t('connectedServices.detail.groupActions.removeMemberConfirmBody', { profileId }),
                { confirmText: t('common.remove'), cancelText: t('common.cancel') },
            );
            if (!ok) return;
            await runGroupMutation(() => removeConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
                serviceId,
                groupId: group.groupId,
                profileId,
                expectedGeneration: group.generation,
            }));
            return;
        }
        await runGroupMutation(() => addConnectedServiceAuthGroupMemberV3(ensureCredentials(), {
            serviceId,
            groupId: group.groupId,
            profileId,
            priority: 100,
            enabled: true,
            expectedGeneration: group.generation,
        }));
    };

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
    const memberItems = profiles.flatMap((candidate): DropdownMenuItem[] => {
        const profileId = typeof candidate.profileId === 'string' ? candidate.profileId.trim() : '';
        if (!profileId) return [];
        const isMember = group.members.some((member) => member.profileId === profileId);
        return [{
            id: profileId,
            title: resolveProfileTitle({ serviceId, profileId, labelsByKey: settings.connectedServicesProfileLabelByKey }),
            subtitle: candidate.providerEmail ?? profileId,
            rightElement: isMember ? <Ionicons name="checkmark" size={18} color={theme.colors.accent.blue} /> : null,
        }];
    });
    const enabledCount = group.members.filter((member) => member.enabled).length;
    const softSwitchRemainingPercent = resolveSoftSwitchRemainingPercent(group);
    const staleProbeMinutes = formatProbeMinutes(resolveProbeIfSnapshotOlderThanMs(group));

    return (
        <ItemList>
            <ItemGroup title={`${serviceLabel} • ${label}`}>
                <Item
                    testID="connected-services-group-detail:name"
                    title={t('connectedServices.detail.groupDetail.nameTitle')}
                    subtitle={label}
                    icon={<Ionicons name="pencil-outline" size={22} color={theme.colors.accent.blue} />}
                    onPress={() => void handleEditName()}
                />
                <Item title={t('connectedServices.detail.groupDetail.groupIdTitle')} subtitle={group.groupId} showChevron={false} />
                <DropdownMenu
                    open={membersOpen}
                    onOpenChange={setMembersOpen}
                    items={memberItems}
                    closeOnSelect={false}
                    selectedId={group.activeProfileId}
                    search
                    searchPlaceholder={t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
                    emptyLabel={t('connectedServices.detail.groupActions.noProfilesAvailable')}
                    onSelect={(profileId) => void handleToggleMember(profileId)}
                    itemTrigger={{
                        title: t('connectedServices.detail.groupDetail.membersTitle'),
                        subtitle: t('connectedServices.detail.groupDetail.membersSubtitle', { enabled: enabledCount, total: group.members.length }),
                        icon: <Ionicons name="people-outline" size={22} color={theme.colors.accent.blue} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'connected-services-group-detail:members', disabled: memberItems.length === 0 },
                    }}
                    rowKind="item"
                    variant="selectable"
                />
            </ItemGroup>

            {group.members.length > 0 ? (
                <ItemGroup title={t('connectedServices.detail.groupActions.membersTitle')}>
                    {group.members
                        .slice()
                        .sort((a, b) => {
                            if (a.priority !== b.priority) return a.priority - b.priority;
                            return a.profileId.localeCompare(b.profileId);
                        })
                        .map((member) => (
                            <Item
                                key={member.profileId}
                                testID={`connected-services-group-detail:member:${member.profileId}`}
                                title={resolveProfileTitle({
                                    serviceId,
                                    profileId: member.profileId,
                                    labelsByKey: settings.connectedServicesProfileLabelByKey,
                                })}
                                subtitle={formatConnectedServiceGroupMemberSubtitle(member, group)}
                                icon={(
                                    <Ionicons
                                        name={member.profileId === group.activeProfileId ? 'radio-button-on-outline' : 'person-circle-outline'}
                                        size={22}
                                        color={member.enabled ? theme.colors.button.secondary.tint : theme.colors.text.tertiary}
                                    />
                                )}
                                rightElement={(
                                    <ItemRowActions
                                        title={member.profileId}
                                        compactActionIds={[`connected-services-group:${group.groupId}:member:${member.profileId}:action:set-active`]}
                                        iconSize={18}
                                        overflowTriggerTestID={`connected-services-group-detail:member:${member.profileId}:actions`}
                                        actions={buildMemberActions({
                                            group,
                                            member,
                                            accountFallbackEnabled: fallbackControlsEnabled,
                                            accountFallbackDisabledSubtitle: fallbackDisabledSubtitle,
                                            onSetActiveMember: (profileId) => void handleSetActiveMember(profileId),
                                            onSetMemberEnabled: (enabled) => void handleSetMemberEnabled(member.profileId, enabled),
                                            onEditMemberPriority: () => void handleEditMemberPriority(member),
                                            onRemoveMember: () => void handleToggleMember(member.profileId),
                                        })}
                                    />
                                )}
                                showChevron={false}
                            />
                        ))}
                </ItemGroup>
            ) : null}

            <ItemGroup title={t('connectedServices.detail.groupDetail.optionsTitle')}>
                <Item
                    testID="connected-services-group-detail:auto-switch"
                    title={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                    subtitle={!runtimeGroupFallbackSupported
                        ? t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')
                        : group.policy.autoSwitch
                            ? t('connectedServices.detail.groupDetail.autoSwitchEnabledSubtitle')
                            : t('connectedServices.detail.groupDetail.autoSwitchDisabledSubtitle')}
                    icon={<Ionicons name="swap-horizontal-outline" size={22} color={theme.colors.accent.blue} />}
                    disabled={!runtimeGroupFallbackSupported}
                    onPress={runtimeGroupFallbackSupported ? () => void handleSetAutoSwitch(!group.policy.autoSwitch) : undefined}
                />
                <DropdownMenu
                    open={strategyOpen}
                    onOpenChange={setStrategyOpen}
                    items={buildStrategyItems(group.policy.strategy)}
                    selectedId={group.policy.strategy}
                    onSelect={(strategy) => void handleSetStrategy(strategy)}
                    itemTrigger={{
                        title: t('connectedServices.detail.groupDetail.strategyTitle'),
                        subtitle: resolveStrategyTitle(group.policy.strategy),
                        icon: <Ionicons name="options-outline" size={22} color={theme.colors.accent.blue} />,
                        showSelectedDetail: false,
                        showSelectedSubtitle: false,
                        itemProps: { testID: 'connected-services-group-detail:strategy' },
                    }}
                    rowKind="item"
                    variant="selectable"
                />
                <Item
                    testID="connected-services-group-detail:soft-switch-threshold"
                    title={t('connectedServices.detail.groupDetail.softSwitchThresholdTitle')}
                    subtitle={t('connectedServices.detail.groupDetail.softSwitchThresholdSubtitle', { percent: String(softSwitchRemainingPercent) })}
                    icon={<Ionicons name="speedometer-outline" size={22} color={theme.colors.accent.indigo} />}
                    onPress={() => void handleEditSoftSwitchRemainingPercent()}
                />
                <Item
                    testID="connected-services-group-detail:stale-probe-after"
                    title={t('connectedServices.detail.groupDetail.staleProbeTitle')}
                    subtitle={t('connectedServices.detail.groupDetail.staleProbeSubtitle', { minutes: staleProbeMinutes })}
                    icon={<Ionicons name="refresh-circle-outline" size={22} color={theme.colors.accent.indigo} />}
                    onPress={() => void handleEditProbeIfSnapshotOlderThan()}
                />
                <Item
                    title={t('connectedServices.detail.groupDetail.recoveryPromptTitle')}
                    subtitle={t('connectedServices.detail.groupDetail.recoveryPromptSubtitle')}
                    icon={<Ionicons name="chatbubble-ellipses-outline" size={22} color={theme.colors.text.secondary} />}
                    showChevron={false}
                />
            </ItemGroup>
        </ItemList>
    );
});
