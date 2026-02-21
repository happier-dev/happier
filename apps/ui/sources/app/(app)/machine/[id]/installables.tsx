import React from 'react';
import { ScrollView } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { DetectedClisList } from '@/components/machines/DetectedClisList';
import { InstallableDepInstaller } from '@/components/machines/InstallableDepInstaller';
import { Switch } from '@/components/ui/forms/Switch';
import { Modal } from '@/modal';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachine, useSettingMutable, useSettings } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, type InstallableAutoUpdateMode } from '@/capabilities/installablesRegistry';
import { resolveInstallablePolicy, applyInstallablePolicyOverride } from '@/sync/domains/settings/installablesPolicy';
import { useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

function formatAutoUpdateMode(mode: InstallableAutoUpdateMode): string {
    if (mode === 'off') return 'Off';
    if (mode === 'notify') return 'Notify';
    return 'Auto';
}

const MACHINE_INSTALLABLES_SCREEN_OPTIONS = { title: 'Installables' } as const;

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
            .filter((d) => d.entry.shouldPrefetchRegistry({ requireExistingResult: true, result: d.detectResult, data: d.status }))
            .flatMap((d) => d.entry.buildRegistryDetectRequest().requests ?? []);

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

    return (
        <>
            <Stack.Screen options={MACHINE_INSTALLABLES_SCREEN_OPTIONS} />
            <ScrollView
                contentContainerStyle={{ paddingBottom: 24 }}
                style={{ backgroundColor: theme.colors.groupped.background }}
            >
                <ItemGroup title="About">
                    <Item
                        title="Installables"
                        subtitle="Manage tools that Happier can install and keep up to date on this machine."
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup title="Detected CLIs">
                    <DetectedClisList state={detectedCapabilities} layout="stacked" />
                </ItemGroup>

                {installables.map(({ entry, enabled, status, policy }) => {
                    if (!enabled) return null;
                    return (
                        <InstallableDepInstaller
                            key={entry.key}
                            machineId={machineId ?? ''}
                            serverId={serverId}
                            enabled={true}
                            groupTitle={`${entry.title}${entry.experimental ? ' (experimental)' : ''}`}
                            depId={entry.capabilityId}
                            depTitle={entry.title}
                            depIconName={entry.iconName as any}
                            depStatus={status}
                            capabilitiesStatus={detectedCapabilities.status}
                            extraItems={
                                <>
                                    <Item
                                        title="Auto-install when needed"
                                        subtitle="Installs in the background when required for a selected backend (best-effort)."
                                        rightElement={<Switch value={policy.autoInstallWhenNeeded} onValueChange={(next) => setPolicyPatch(entry.key, { autoInstallWhenNeeded: next })} />}
                                        showChevron={false}
                                        onPress={() => setPolicyPatch(entry.key, { autoInstallWhenNeeded: !policy.autoInstallWhenNeeded })}
                                    />
                                    <Item
                                        title="Auto-update"
                                        subtitle={formatAutoUpdateMode(policy.autoUpdateMode)}
                                        showChevron={true}
                                        onPress={() => {
                                            Modal.alert(
                                                'Auto-update',
                                                'Choose how Happier should handle updates for this installable.',
                                                [
                                                    { text: 'Off', onPress: () => setPolicyPatch(entry.key, { autoUpdateMode: 'off' }) },
                                                    { text: 'Notify', onPress: () => setPolicyPatch(entry.key, { autoUpdateMode: 'notify' }) },
                                                    { text: 'Auto', onPress: () => setPolicyPatch(entry.key, { autoUpdateMode: 'auto' }) },
                                                    { text: 'Cancel', style: 'cancel' },
                                                ],
                                            );
                                        }}
                                    />
                                </>
                            }
                            installSpecSettingKey={entry.installSpecSettingKey}
                            installSpecTitle={entry.installSpecTitle}
                            installSpecDescription={entry.installSpecDescription}
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
                            refreshRegistry={() => refreshDetectedCapabilities({ request: entry.buildRegistryDetectRequest(), timeoutMs: 12_000 })}
                        />
                    );
                })}
            </ScrollView>
        </>
    );
}
