import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type { ConnectedServiceAuthGroupV1, ConnectedServiceId, ConnectedServiceQuotaSnapshotV1 } from '@happier-dev/protocol';

import type { ItemAction } from '@/components/ui/lists/itemActions';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Text } from '@/components/ui/text/Text';
import { connectedServiceProfileKey, resolveConnectedServiceProfileLabel } from '@/sync/domains/connectedServices/connectedServiceProfilePreferences';
import { computeConnectedServiceQuotaSummaryBadges } from '@/sync/domains/connectedServices/connectedServiceQuotaBadges';
import { t } from '@/text';

import { ConnectedServiceQuotaBadgesView } from '../ConnectedServiceQuotaBadgesView';
import { formatConnectedServiceGroupMemberSubtitle } from '../model/connectedServiceGroupMemberSubtitle';

type ConnectedServiceGroupProfileLike = Readonly<{
    profileId?: string;
    providerEmail?: string | null;
}>;

type ConnectedServiceGroupMember = ConnectedServiceAuthGroupV1['members'][number];

function readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function readGroupState(group: ConnectedServiceAuthGroupV1): Readonly<{
    status: string;
    cooldownUntilMs: number | null;
}> {
    const rawState = group.state && typeof group.state === 'object' && !Array.isArray(group.state)
        ? group.state as Record<string, unknown>
        : {};
    return {
        status: typeof rawState.status === 'string' ? rawState.status.trim() : '',
        cooldownUntilMs: typeof rawState.cooldownUntilMs === 'number' && Number.isFinite(rawState.cooldownUntilMs)
            ? rawState.cooldownUntilMs
            : null,
    };
}

function resolveGroupStatusLabel(group: ConnectedServiceAuthGroupV1, enabledMemberCount: number): string {
    if (enabledMemberCount <= 0) return t('connectedServices.detail.groups.statusNeedsMembers');
    const { status } = readGroupState(group);
    if (status === 'exhausted') return t('connectedServices.detail.groups.statusExhausted');
    if (status === 'switching') return t('connectedServices.detail.groups.statusSwitching');
    if (status === 'error') return t('connectedServices.detail.groups.statusError');
    if (status === 'unknown') return t('connectedServices.detail.groups.statusUnknown');
    if (status === 'ready' || !status) return t('connectedServices.detail.groups.statusReady');
    return t('connectedServices.detail.groups.statusUnknown');
}

function formatGroupSubtitle(group: ConnectedServiceAuthGroupV1): string {
    const activeProfileId = group.activeProfileId?.trim();
    const enabledMemberCount = group.members.filter((member) => member.enabled).length;
    const prioritySummary = [...group.members]
        .sort((a, b) => {
            if (a.priority !== b.priority) return a.priority - b.priority;
            return a.profileId.localeCompare(b.profileId);
        })
        .map((member) => `${member.profileId}:${member.priority}`)
        .join(', ');
    const baseSubtitle = activeProfileId
        ? t('connectedServices.detail.groups.activeMember', { profileId: activeProfileId })
        : t('connectedServices.detail.groups.subtitle', { count: enabledMemberCount });
    const { cooldownUntilMs } = readGroupState(group);
    const strategy = group.policy.strategy;
    const parts = [
        baseSubtitle,
        t('connectedServices.detail.groups.enabledMembers', { enabled: enabledMemberCount, total: group.members.length }),
        group.policy.autoSwitch
            ? t('connectedServices.detail.groups.autoFallbackEnabled')
            : t('connectedServices.detail.groups.autoFallbackDisabled'),
        strategy === 'manual'
            ? t('connectedServices.detail.groups.strategyManual')
            : strategy === 'least_limited'
                ? t('connectedServices.detail.groups.strategyLeastLimited')
                : t('connectedServices.detail.groups.strategyPriority'),
        prioritySummary ? t('connectedServices.detail.groups.priority', { priority: prioritySummary }) : null,
        resolveGroupStatusLabel(group, enabledMemberCount),
        cooldownUntilMs === null
            ? null
            : t('connectedServices.detail.groups.cooldown', {
                time: new Date(cooldownUntilMs).toLocaleString(),
            }),
    ];
    return parts.filter(Boolean).join(' • ');
}

