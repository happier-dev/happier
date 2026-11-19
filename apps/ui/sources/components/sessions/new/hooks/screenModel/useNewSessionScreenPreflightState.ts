import * as React from 'react';
import type { ConnectedServiceBindingsV2} from '@happier-dev/protocol/connect/connected-service-bindings';
import type { PersistedBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

import {
    resolveNewSessionCapabilityProbeContext,
    resolveNewSessionModelCapabilityProbeContext,
    resolveNewSessionOperationalBackendTarget,
    withNewSessionConfigOptionOverrides,
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

type AcpConfigOptionsProbeState = ReturnType<typeof useNewSessionPreflightConfigOptionsState>['probe'];

export function useNewSessionScreenPreflightState(params: Readonly<{
    backendTarget: PersistedBackendTargetRefV2;
    modelId?: string | null;
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
    configOptionOverrides?: Readonly<Record<string, string>> | null;
}>): Readonly<{
    connectedAccountSelected: boolean;
    preflightModels: ReturnType<typeof useNewSessionPreflightModelsState>['preflightModels'];
    preflightModelsTargetKey: ReturnType<typeof useNewSessionPreflightModelsState>['preflightModelsTargetKey'];
    modelOptions: ReturnType<typeof useNewSessionPreflightModelsState>['modelOptions'];
    modelOptionsProbeState: ModelOptionsProbeState;
    preflightSessionModes: ReturnType<typeof useNewSessionPreflightSessionModesState>['preflightModes'];
    acpSessionModeOptions: ReturnType<typeof useNewSessionPreflightSessionModesState>['modeOptions'];
    acpSessionModeProbeState: AcpSessionModeProbeState;
    acpConfigOptions: ReturnType<typeof useNewSessionPreflightConfigOptionsState>['configOptions'];
    acpConfigOptionsUnavailable: boolean;
    acpModelConfigOptionId: ReturnType<typeof useNewSessionPreflightConfigOptionsState>['modelConfigOptionId'];
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
            modelId: params.modelId,
            settings,
            selectedProfileId: params.selectedProfileId,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            machineId: params.selectedMachineId,
            pluginSettings: effectivePluginSettings,
        });
    }, [effectivePluginSettings, params.backendTarget, params.modelId, params.runtimeCarrierAgentId, params.selectedMachineId, params.selectedProfileId, probesEnabled]), runtimeSettingsKeys);
    const modelCapabilityProbeContext = useSettingsSelector(React.useCallback((settings) => {
        if (!probesEnabled) return null;
        return resolveNewSessionModelCapabilityProbeContext({
            backendTarget: params.backendTarget,
            modelId: params.modelId,
            settings,
            selectedProfileId: params.selectedProfileId,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            machineId: params.selectedMachineId,
            pluginSettings: effectivePluginSettings,
            connectedServices: params.connectedServicesBindingsPayload,
            connectedServicesCacheIdentity: params.connectedServicesModelProbeCacheIdentity,
        });
    }, [effectivePluginSettings, params.backendTarget, params.connectedServicesBindingsPayload, params.connectedServicesModelProbeCacheIdentity, params.modelId, params.runtimeCarrierAgentId, params.selectedMachineId, params.selectedProfileId, probesEnabled]), runtimeSettingsKeys);

    const { usesNativeCatalog, connectedAccountSelected, preflightModels, preflightModelsTargetKey, modelOptions, probe: modelOptionsProbe } = useNewSessionPreflightModelsState({
        backendTarget: operationalBackendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: withNewSessionConfigOptionOverrides(modelCapabilityProbeContext, params.configOptionOverrides),
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
            probeContext: withNewSessionConfigOptionOverrides(capabilityProbeContext, params.configOptionOverrides),
            enabled: machineProbesEnabled,
        });
    const { configOptions: acpConfigOptions, unavailable: acpConfigOptionsUnavailable, modelConfigOptionId: acpModelConfigOptionId, probe: acpConfigOptionsProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: operationalBackendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: withNewSessionConfigOptionOverrides(capabilityProbeContext, params.configOptionOverrides),
        enabled: machineProbesEnabled && usesNativeCatalog,
    });

    return {
        connectedAccountSelected,
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
        acpConfigOptionsUnavailable,
        acpModelConfigOptionId,
        acpConfigOptionsProbeState: acpConfigOptionsProbe,
    };
}
