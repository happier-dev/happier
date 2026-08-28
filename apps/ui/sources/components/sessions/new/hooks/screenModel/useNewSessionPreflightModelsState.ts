import * as React from 'react';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
    createUnavailablePreflightModelList,
    getModelOptionsForAgentTypeOrPreflight,
    type PreflightModelList,
} from '@/sync/domains/models/modelOptions';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import { parsePreflightModelListFromProbeModelsResult } from '@/sync/domains/models/parsePreflightModelListFromProbeModelsResult';
import {
    DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
    DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS,
    readDynamicModelProbeCache,
    runDynamicModelProbeDedupe,
    writeDynamicModelProbeCacheError,
    writeDynamicModelProbeCacheSuccess,
    writeDynamicModelProbeCacheTransientSuccess,
    writeDynamicModelProbeCacheUnavailable,
} from '@/sync/domains/models/dynamicModelProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import { scheduleProbedResourceRetryAfterExpiry } from './probedResourceRetrySchedule';

type DynamicModelProbeAttempt = Readonly<{
    list: PreflightModelList;
    cacheable: boolean;
    retryDelayMs?: number;
}>;

function createUnavailableModelProbeAttempt(retryDelayMs: number): DynamicModelProbeAttempt {
    return {
        list: createUnavailablePreflightModelList(),
        cacheable: false,
        retryDelayMs,
    };
}

