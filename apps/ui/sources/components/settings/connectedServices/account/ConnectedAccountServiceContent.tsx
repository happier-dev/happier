import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useUnistyles } from 'react-native-unistyles';

import type {
    ConnectedServiceId,
    PluginConnectedAccountAuthenticationModeV2,
    QualifiedConnectedAccountProfileV4,
    QualifiedConnectedAccountRef,
} from '@happier-dev/protocol';

import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import {
    ConnectedServiceSegmentedShell,
    type ConnectedServiceDetailSegment,
} from '@/components/settings/connectedServices/detail/ConnectedServiceSegmentedShell';
import { useConnectedServiceQuotaSnapshot } from '@/hooks/server/connectedServices/useConnectedServiceQuotaSnapshot';
import { useQualifiedConnectedAccountQuota } from '@/hooks/server/connectedServices/useQualifiedConnectedAccountQuota';
import type {
    UseQualifiedConnectedAccountGroupsResult,
} from '@/hooks/server/connectedServices/useQualifiedConnectedAccountGroups';
import { Modal } from '@/modal';
import { deriveConnectedServiceAuthGroupIdFromName } from '@/sync/domains/connectedServices/deriveConnectedServiceAuthGroupIdFromName';
import type {
    ConnectedAccountSettingsRouteFocus,
} from '@/sync/domains/connectedServices/connectedAccountSettingsRoute';
import { t } from '@/text';
import {
    isConnectedServiceRuntimeCooldownError,
    resolveConnectedServiceRuntimeCooldownOverrideBody,
} from '../connectedServiceSettingsErrors';
import {
    isQualifiedConnectedAccountLegacyOperationSupported,
} from '@/sync/domains/connectedServices/qualifiedConnectedAccountUiSource';

export type ConnectedAccountServiceProfile =
    Omit<QualifiedConnectedAccountProfileV4, 'credentialRevision'>
    & Readonly<{ credentialRevision?: string | null }>;

type ServiceConfigurationStatusByModeId = Readonly<
    Record<
        string,
        'ready' | 'configurationRequired' | undefined
    >
>;

function isServiceConfigurationBlocked(
    statusByModeId: ServiceConfigurationStatusByModeId | undefined,
    modeId: string,
): boolean {
    return statusByModeId?.[modeId] !== 'ready';
}

function localizedText(
    value: string | Readonly<{ fallback: string }> | undefined,
): string {
    return typeof value === 'string' ? value : value?.fallback ?? '';
}

function accountStatusLabel(
    status: QualifiedConnectedAccountProfileV4['status'],
): string {
    switch (status) {
        case 'connected':
            return t('connectedServices.detail.profiles.connected');
        case 'refreshing':
            return t('connectedServices.detail.profiles.refreshing');
        case 'needs_reauth':
            return t('connectedServices.detail.profiles.needsReauth');
        case 'refresh_failed_retryable':
            return t('connectedServices.detail.profiles.refreshFailedRetryable');
    }
}

function quotaSubtitle(snapshot: Readonly<{
    planLabel: string | null;
    meters: readonly Readonly<{
        remainingPct?: number | null;
        usedPct?: number | null;
    }>[];
}>): string {
    const percentages = snapshot.meters
        .map((meter) => meter.remainingPct
            ?? (meter.usedPct === null || meter.usedPct === undefined
                ? null
                : 100 - meter.usedPct))
        .filter((value): value is number => value !== null);
    const remaining = percentages.length > 0
        ? Math.min(...percentages)
        : null;
    return [
        snapshot.planLabel,
        remaining === null ? null : `${Math.round(remaining)}%`,
    ].filter((value): value is string => Boolean(value)).join(' · ');
}

const QualifiedQuotaRow = React.memo(function QualifiedQuotaRow(props: Readonly<{
    account: QualifiedConnectedAccountRef;
}>) {
    const quota = useQualifiedConnectedAccountQuota(props.account);
    if (quota.supported === false) return null;
    if (
        quota.supported === null
        && !quota.loading
        && !quota.error
    ) {
        return null;
    }
    return (
        <Item
            testID={`qualified-connected-account-quota:${props.account.accountId}`}
            title={t('connectedServices.account.usageCaption')}
            subtitle={quota.snapshot
                ? quotaSubtitle(quota.snapshot)
                : quota.error ?? t('connectedServices.deviceAuth.preparing')}
            icon={<Ionicons name="speedometer-outline" size={22} />}
            disabled={quota.refreshing}
            onPress={quota.supported === true ? () => {
                void quota.refresh();
            } : undefined}
            showChevron={quota.supported === true}
        />
    );
});

