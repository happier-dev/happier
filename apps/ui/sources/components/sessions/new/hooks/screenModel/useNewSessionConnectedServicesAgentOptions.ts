import * as React from 'react';

import { getAgentCore, buildNewSessionOptionsFromUiState, type AgentId } from '@/agents/catalog/catalog';
import {
    useNewSessionConnectedServices,
    type NewSessionConnectedServicesResult,
} from '@/components/sessions/new/modules/useNewSessionConnectedServices';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';

type BackendNewSessionOptionStateByTargetKey = Record<string, Record<string, unknown>>;
type ConnectedServicesParams = Parameters<typeof useNewSessionConnectedServices>[0];

export function useNewSessionConnectedServicesAgentOptions(params: Readonly<{
    /** Explicit bundled behavior backing for connected-services controls. */
    staticAgentId?: AgentId | null;
    /**
     * The Agent that will actually run the Session. An installed Agent has no
     * bundled presentation id, so the declared option base must be built from
     * the operational identity the composer rendered those options under.
     */
    runtimeCarrierAgentId?: AgentId | null;
    /**
     * The machine the composer is about to spawn on. An installed Agent's
     * option declaration is a per-machine fact.
     */
    selectedMachineId?: string | null;
    /** @deprecated Direct callers without a projected backend entry are bundled-only. */
    agentType?: AgentId;
    targetServerId: string | null;
    selectedBackendTargetKey: string;
    setBackendNewSessionOptionStateByTargetKey: React.Dispatch<React.SetStateAction<BackendNewSessionOptionStateByTargetKey>>;
    agentOptionState: Record<string, unknown> | null;
    settings: ConnectedServicesParams['settings'];
    router: ConnectedServicesParams['router'];
}>): Readonly<{
    setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
    connectedServicesAuthChip: NewSessionConnectedServicesResult['connectedServicesAuthChip'];
    connectedServicesBindingsPayload: NewSessionConnectedServicesResult['connectedServicesBindingsPayload'];
    connectedServicesModelProbeCacheIdentity: NewSessionConnectedServicesResult['connectedServicesModelProbeCacheIdentity'];
    agentNewSessionOptions: Record<string, unknown> | null;
}> {
    const staticAgentId = params.staticAgentId ?? params.agentType ?? null;
    const behaviorAgentId = resolveNewSessionBehaviorAgentId({
        runtimeCarrierAgentId: params.runtimeCarrierAgentId,
        staticAgentId,
    });
    const selectedMachineId = params.selectedMachineId ?? null;
    const agentCore = React.useMemo(
        () => staticAgentId ? getAgentCore(staticAgentId) : null,
        [staticAgentId],
    );

    const setAgentOptionStateForCurrentAgent = React.useCallback((key: string, value: unknown) => {
        params.setBackendNewSessionOptionStateByTargetKey((prev) => {
            const current = prev[params.selectedBackendTargetKey] ?? {};
            const nextForTarget = { ...current, [key]: value };
            return { ...prev, [params.selectedBackendTargetKey]: nextForTarget };
        });
    }, [params.selectedBackendTargetKey]);

    const { connectedServicesBindingsPayload, connectedServicesModelProbeCacheIdentity, connectedServicesAuthChip } = useNewSessionConnectedServices({
        agentCore,
        agentOptionState: params.agentOptionState,
        settings: params.settings,
        targetServerId: params.targetServerId,
        router: params.router,
        setAgentOptionStateForCurrentAgent,
    });

    const agentNewSessionOptions = React.useMemo(() => {
        const base = behaviorAgentId
            ? buildNewSessionOptionsFromUiState({
                agentId: behaviorAgentId,
                agentOptionState: params.agentOptionState,
                machineId: selectedMachineId,
            }) ?? {}
            : {};
        const merged: Record<string, unknown> = { ...base };
        if (connectedServicesBindingsPayload) {
            merged.connectedServices = connectedServicesBindingsPayload;
        }
        return Object.keys(merged).length > 0 ? merged : null;
    }, [params.agentOptionState, behaviorAgentId, selectedMachineId, connectedServicesBindingsPayload]);

    return {
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        connectedServicesBindingsPayload,
        connectedServicesModelProbeCacheIdentity,
        agentNewSessionOptions,
    };
}