function resolveMissingEligibleWarning(group: ConnectedServiceAuthGroupV1): string | null {
    const enabledMembers = group.members.filter((member) => member.enabled);
    if (enabledMembers.length === 0) return t('connectedServices.detail.groups.warningNoEnabledMembers');
    if (!group.policy.autoSwitch) return null;
    if (enabledMembers.length === 1) return t('connectedServices.detail.groups.warningNoFallbackMember');
    return null;
}

function buildGroupActions(params: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    accountFallbackEnabled: boolean;
    accountFallbackDisabledSubtitle?: string;
    onEditGroup: (group: ConnectedServiceAuthGroupV1) => void;
    onSetGroupAutoSwitch: (group: ConnectedServiceAuthGroupV1, autoSwitch: boolean) => void;
    onSetGroupStrategy: (group: ConnectedServiceAuthGroupV1, strategy: 'priority' | 'manual') => void;
    onDeleteGroup: (group: ConnectedServiceAuthGroupV1) => void;
}>): ItemAction[] {
    const group = params.group;
    return [
        {
            id: `connected-services-group:${group.groupId}:action:edit`,
            inlineTestID: `connected-services-group:${group.groupId}:action:edit`,
            title: t('connectedServices.detail.groupActions.editTitle'),
            icon: 'pencil-outline',
            onPress: () => params.onEditGroup(group),
        },
        {
            id: group.policy.autoSwitch
                ? `connected-services-group:${group.groupId}:action:disable-fallback`
                : `connected-services-group:${group.groupId}:action:enable-fallback`,
            title: group.policy.autoSwitch
                ? t('connectedServices.detail.groupActions.disableFallback')
                : t('connectedServices.detail.groupActions.enableFallback'),
            subtitle: params.accountFallbackEnabled
                ? undefined
                : params.accountFallbackDisabledSubtitle,
            icon: group.policy.autoSwitch ? 'pause-circle-outline' : 'swap-horizontal-outline',
            disabled: !params.accountFallbackEnabled,
            onPress: () => params.onSetGroupAutoSwitch(group, !group.policy.autoSwitch),
        },
        {
            id: group.policy.strategy === 'manual'
                ? `connected-services-group:${group.groupId}:action:priority-strategy`
                : `connected-services-group:${group.groupId}:action:manual-strategy`,
            title: group.policy.strategy === 'manual'
                ? t('connectedServices.detail.groupActions.usePriorityStrategy')
                : t('connectedServices.detail.groupActions.useManualStrategy'),
            icon: group.policy.strategy === 'manual' ? 'list-outline' : 'hand-left-outline',
            onPress: () => params.onSetGroupStrategy(group, group.policy.strategy === 'manual' ? 'priority' : 'manual'),
        },
        {
            id: `connected-services-group:${group.groupId}:action:delete`,
            title: t('common.delete'),
            icon: 'trash-outline',
            destructive: true,
            onPress: () => params.onDeleteGroup(group),
        },
    ];
}

