import * as React from 'react';
import type { ConnectedServiceBindingsV2, PersistedBackendTargetRefV2 } from '@happier-dev/protocol';

import {
    resolveNewSessionCapabilityProbeContext,
    resolveNewSessionModelCapabilityProbeContext,
    resolveNewSessionOperationalBackendTarget,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { Settings } from '@/sync/domains/settings/settings';
import type {
    AgentPluginSettingsReadiness,
    AgentPluginSettingsSnapshot,
} from '@/agents/registry/registryUiBehavior';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import { useNewSessionPreflightSessionModesState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState';

type ModelOptionsProbeState = ReturnType<typeof useNewSessionPreflightModelsState>['probe'];

type AcpSessionModeProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
}>;

type AcpConfigOptionsProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh: () => void;
}>;

export function useNewSessionScreenPreflightState(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    runtimeCarrierAgentId?: string | null;
    selectedProfileId?: string | null;
    settings: Settings;
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    pluginSettingsReadiness?: AgentPluginSettingsReadiness | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    connectedServicesBindingsPayload?: ConnectedServiceBindingsV2 | null;
    connectedServicesModelProbeCacheIdentity?: string | null;
    /** Inherited authentication cannot be probed as Native while its catalog is unread. */
    connectedAccountDefaultsReady?: boolean;
    /**
     * `false`: read cached probe results only and send no probe to the machine (an embedded
     * composer before the person reaches for it). Cache identity is unchanged, so the probes
     * that start on intent land in the same entries.
     */
    machineProbesEnabled?: boolean;
}>): Readonly<{
    preflightModels: ReturnType<typeof useNewSessionPreflightModelsState>['preflightModels'];
    preflightModelsTargetKey: ReturnType<typeof useNewSessionPreflightModelsState>['preflightModelsTargetKey'];
    modelOptions: ReturnType<typeof useNewSessionPreflightModelsState>['modelOptions'];
    modelOptionsProbeState: ModelOptionsProbeState;
    preflightSessionModes: ReturnType<typeof useNewSessionPreflightSessionModesState>['preflightModes'];
    acpSessionModeOptions: ReturnType<typeof useNewSessionPreflightSessionModesState>['modeOptions'];
    acpSessionModeProbeState: AcpSessionModeProbeState;
    acpConfigOptions: ReturnType<typeof useNewSessionPreflightConfigOptionsState>['configOptions'];
    acpConfigOptionsProbeState: AcpConfigOptionsProbeState;
}> {
    const pluginSettingsReady = params.pluginSettingsReadiness === null
        || params.pluginSettingsReadiness === undefined
        || params.pluginSettingsReadiness.ready;
    const probesEnabled = pluginSettingsReady && params.connectedAccountDefaultsReady !== false;
    const effectivePluginSettings = probesEnabled ? params.pluginSettings : null;
    const machineProbesEnabled = probesEnabled && params.machineProbesEnabled !== false;
    const operationalBackendTarget = React.useMemo(() => resolveNewSessionOperationalBackendTarget({
        backendTarget: params.backendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
    }), [params.backendTarget, params.runtimeCarrierAgentId]);
    const capabilityProbeContext = React.useMemo(() => {
        if (!probesEnabled) return null;
        return resolveNewSessionCapabilityProbeContext({
            backendTarget: params.backendTarget,
            settings: params.settings,
            selectedProfileId: params.selectedProfileId,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            machineId: params.selectedMachineId,
            pluginSettings: effectivePluginSettings,
        });
    }, [effectivePluginSettings, params.backendTarget, params.runtimeCarrierAgentId, params.selectedMachineId, params.selectedProfileId, params.settings, probesEnabled]);
    const modelCapabilityProbeContext = React.useMemo(() => {
        if (!probesEnabled) return null;
        return resolveNewSessionModelCapabilityProbeContext({
            backendTarget: params.backendTarget,
            settings: params.settings,
            selectedProfileId: params.selectedProfileId,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            machineId: params.selectedMachineId,
            pluginSettings: effectivePluginSettings,
            connectedServices: params.connectedServicesBindingsPayload,
            connectedServicesCacheIdentity: params.connectedServicesModelProbeCacheIdentity,
        });
    }, [effectivePluginSettings, params.backendTarget, params.connectedServicesBindingsPayload, params.connectedServicesModelProbeCacheIdentity, params.runtimeCarrierAgentId, params.selectedMachineId, params.selectedProfileId, params.settings, probesEnabled]);

    const { preflightModels, preflightModelsTargetKey, modelOptions, probe: modelOptionsProbe } = useNewSessionPreflightModelsState({
        backendTarget: operationalBackendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: modelCapabilityProbeContext,
        enabled: machineProbesEnabled,
    });
    const { preflightModes: preflightSessionModes, modeOptions: acpSessionModeOptions, probe: acpSessionModeProbe } =
        useNewSessionPreflightSessionModesState({
            backendTarget: operationalBackendTarget,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            selectedMachineId: params.selectedMachineId,
            capabilityServerId: params.capabilityServerId,
            cwd: params.cwd,
            probeContext: capabilityProbeContext,
            enabled: machineProbesEnabled,
        });
    const { configOptions: acpConfigOptions, probe: acpConfigOptionsProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: operationalBackendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: capabilityProbeContext,
        enabled: machineProbesEnabled,
    });

    return {
        preflightModels,
        preflightModelsTargetKey,
        modelOptions,
        modelOptionsProbeState: modelOptionsProbe,
        preflightSessionModes,
        acpSessionModeOptions,
        acpSessionModeProbeState: {
            phase: acpSessionModeProbe.phase,
            onRefresh: acpSessionModeProbe.onRefresh,
        },
        acpConfigOptions,
        acpConfigOptionsProbeState: {
            phase: acpConfigOptionsProbe.phase,
            onRefresh: acpConfigOptionsProbe.onRefresh,
        },
    };
}
