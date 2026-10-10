import * as React from 'react';

import { getAgentCore, buildNewSessionOptionsFromUiState, type AgentId } from '@/agents/catalog/catalog';
import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import type { DaemonMergedProjectionInputsState } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import {
    useNewSessionConnectedServices,
    type NewSessionConnectedServicesResult,
} from '@/components/sessions/new/modules/useNewSessionConnectedServices';
import { resolveNewSessionBehaviorAgentId } from '@/components/sessions/new/modules/newSessionBehaviorAgent';

type BackendNewSessionOptionStateByTargetKey = Record<string, Record<string, unknown>>;
type ConnectedServicesParams = Parameters<typeof useNewSessionConnectedServices>[0];

/** Account-choice metadata for the selected target; never execution admission. */
export function resolveNewSessionConnectedServicesAgent(params: Readonly<{
    projection: DaemonMergedProjectionInputsState;
    selectedBackendTargetKey: string;
    catalog: Omit<Parameters<typeof getResolvedBackendCatalogEntries>[0],
        'mergedProviderProjectionById' | 'mergedBackendProjectionById' | 'discoveredBackendIds'>;
}>): ResolvedAgentCatalogEntry | null {
    // The projection hook fences Account/Machine scope and retains declarations
    // during a refresh. Choosing an Account credential does not ask the daemon
    // to execute anything and must stay available to resolve native sign-out.
    const inputs = params.projection.inputs;
    return getResolvedBackendCatalogEntries({
        ...params.catalog,
        mergedProviderProjectionById: inputs?.mergedProviderProjectionById,
        mergedBackendProjectionById: inputs?.mergedBackendProjectionById,
        discoveredBackendIds: inputs?.discoveredBackendIds,
    }).find((entry) => entry.backendTargetKey === params.selectedBackendTargetKey)?.agentCatalogEntry ?? null;
}

export function useNewSessionConnectedServicesAgentOptions(params: Readonly<{
    /** Explicit bundled behavior backing for connected-services controls. */
    staticAgentId?: AgentId | null;
    /**
     * The Agent that will actually run the Session. An installed Agent has no
     * bundled presentation id, so the declared option base must be built from
     * the operational identity the composer rendered those options under.
     */
    runtimeCarrierAgentId?: string | null;
    /**
     * The machine the composer is about to spawn on. An installed Agent's
     * option declaration is a per-machine fact.
     */
    selectedMachineId?: string | null;
    /** @deprecated Direct callers without a projected backend entry are bundled-only. */
    agentType?: AgentId;
    targetServerId: string | null;
    selectedBackendTargetKey: string;
    /**
     * Exact Connected Account declarations from the authoritative machine Agent
     * catalog projection for the selected target. Session connected-account
     * selection keys are the canonical qualified keys of these declarations.
     */
    connectedAccounts?: ResolvedAgentCatalogEntry['connectedAccounts'];
    /** The selected Agent's contribution identity; it keys the Agent's default authentication. */
    agentIdentity?: ResolvedAgentCatalogEntry['identity'];
    teamCredentialResources?: ConnectedServicesParams['teamCredentialResources'];
    modelSelection?: ConnectedServicesParams['modelSelection'];
    providerSources?: ConnectedServicesParams['providerSources'];
    providerSettings?: ConnectedServicesParams['providerSettings'];
    providerProjection?: ConnectedServicesParams['providerProjection'];
    modelRouteTeamSources?: ConnectedServicesParams['modelRouteTeamSources'];
    teamCredentialResourceCurrentKeys?: ConnectedServicesParams['teamCredentialResourceCurrentKeys'];
    teamNameById?: ConnectedServicesParams['teamNameById'];
    applyTeamCredentialPolicy?: ConnectedServicesParams['applyTeamCredentialPolicy'];
    setBackendNewSessionOptionStateByTargetKey: React.Dispatch<React.SetStateAction<BackendNewSessionOptionStateByTargetKey>>;
    agentOptionState: Record<string, unknown> | null;
    machineAgent?: ConnectedServicesParams['machineAgent'];
    settings: ConnectedServicesParams['settings'];
    router: ConnectedServicesParams['router'];
}>): Readonly<{
    setAgentOptionStateForCurrentAgent: (key: string, value: unknown) => void;
    connectedServicesAuthChip: NewSessionConnectedServicesResult['connectedServicesAuthChip'];
    routePresentation: NewSessionConnectedServicesResult['routePresentation'];
    requesterSignInPurposes: NewSessionConnectedServicesResult['requesterSignInPurposes'];
    connectedServicesBindingsPayload: NewSessionConnectedServicesResult['connectedServicesBindingsPayload'];
    connectedServicesModelProbeCacheIdentity: NewSessionConnectedServicesResult['connectedServicesModelProbeCacheIdentity'];
    connectedAccountDefaultsStatus: NewSessionConnectedServicesResult['connectedAccountDefaultsStatus'];
    requireConnectedAccountDefaultsReady: NewSessionConnectedServicesResult['requireConnectedAccountDefaultsReady'];
    agentNewSessionOptions: Record<string, unknown> | null;
    selectedCredentialMachineAgent: NewSessionConnectedServicesResult['selectedCredentialMachineAgent'];
    connectedServicesRecoveryAction: NewSessionConnectedServicesResult['connectedServicesRecoveryAction'];
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

    const { connectedAccountDefaultsStatus, requireConnectedAccountDefaultsReady,
        connectedServicesBindingsPayload, connectedServicesModelProbeCacheIdentity, connectedServicesAuthChip,
        selectedCredentialMachineAgent, connectedServicesRecoveryAction, routePresentation, requesterSignInPurposes } = useNewSessionConnectedServices({
        modelSelection: params.modelSelection,
        providerSources: params.providerSources,
        providerSettings: params.providerSettings,
        providerProjection: params.providerProjection,
        modelRouteTeamSources: params.modelRouteTeamSources,
        agentCore,
        defaultAuthAgentId: behaviorAgentId,
        defaultAuthConsumer: params.agentIdentity ?? null,
        connectedAccounts: params.connectedAccounts ?? [],
        agentOptionState: params.agentOptionState,
        machineAgent: params.machineAgent,
        settings: params.settings,
        targetServerId: params.targetServerId,
        sourceMachineId: selectedMachineId,
        teamCredentialResources: params.teamCredentialResources,
        teamCredentialResourceCurrentKeys: params.teamCredentialResourceCurrentKeys,
        teamNameById: params.teamNameById,
        router: params.router,
        setAgentOptionStateForCurrentAgent,
        applyTeamCredentialPolicy: params.applyTeamCredentialPolicy,
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
        routePresentation,
        requesterSignInPurposes,
        setAgentOptionStateForCurrentAgent,
        connectedServicesAuthChip,
        connectedServicesBindingsPayload,
        connectedServicesModelProbeCacheIdentity,
        connectedAccountDefaultsStatus,
        requireConnectedAccountDefaultsReady,
        agentNewSessionOptions,
        selectedCredentialMachineAgent,
        connectedServicesRecoveryAction,
    };
}
