import * as React from 'react';
import {
    canonicalizeProviderContributionKeyV1,
    createProviderErrorV1,
    type ProviderDiscoveryCandidateV1,
    type ProviderErrorV1,
} from '@happier-dev/protocol';
import { useFocusEffect } from '@react-navigation/native';
import { useRouter } from 'expo-router';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { ShimmerView } from '@/components/ui/feedback/ShimmerView';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { Switch } from '@/components/ui/forms/Switch';
import { ProviderMachineSelector } from '@/components/settings/providers/ProviderMachineSelector';
import { ProviderErrorItems } from '@/components/settings/providers/ProviderErrorItems';
import { SearchHeader } from '@/components/ui/forms/SearchHeader';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import {
    presentProviderConnection,
    PROVIDER_CONNECTION_STATUS_KEY,
} from '@/providers/connection/presentation';
import { listProviderSettingsTargetMachines, resolveProviderSettingsTargetMachine } from '@/providers/hooks/targetMachine';
import { useProviderConnectionMutation } from '@/providers/hooks/useProviderConnectionMutation';
import { useProviderConnections } from '@/providers/hooks/useProviderConnections';
import { useAllMachines, useMachineListByServerId } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useNavigationFocusReturn } from '@/utils/navigation/useNavigationFocusReturn';
import {
    ProviderConnectionsCatalogSection,
    type ProviderConfiguredConnectionRow,
} from './index/ProviderConnectionsCatalogSection';
import {
    ProviderFeatureAvailabilityNotice,
    useProviderFeatureAvailability,
} from './ProviderFeatureAvailability';

function candidatePort(candidate: ProviderDiscoveryCandidateV1): string {
    const endpoint = new URL(candidate.normalizedEndpointUrl);
    if (endpoint.port) return endpoint.port;
    return endpoint.protocol === 'https:' ? '443' : '80';
}