export function useNewSessionPreflightModelsState(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    providerConnectionId?: string | null;
    runtimeCarrierAgentId?: string | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
}>): Readonly<{
    preflightModels: PreflightModelList | null;
    preflightModelsTargetKey: string | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        onRefresh?: () => void;
    }>;
}> {
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const [preflightModelsTargetKey, setPreflightModelsTargetKey] = React.useState<string | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const preflightModelsRef = React.useRef<PreflightModelList | null>(null);
    const preflightModelsCacheableRef = React.useRef(true);
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

    const agentType = React.useMemo<string | null>(() => {
        if (!backendTarget) return null;
        if (backendTarget.configuredBackendId) {
            return params.runtimeCarrierAgentId ?? null;
        }
        if (!isBundledAgentId(backendTarget.backendId)) {
            return params.runtimeCarrierAgentId ?? null;
        }
        // For built-in backends the backend id is already a canonical agent id.
        // For plugin-contributed backends the provider may still override it.
        return resolveCatalogAgentIdForBackendTarget(backendTarget) ?? backendTarget.backendId;
    }, [backendTarget, params.runtimeCarrierAgentId]);

    const dynamicProbeEnabled = React.useMemo(() => {
        if (!agentType) return false;
        // An Agent with no bundled model config declares probing through its own
        // contribution; the bundled static-only veto does not apply to it.
        return !isBundledAgentId(agentType)
            || getAgentCore(agentType)?.model.dynamicProbe !== 'static-only';
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
    const modelSuccessCacheMaxAgeMs = params.probeContext?.modelSuccessCacheMaxAgeMs ?? undefined;

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
            params.providerConnectionId ?? null,
            ...extraKeySuffixParts,
        ]);
    }, [agentType, backendTargetKey, params.capabilityServerId, params.providerConnectionId, params.selectedMachineId, probeContextKey, probeContextCacheKeySuffixParts]);

    const preflightModelsKey = React.useMemo(() => {
        if (!backendTargetKey || !agentType) return null;
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            providerConnectionId: params.providerConnectionId ?? null,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
            extraKeySuffixParts: probeContextCacheKeySuffixParts,
        });
    }, [agentType, backendTargetKey, params.capabilityServerId, params.cwd, params.providerConnectionId, params.selectedMachineId, probeContextCacheKeySuffixParts]);

    React.useEffect(() => {
        preflightModelsRef.current = preflightModels;
        refreshedAtRef.current = refreshedAt;
    }, [preflightModels, refreshedAt]);

    React.useEffect(() => {
        if (!preflightModelsKey) {
            setPreflightModels(null);
            preflightModelsRef.current = null;
            preflightModelsCacheableRef.current = true;
            setPreflightModelsTargetKey(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            refreshedAtRef.current = null;
            lastScopeKeyRef.current = probeScopeKey;
            return;
        }

        if (!agentType) {
            setPreflightModels(null);
            preflightModelsRef.current = null;
            preflightModelsCacheableRef.current = true;
            setPreflightModelsTargetKey(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            refreshedAtRef.current = null;
            return;
        }

        const core = getAgentCore(agentType);
        if (core?.model.dynamicProbe === 'static-only') {
            // This provider intentionally does not support dynamic model probing; rely on catalog-only models.
            // Clear any previously cached dynamic list for this scope so we don't render stale/unknown models.
            lastScopeKeyRef.current = probeScopeKey;
            if (preflightModelsRef.current !== null) {
                setPreflightModels(null);
                setPreflightModelsTargetKey(null);
                preflightModelsRef.current = null;
                preflightModelsCacheableRef.current = true;
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

        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey, modelSuccessCacheMaxAgeMs);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        const cachedCanPersist = cacheEntry?.kind === 'success' && cacheEntry.cacheable !== false;
        const scopeStable = lastScopeKeyRef.current !== null && probeScopeKey !== null && lastScopeKeyRef.current === probeScopeKey;
        lastScopeKeyRef.current = probeScopeKey;
        if (cached) {
            setPreflightModels(cached);
            preflightModelsRef.current = cached;
            preflightModelsCacheableRef.current = cachedCanPersist;
            setPreflightModelsTargetKey(backendTargetKey);
            const cachedUpdatedAt = cacheEntry?.updatedAt ?? null;
            setRefreshedAt(cachedUpdatedAt);
            refreshedAtRef.current = cachedUpdatedAt;
        } else if (!scopeStable) {
            // Engine/machine/server scope changed: clear any previous list to avoid showing the wrong provider's models.
            setPreflightModels(null);
            setPreflightModelsTargetKey(null);
            preflightModelsRef.current = null;
            preflightModelsCacheableRef.current = true;
            refreshedAtRef.current = null;
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
            const probeAgentType = agentType;
            if (!probeAgentType) return;
            const core = getAgentCore(probeAgentType);
            // A bundled Agent that declares no model selection is settled here.
            // Without a bundled core the machine capability probe itself answers
            // whether the Agent supports selection, so let it decide.
            if ((core !== null && core.model.supportsSelection !== true) || !params.selectedMachineId) {
                if (!cancelled) {
                    setProbePhase('idle');
                }
                return;
            }
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';

            const hasExisting = Boolean(preflightModelsRef.current);
            setProbePhase(hasExisting ? 'refreshing' : 'loading');
            const attempt = await runDynamicModelProbeDedupe<DynamicModelProbeAttempt | null>(preflightModelsKey, async () => {
                const capabilityId = buildProviderCliCapabilityId(probeAgentType);
                const res = await machineCapabilitiesInvoke(params.selectedMachineId!, {
                    id: capabilityId,
                    method: 'probeModels',
                    params: {
                        timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS,
                        ...(backendTargetForProbe ? { backendTarget: backendTargetForProbe } : {}),
                        ...(probeContextCapabilityParams ? probeContextCapabilityParams : {}),
                        ...(cwd ? { cwd } : {}),
                    },
                }, {
                    serverId: params.capabilityServerId,
                    timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS,
                });

                if (!res.supported) {
                    return createUnavailableModelProbeAttempt(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS);
                }
                if (!res.response.ok) {
                    return createUnavailableModelProbeAttempt(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS);
                }

                const list = parsePreflightModelListFromProbeModelsResult(res.response.result);
                if (!list) {
                    return createUnavailableModelProbeAttempt(DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS);
                }

                const result = res.response.result;
                const source = result && typeof result === 'object' && !Array.isArray(result)
                    ? (typeof (result as Record<string, unknown>).source === 'string' ? (result as Record<string, unknown>).source : null)
                    : null;
                // When the CLI probe returns a static fallback (dynamic probe failed), do not persist it
                // for a full day. Persisting it long-lived is what causes “Thinking/Speed only appear after refresh”.
                const cacheable = source !== 'static' && source !== 'unavailable';
                return {
                    list,
                    cacheable,
                    ...(cacheable ? {} : {
                        retryDelayMs: source === 'static'
                            ? DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS
                            : DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS,
                    }),
                };
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            const list = attempt?.list ?? null;
            if (list && attempt?.cacheable !== false) {
                staticFallbackRetryRef.current = { scopeKey: probeScopeKey, attempts: 0 };
                writeDynamicModelProbeCacheSuccess(preflightModelsKey, list, commitNowMs);
                setPreflightModels(list);
                preflightModelsCacheableRef.current = true;
                setPreflightModelsTargetKey(backendTargetKey);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }
            if (list?.unavailable === true && attempt?.cacheable === false) {
                writeDynamicModelProbeCacheUnavailable(preflightModelsKey, commitNowMs);
                setPreflightModels(list);
                preflightModelsCacheableRef.current = false;
                setPreflightModelsTargetKey(backendTargetKey);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                retryTimeout = setTimeout(() => {
                    setRefreshNonce((n) => n + 1);
                }, attempt.retryDelayMs ?? DYNAMIC_MODEL_PROBE_ERROR_BACKOFF_MS);
                return;
            }
            if (list && attempt?.cacheable === false && !cached) {
                // Show the list (useful fallback) and retain it for same-runtime remounts, but retry soon
                // and do not persist it across app restarts.
                writeDynamicModelProbeCacheTransientSuccess(preflightModelsKey, list, commitNowMs);
                writeDynamicModelProbeCacheError(preflightModelsKey, commitNowMs);
                setPreflightModels(list);
                preflightModelsCacheableRef.current = false;
                setPreflightModelsTargetKey(backendTargetKey);
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
                    }, attempt.retryDelayMs ?? DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS);
                }
                return;
            }

            if (cached) {
                // Keep stale-but-usable model lists sticky if a refresh probe fails.
                if (cachedCanPersist) {
                    writeDynamicModelProbeCacheSuccess(preflightModelsKey, cached, commitNowMs);
                }
                setPreflightModels(cached);
                preflightModelsCacheableRef.current = cachedCanPersist;
                setPreflightModelsTargetKey(backendTargetKey);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            const stale = preflightModelsRef.current;
            const staleUpdatedAt = refreshedAtRef.current;
            if (stale && staleUpdatedAt) {
                // When switching cwd/worktree, keep the last usable list on screen even if the new probe fails.
                if (preflightModelsCacheableRef.current) {
                    writeDynamicModelProbeCacheSuccess(preflightModelsKey, stale, commitNowMs);
                } else {
                    writeDynamicModelProbeCacheTransientSuccess(preflightModelsKey, stale, commitNowMs);
                }
                setPreflightModels(stale);
                setPreflightModelsTargetKey(backendTargetKey);
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
    }, [agentType, backendTargetForProbe, backendTargetKey, modelSuccessCacheMaxAgeMs, preflightModelsKey, probeScopeKey, refreshNonce, probeContextCapabilityParams]);

    const modelOptions = React.useMemo(
        () => {
            if (!agentType) {
                return [] as ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
            }
            return getModelOptionsForAgentTypeOrPreflight({
                agentType,
                preflight: preflightModels,
                preflightTargetKey: preflightModelsTargetKey,
                currentTargetKey: backendTargetKey,
            });
        },
        [agentType, backendTargetKey, preflightModels, preflightModelsTargetKey],
    );

    return {
        preflightModels,
        preflightModelsTargetKey,
        modelOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            ...(dynamicProbeEnabled ? { onRefresh } : {}),
        },
    };
}
