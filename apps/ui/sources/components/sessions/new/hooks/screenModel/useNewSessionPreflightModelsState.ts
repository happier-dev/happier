import * as React from 'react';
import { buildBackendTargetKey, isBuiltInAgentTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { getModelOptionsForAgentTypeOrPreflight, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import type { AcpConfigOption } from '@/sync/acp/configOptionsControl';
import {
    DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import type { NewSessionCapabilityProbeContext } from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { scheduleProbedResourceRetryAfterExpiry } from './probedResourceRetrySchedule';

export function useNewSessionPreflightModelsState(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
}>): Readonly<{
    preflightModels: PreflightModelList | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        onRefresh: () => void;
    }>;
}> {
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const preflightModelsRef = React.useRef<PreflightModelList | null>(null);
    const refreshedAtRef = React.useRef<number | null>(null);
    const lastScopeKeyRef = React.useRef<string | null>(null);

    const onRefresh = React.useCallback(() => {
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

    const probeScopeKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        const extraKeySuffixParts = Array.isArray(params.probeContext?.cacheKeySuffixParts)
            ? params.probeContext!.cacheKeySuffixParts!.map((part) => String(part ?? '').trim()).filter(Boolean)
            : [];
        // Scope key excludes cwd so switching worktrees doesn't flash the dynamic model list.
        return JSON.stringify([
            'dynamicModelProbeScope',
            serverId,
            machineId,
            backendTargetKey,
            ...extraKeySuffixParts,
        ]);
    }, [backendTargetKey, params.capabilityServerId, params.probeContext?.cacheKeySuffixParts, params.selectedMachineId]);

    const preflightModelsKey = React.useMemo(() => {
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
            extraKeySuffixParts: params.probeContext?.cacheKeySuffixParts ?? null,
        });
    }, [backendTargetKey, params.capabilityServerId, params.cwd, params.probeContext?.cacheKeySuffixParts, params.selectedMachineId]);

    React.useEffect(() => {
        preflightModelsRef.current = preflightModels;
        refreshedAtRef.current = refreshedAt;
    }, [preflightModels, refreshedAt]);

    React.useEffect(() => {
        if (!preflightModelsKey) {
            setPreflightModels(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            lastScopeKeyRef.current = probeScopeKey;
            return;
        }

        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const shouldForceProbe = refreshNonce !== 0 && refreshNonce !== lastHandledRefreshNonceRef.current;
        if (shouldForceProbe) {
            lastHandledRefreshNonceRef.current = refreshNonce;
        }

        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        const scopeStable = lastScopeKeyRef.current !== null && probeScopeKey !== null && lastScopeKeyRef.current === probeScopeKey;
        lastScopeKeyRef.current = probeScopeKey;
        if (cached) {
            setPreflightModels(cached);
            setRefreshedAt(cacheEntry?.updatedAt ?? null);
        } else if (!scopeStable) {
            // Engine/machine/server scope changed: clear any previous list to avoid showing the wrong provider's models.
            setPreflightModels(null);
            setRefreshedAt(null);
        }

        const nowMs = Date.now();
        if (!shouldForceProbe && cacheEntry && nowMs >= 0 && nowMs < cacheEntry.expiresAt) {
            setProbePhase('idle');
            retryTimeout = scheduleProbedResourceRetryAfterExpiry(cacheEntry, nowMs, () => {
                setRefreshNonce((n) => n + 1);
            });
            return () => {
                if (retryTimeout) clearTimeout(retryTimeout);
            };
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

            const hasExisting = Boolean(preflightModelsRef.current);
            setProbePhase(hasExisting ? 'refreshing' : 'loading');
            const list = await runDynamicModelProbeDedupe(preflightModelsKey, async () => {
                const res = await machineCapabilitiesInvoke(params.selectedMachineId!, {
                    id: `cli.${agentType}` as any,
                    method: 'probeModels',
                    params: {
                        timeoutMs: 15_000,
                        backendTarget,
                        ...(params.probeContext?.capabilityParams ? params.probeContext.capabilityParams : {}),
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
                            ...(Array.isArray(m.modelOptions) && m.modelOptions.length > 0
                                ? { modelOptions: m.modelOptions as readonly AcpConfigOption[] }
                                : {}),
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

            const stale = preflightModelsRef.current;
            const staleUpdatedAt = refreshedAtRef.current;
            if (stale && staleUpdatedAt) {
                // When switching cwd/worktree, keep the last usable list on screen even if the new probe fails.
                writeDynamicModelProbeCacheSuccess(preflightModelsKey, stale, commitNowMs);
                setPreflightModels(stale);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            writeDynamicModelProbeCacheError(preflightModelsKey, commitNowMs);
            setProbePhase('idle');
            retryTimeout = setTimeout(() => {
                setRefreshNonce((n) => n + 1);
            }, DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS);
        };

        void run();
        return () => {
            cancelled = true;
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTarget, preflightModelsKey, probeScopeKey, params.capabilityServerId, params.cwd, params.selectedMachineId, params.probeContext?.capabilityParams, refreshNonce]);

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
            onRefresh,
        },
    };
}
