import * as React from 'react';
import type { ConnectedServiceBindingsV2, PersistedBackendTargetRefV2 } from '@happier-dev/protocol';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

import {
    resolveNewSessionCapabilityProbeContext,
    resolveNewSessionModelCapabilityProbeContext,
    resolveNewSessionOperationalBackendTarget,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { useSettingsSelector } from '@/sync/store/hooks';
import { getAgentUiSettingsKeys } from '@/agents/catalog/useAgentUiSettings';
import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
    pluginSettings?: AgentPluginSettingsSnapshot | null;
    pluginSettingsReadiness?: AgentPluginSettingsReadiness | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    connectedServicesBindingsPayload?: ConnectedServiceBindingsV2 | null;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
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
    const behaviorAgentId = params.runtimeCarrierAgentId?.trim()
        || resolveCatalogAgentIdForBackendTarget(operationalBackendTarget);
    const runtimeSettingsKeys = getAgentUiSettingsKeys({
        agentIds: behaviorAgentId ? [behaviorAgentId] : [],
        machineId: params.selectedMachineId,
        domain: 'runtime',
    });
    const capabilityProbeContext = useSettingsSelector(React.useCallback((settings) => {
        if (!probesEnabled) return null;
        return resolveNewSessionCapabilityProbeContext({
            backendTarget: params.backendTarget,
            settings,
            selectedProfileId: params.selectedProfileId,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            machineId: params.selectedMachineId,
            pluginSettings: effectivePluginSettings,
        });
    }, [effectivePluginSettings, params.backendTarget, params.runtimeCarrierAgentId, params.selectedMachineId, params.selectedProfileId, probesEnabled]), runtimeSettingsKeys);
    const modelCapabilityProbeContext = useSettingsSelector(React.useCallback((settings) => {
        if (!probesEnabled) return null;
        return resolveNewSessionModelCapabilityProbeContext({
            backendTarget: params.backendTarget,
            settings,
            selectedProfileId: params.selectedProfileId,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            machineId: params.selectedMachineId,
            pluginSettings: effectivePluginSettings,
            connectedServices: params.connectedServicesBindingsPayload,
            connectedServicesCacheIdentity: params.connectedServicesModelProbeCacheIdentity,
        });
    }, [effectivePluginSettings, params.backendTarget, params.connectedServicesBindingsPayload, params.connectedServicesModelProbeCacheIdentity, params.runtimeCarrierAgentId, params.selectedMachineId, params.selectedProfileId, probesEnabled]), runtimeSettingsKeys);

    const { preflightModels, preflightModelsTargetKey, modelOptions, probe: modelOptionsProbe } = useNewSessionPreflightModelsState({
        backendTarget: operationalBackendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: modelCapabilityProbeContext,
        selectedTeamCredentialModel: params.selectedTeamCredentialModel,
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
