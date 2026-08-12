import * as React from 'react';
import type { BackendTargetRefV2, ConnectedServiceBindingsV1 } from '@happier-dev/protocol';

import type { AgentId } from '@/agents/catalog/catalog';
import { resolveNewSessionCapabilityProbeContext, resolveNewSessionModelCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import type { Settings } from '@/sync/domains/settings/settings';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useNewSessionPreflightConfigOptionsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState';
import { useNewSessionPreflightSessionModesState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState';

type ModelOptionsProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
}>;

type AcpSessionModeProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh?: () => void;
}>;

type AcpConfigOptionsProbeState = Readonly<{
    phase: 'idle' | 'loading' | 'refreshing';
    onRefresh: () => void;
}>;

export function useNewSessionScreenPreflightState(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    runtimeCarrierAgentId?: AgentId | null;
    settings: Settings;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd: string | null;
    connectedServicesBindingsPayload?: ConnectedServiceBindingsV1 | null;
    connectedServicesModelProbeCacheIdentity?: string | null;
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
    const capabilityProbeContext = React.useMemo(() => {
        return resolveNewSessionCapabilityProbeContext({
            backendTarget: params.backendTarget,
            settings: params.settings,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        });
    }, [params.backendTarget, params.runtimeCarrierAgentId, params.settings]);
    const modelCapabilityProbeContext = React.useMemo(() => {
        return resolveNewSessionModelCapabilityProbeContext({
            backendTarget: params.backendTarget,
            settings: params.settings,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            connectedServices: params.connectedServicesBindingsPayload,
            connectedServicesCacheIdentity: params.connectedServicesModelProbeCacheIdentity,
        });
    }, [params.backendTarget, params.connectedServicesBindingsPayload, params.connectedServicesModelProbeCacheIdentity, params.runtimeCarrierAgentId, params.settings]);

    const { preflightModels, preflightModelsTargetKey, modelOptions, probe: modelOptionsProbe } = useNewSessionPreflightModelsState({
        backendTarget: params.backendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: modelCapabilityProbeContext,
    });
    const { preflightModes: preflightSessionModes, modeOptions: acpSessionModeOptions, probe: acpSessionModeProbe } =
        useNewSessionPreflightSessionModesState({
            backendTarget: params.backendTarget,
            runtimeCarrierAgentId: params.runtimeCarrierAgentId,
            selectedMachineId: params.selectedMachineId,
            capabilityServerId: params.capabilityServerId,
            cwd: params.cwd,
            probeContext: capabilityProbeContext,
        });
    const { configOptions: acpConfigOptions, probe: acpConfigOptionsProbe } = useNewSessionPreflightConfigOptionsState({
        backendTarget: params.backendTarget,
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        selectedMachineId: params.selectedMachineId,
        capabilityServerId: params.capabilityServerId,
        cwd: params.cwd,
        probeContext: capabilityProbeContext,
    });

    return {
        preflightModels,
        preflightModelsTargetKey,
        modelOptions,
        modelOptionsProbeState: {
            phase: modelOptionsProbe.phase,
            onRefresh: modelOptionsProbe.onRefresh,
        },
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