export const ProviderConnectionsSettingsScreen = React.memo(function ProviderConnectionsSettingsScreen() {
    const router = useRouter();
    const { theme } = useUnistyles();
    const { enabled, presentation: availabilityPresentation } = useProviderFeatureAvailability();
    const localDiscoveryEnabled = useFeatureEnabled('providers.localDiscovery');
    const machines = useAllMachines();
    const machineListByServerId = useMachineListByServerId();
    const activeServer = useActiveServerSnapshot();
    const serverId = typeof activeServer.serverId === 'string' ? activeServer.serverId : null;
    const [preferredMachineId, setPreferredMachineId] = React.useState<string | null>(null);
    const eligibleMachineIds = React.useMemo(() => new Set(listProviderSettingsTargetMachines({
        serverId, machines, machineListByServerId,
    }).map((machine) => machine.id)), [machineListByServerId, machines, serverId]);
    const targetMachines = React.useMemo(
        () => machines.filter((machine) => eligibleMachineIds.has(machine.id)),
        [eligibleMachineIds, machines],
    );
    const machineId = React.useMemo(() => resolveProviderSettingsTargetMachine({
        serverId, preferredMachineId, machines, machineListByServerId,
    }), [machineListByServerId, machines, preferredMachineId, serverId]);
    const { data, error, loading, refresh } = useProviderConnections({
        enabled, machineId, serverId,
    });
    const hasFocusedIndex = React.useRef(false);
    useFocusEffect(React.useCallback(() => {
        if (!hasFocusedIndex.current) {
            hasFocusedIndex.current = true;
            return;
        }
        void refresh();
    }, [refresh]));
    const navigateWithFocusReturn = useNavigationFocusReturn({
        ready: !enabled || (!loading && (data !== null || error !== null || machineId === null)),
    });
    const mutation = useProviderConnectionMutation({ serverId, refresh });
    const [searchQuery, setSearchQuery] = React.useState('');
    const [discoverySelectionError, setDiscoverySelectionError] = React.useState<ProviderErrorV1 | null>(null);
    const [optimisticEnabledByConnectionId, setOptimisticEnabledByConnectionId] = React.useState<Readonly<Record<string, boolean>>>({});
    const showSearch = (data?.connections.length ?? 0) + (data?.available.length ?? 0)
        + (localDiscoveryEnabled
            ? (data?.discoveryCandidates.length ?? 0) + (data?.localInstallations.length ?? 0)
            : 0) >= 10;
    React.useEffect(() => {
        if (!showSearch && searchQuery) setSearchQuery('');
    }, [searchQuery, showSearch]);
    const normalizedSearch = showSearch ? searchQuery.trim().toLocaleLowerCase() : '';
    const visibleConnections = React.useMemo(() => data?.connections.filter((connection) => !normalizedSearch
        || `${connection.displayName} ${connection.providerName}`.toLocaleLowerCase().includes(normalizedSearch)) ?? [], [data?.connections, normalizedSearch]);
    const visibleAvailable = React.useMemo(() => data?.available.filter((provider) => !normalizedSearch
        || provider.name.toLocaleLowerCase().includes(normalizedSearch)) ?? [], [data?.available, normalizedSearch]);
    const visibleDiscoveryCandidates = React.useMemo(() => localDiscoveryEnabled
        ? data?.discoveryCandidates.filter((candidate) => !normalizedSearch
            || candidate.providerName.toLocaleLowerCase().includes(normalizedSearch)) ?? []
        : [], [data?.discoveryCandidates, localDiscoveryEnabled, normalizedSearch]);
    const visibleLocalInstallations = React.useMemo(() => {
        if (!localDiscoveryEnabled) return [];
        const candidateContributions = new Set(data?.discoveryCandidates.map((candidate) =>
            canonicalizeProviderContributionKeyV1(candidate.contributionKey)) ?? []);
        return data?.localInstallations.filter((installation) => !candidateContributions.has(
            canonicalizeProviderContributionKeyV1(installation.contributionKey),
        )
            && (!normalizedSearch || installation.providerName.toLocaleLowerCase().includes(normalizedSearch))) ?? [];
    }, [data?.discoveryCandidates, data?.localInstallations, localDiscoveryEnabled, normalizedSearch]);
    const searchEmpty = Boolean(normalizedSearch)
        && visibleConnections.length === 0
        && visibleAvailable.length === 0
        && visibleDiscoveryCandidates.length === 0
        && visibleLocalInstallations.length === 0;
    const configuredRows = React.useMemo<readonly ProviderConfiguredConnectionRow[]>(() => (
        visibleConnections.map((connection) => {
            const presentation = presentProviderConnection(connection);
            const modelCountLabel = presentation.modelCount === null
                ? null
                : t('settingsProviders.detail.modelCount', { count: presentation.modelCount });
            return {
                connectionId: connection.connectionId,
                title: presentation.title,
                subtitle: [presentation.subtitle, modelCountLabel].filter(Boolean).join(' · ')
                    || t(PROVIDER_CONNECTION_STATUS_KEY[presentation.status]),
                icon: connection.icon,
                status: presentation.status,
                enabled: optimisticEnabledByConnectionId[connection.connectionId]
                    ?? (connection.grants.effectiveState === undefined
                        ? connection.authorized
                        : connection.grants.effectiveState === 'valid'),
                pending: mutation.pendingKey === connection.connectionId,
            };
        })
    ), [mutation.pendingKey, optimisticEnabledByConnectionId, visibleConnections]);

    const setConnectionEnabled = React.useCallback(async (
        connectionId: string,
        next: boolean,
        scope: 'account' | 'machine' | 'connection',
    ) => {
        if (!machineId) return;
        setOptimisticEnabledByConnectionId((current) => ({ ...current, [connectionId]: next }));
        try {
            await mutation.run({
                action: 'setEnabled', machineId, connectionId, enabled: next,
                ...(!next ? { scope } : {}),
            }, connectionId);
        } finally {
            setOptimisticEnabledByConnectionId((current) => {
                const updated = { ...current };
                delete updated[connectionId];
                return updated;
            });
        }
    }, [machineId, mutation]);

    const enableDetectedCandidate = React.useCallback(async (candidate: ProviderDiscoveryCandidateV1) => {
        if (!machineId) return;
        setDiscoverySelectionError(null);
        if (!candidate.candidateId) {
            setDiscoverySelectionError(createProviderErrorV1('provider_authorization_changed', {
                machineId,
                ...(candidate.connection.status === 'matched'
                    ? { connectionId: candidate.connection.connectionId }
                    : {}),
            }));
            return;
        }
        let displayName: string | null = null;
        if (candidate.connection.status === 'requires_named_connection') {
            displayName = await Modal.prompt(
                t('settingsProviders.local.addConnectionTitle'),
                t('settingsProviders.local.addConnectionDescription'),
                {
                    defaultValue: t('settingsProviders.local.defaultConnectionName', { provider: candidate.providerName }),
                    confirmText: t('common.create'),
                },
            );
            if (!displayName?.trim()) return;
            displayName = displayName.trim();
        }
        const connectionId = candidate.connection.status === 'matched'
            ? candidate.connection.connectionId
            : `pc_${randomUUID()}`;
        const result = await mutation.run({
            action: 'enableDetected', machineId, connectionId,
            candidateId: candidate.candidateId,
            displayName,
            savedSecretId: null,
        }, `detected:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`);
        if (result?.status === 'error' && result.error.code === 'provider_secret_missing') {
            if (candidate.connection.status === 'matched') {
                const matchedConnectionId = candidate.connection.connectionId;
                navigateWithFocusReturn(() => {
                    router.push(`/(app)/settings/providers/${matchedConnectionId}` as never);
                });
            } else {
                const params: Array<readonly [string, string]> = [
                    ['contributionKey', candidate.contributionKey],
                    ['candidateId', candidate.candidateId],
                ];
                if (displayName) params.push(['displayName', displayName]);
                const queryString = params
                    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
                    .join('&');
                navigateWithFocusReturn(() => {
                    router.push(`/(app)/settings/providers/new?${queryString}` as never);
                });
            }
            mutation.clearError();
        }
    }, [machineId, mutation, navigateWithFocusReturn, router]);

    const startLocalInstallation = React.useCallback(async (installation: Readonly<{
        contributionKey: string;
    }>) => {
        if (!machineId) return;
        await mutation.run({
            action: 'startLocal',
            machineId,
            connectionId: `pc_${randomUUID()}`,
            contributionKey: installation.contributionKey,
        }, `start:${installation.contributionKey}`);
    }, [machineId, mutation]);

    if (availabilityPresentation) {
        return (
            <ItemList style={{ paddingTop: 0 }}>
                <ItemGroup title={t('settingsProviders.title')}>
                    <ProviderFeatureAvailabilityNotice presentation={availabilityPresentation} />
                </ItemGroup>
            </ItemList>
        );
    }

    return (
        <ItemList testID="settings-providers-screen" style={{ paddingTop: 0 }}>
            {showSearch ? <SearchHeader testID="settings-providers-search" value={searchQuery} onChangeText={setSearchQuery} placeholder={t('settingsProviders.searchPlaceholder')} /> : null}
            {machineId && targetMachines.length > 1 ? (
                <ItemGroup title={t('settingsProviders.detail.targetMachine')}>
                    <ProviderMachineSelector machines={targetMachines} selectedId={machineId} onSelect={setPreferredMachineId} />
                </ItemGroup>
            ) : null}
            {!machineId ? (
                <ItemGroup title={t('settingsProviders.title')}>
                    <Item mode="info" title={t('settingsProviders.noMachine')} subtitle={t('settingsProviders.noMachineDescription')} />
                </ItemGroup>
            ) : null}
            {loading && !data ? (
                <ItemGroup title={t('settingsProviders.configuredTitle')}>
                    <ShimmerView style={{ borderRadius: 12, marginBottom: 8 }}>
                        <View style={{ height: 64, borderRadius: 12, backgroundColor: theme.colors.surface.elevated }} />
                    </ShimmerView>
                    <ShimmerView style={{ borderRadius: 12, marginBottom: 8 }}>
                        <View style={{ height: 64, borderRadius: 12, backgroundColor: theme.colors.surface.elevated }} />
                    </ShimmerView>
                    <ShimmerView style={{ borderRadius: 12 }}>
                        <View style={{ height: 64, borderRadius: 12, backgroundColor: theme.colors.surface.elevated }} />
                    </ShimmerView>
                </ItemGroup>
            ) : null}
            {visibleDiscoveryCandidates.length || visibleLocalInstallations.length ? (
                <ItemGroup
                    title={`${t('settingsProviders.local.title')} · ${visibleDiscoveryCandidates.length + visibleLocalInstallations.length}`}
                    footer={t('settingsProviders.local.footer')}
                >
                    {visibleDiscoveryCandidates.map((candidate) => {
                        const candidateConnection = candidate.connection;
                        const matchedConnection = candidateConnection.status === 'matched'
                            ? data?.connections.find((connection) => connection.connectionId === candidateConnection.connectionId) ?? null
                            : null;
                        const enabledOnMachine = matchedConnection?.authorized ?? false;
                        const pendingKey = `detected:${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`;
                        const evidenceLabel = candidate.evidence.kind === 'attributed_listener'
                            ? t('settingsProviders.local.detectedAtPort', { port: candidatePort(candidate) })
                            : t('settingsProviders.local.possibleAtPort', { provider: candidate.providerName, port: candidatePort(candidate) });
                        const detail = () => {
                            if (matchedConnection) {
                                navigateWithFocusReturn(() => {
                                    router.push(`/(app)/settings/providers/${matchedConnection.connectionId}` as never);
                                });
                            } else {
                                void enableDetectedCandidate(candidate);
                            }
                        };
                        return (
                            <Item
                                key={`${candidate.contributionKey}:${candidate.normalizedEndpointUrl}`}
                                title={candidate.providerName}
                                subtitle={evidenceLabel}
                                icon={<SafeIonicons name="hardware-chip-outline" size={29} color={theme.colors.text.secondary} />}
                                rightElement={mutation.pendingKey === pendingKey
                                    ? <ActivitySpinner size="small" />
                                    : <Switch
                                        accessibilityLabel={`${candidate.providerName}, ${candidate.normalizedEndpointUrl}`}
                                        value={enabledOnMachine}
                                        onValueChange={(next) => {
                                            if (!next && matchedConnection) {
                                                const disableScope = matchedConnection.grants.enabledMachineIds.includes(candidate.machineId)
                                                    ? 'machine'
                                                    : 'account';
                                                void setConnectionEnabled(matchedConnection.connectionId, false, disableScope);
                                                return;
                                            }
                                            if (next) void enableDetectedCandidate(candidate);
                                        }}
                                    />}
                                rightElementOutsidePressable
                                keepChevronWithRightElement
                                subtitleAccessory={<StatusPill chrome="plain" variant="neutral" label={candidate.evidence.kind === 'attributed_listener'
                                    ? t('settingsProviders.local.detected')
                                    : t('settingsProviders.local.possible')} />}
                                onPress={detail}
                            />
                        );
                    })}
                    {visibleLocalInstallations.map((installation) => {
                        const pendingKey = `start:${installation.contributionKey}`;
                        return <Item
                            key={`installation:${installation.contributionKey}`}
                            mode="info"
                            title={installation.providerName}
                            subtitle={installation.status === 'app_running_server_off'
                                ? t('settingsProviders.local.appRunningServerOff')
                                : t('settingsProviders.local.installedNotRunning')}
                            icon={<SafeIonicons name="hardware-chip-outline" size={29} color={theme.colors.text.secondary} />}
                            rightElement={installation.managedStartAvailable ? (
                                mutation.pendingKey === pendingKey ? <ActivitySpinner size="small" /> : <IconButton
                                    iconName="play-outline"
                                    tone="primary"
                                    accessibilityLabel={t('settingsProviders.local.startManaged', { provider: installation.providerName })}
                                    tooltip={t('settingsProviders.local.startManaged', { provider: installation.providerName })}
                                    onPress={() => startLocalInstallation(installation)}
                                />
                            ) : undefined}
                            rightElementOutsidePressable={installation.managedStartAvailable}
                            subtitleAccessory={<StatusPill chrome="plain" variant="neutral" label={t('settingsProviders.status.notChecked')} />}
                        />;
                    })}
                </ItemGroup>
            ) : null}
            <ProviderConnectionsCatalogSection
                machineAvailable={machineId !== null}
                hasData={data !== null}
                searchEmpty={searchEmpty}
                configured={configuredRows}
                available={visibleAvailable}
                availableTruncated={data?.availableTruncated ?? false}
                textColor={theme.colors.text.secondary}
                onSetConnectionEnabled={(connectionId, next) => { void setConnectionEnabled(connectionId, next, 'connection'); }}
                onOpenConnection={(connectionId) => navigateWithFocusReturn(() => {
                    router.push(`/(app)/settings/providers/${connectionId}` as never);
                })}
                onOpenAvailable={(contributionKey) => navigateWithFocusReturn(() => {
                    router.push(`/(app)/settings/providers/new?contributionKey=${encodeURIComponent(contributionKey)}` as never);
                })}
            />
            <ItemGroup title={t('settingsProviders.customTitle')} footer={t('settingsProviders.customFooter')}>
                <Item
                    testID="settings-provider-add-custom"
                    title={t('settingsProviders.addCustom')}
                    subtitle={t('settingsProviders.addCustomDescription')}
                    icon={<SafeIonicons name="add-outline" size={29} color={theme.colors.text.secondary} />}
                    onPress={() => navigateWithFocusReturn(() => {
                        router.push('/(app)/settings/providers/new' as never);
                    })}
                />
            </ItemGroup>
            {error || mutation.error || discoverySelectionError ? (() => {
                const providerFailure = mutation.error
                    ? {
                        error: mutation.error,
                        retry: mutation.retry,
                        reviewCurrentState: refresh,
                    }
                    : error
                        ? { error, retry: refresh }
                        : { error: discoverySelectionError };
                return <ItemGroup>
                    <ProviderErrorItems
                        error={providerFailure.error}
                        retry={providerFailure.retry}
                        reviewCurrentState={'reviewCurrentState' in providerFailure
                            ? providerFailure.reviewCurrentState
                            : undefined}
                    />
                </ItemGroup>;
            })() : null}
        </ItemList>
    );
});
