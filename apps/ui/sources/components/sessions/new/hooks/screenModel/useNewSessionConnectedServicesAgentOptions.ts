import * as React from 'react';

import { getAgentCore, buildNewSessionOptionsFromUiState, type AgentId } from '@/agents/catalog/catalog';
import {
    useNewSessionConnectedServices,
    type NewSessionConnectedServicesResult,
} from '@/components/sessions/new/modules/useNewSessionConnectedServices';

type BackendNewSessionOptionStateByTargetKey = Record<string, Record<string, unknown>>;
type ConnectedServicesParams = Parameters<typeof useNewSessionConnectedServices>[0];

export function useNewSessionConnectedServicesAgentOptions(params: Readonly<{
    /** Explicit bundled behavior backing for connected-services controls. */
    staticAgentId?: AgentId | null;
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
        const base = staticAgentId
            ? buildNewSessionOptionsFromUiState({ agentId: staticAgentId, agentOptionState: params.agentOptionState }) ?? {}
            : {};
        const merged: Record<string, unknown> = { ...base };
        if (connectedServicesBindingsPayload) {
            merged.connectedServices = connectedServicesBindingsPayload;
        }
        return Object.keys(merged).length > 0 ? merged : null;
    }, [params.agentOptionState, staticAgentId, connectedServicesBindingsPayload]);

    return {
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        connectedServicesBindingsPayload,
        connectedServicesModelProbeCacheIdentity,
        agentNewSessionOptions,
    };
}