function buildMemberActions(params: Readonly<{
    group: ConnectedServiceAuthGroupV1;
    member: ConnectedServiceGroupMember;
    accountFallbackEnabled: boolean;
    accountFallbackDisabledSubtitle?: string;
    onSetActiveMember: (group: ConnectedServiceAuthGroupV1, profileId: string) => void;
    onSetMemberEnabled: (group: ConnectedServiceAuthGroupV1, member: ConnectedServiceGroupMember, enabled: boolean) => void;
    onEditMemberPriority: (group: ConnectedServiceAuthGroupV1, member: ConnectedServiceGroupMember) => void;
    onRemoveMember: (group: ConnectedServiceAuthGroupV1, member: ConnectedServiceGroupMember) => void;
}>): ItemAction[] {
    const { group, member } = params;
    const isActive = member.profileId === group.activeProfileId;
    return [
        {
            id: `connected-services-group:${group.groupId}:member:${member.profileId}:action:set-active`,
            title: isActive
                ? t('connectedServices.detail.groupActions.activeMember')
                : t('connectedServices.detail.groupActions.makeActive'),
            subtitle: !isActive && !params.accountFallbackEnabled
                ? params.accountFallbackDisabledSubtitle
                : undefined,
            icon: isActive ? 'radio-button-on-outline' : 'radio-button-off-outline',
            disabled: isActive || !params.accountFallbackEnabled,
            onPress: () => params.onSetActiveMember(group, member.profileId),
        },
        {
            id: member.enabled
                ? `connected-services-group:${group.groupId}:member:${member.profileId}:action:disable`
                : `connected-services-group:${group.groupId}:member:${member.profileId}:action:enable`,
            title: member.enabled
                ? t('connectedServices.detail.groupActions.disableMember')
                : t('connectedServices.detail.groupActions.enableMember'),
            icon: member.enabled ? 'pause-circle-outline' : 'play-circle-outline',
            onPress: () => params.onSetMemberEnabled(group, member, !member.enabled),
        },
        {
            id: `connected-services-group:${group.groupId}:member:${member.profileId}:action:priority`,
            title: t('connectedServices.detail.groupActions.editPriority'),
            icon: 'reorder-three-outline',
            onPress: () => params.onEditMemberPriority(group, member),
        },
        {
            id: `connected-services-group:${group.groupId}:member:${member.profileId}:action:remove`,
            title: t('connectedServices.detail.groupActions.removeMember'),
            icon: 'remove-circle-outline',
            destructive: true,
            onPress: () => params.onRemoveMember(group, member),
        },
    ];
}