const LegacyQuotaRow = React.memo(function LegacyQuotaRow(props: Readonly<{
    serviceId: ConnectedServiceId;
    accountId: string;
    credentialHealthStatus: unknown;
}>) {
    const quota = useConnectedServiceQuotaSnapshot({
        serviceId: props.serviceId,
        profileId: props.accountId,
        credentialHealthStatus: props.credentialHealthStatus,
    });
    if (!quota.loading && !quota.snapshot && !quota.error) return null;
    return (
        <Item
            testID={`qualified-connected-account-quota:${props.accountId}`}
            title={t('connectedServices.account.usageCaption')}
            subtitle={quota.snapshot
                ? quotaSubtitle(quota.snapshot)
                : quota.error ?? t('connectedServices.deviceAuth.preparing')}
            icon={<Ionicons name="speedometer-outline" size={22} />}
            disabled={quota.isRefreshing}
            onPress={quota.canRefresh ? () => {
                void quota.refresh();
            } : undefined}
            showChevron={quota.canRefresh}
        />
    );
});

function groupStrategyTitle(
    strategy: 'priority' | 'least_limited' | 'manual',
): string {
    switch (strategy) {
        case 'priority':
            return t('connectedServices.detail.groupDetail.strategyPriorityTitle');
        case 'least_limited':
            return t('connectedServices.detail.groupDetail.strategyLeastLimitedTitle');
        case 'manual':
            return t('connectedServices.detail.groupDetail.strategyManualTitle');
    }
}

function parsePromptNumber(raw: string): number | null {
    const value = Number(raw.trim().replace(/%$/, ''));
    return Number.isFinite(value) ? value : null;
}

const EMPTY_GROUPS: UseQualifiedConnectedAccountGroupsResult = {
    status: 'unsupported',
    source: null,
    groups: [],
    error: null,
    mutating: false,
    refresh: async () => {},
    create: async () => null,
    patch: async () => null,
    delete: async () => false,
    addMember: async () => null,
    patchMember: async () => null,
    removeMember: async () => null,
    setActiveAccount: async () => null,
};

