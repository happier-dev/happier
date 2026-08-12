import * as React from 'react';
import {
    buildBackendTargetKey,
    isBuiltInAgentTarget,
    type BackendTargetRefV1,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
    writeDynamicModelProbeCacheTransientSuccess,
} from '@/sync/domains/models/dynamicModelProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import type { CapabilityId } from '@/sync/api/capabilities/capabilitiesProtocol';
import { scheduleProbedResourceRetryAfterExpiry } from './probedResourceRetrySchedule';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export function useNewSessionPreflightModelsState(params: Readonly<{
    backendTarget: BackendTargetRefV1;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    profileId?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
    connectedServices?: ConnectedServiceBindingsV1 | null;
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

    const dynamicProbeEnabled = React.useMemo(() => {
        const core = getAgentCore(agentType);
        return core.model.dynamicProbe !== 'static-only';
    }, [agentType]);

    const backendTargetKey = React.useMemo(() => buildBackendTargetKey(backendTarget), [backendTarget]);

    const probeContextKey = buildNewSessionCapabilityProbeContextKey(params.probeContext);
    const probeContextCacheKeySuffixParts = React.useMemo(
        () => normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(params.probeContext),
        [probeContextKey],
    );
    const probeContextCapabilityParams = React.useMemo(
        () => params.probeContext?.capabilityParams ?? null,
        [probeContextKey],
    );
    const connectedServicesKey = React.useMemo(
        () => stableJsonStringify(params.connectedServices ?? null),
        [params.connectedServices],
    );
    const profileId = typeof params.profileId === 'string' && params.profileId.trim().length > 0
        ? params.profileId.trim()
        : null;
    const probeCacheKeySuffixParts = React.useMemo(
        () => [
            ...(probeContextCacheKeySuffixParts ?? []),
            ...(profileId ? [`profile:${profileId}`] : []),
        ],
        [probeContextCacheKeySuffixParts, profileId],
    );

    const probeScopeKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        // Scope key excludes cwd so switching worktrees doesn't flash the dynamic model list.
        return JSON.stringify([
            'dynamicModelProbeScope',
            serverId,
            machineId,
            backendTargetKey,
            connectedServicesKey,
            ...probeCacheKeySuffixParts,
        ]);
    }, [backendTargetKey, params.capabilityServerId, params.selectedMachineId, probeContextKey, probeCacheKeySuffixParts, connectedServicesKey]);

    const preflightModelsKey = React.useMemo(() => {
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
            extraKeySuffixParts: probeCacheKeySuffixParts,
            connectedServices: params.connectedServices ?? null,
        });
    }, [backendTargetKey, params.capabilityServerId, params.cwd, params.selectedMachineId, probeCacheKeySuffixParts, connectedServicesKey]);

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

        const core = getAgentCore(agentType);
        if (core.model.dynamicProbe === 'static-only') {
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

        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey);
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
                const capabilityId: CapabilityId = `cli.${agentType}`;
                const res = await machineCapabilitiesInvoke(params.selectedMachineId!, {
                    id: capabilityId,
                    method: 'probeModels',
                    params: {
                        timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                        backendTarget,
                        ...(profileId ? { profileId } : {}),
                        ...(probeContextCapabilityParams ? probeContextCapabilityParams : {}),
                        ...(params.connectedServices ? { connectedServices: params.connectedServices } : {}),
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
                const resultRecord = result && typeof result === 'object' && !Array.isArray(result)
                    ? result as Record<string, unknown>
                    : null;
                const source = typeof resultRecord?.source === 'string' ? resultRecord.source : null;
                // When the CLI probe returns a static fallback (dynamic probe failed), do not persist it
                // for a full day. Persisting it long-lived is what causes “Thinking/Speed only appear after refresh”.
                const cacheable = resultRecord?.cacheable !== false && source !== 'static';
                return { list, cacheable };
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
                    }, DYNAMIC_MODEL_PROBE_STATIC_FALLBACK_RETRY_MS);
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
    }, [agentType, backendTarget, backendTargetKey, preflightModelsKey, probeScopeKey, params.capabilityServerId, params.cwd, params.selectedMachineId, profileId, probeContextKey, refreshNonce, probeContextCapabilityParams, params.connectedServices]);

    const modelOptions = React.useMemo(
        () => getModelOptionsForAgentTypeOrPreflight({ agentType, preflight: preflightModels }),
        [agentType, preflightModels],
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
