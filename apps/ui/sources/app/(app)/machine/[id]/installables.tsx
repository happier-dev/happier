import React from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { InstallableDepInstaller } from '@/components/machines/InstallableDepInstaller';
import { ProviderSetupFlow } from '@/components/settings/providers/setup/ProviderSetupFlow';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachine, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, type InstallableAutoUpdateMode } from '@/capabilities/installablesRegistry';
import { resolveInstallablePolicy, applyInstallablePolicyOverride } from '@happier-dev/protocol/installablesPolicy';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

function formatAutoUpdateMode(mode: InstallableAutoUpdateMode): string {
    if (mode === 'off') return t('machine.installables.autoUpdateModes.off');
    if (mode === 'notify') return t('machine.installables.autoUpdateModes.notify');
    return t('machine.installables.autoUpdateModes.auto');
}

export default function MachineInstallablesScreen() {
    const { theme } = useUnistyles();
    const { id: machineId, serverId: serverIdParam } = useLocalSearchParams<{ id: string; serverId?: string }>();
    const machine = useMachine(machineId!);
    const isOnline = !!machine && isMachineOnline(machine);
    const serverId = typeof serverIdParam === 'string' && serverIdParam.trim().length > 0 ? serverIdParam.trim() : getActiveServerId();

    const settings = useSettings();
    const [installablesPolicyByMachineId, setInstallablesPolicyByMachineId] = useSettingMutable('installablesPolicyByMachineId');

    const { state: detectedCapabilities, refresh: refreshDetectedCapabilities } = useMachineCapabilitiesCache({
        machineId: machineId ?? null,
        serverId,
        enabled: Boolean(machineId && isOnline),
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });

    const capabilitiesSnapshot = React.useMemo(() => {
        const snapshot =
            detectedCapabilities.status === 'loaded'
                ? detectedCapabilities.snapshot
                : detectedCapabilities.status === 'loading'
                    ? detectedCapabilities.snapshot
                    : detectedCapabilities.status === 'error'
                        ? detectedCapabilities.snapshot
                        : undefined;
        return snapshot ?? null;
    }, [detectedCapabilities]);

    const installables = React.useMemo(() => {
        const entries = getInstallablesRegistryEntries();
        const results = capabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const enabled = entry.enabledWhen(settings as any);
            const status = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            const policy = resolveInstallablePolicy({
                settings: settings as any,
                machineId: machineId ?? '',
                installableKey: entry.key,
                defaults: entry.defaultPolicy,
            });
            return { entry, enabled, status, detectResult, policy };
        });
    }, [capabilitiesSnapshot, machineId, settings]);

    React.useEffect(() => {
        if (!machineId) return;
        if (!isOnline) return;
        const results = capabilitiesSnapshot?.response.results;
        if (!results) return;

        const requests = installables
            .filter((d) => d.enabled)
            .filter((d) => d.entry.shouldPrefetchLatestVersion({ requireExistingResult: true, result: d.detectResult, data: d.status }))
            .flatMap((d) => d.entry.buildLatestVersionDetectRequest().requests ?? []);

        if (requests.length === 0) return;

        refreshDetectedCapabilities({
            request: { requests },
            timeoutMs: 12_000,
        });
    }, [capabilitiesSnapshot, installables, isOnline, machineId, refreshDetectedCapabilities]);

    const setPolicyPatch = React.useCallback((installableKey: string, patch: { autoInstallWhenNeeded?: boolean; autoUpdateMode?: InstallableAutoUpdateMode }) => {
        if (!machineId) return;
        const next = applyInstallablePolicyOverride({ prev: installablesPolicyByMachineId ?? {}, machineId, installableKey, patch });
        setInstallablesPolicyByMachineId(next);
    }, [installablesPolicyByMachineId, machineId, setInstallablesPolicyByMachineId]);

    const screenTitle = t('machine.installables.screenTitle');
    const screenOptions = React.useMemo(() => ({ title: screenTitle }), [screenTitle]);

    return (
        <>
            <Stack.Screen options={screenOptions} />
            <ScrollView
                contentContainerStyle={{ paddingBottom: 24 }}
                style={{ backgroundColor: theme.colors.background.canvas }}
            >
                <ItemGroup title={t('machine.installables.aboutGroupTitle')}>
                    <Item
                        title={screenTitle}
                        subtitle={t('machine.installables.aboutSubtitle')}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title={t('machine.detectedClis')}>
                    <DetectedClisList state={detectedCapabilities} layout="stacked" />
                </ItemGroup>

                <ProviderSetupFlow machineId={machineId ?? null} serverId={serverId} />

                {installables.map(({ entry, enabled, status, policy }) => {
                    if (!enabled) return null;
                    return (
                        <InstallableDepInstaller
                            key={entry.key}
                            machineId={machineId ?? ''}
                            serverId={serverId}
                            enabled={true}
                            groupTitle={entry.experimental ? t('machine.installables.experimentalGroupTitle', { title: entry.title }) : entry.title}
                            depId={entry.capabilityId}
                            depTitle={entry.title}
                            depIconName={entry.iconName as any}
                            depStatus={status}
                            capabilitiesStatus={detectedCapabilities.status}
                            extraItems={
                                <>
                                    <Item
                                        title={t('machine.installables.autoInstallTitle')}
                                        subtitle={t('machine.installables.autoInstallSubtitle')}
                                        rightElement={<Switch value={policy.autoInstallWhenNeeded} onValueChange={(next) => setPolicyPatch(entry.key, { autoInstallWhenNeeded: next })} />}
                                        showChevron={false}
                                        onPress={() => setPolicyPatch(entry.key, { autoInstallWhenNeeded: !policy.autoInstallWhenNeeded })}
                                    />
                                    <Item
                                        title={t('machine.installables.autoUpdateTitle')}
                                        subtitle={formatAutoUpdateMode(policy.autoUpdateMode)}
                                        showChevron={true}
                                        onPress={() => {
                                            Modal.alert(
                                                t('machine.installables.autoUpdatePromptTitle'),
                                                t('machine.installables.autoUpdatePromptBody'),
                                                [
                                                    { text: t('machine.installables.autoUpdateModes.off'), onPress: () => setPolicyPatch(entry.key, { autoUpdateMode: 'off' }) },
                                                    { text: t('machine.installables.autoUpdateModes.notify'), onPress: () => setPolicyPatch(entry.key, { autoUpdateMode: 'notify' }) },
                                                    { text: t('machine.installables.autoUpdateModes.auto'), onPress: () => setPolicyPatch(entry.key, { autoUpdateMode: 'auto' }) },
                                                    { text: t('common.cancel'), style: 'cancel' },
                                                ],
                                            );
                                        }}
                                    />
                                </>
                            }
                            installLabels={{
                                install: t(entry.installLabels.installKey),
                                update: t(entry.installLabels.updateKey),
                                reinstall: t(entry.installLabels.reinstallKey),
                            }}
                            installModal={{
                                installTitle: t(entry.installModal.installTitleKey),
                                updateTitle: t(entry.installModal.updateTitleKey),
                                reinstallTitle: t(entry.installModal.reinstallTitleKey),
                                description: t(entry.installModal.descriptionKey),
                            }}
                            refreshStatus={() => refreshDetectedCapabilities()}
                            refreshLatestVersion={() => refreshDetectedCapabilities({ request: entry.buildLatestVersionDetectRequest(), timeoutMs: 12_000 })}
                        />
                    );
                })}
            </ScrollView>
        </>
    );
}