export const ConnectedAccountServiceContent = React.memo(function ConnectedAccountServiceContent(props: Readonly<{
    title: string;
    service: QualifiedConnectedAccountRef['service'];
    legacyServiceId?: ConnectedServiceId | null;
    focus?: ConnectedAccountSettingsRouteFocus | null;
    modes: readonly PluginConnectedAccountAuthenticationModeV2[];
    accounts: readonly ConnectedAccountServiceProfile[];
    serviceConfigurationStatusByModeId?: ServiceConfigurationStatusByModeId;
    accountLabels?: Readonly<Record<string, string | undefined>>;
    defaultAccountId?: string | null;
    groups?: UseQualifiedConnectedAccountGroupsResult;
    busy: boolean;
    onEditLabel?(account: QualifiedConnectedAccountRef): void;
    onToggleDefault?(account: QualifiedConnectedAccountRef): void;
    onConfigureAccount?(account: QualifiedConnectedAccountRef): void;
    onConfigureService?(modeId: string): void;
    onBeginConnect?(input: Readonly<{
        service: QualifiedConnectedAccountRef['service'];
        modeId: string;
    }>): void;
    canReconnectAccount?(account: ConnectedAccountServiceProfile): boolean;
    onBeginReconnect?(account: QualifiedConnectedAccountRef): void;
    onRevoke?(account: QualifiedConnectedAccountRef): void;
}>) {
    const { theme } = useUnistyles();
    const groups = props.groups ?? EMPTY_GROUPS;
    const accountLabels = props.accountLabels ?? {};
    const accounts = React.useMemo(
        () => props.accounts.filter((account) => (
            account.ref.service.pluginId === props.service.pluginId
            && account.ref.service.localId === props.service.localId
        )),
        [
            props.accounts,
            props.service.localId,
            props.service.pluginId,
        ],
    );
    const [activeSegment, setActiveSegment] =
        React.useState<ConnectedServiceDetailSegment>(
            props.focus?.kind === 'group' ? 'pools' : 'accounts',
        );
    const [selectedGroupId, setSelectedGroupId] = React.useState<string | null>(
        props.focus?.kind === 'group' ? props.focus.groupId : null,
    );
    const selectedGroup = groups.groups.find(
        (group) => group.ref.groupId === selectedGroupId,
    ) ?? null;
    const poolsAvailable = groups.source !== null;
    const legacyQuotaSupported = groups.source?.protocol === 'legacy-v3'
        && props.legacyServiceId
        ? isQualifiedConnectedAccountLegacyOperationSupported({
            service: props.service,
            legacyServiceId: props.legacyServiceId,
            peerClass: 'revisioned-v2-v3',
            operation: 'quota_read',
        })
        : false;

    React.useEffect(() => {
        if (props.focus?.kind === 'group') {
            setActiveSegment('pools');
            setSelectedGroupId(props.focus.groupId);
            return;
        }
        setActiveSegment('accounts');
        setSelectedGroupId(null);
    }, [props.focus]);

    const createGroup = React.useCallback(async () => {
        const displayNameResult = await Modal.prompt(
            t('connectedServices.detail.groupActions.createTitle'),
            t('connectedServices.detail.groupActions.createSubtitle'),
            {
                placeholder: t('connectedServices.detail.groupActions.displayNamePlaceholder'),
                confirmText: t('common.create'),
                cancelText: t('common.cancel'),
            },
        );
        const displayName = typeof displayNameResult === 'string'
            ? displayNameResult.trim()
            : '';
        if (!displayName) return;
        const groupId = deriveConnectedServiceAuthGroupIdFromName({
            name: displayName,
            existingGroupIds: groups.groups.map(
                (group) => group.ref.groupId,
            ),
        });
        if (!groupId) {
            await Modal.alert(
                t('connectedServices.detail.groupActions.invalidGroupIdTitle'),
                t('connectedServices.detail.groupActions.invalidGroupIdBody'),
            );
            return;
        }
        const created = await groups.create({
            groupId,
            displayName,
        });
        if (created) setSelectedGroupId(created.ref.groupId);
    }, [groups]);

    const editSelectedGroupName = React.useCallback(async () => {
        if (!selectedGroup) return;
        const result = await Modal.prompt(
            t('connectedServices.detail.groupDetail.nameTitle'),
            t('connectedServices.detail.groupDetail.namePromptBody'),
            {
                defaultValue:
                    selectedGroup.displayName ?? selectedGroup.ref.groupId,
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof result !== 'string') return;
        await groups.patch({
            group: selectedGroup,
            displayName: result.trim() || null,
        });
    }, [groups, selectedGroup]);

    const editPolicyNumber = React.useCallback(async (params: Readonly<{
        field:
            | 'softSwitchRemainingPercent'
            | 'probeIfSnapshotOlderThanMs'
            | 'cooldownMs'
            | 'maxSwitchesPerTurn'
            | 'maxSwitchesPerSessionHour';
        title:
            | 'connectedServices.detail.groupDetail.softSwitchThresholdTitle'
            | 'connectedServices.detail.groupDetail.staleProbeTitle'
            | 'connectedServices.detail.groupDetail.switchBudgetTitle';
        current: number;
        minimum: number;
        maximum?: number;
        scale?: number;
    }>) => {
        if (!selectedGroup) return;
        const scale = params.scale ?? 1;
        const result = await Modal.prompt(
            t(params.title),
            t(params.title),
            {
                defaultValue: String(params.current / scale),
                confirmText: t('common.save'),
                cancelText: t('common.cancel'),
            },
        );
        if (typeof result !== 'string') return;
        const parsed = parsePromptNumber(result);
        if (
            parsed === null
            || parsed < params.minimum
            || (params.maximum !== undefined && parsed > params.maximum)
        ) {
            await Modal.alert(
                t('common.error'),
                t('connectedServices.errors.generic'),
            );
            return;
        }
        await groups.patch({
            group: selectedGroup,
            policy: {
                [params.field]: Math.round(parsed * scale),
            },
        });
    }, [groups, selectedGroup]);

    const setActiveAccount = React.useCallback(async (
        account: QualifiedConnectedAccountRef,
    ) => {
        if (!selectedGroup) return;
        try {
            await groups.setActiveAccount({
                group: selectedGroup,
                account,
            });
        } catch (error) {
            if (!isConnectedServiceRuntimeCooldownError(error)) return;
            const confirmed = await Modal.confirm(
                t('connectedServices.errors.runtimeCooldownOverrideTitle'),
                resolveConnectedServiceRuntimeCooldownOverrideBody(error),
                {
                    confirmText:
                        t('connectedServices.errors.runtimeCooldownOverrideConfirm'),
                    cancelText: t('common.cancel'),
                },
            );
            if (!confirmed) return;
            await groups.setActiveAccount({
                group: selectedGroup,
                account,
                overrideRuntimeCooldown: true,
            }).catch(() => null);
        }
    }, [groups, selectedGroup]);

    const moveMember = React.useCallback(async (
        accountId: string,
        direction: -1 | 1,
    ) => {
        if (!selectedGroup) return;
        const ordered = [...selectedGroup.members].sort(
            (left, right) => left.priority - right.priority,
        );
        const from = ordered.findIndex(
            (member) => member.ref.accountId === accountId,
        );
        const to = from + direction;
        if (from < 0 || to < 0 || to >= ordered.length) return;
        [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
        let current = selectedGroup;
        for (const [index, member] of ordered.entries()) {
            const priority = (index + 1) * 100;
            const currentMember = current.members.find(
                (candidate) => candidate.ref.accountId === member.ref.accountId,
            );
            if (!currentMember || currentMember.priority === priority) continue;
            const next = await groups.patchMember({
                group: current,
                account: currentMember.ref,
                priority,
            });
            if (!next) return;
            current = next;
        }
    }, [groups, selectedGroup]);

    const deleteSelectedGroup = React.useCallback(async () => {
        if (!selectedGroup) return;
        const confirmed = await Modal.confirm(
            t('connectedServices.pools.delete.confirmTitle'),
            t('connectedServices.pools.delete.confirmMessage', {
                name: selectedGroup.displayName ?? selectedGroup.ref.groupId,
            }),
            {
                confirmText: t('connectedServices.pools.delete.title'),
                cancelText: t('common.cancel'),
                destructive: true,
            },
        );
        if (!confirmed) return;
        if (await groups.delete(selectedGroup)) setSelectedGroupId(null);
    }, [groups, selectedGroup]);

    const accountsContent = (
        <>
            <ItemGroup title={props.title}>
                {accounts.length === 0 ? (
                    <Item
                        testID="connected-accounts:empty"
                        title={t('connectedServices.detail.profiles.empty')}
                        mode="info"
                        showChevron={false}
                    />
                ) : accounts.map((account) => {
                    const requiresSupportedSetup = account.status === 'needs_reauth'
                        && account.authenticationModeId === null;
                    const authenticationMode = props.modes.find(
                        (mode) => mode.id === account.authenticationModeId,
                    );
                    const configurationBlocked = authenticationMode === undefined
                        ? !account.configurationReady
                        : authenticationMode.configuration?.scope === 'service'
                            ? isServiceConfigurationBlocked(
                                props.serviceConfigurationStatusByModeId,
                                authenticationMode.id,
                            )
                            : authenticationMode.configuration?.scope
                                === 'account'
                                && !account.configurationReady;
                    const reconnectAllowed = Boolean(
                        props.onBeginReconnect
                        && (
                            !props.canReconnectAccount
                            || props.canReconnectAccount(account)
                        ),
                    );
                    const label = accountLabels[account.ref.accountId]
                        ?? account.displayName
                        ?? account.ref.accountId;
                    return (
                        <React.Fragment key={account.ref.accountId}>
                            <Item
                                testID={`connected-account:${account.ref.accountId}`}
                                title={label}
                                subtitle={[
                                    accountStatusLabel(account.status),
                                    props.defaultAccountId === account.ref.accountId
                                        ? t('connectedServices.detail.actions.unsetDefault')
                                        : null,
                                    configurationBlocked
                                        ? t('common.blocked')
                                        : null,
                                ].filter((value): value is string => Boolean(value)).join(' · ')}
                                icon={<Ionicons
                                    name="person-circle-outline"
                                    size={22}
                                    color={theme.colors.accent.blue}
                                />}
                                selected={props.focus?.kind === 'account'
                                    && props.focus.accountId
                                        === account.ref.accountId}
                                disabled={
                                    props.busy
                                    || requiresSupportedSetup
                                    || !reconnectAllowed
                                }
                                onPress={requiresSupportedSetup
                                    || !reconnectAllowed
                                    ? undefined
                                    : () => props.onBeginReconnect?.(account.ref)}
                            />
                            {props.onEditLabel ? (
                                <Item
                                    testID={`connected-account-label:${account.ref.accountId}`}
                                    title={t('connectedServices.detail.actions.editLabel')}
                                    detail={accountLabels[account.ref.accountId]}
                                    onPress={() => props.onEditLabel?.(account.ref)}
                                />
                            ) : null}
                            {props.onToggleDefault ? (
                                <Item
                                    testID={`connected-account-default:${account.ref.accountId}`}
                                    title={props.defaultAccountId === account.ref.accountId
                                        ? t('connectedServices.detail.actions.unsetDefault')
                                        : t('connectedServices.detail.actions.setDefault')}
                                    icon={<Ionicons
                                        name={props.defaultAccountId === account.ref.accountId
                                            ? 'star'
                                            : 'star-outline'}
                                        size={22}
                                        color={theme.colors.accent.blue}
                                    />}
                                    onPress={() => props.onToggleDefault?.(account.ref)}
                                />
                            ) : null}
                            {props.onConfigureAccount
                                && account.authenticationModeId
                                && props.modes.some((mode) => (
                                    mode.id === account.authenticationModeId
                                    && mode.configuration?.scope === 'account'
                                )) ? (
                                    <Item
                                        testID={`connected-account-configuration-settings:${account.ref.accountId}`}
                                        title={t('connectedServices.account.configurationTitle')}
                                        icon={<Ionicons
                                            name="settings-outline"
                                            size={22}
                                            color={theme.colors.accent.blue}
                                        />}
                                        disabled={props.busy}
                                        onPress={() =>
                                            props.onConfigureAccount?.(
                                                account.ref,
                                            )}
                                    />
                                ) : null}
                            {groups.source?.protocol === 'v4' ? (
                                <QualifiedQuotaRow account={account.ref} />
                            ) : legacyQuotaSupported
                                && props.legacyServiceId ? (
                                    <LegacyQuotaRow
                                        serviceId={props.legacyServiceId}
                                        accountId={account.ref.accountId}
                                        credentialHealthStatus={account.status}
                                    />
                                ) : null}
                        </React.Fragment>
                    );
                })}
            </ItemGroup>
            {(
                props.onBeginConnect
                || props.onConfigureService
                || props.onRevoke
            ) ? (
                <ItemGroup title={t('connectedServices.detail.actionsGroupTitle')}>
                {props.onBeginConnect ? props.modes.map((mode) => (
                    <Item
                        key={mode.id}
                        testID={`connected-account-mode:${mode.id}`}
                        title={localizedText(mode.title) || mode.id}
                        icon={<Ionicons
                            name="add-circle-outline"
                            size={22}
                            color={theme.colors.accent.blue}
                        />}
                        disabled={props.busy}
                        onPress={() => props.onBeginConnect?.({
                            service: props.service,
                            modeId: mode.id,
                        })}
                    />
                )) : null}
                {props.onConfigureService ? props.modes
                    .filter((mode) =>
                        mode.configuration?.scope === 'service')
                    .map((mode) => (
                        <Item
                            key={`configure:${mode.id}`}
                            testID={`connected-service-configuration-settings:${mode.id}`}
                            title={t('connectedServices.account.configurationTitle')}
                            detail={[
                                localizedText(mode.title) || mode.id,
                                isServiceConfigurationBlocked(
                                    props.serviceConfigurationStatusByModeId,
                                    mode.id,
                                ) ? t('common.blocked') : null,
                            ].filter(
                                (value): value is string => Boolean(value),
                            ).join(' · ')}
                            icon={<Ionicons
                                name="settings-outline"
                                size={22}
                                color={theme.colors.accent.blue}
                            />}
                            disabled={props.busy}
                            onPress={() =>
                                props.onConfigureService?.(mode.id)}
                        />
                    )) : null}
                {props.onRevoke ? accounts.map((account) => (
                    <Item
                        key={`revoke:${account.ref.accountId}`}
                        testID={`connected-account-revoke:${account.ref.accountId}`}
                        title={`${t('modals.disconnect')}: ${
                            accountLabels[account.ref.accountId]
                            ?? account.displayName
                            ?? account.ref.accountId
                        }`}
                        icon={<Ionicons
                            name="trash-outline"
                            size={22}
                            color={theme.colors.accent.blue}
                        />}
                        destructive
                        disabled={props.busy}
                        onPress={() => props.onRevoke?.(account.ref)}
                    />
                )) : null}
                </ItemGroup>
            ) : null}
        </>
    );

    const poolsContent = selectedGroup ? (
        <>
            <ItemGroup title={selectedGroup.displayName ?? selectedGroup.ref.groupId}>
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}`}
                    title={selectedGroup.displayName ?? selectedGroup.ref.groupId}
                    subtitle={groupStrategyTitle(selectedGroup.policy.strategy)}
                    onPress={() => setSelectedGroupId(null)}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:edit-name`}
                    title={t('connectedServices.detail.groupDetail.nameTitle')}
                    onPress={() => {
                        void editSelectedGroupName();
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:auto-switch`}
                    title={t('connectedServices.detail.groupDetail.autoSwitchTitle')}
                    rightElement={<Switch
                        value={selectedGroup.policy.autoSwitch}
                        disabled={groups.mutating}
                        onValueChange={(autoSwitch) => {
                            void groups.patch({
                                group: selectedGroup,
                                policy: { autoSwitch },
                            });
                        }}
                    />}
                    showChevron={false}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:strategy`}
                    title={t('connectedServices.detail.groupDetail.strategyTitle')}
                    detail={groupStrategyTitle(selectedGroup.policy.strategy)}
                    onPress={() => {
                        const next = selectedGroup.policy.strategy === 'priority'
                            ? 'least_limited'
                            : selectedGroup.policy.strategy === 'least_limited'
                                ? 'manual'
                                : 'priority';
                        void groups.patch({
                            group: selectedGroup,
                            policy: { strategy: next },
                        });
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:recovery-mode`}
                    title={t('connectedServices.detail.groupDetail.recoveryModeTitle')}
                    detail={t(
                        selectedGroup.policy.recoveryMode === 'off'
                            ? 'connectedServices.detail.groupDetail.recoveryModeOffSubtitle'
                            : selectedGroup.policy.recoveryMode === 'wait_until_reset'
                                ? 'connectedServices.detail.groupDetail.recoveryModeWaitUntilResetSubtitle'
                                : selectedGroup.policy.recoveryMode === 'switch_then_resume'
                                    ? 'connectedServices.detail.groupDetail.recoveryModeSwitchThenResumeSubtitle'
                                    : 'connectedServices.detail.groupDetail.recoveryModeSwitchOrWaitSubtitle',
                    )}
                    onPress={() => {
                        const next = selectedGroup.policy.recoveryMode === 'off'
                            ? 'wait_until_reset'
                            : selectedGroup.policy.recoveryMode === 'wait_until_reset'
                                ? 'switch_then_resume'
                                : selectedGroup.policy.recoveryMode === 'switch_then_resume'
                                    ? 'switch_or_wait'
                                    : 'off';
                        void groups.patch({
                            group: selectedGroup,
                            policy: { recoveryMode: next },
                        });
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:auto-restore-primary`}
                    title={t('connectedServices.pools.behavior.autoRestorePrimaryTitle')}
                    rightElement={<Switch
                        value={selectedGroup.policy.autoRestorePrimaryWhenReset}
                        disabled={groups.mutating}
                        onValueChange={(autoRestorePrimaryWhenReset) => {
                            void groups.patch({
                                group: selectedGroup,
                                policy: { autoRestorePrimaryWhenReset },
                            });
                        }}
                    />}
                    showChevron={false}
                />
                {([
                    ['usageLimit', 'connectedServices.pools.behavior.switchOn.usageLimit'],
                    ['authExpired', 'connectedServices.pools.behavior.switchOn.authExpired'],
                    ['accountChanged', 'connectedServices.pools.behavior.switchOn.accountChanged'],
                    ['refreshFailure', 'connectedServices.pools.behavior.switchOn.refreshFailure'],
                ] as const).map(([field, titleKey]) => (
                    <Item
                        key={field}
                        testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:switch-on:${field}`}
                        title={t(titleKey)}
                        subtitle={t('connectedServices.pools.behavior.switchOnGroupSubtitle')}
                        rightElement={<Switch
                            value={selectedGroup.policy.switchOn[field]}
                            disabled={groups.mutating}
                            onValueChange={(value) => {
                                void groups.patch({
                                    group: selectedGroup,
                                    policy: {
                                        switchOn: {
                                            ...selectedGroup.policy.switchOn,
                                            [field]: value,
                                        },
                                    },
                                });
                            }}
                        />}
                        showChevron={false}
                    />
                ))}
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:soft-switch-percent`}
                    title={t('connectedServices.detail.groupDetail.softSwitchThresholdTitle')}
                    detail={`${selectedGroup.policy.softSwitchRemainingPercent}%`}
                    onPress={() => {
                        void editPolicyNumber({
                            field: 'softSwitchRemainingPercent',
                            title: 'connectedServices.detail.groupDetail.softSwitchThresholdTitle',
                            current: selectedGroup.policy.softSwitchRemainingPercent,
                            minimum: 0,
                            maximum: 100,
                        });
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:stale-probe`}
                    title={t('connectedServices.detail.groupDetail.staleProbeTitle')}
                    detail={String(Math.round(
                        selectedGroup.policy.probeIfSnapshotOlderThanMs / 60_000,
                    ))}
                    onPress={() => {
                        void editPolicyNumber({
                            field: 'probeIfSnapshotOlderThanMs',
                            title: 'connectedServices.detail.groupDetail.staleProbeTitle',
                            current:
                                selectedGroup.policy.probeIfSnapshotOlderThanMs,
                            minimum: 1,
                            scale: 60_000,
                        });
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:cooldown`}
                    title={t('connectedServices.detail.groupDetail.switchBudgetTitle')}
                    detail={String(Math.round(selectedGroup.policy.cooldownMs / 1_000))}
                    onPress={() => {
                        void editPolicyNumber({
                            field: 'cooldownMs',
                            title: 'connectedServices.detail.groupDetail.switchBudgetTitle',
                            current: selectedGroup.policy.cooldownMs,
                            minimum: 0,
                            scale: 1_000,
                        });
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:max-switches-turn`}
                    title={t('connectedServices.detail.groupDetail.switchBudgetTitle')}
                    detail={String(selectedGroup.policy.maxSwitchesPerTurn)}
                    onPress={() => {
                        void editPolicyNumber({
                            field: 'maxSwitchesPerTurn',
                            title: 'connectedServices.detail.groupDetail.switchBudgetTitle',
                            current: selectedGroup.policy.maxSwitchesPerTurn,
                            minimum: 0,
                        });
                    }}
                />
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:max-switches-hour`}
                    title={t('connectedServices.detail.groupDetail.switchBudgetTitle')}
                    detail={String(selectedGroup.policy.maxSwitchesPerSessionHour)}
                    onPress={() => {
                        void editPolicyNumber({
                            field: 'maxSwitchesPerSessionHour',
                            title: 'connectedServices.detail.groupDetail.switchBudgetTitle',
                            current:
                                selectedGroup.policy.maxSwitchesPerSessionHour,
                            minimum: 0,
                        });
                    }}
                />
            </ItemGroup>
            <ItemGroup title={t('connectedServices.pools.detail.membersTitle')}>
                {selectedGroup.members.map((member) => {
                    const account = accounts.find(
                        (candidate) => candidate.ref.accountId === member.ref.accountId,
                    );
                    const title = accountLabels[member.ref.accountId]
                        ?? account?.displayName
                        ?? member.ref.accountId;
                    return (
                        <React.Fragment key={member.ref.accountId}>
                            <Item
                                testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:member:${member.ref.accountId}`}
                                title={title}
                                subtitle={selectedGroup.activeAccountId === member.ref.accountId
                                    ? t('connectedServices.detail.groups.memberActive')
                                    : member.enabled
                                        ? t('connectedServices.detail.groups.memberEnabled')
                                        : t('connectedServices.detail.groups.memberDisabled')}
                                rightElement={<Switch
                                    value={member.enabled}
                                    disabled={groups.mutating}
                                    onValueChange={(enabled) => {
                                        void groups.patchMember({
                                            group: selectedGroup,
                                            account: member.ref,
                                            enabled,
                                        });
                                    }}
                                />}
                                onPress={selectedGroup.activeAccountId === member.ref.accountId
                                    ? undefined
                                    : () => {
                                        void setActiveAccount(member.ref);
                                    }}
                            />
                            <Item
                                testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:move-up:${member.ref.accountId}`}
                                title={t('connectedServices.pools.detail.moveUp')}
                                disabled={
                                    [...selectedGroup.members]
                                        .sort((left, right) => left.priority - right.priority)[0]
                                        ?.ref.accountId === member.ref.accountId
                                }
                                onPress={() => {
                                    void moveMember(member.ref.accountId, -1);
                                }}
                            />
                            <Item
                                testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:move-down:${member.ref.accountId}`}
                                title={t('connectedServices.pools.detail.moveDown')}
                                disabled={
                                    [...selectedGroup.members]
                                        .sort((left, right) => left.priority - right.priority)
                                        .at(-1)?.ref.accountId === member.ref.accountId
                                }
                                onPress={() => {
                                    void moveMember(member.ref.accountId, 1);
                                }}
                            />
                            <Item
                                testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:remove:${member.ref.accountId}`}
                                title={t('connectedServices.detail.groupActions.removeMember')}
                                destructive
                                onPress={() => {
                                    void (async () => {
                                        const confirmed = await Modal.confirm(
                                            t('connectedServices.detail.groupActions.removeMemberConfirmTitle'),
                                            t('connectedServices.detail.groupActions.removeMemberConfirmBody', {
                                                profileId: member.ref.accountId,
                                            }),
                                            {
                                                confirmText: t('connectedServices.detail.groupActions.removeMember'),
                                                cancelText: t('common.cancel'),
                                                destructive: true,
                                            },
                                        );
                                        if (!confirmed) return;
                                        await groups.removeMember({
                                            group: selectedGroup,
                                            account: member.ref,
                                        });
                                    })();
                                }}
                            />
                        </React.Fragment>
                    );
                })}
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:add-member`}
                    title={t('connectedServices.detail.groupActions.addMember')}
                    disabled={
                        groups.mutating
                        || accounts.every((account) => selectedGroup.members.some(
                            (member) => member.ref.accountId === account.ref.accountId,
                        ))
                    }
                    onPress={() => {
                        const candidates = accounts.filter((account) => (
                            !selectedGroup.members.some(
                                (member) => member.ref.accountId === account.ref.accountId,
                            )
                        ));
                        Modal.alert(
                            t('connectedServices.detail.groupActions.addMember'),
                            t('connectedServices.detail.groupActions.addMemberSubtitle'),
                            [
                                ...candidates.map((account) => ({
                                    text: accountLabels[account.ref.accountId]
                                        ?? account.displayName
                                        ?? account.ref.accountId,
                                    onPress: () => {
                                        void groups.addMember({
                                            group: selectedGroup,
                                            account: account.ref,
                                        });
                                    },
                                })),
                                { text: t('common.cancel'), style: 'cancel' as const },
                            ],
                        );
                    }}
                />
            </ItemGroup>
            <ItemGroup>
                <Item
                    testID={`qualified-connected-account-group:${selectedGroup.ref.groupId}:delete`}
                    title={t('connectedServices.pools.delete.title')}
                    subtitle={t('connectedServices.pools.delete.subtitle')}
                    destructive
                    onPress={() => {
                        void deleteSelectedGroup();
                    }}
                />
            </ItemGroup>
            {groups.error ? (
                <ItemGroup>
                    <Item
                        testID="qualified-connected-account-groups:error"
                        title={groups.error}
                        mode="info"
                        showChevron={false}
                    />
                </ItemGroup>
            ) : null}
        </>
    ) : (
        <>
            <ItemGroup title={t('connectedServices.pools.title')}>
                {groups.groups.map((group) => (
                    <Item
                        key={group.ref.groupId}
                        testID={`qualified-connected-account-group:${group.ref.groupId}`}
                        title={group.displayName ?? group.ref.groupId}
                        subtitle={[
                            groupStrategyTitle(group.policy.strategy),
                            group.activeAccountId,
                        ].filter((value): value is string => Boolean(value)).join(' · ')}
                        onPress={() => setSelectedGroupId(group.ref.groupId)}
                    />
                ))}
                {groups.status === 'loading' ? (
                    <Item
                        testID="qualified-connected-account-groups:loading"
                        title={t('connectedServices.deviceAuth.preparing')}
                        mode="info"
                        showChevron={false}
                    />
                ) : null}
                {groups.status === 'error' ? (
                    <Item
                        testID="qualified-connected-account-groups:error"
                        title={groups.error ?? t('connectedServices.errors.generic')}
                        onPress={() => {
                            void groups.refresh();
                        }}
                    />
                ) : null}
                {groups.status === 'loaded'
                    && groups.groups.length === 0 ? (
                        <Item
                            testID="qualified-connected-account-groups:empty"
                            title={t('connectedServices.pools.empty.title')}
                            subtitle={t('connectedServices.pools.empty.subtitle')}
                            mode="info"
                            showChevron={false}
                        />
                    ) : null}
            </ItemGroup>
            <ItemGroup>
                <Item
                    testID="qualified-connected-account-group:create"
                    title={t('connectedServices.pools.create.title')}
                    subtitle={t('connectedServices.pools.create.subtitle')}
                    disabled={groups.status !== 'loaded' || groups.mutating}
                    onPress={() => {
                        void createGroup();
                    }}
                />
            </ItemGroup>
        </>
    );

    return (
        <ConnectedServiceSegmentedShell
            activeSegment={activeSegment}
            onSelectSegment={setActiveSegment}
            poolsAvailable={poolsAvailable}
            accountsContent={accountsContent}
            poolsContent={poolsContent}
        />
    );
});
