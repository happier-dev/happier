import React from 'react';

import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import type { SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useMachineCapabilitiesCache } from '@/hooks/server/useMachineCapabilitiesCache';
import { useMachine, useSetting } from '@/sync/domains/state/storage';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS } from '@/capabilities/requests';
import { getInstallablesRegistryEntries, type InstallableAutoUpdateMode } from '@/capabilities/installablesRegistry';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { resolveInstallablePolicy } from '@happier-dev/protocol/installablesPolicy';
import { getPreferredLanguage, t } from '@/text';
import { Modal } from '@/modal';

import { MachineToolRow } from './MachineToolRow';

function buildAutoUpdateModeOptions(): ReadonlyArray<SegmentedChoiceOption<InstallableAutoUpdateMode>> {
    return [
        { id: 'off', label: t('machine.installables.autoUpdateModes.off'), description: t('machineDetailPage.toolsPage.autoUpdateOff') },
        { id: 'notify', label: t('machine.installables.autoUpdateModes.notify'), description: t('machineDetailPage.toolsPage.autoUpdateNotify') },
        { id: 'auto', label: t('machine.installables.autoUpdateModes.auto'), description: t('machineDetailPage.toolsPage.autoUpdateAuto') },
    ];
}

/**
 * The machine's tools that are not agents (Tools sub-page, lab setup-over Tools): one row per tool with its
 * version, state and next action; each row opens in place into its auto-install and auto-update policy.
 * Agents and their parts install from the machine's Agents page (lab agent-setup M1).
 */
export function MachineInstallablesSection(props: Readonly<{ machineId: string; serverId: string; machineSentenceName: string }>) {
    const { machineId, serverId, machineSentenceName } = props;
    const machine = useMachine(machineId);
    const presence = useMachinePresenceSummary(serverId, machineId);
    const isOnline = !!machine && presence.reachability === 'reachable';

    const installablesPolicyByMachineId = useSetting('installablesPolicyByMachineId');
    const policyAction = useMountedActionExecution(serverId);

    const { state: detectedCapabilities, refresh: refreshDetectedCapabilities } = useMachineCapabilitiesCache({
        machineId: machineId ?? null,
        serverId,
        enabled: Boolean(machineId && isOnline),
        request: CAPABILITIES_REQUEST_MACHINE_DETAILS,
    });
    const daemonMergedProjection = useDaemonMergedProjectionInputs({
        machineId: machineId ?? null,
        serverId,
        // Offline, the last projected metadata stays visible (read-only); only an online machine is asked.
        enabled: Boolean(machineId),
        load: isOnline,
    });
    // Stale metadata labels the rows; installing stays gated on the live capabilities status.
    const daemonMergedProjectionInputs = daemonMergedProjection.inputs;

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
        const entries = getInstallablesRegistryEntries({
            pluginProjection: daemonMergedProjectionInputs?.pluginProjectionV2 ?? undefined,
        });
        const results = capabilitiesSnapshot?.response.results;
        return entries.map((entry) => {
            const enabled = entry.enabledWhen();
            const status = entry.getStatus(results);
            const detectResult = entry.getDetectResult(results);
            const policy = resolveInstallablePolicy({
                settings: { installablesPolicyByMachineId },
                machineId: machineId ?? '',
                installableKey: entry.key,
                defaults: entry.defaultPolicy,
            });
            return { entry, enabled, status, detectResult, policy };
        });
    }, [capabilitiesSnapshot, daemonMergedProjectionInputs?.pluginProjectionV2, machineId, installablesPolicyByMachineId]);

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
        void policyAction.execute('settings.set', { anchor: 'machines.installables.policy', key: machineId,
            value: { installableKey, patch } }).then(result => {
            if (!result.ok) Modal.alert(t('common.error'), result.error);
        }).catch(error => {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : t('common.requestFailed'));
        });
    }, [machineId, policyAction.execute]);

    // Labels come from `t()`, so the options are rebuilt when the language changes.
    const preferredLanguage = getPreferredLanguage();
    const autoUpdateModeOptions = React.useMemo(buildAutoUpdateModeOptions, [preferredLanguage]);

    const visible = installables.filter((d) => d.enabled);
    const capabilitiesStatus = isOnline ? detectedCapabilities.status : 'idle';
    const refreshStatus = React.useCallback(() => refreshDetectedCapabilities(), [refreshDetectedCapabilities]);
    const checking = isOnline && detectedCapabilities.status === 'loading';
    // Like the machine's Agents: what is here, then what can be added. Only a finished answer makes a tool one
    // "to install"; a tool still being checked stays with the machine's tools and says so.
    const isAvailable = (d: (typeof visible)[number]) => d.status ? !d.status.installed : capabilitiesStatus === 'loaded';
    const here = visible.filter((d) => !isAvailable(d));
    const available = visible.filter(isAvailable);
    const row = (d: (typeof visible)[number], index: number, list: readonly unknown[]) => (
        <MachineToolRow
            key={d.entry.key}
            entry={d.entry}
            machineId={machineId}
            serverId={serverId}
            status={d.status}
            capabilitiesStatus={capabilitiesStatus}
            policy={d.policy}
            autoUpdateModeOptions={autoUpdateModeOptions}
            onPolicyChange={setPolicyPatch}
            refreshStatus={refreshStatus}
            refreshLatestVersion={isOnline
                ? () => refreshDetectedCapabilities({ request: d.entry.buildLatestVersionDetectRequest(), timeoutMs: 12_000 })
                : undefined}
            showDivider={index < list.length - 1}
        />
    );
    return (
        <>
            <ItemGroup
                description={machine ? t('machineDetailPage.toolsPage.description', { machine: machineSentenceName }) : undefined}
                action={isOnline ? (
                    <RoundButton
                        testID="machine-tools-check-again"
                        size="small"
                        display="inverted"
                        title={t('machineDetailPage.toolsPage.checkAgain')}
                        loading={checking && capabilitiesSnapshot !== null}
                        onPress={refreshStatus}
                    />
                ) : undefined}
            >
                {here.length > 0 ? here.map(row) : (
                    <SurfaceStateCard testID="machine-tools-empty" size="line" kind="empty" title={t('machineDetailPage.toolsPage.emptyInstalled')} />
                )}
            </ItemGroup>
            {available.length > 0 ? (
                <ItemGroup title={t('machineDetailPage.toolsPage.availableTitle')} description={t('machineDetailPage.toolsPage.availableDescription')}>
                    {available.map(row)}
                </ItemGroup>
            ) : null}
        </>
    );
}
