import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { coerceNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import { useNewSessionAgentPickerControls } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentPickerControls';
import type { ModelMode } from '@/sync/domains/permissions/permissionTypes';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';

type AgentPickerControlsParams = Parameters<typeof useNewSessionAgentPickerControls>[0];

export function useNewSessionAgentSelectionModelModeReconciliation(
    params: Readonly<AgentPickerControlsParams & {
        agentType: AgentId;
        preflightModels: PreflightModelList | null;
        preflightModelsTargetKey: string | null;
    }>,
): ReturnType<typeof useNewSessionAgentPickerControls> {
    React.useEffect(() => {
        const core = getAgentCore(params.agentType);
        const next = coerceNewSessionModelMode({
            modelMode: String(params.modelMode),
            modelConfig: {
                defaultMode: core.model.defaultMode,
                allowedModes: core.model.allowedModes,
                supportsFreeform: core.model.supportsFreeform,
                dynamicProbe: core.model.dynamicProbe ?? 'auto',
            },
            preflight: params.preflightModels
                ? {
                    availableModels: params.preflightModels.availableModels.map((m) => ({ id: m.id })),
                    supportsFreeform: params.preflightModels.supportsFreeform === true,
                    targetKey: params.preflightModelsTargetKey,
                }
                : null,
            currentTargetKey: params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey,
        });
        if (next !== params.modelMode) {
            params.setModelMode(next as ModelMode);
        }
    }, [
        params.agentType,
        params.modelMode,
        params.preflightModels,
        params.preflightModelsTargetKey,
        params.selectedBackendEntry?.backendTargetKey,
        params.selectedBackendTargetKey,
    ]);

    return useNewSessionAgentPickerControls(params);
}
