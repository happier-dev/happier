import * as React from 'react';
import { buildBackendTargetKeyV2, readBackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { resolveAgentExecutionTargetForBackendTarget } from '@/agents/backendCatalog/resolveAgentExecutionTargetForBackendTarget';

import { resolveRunAnsweringEngine, resolveRunNativeModelLabel, type RunNativeModelCatalog } from './resolveExecutionRunSelectionLabel';
import { useRunSessionModels } from './useRunSessionModels';

/** One source for the recorded producer's name on readings, Run headers and every Ask composer. */
export function useRunAnsweringEngine(params: Omit<Parameters<typeof resolveRunAnsweringEngine>[0], 'sessionModels'> & Readonly<{
    sessionId?: string | null;
    serverId?: string | null;
    machineId?: string | null;
    cwd?: string | null;
    presented?: boolean;
}>) {
    const sessionModels = useRunSessionModels(params.sessionId, params.serverId);
    const sessionMachine = useSessionMachineTarget(params.sessionId ?? null, params.serverId);
    const target = React.useMemo(() => {
        try { return params.backendTarget ? readBackendTargetRefV2(params.backendTarget) : null; } catch { return null; }
    }, [params.backendTarget]);
    const native = !params.selection?.modelSelection?.providerConnectionId && !params.selection?.teamCredentialModel;
    const knownLabel = params.modelId
        ? resolveRunNativeModelLabel(target, params.catalogProfiles, params.selection, sessionModels)(params.modelId) : null;
    const targetKey = React.useMemo(() => target ? buildBackendTargetKeyV2(target) : null, [target]);
    const runtimeCarrierAgentId = React.useMemo(() => target?.configuredBackendId
        ? resolveAgentExecutionTargetForBackendTarget({ backendTarget: target })?.identity.localId
        : target?.backendId, [target]);
    // A recorded producer needs its exact Agent's names, never the picker's all-Agent profiles.
    // Reuse an already supplied catalog or recorded Session name before observing that one target.
    const models = useNewSessionPreflightModelsState({
        backendTarget: native ? target : null,
        runtimeCarrierAgentId,
        capabilityServerId: params.serverId ?? '',
        selectedMachineId: (params.sessionId ? sessionMachine?.machineId : params.machineId) ?? null,
        cwd: params.sessionId ? sessionMachine?.basePath : params.cwd,
        enabled: params.presented !== false && native && Boolean(target && params.modelId && !knownLabel),
    });
    const catalogProfiles = React.useMemo<RunNativeModelCatalog>(() => params.catalogProfiles
        ?? (targetKey ? models.preflightModels?.availableModels.map(model => ({
            title: model.name, modelSelector: { backendTargetKey: targetKey, modelId: model.id },
        })) ?? [] : []), [params.catalogProfiles, targetKey, models.preflightModels]);
    const engine = React.useMemo(() => resolveRunAnsweringEngine({
        backendTarget: target, modelId: params.modelId, selection: params.selection,
        sessionModels, catalogProfiles,
    }), [target, params.modelId, params.selection, sessionModels, catalogProfiles]);
    return { engine, sessionModels, catalogProfiles };
}
