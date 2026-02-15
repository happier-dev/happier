import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { getModelOptionsForAgentTypeOrPreflight, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import { buildPreflightModelCacheKey } from '@/components/sessions/new/modules/preflightModelCacheKey';

export function useNewSessionPreflightModelsState(params: Readonly<{
    agentType: AgentId;
    selectedMachineId: string | null;
    capabilityServerId: string;
}>): Readonly<{
    preflightModels: PreflightModelList | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
}> {
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const preflightModelsCacheRef = React.useRef(new Map<string, PreflightModelList>());

    const preflightModelsKey = React.useMemo(() => {
        return buildPreflightModelCacheKey({
            machineId: params.selectedMachineId,
            agentType: params.agentType,
            serverId: params.capabilityServerId,
        });
    }, [params.agentType, params.capabilityServerId, params.selectedMachineId]);

    React.useEffect(() => {
        if (!preflightModelsKey) {
            setPreflightModels(null);
            return;
        }

        const cached = preflightModelsCacheRef.current.get(preflightModelsKey) ?? null;
        setPreflightModels(cached);

        let cancelled = false;
        const run = async () => {
            const core = getAgentCore(params.agentType);
            if (core.model.supportsSelection !== true) return;
            if (!params.selectedMachineId) return;

            const res = await machineCapabilitiesInvoke(params.selectedMachineId, {
                id: `cli.${params.agentType}` as any,
                method: 'probeModels',
                params: { timeoutMs: 3500 },
            }, {
                serverId: params.capabilityServerId,
            });
            if (cancelled) return;
            if (!res.supported) return;
            if (!res.response.ok) return;

            const raw = res.response.result as any;
            const modelsRaw = raw?.availableModels;
            const supportsFreeformRaw = raw?.supportsFreeform;
            if (!Array.isArray(modelsRaw)) return;

            const list: PreflightModelList = {
                availableModels: modelsRaw
                    .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                    .map((m: any) => ({
                        id: String(m.id),
                        name: String(m.name),
                        ...(typeof m.description === 'string' ? { description: m.description } : {}),
                    })),
                supportsFreeform: Boolean(supportsFreeformRaw),
            };

            preflightModelsCacheRef.current.set(preflightModelsKey, list);
            setPreflightModels(list);
        };

        void run();
        return () => { cancelled = true; };
    }, [preflightModelsKey, params.agentType, params.selectedMachineId, params.capabilityServerId]);

    const modelOptions = React.useMemo(
        () => getModelOptionsForAgentTypeOrPreflight({ agentType: params.agentType, preflight: preflightModels }),
        [params.agentType, preflightModels],
    );

    return { preflightModels, modelOptions };
}

