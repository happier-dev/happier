import * as React from 'react';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol';

import { getAgentCore, isAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { getModelOptionsForAgentTypeOrPreflight, type PreflightModelList } from '@/sync/domains/models/modelOptions';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import {
    DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
    DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS,
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { scheduleProbedResourceRetryAfterExpiry } from './probedResourceRetrySchedule';

export function useNewSessionPreflightModelsState(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    runtimeCarrierAgentId?: AgentId | null;
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
        onRefresh?: () => void;
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
    const staticFallbackRetryRef = React.useRef<Readonly<{ scopeKey: string | null; attempts: number }> | null>(null);

    const onRefresh = React.useCallback(() => {
        setRefreshNonce((n) => n + 1);
    }, []);

    const backendTarget = params.backendTarget ?? null;
    const backendTargetKey = React.useMemo(() => {
        if (!backendTarget) return null;
        return resolveBackendTargetKeyV2(backendTarget);
    }, [backendTarget]);

    const backendTargetForProbe = React.useMemo(() => {
        if (!backendTarget) return null;
        // Stabilize by semantic identity (backendTargetKey) so effects don't thrash on object identity churn.
        return readBackendTargetRefV2(backendTarget);
    }, [backendTargetKey]);

    const agentType = React.useMemo<AgentId | null>(() => {
        if (!backendTarget) return null;
        if (backendTarget.configuredBackendId) {
            return params.runtimeCarrierAgentId ?? null;
        }
        if (!isAgentId(backendTarget.backendId)) {
            return params.runtimeCarrierAgentId ?? null;
        }
        // For built-in backends the backend id is already a canonical agent id.
        // For plugin-contributed backends the provider may still override it.
        return resolveProviderAgentIdForBackendTarget(backendTarget) ?? backendTarget.backendId;
    }, [backendTarget, params.runtimeCarrierAgentId]);

    const dynamicProbeEnabled = React.useMemo(() => {
        if (!agentType) return false;
        return getAgentCore(agentType).model.dynamicProbe !== 'static-only';
    }, [agentType]);

    const probeContextKey = buildNewSessionCapabilityProbeContextKey(params.probeContext);
    const probeContextCacheKeySuffixParts = React.useMemo(
        () => normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(params.probeContext),
        [probeContextKey],
    );
    const probeContextCapabilityParams = React.useMemo(
        () => params.probeContext?.capabilityParams ?? null,
        [probeContextKey],
    );

    const probeScopeKey = React.useMemo(() => {
        if (!backendTargetKey || !agentType) return null;
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        const extraKeySuffixParts = probeContextCacheKeySuffixParts ?? [];
        // Scope key excludes cwd so switching worktrees doesn't flash the dynamic model list.
        return JSON.stringify([
            'dynamicModelProbeScope',
            serverId,
            machineId,
            backendTargetKey,
            ...extraKeySuffixParts,
        ]);
    }, [agentType, backendTargetKey, params.capabilityServerId, params.selectedMachineId, probeContextKey, probeContextCacheKeySuffixParts]);

    const preflightModelsKey = React.useMemo(() => {
        if (!backendTargetKey || !agentType) return null;
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
            extraKeySuffixParts: probeContextCacheKeySuffixParts,
        });
    }, [agentType, backendTargetKey, params.capabilityServerId, params.cwd, params.selectedMachineId, probeContextCacheKeySuffixParts]);

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

        if (!agentType) {
            setPreflightModels(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            return;
        }

        const core = getAgentCore(agentType);
        if (core.model.dynamicProbe === 'static-only') {
            // This provider intentionally does not support dynamic model probing; rely on catalog-only models.
            // Clear any previously cached dynamic list for this scope so we don't render stale/unknown models.
            lastScopeKeyRef.current = probeScopeKey;
            if (preflightModelsRef.current !== null) {
                setPreflightModels(null);
                preflightModelsRef.current = null;
            }
            if (refreshedAtRef.current !== null) {
                setRefreshedAt(null);
                refreshedAtRef.current = null;
            }
            setProbePhase('idle');
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
            const attempt = await runDynamicModelProbeDedupe<Readonly<{
                list: PreflightModelList;
                cacheable: boolean;
            }> | null>(preflightModelsKey, async () => {
                    const res = await machineCapabilitiesInvoke(params.selectedMachineId!, {
                        id: `cli.${agentType}` as any,
                        method: 'probeModels',
                        params: {
                            timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                            ...(backendTargetForProbe ? { backendTarget: backendTargetForProbe } : {}),
                            ...(probeContextCapabilityParams ? probeContextCapabilityParams : {}),
                            ...(cwd ? { cwd } : {}),
                        },
                    }, {
                        serverId: params.capabilityServerId,
                    });

                if (!res.supported) return null;
                if (!res.response.ok) return null;

                const list = parsePreflightModelListFromProbeModelsResult(res.response.result);
                if (!list) return null;

                const result = res.response.result;
                const source = result && typeof result === 'object' && !Array.isArray(result)
                    ? (typeof (result as Record<string, unknown>).source === 'string' ? (result as Record<string, unknown>).source : null)
                    : null;
                // When the CLI probe returns a static fallback (dynamic probe failed), do not persist it
                // for a full day. Persisting it long-lived is what causes “Thinking/Speed only appear after refresh”.
                const cacheable = source !== 'static';
                return { list, cacheable };
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            const list = attempt?.list ?? null;
            if (list && attempt?.cacheable !== false) {
                staticFallbackRetryRef.current = { scopeKey: probeScopeKey, attempts: 0 };
                writeDynamicModelProbeCacheSuccess(preflightModelsKey, list, commitNowMs);
                setPreflightModels(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }
            if (list && attempt?.cacheable === false && !cached) {
                // Show the list (useful fallback) but retry soon; do not persist across app restarts.
                writeDynamicModelProbeCacheError(preflightModelsKey, commitNowMs);
                setPreflightModels(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                const state = staticFallbackRetryRef.current;
                const scopeKey = probeScopeKey;
                const attempts = state && state.scopeKey === scopeKey ? state.attempts : 0;
                // Cap fast retries to avoid hammering the CLI when the provider genuinely cannot
                // return a dynamic list right now (for example: logged out / offline).
                if (attempts < 2) {
                    staticFallbackRetryRef.current = { scopeKey, attempts: attempts + 1 };
                    retryTimeout = setTimeout(() => {
                        setRefreshNonce((n) => n + 1);
                    }, DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS);
                }
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
    }, [agentType, backendTargetForProbe, preflightModelsKey, probeScopeKey, refreshNonce, probeContextCapabilityParams]);

    const modelOptions = React.useMemo(
        () => {
            if (!agentType) {
                return [] as ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
            }
            return getModelOptionsForAgentTypeOrPreflight({ agentType, preflight: preflightModels });
        },
        [agentType, preflightModels],
    );

    return {
        preflightModels,
        modelOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            ...(dynamicProbeEnabled ? { onRefresh } : {}),
        },
    };
}
