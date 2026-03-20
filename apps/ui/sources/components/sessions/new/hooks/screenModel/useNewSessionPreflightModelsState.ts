import * as React from 'react';
import { buildBackendTargetKey, isBuiltInAgentTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
    backendTarget: BackendTargetRefV1;
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

    const backendTargetKind = params.backendTarget.kind;
    const backendTargetAgentId = isBuiltInAgentTarget(params.backendTarget) ? params.backendTarget.agentId : null;
    const backendTargetBackendId = isBuiltInAgentTarget(params.backendTarget) ? null : params.backendTarget.backendId;

    const backendTarget = React.useMemo<BackendTargetRefV1>(() => {
        return backendTargetKind === 'builtInAgent'
            ? { kind: 'builtInAgent', agentId: backendTargetAgentId! }
            : { kind: 'configuredAcpBackend', backendId: backendTargetBackendId! };
    }, [backendTargetAgentId, backendTargetBackendId, backendTargetKind]);

    const agentType = React.useMemo<AgentId>(() => {
        return resolveProviderAgentIdForBackendTarget(backendTarget);
    }, [backendTarget]);

    const backendTargetKey = React.useMemo(() => buildBackendTargetKey(backendTarget), [backendTarget]);

    const preflightModelsKey = React.useMemo(() => {
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
        });
    }, [backendTargetKey, params.capabilityServerId, params.cwd, params.selectedMachineId]);

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
            const core = getAgentCore(agentType);
            if (core.model.supportsSelection !== true || !params.selectedMachineId) {
                if (!cancelled) {
                    setProbePhase('idle');
                }
                return;
            }
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';

            setProbePhase(cached ? 'refreshing' : 'loading');
            const list = await runDynamicModelProbeDedupe(preflightModelsKey, async () => {
                const res = await machineCapabilitiesInvoke(params.selectedMachineId!, {
                    id: `cli.${agentType}` as any,
                    method: 'probeModels',
                    params: {
                        timeoutMs: 15_000,
                        backendTarget,
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
                if (!Array.isArray(modelsRaw)) return null;

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
                if (parsed.availableModels.length === 0 && parsed.supportsFreeform !== true) return null;
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
    }, [agentType, backendTarget, preflightModelsKey, params.selectedMachineId, params.capabilityServerId, params.cwd, refreshNonce]);

    const modelOptions = React.useMemo(
        () => getModelOptionsForAgentTypeOrPreflight({ agentType, preflight: preflightModels }),
        [agentType, preflightModels],
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
