import * as React from 'react';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { coerceNewSessionModelMode } from '@/components/sessions/new/hooks/newSessionModelModePolicy';
import { useNewSessionAgentPickerControls } from '@/components/sessions/new/hooks/screenModel/useNewSessionAgentPickerControls';
import type { PreflightModelList } from '@/sync/domains/models/modelOptions';

type AgentPickerControlsParams = Parameters<typeof useNewSessionAgentPickerControls>[0];

export function useNewSessionAgentSelectionModelModeReconciliation(
    params: Readonly<AgentPickerControlsParams & {
        agentType: string;
        preflightModels: PreflightModelList | null;
        preflightModelsTargetKey: string | null;
    }>,
): ReturnType<typeof useNewSessionAgentPickerControls> {
    React.useEffect(() => {
        const core = isBundledAgentId(params.agentType) ? getAgentCore(params.agentType) : null;
        const next = coerceNewSessionModelMode({
            modelMode: String(params.modelMode),
            modelConfig: {
                defaultMode: core?.model.defaultMode ?? 'default',
                allowedModes: core?.model.allowedModes ?? [],
                supportsFreeform: core?.model.supportsFreeform ?? false,
                freeformModelIdPrefixes: core?.model.freeformModelIdPrefixes ?? [],
                dynamicProbe: core?.model.dynamicProbe ?? 'auto',
            },
            preflight: params.preflightModels
                ? {
                    availableModels: params.preflightModels.availableModels.map((m) => ({ id: m.id, name: m.name })),
                    supportsFreeform: params.preflightModels.supportsFreeform === true,
                    unavailable: params.preflightModels.unavailable === true,
                    targetKey: params.preflightModelsTargetKey,
                }
                : null,
            currentTargetKey: params.selectedBackendEntry?.backendTargetKey ?? params.selectedBackendTargetKey,
        });
        if (next !== params.modelMode) {
            params.setModelMode(next);
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