export const ConnectedServiceDetailGroupsGroup = React.memo(function ConnectedServiceDetailGroupsGroup(props: Readonly<{
    serviceId: ConnectedServiceId;
    groups: ReadonlyArray<ConnectedServiceAuthGroupV1>;
    profiles: ReadonlyArray<ConnectedServiceGroupProfileLike>;
    profileLabelsByKey: Readonly<Record<string, string>>;
    pinnedMeterIdsByKey: Readonly<Record<string, ReadonlyArray<string>>>;
    quotaSummaryStrategyByKey: Readonly<Record<string, 'primary' | 'min_remaining' | undefined>>;
    quotaSnapshotsByKey: Readonly<Record<string, ConnectedServiceQuotaSnapshotV1 | null>>;
    quotasEnabled: boolean;
    accountFallbackEnabled: boolean;
    groupConfigurationSupported: boolean;
    runtimeGroupFallbackSupported: boolean;
    onCreateGroup: () => void;
    onOpenGroup: (groupId: string) => void;
    onDeleteGroup: (groupId: string) => void;
    onAddMember: (groupId: string, profileId: string) => void;
    onRemoveMember: (groupId: string, profileId: string) => void;
    onSetGroupAutoSwitch: (groupId: string, autoSwitch: boolean) => void;
    onSetGroupStrategy: (groupId: string, strategy: 'priority' | 'manual') => void;
    onSetActiveProfile: (groupId: string, profileId: string, expectedGeneration: number) => void;
    onSetMemberEnabled: (groupId: string, profileId: string, enabled: boolean) => void;
    onEditMemberPriority: (groupId: string, profileId: string, currentPriority: number) => void;
}>) {
    const { theme } = useUnistyles();
    const [openMembersGroupId, setOpenMembersGroupId] = React.useState<string | null>(null);
    const fallbackControlsEnabled = props.accountFallbackEnabled && props.runtimeGroupFallbackSupported;
    const fallbackDisabledSubtitle = !props.runtimeGroupFallbackSupported
        ? t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')
        : props.accountFallbackEnabled
            ? undefined
            : t('connectedServices.detail.groupActions.accountFallbackDisabled');

    return (
        <>
            <ItemGroup title={t('connectedServices.detail.groups.title')}>
                {props.groups.length === 0 ? (
                    <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
                        <Text style={{ color: theme.colors.text.secondary }}>{t('connectedServices.detail.groups.empty')}</Text>
                    </View>
                ) : null}
                {props.groups.map((group) => {
                    const title = group.displayName?.trim() || group.groupId;
                    const enabledMemberCount = group.members.filter((member) => member.enabled).length;
                    const warning = resolveMissingEligibleWarning(group);
                    const iconName = enabledMemberCount > 0 && readGroupState(group).status !== 'exhausted'
                        ? 'git-network-outline'
                        : 'warning-outline';
                    const iconColor = iconName === 'git-network-outline'
                        ? theme.colors.state.success.foreground
                        : theme.colors.accent.orange;
                    const memberIds = new Set(group.members.map((member) => member.profileId));
                    const memberItems = props.profiles.flatMap((profile): DropdownMenuItem[] => {
                        const profileId = typeof profile.profileId === 'string' ? profile.profileId.trim() : '';
                        if (!profileId) return [];
                        const label = resolveProfileTitle({
                            serviceId: props.serviceId,
                            profileId,
                            labelsByKey: props.profileLabelsByKey,
                        });
                        return [{
                            id: profileId,
                            testID: `connected-services-group:${group.groupId}:member-option:${profileId}`,
                            title: label,
                            subtitle: profile.providerEmail?.trim() || profileId,
                            rightElement: memberIds.has(profileId)
                                ? <Ionicons name="checkmark" size={18} color={theme.colors.accent.blue} />
                                : null,
                        }];
                    });

                    return (
                        <React.Fragment key={group.groupId}>
                            <Item
                                testID={`connected-services-auth-group:${group.groupId}`}
                                title={title}
                                subtitle={formatGroupSubtitle(group)}
                                icon={<Ionicons name={iconName} size={22} color={iconColor} />}
                                rightElement={(
                                    <ItemRowActions
                                        title={title}
                                        compactActionIds={[`connected-services-group:${group.groupId}:action:edit`]}
                                        iconSize={18}
                                        overflowTriggerTestID={`connected-services-group:${group.groupId}:actions`}
                                        actions={buildGroupActions({
                                            group,
                                            accountFallbackEnabled: fallbackControlsEnabled,
                                            accountFallbackDisabledSubtitle: fallbackDisabledSubtitle,
                                            onEditGroup: (target) => props.onOpenGroup(target.groupId),
                                            onSetGroupAutoSwitch: (target, autoSwitch) => props.onSetGroupAutoSwitch(target.groupId, autoSwitch),
                                            onSetGroupStrategy: (target, strategy) => props.onSetGroupStrategy(target.groupId, strategy),
                                            onDeleteGroup: (target) => props.onDeleteGroup(target.groupId),
                                        })}
                                    />
                                )}
                                showChevron={false}
                            />
                            {warning ? (
                                <Item
                                    testID={`connected-services-group:${group.groupId}:warning`}
                                    title={warning}
                                    icon={<Ionicons name="warning-outline" size={22} color={theme.colors.accent.orange} />}
                                    mode="info"
                                    showChevron={false}
                                />
                            ) : null}
                            {group.members
                                .slice()
                                .sort((a, b) => {
                                    if (a.priority !== b.priority) return a.priority - b.priority;
                                    return a.profileId.localeCompare(b.profileId);
                                })
                                .map((member) => {
                                    const quotaKey = connectedServiceProfileKey({ serviceId: props.serviceId, profileId: member.profileId });
                                    const rawStrategy = props.quotaSummaryStrategyByKey[quotaKey];
                                    const badges = props.quotasEnabled
                                        ? computeConnectedServiceQuotaSummaryBadges({
                                            snapshot: props.quotaSnapshotsByKey[quotaKey] ?? null,
                                            pinnedMeterIds: props.pinnedMeterIdsByKey[quotaKey] ?? [],
                                            strategy: rawStrategy === 'min_remaining' ? 'min_remaining' : 'primary',
                                        })
                                        : [];
                                    return (
                                        <Item
                                            key={`${group.groupId}:member:${member.profileId}`}
                                            testID={`connected-services-group:${group.groupId}:member:${member.profileId}`}
                                            title={resolveProfileTitle({
                                                serviceId: props.serviceId,
                                                profileId: member.profileId,
                                                labelsByKey: props.profileLabelsByKey,
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
                                                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                                                    {props.quotasEnabled ? <ConnectedServiceQuotaBadgesView badges={badges} /> : null}
                                                    <ItemRowActions
                                                        title={member.profileId}
                                                        compactActionIds={[`connected-services-group:${group.groupId}:member:${member.profileId}:action:set-active`]}
                                                        iconSize={18}
                                                        overflowTriggerTestID={`connected-services-group:${group.groupId}:member:${member.profileId}:actions`}
                                                        actions={buildMemberActions({
                                                            group,
                                                            member,
                                                            accountFallbackEnabled: fallbackControlsEnabled,
                                                            accountFallbackDisabledSubtitle: fallbackDisabledSubtitle,
                                                            onSetActiveMember: (target, profileId) => props.onSetActiveProfile(target.groupId, profileId, target.generation),
                                                            onSetMemberEnabled: (target, targetMember, enabled) => props.onSetMemberEnabled(target.groupId, targetMember.profileId, enabled),
                                                            onEditMemberPriority: (target, targetMember) => props.onEditMemberPriority(target.groupId, targetMember.profileId, targetMember.priority),
                                                            onRemoveMember: (target, targetMember) => props.onRemoveMember(target.groupId, targetMember.profileId),
                                                        })}
                                                    />
                                                </View>
                                            )}
                                            showChevron={false}
                                        />
                                    );
                                })}
                            <DropdownMenu
                                open={openMembersGroupId === group.groupId}
                                onOpenChange={(open) => setOpenMembersGroupId(open ? group.groupId : null)}
                                items={memberItems}
                                closeOnSelect={false}
                                selectedId={group.activeProfileId || null}
                                search
                                searchPlaceholder={t('connectedServices.detail.groupActions.searchMembersPlaceholder')}
                                emptyLabel={t('connectedServices.detail.groupActions.noProfilesAvailable')}
                                onSelect={(profileId) => {
                                    if (memberIds.has(profileId)) {
                                        props.onRemoveMember(group.groupId, profileId);
                                        return;
                                    }
                                    props.onAddMember(group.groupId, profileId);
                                }}
                                itemTrigger={{
                                    title: t('connectedServices.detail.groupActions.membersTitle'),
                                    subtitle: t('connectedServices.detail.groupActions.membersSubtitle'),
                                    icon: <Ionicons name="people-outline" size={22} color={theme.colors.accent.blue} />,
                                    showSelectedDetail: false,
                                    showSelectedSubtitle: false,
                                    itemProps: {
                                        testID: `connected-services-auth-group:${group.groupId}:members`,
                                        disabled: memberItems.length === 0,
                                    },
                                }}
                                rowKind="item"
                                variant="selectable"
                            />
                        </React.Fragment>
                    );
                })}
            </ItemGroup>
            <ItemGroup title={t('connectedServices.detail.groups.actionsTitle')}>
                <Item
                    testID="connected-services-action:create-group"
                    title={t('connectedServices.detail.groups.createTitle')}
                    subtitle={props.groupConfigurationSupported
                        ? t('connectedServices.detail.groups.createSubtitle')
                        : t('connectedServices.detail.groupActions.runtimeFallbackUnsupported')}
                    icon={<Ionicons name="add-circle-outline" size={22} color={theme.colors.accent.blue} />}
                    disabled={!props.groupConfigurationSupported}
                    onPress={props.groupConfigurationSupported ? props.onCreateGroup : undefined}
                />
            </ItemGroup>
        </>
    );
});
