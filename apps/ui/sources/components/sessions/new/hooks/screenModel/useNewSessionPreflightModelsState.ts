import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { getModelOptionsForAgentTypeOrPreflight, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import {
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';

export function useNewSessionPreflightModelsState(params: Readonly<{
    agentType: AgentId;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
}>): Readonly<{
    preflightModels: PreflightModelList | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        refresh: () => void;
    }>;
}> {
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);

    const refresh = React.useCallback(() => {
        setRefreshNonce((n) => n + 1);
    }, []);

    const preflightModelsKey = React.useMemo(() => {
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            agentType: params.agentType,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
        });
    }, [params.agentType, params.capabilityServerId, params.cwd, params.selectedMachineId]);

    React.useEffect(() => {
        if (!preflightModelsKey) {
            setPreflightModels(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            return;
        }

        const shouldForceProbe = refreshNonce !== 0 && refreshNonce !== lastHandledRefreshNonceRef.current;
        if (shouldForceProbe) {
            lastHandledRefreshNonceRef.current = refreshNonce;
        }

        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        setPreflightModels(cached);
        setRefreshedAt(cacheEntry?.kind === 'success' ? cacheEntry.updatedAt : null);

        const nowMs = Date.now();
        if (!shouldForceProbe && cacheEntry && nowMs >= 0 && nowMs < cacheEntry.expiresAt) {
            setProbePhase('idle');
            return;
        }

        let cancelled = false;
        const run = async () => {
            const core = getAgentCore(params.agentType);
            if (core.model.supportsSelection !== true) return;
            if (!params.selectedMachineId) return;
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';

            setProbePhase(cached ? 'refreshing' : 'loading');
            const list = await runDynamicModelProbeDedupe(preflightModelsKey, async () => {
                const res = await machineCapabilitiesInvoke(params.selectedMachineId!, {
                    id: `cli.${params.agentType}` as any,
                    method: 'probeModels',
                    params: {
                        timeoutMs: 15_000,
                        ...(cwd ? { cwd } : {}),
                    },
                }, {
                    serverId: params.capabilityServerId,
                });

                if (!res.supported) return null;
                if (!res.response.ok) return null;

                const raw = res.response.result as any;
                const modelsRaw = raw?.availableModels;
                const supportsFreeformRaw = raw?.supportsFreeform;
                if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) return null;

                const parsed: PreflightModelList = {
                    availableModels: modelsRaw
                        .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                        .map((m: any) => ({
                            id: String(m.id),
                            name: String(m.name),
                            ...(typeof m.description === 'string' ? { description: m.description } : {}),
                        })),
                    supportsFreeform: Boolean(supportsFreeformRaw),
                };
                if (parsed.availableModels.length === 0) return null;
                return parsed;
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            if (list) {
                writeDynamicModelProbeCacheSuccess(preflightModelsKey, list, commitNowMs);
                setPreflightModels(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (cached) {
                // Keep stale-but-usable model lists sticky if a refresh probe fails.
                writeDynamicModelProbeCacheSuccess(preflightModelsKey, cached, commitNowMs);
                setPreflightModels(cached);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            writeDynamicModelProbeCacheError(preflightModelsKey, commitNowMs);
            setProbePhase('idle');
        };

        void run();
        return () => { cancelled = true; };
    }, [preflightModelsKey, params.agentType, params.selectedMachineId, params.capabilityServerId, params.cwd, refreshNonce]);

    const modelOptions = React.useMemo(
        () => getModelOptionsForAgentTypeOrPreflight({ agentType: params.agentType, preflight: preflightModels }),
        [params.agentType, preflightModels],
    );

    return {
        preflightModels,
        modelOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            refresh,
        },
    };
}
