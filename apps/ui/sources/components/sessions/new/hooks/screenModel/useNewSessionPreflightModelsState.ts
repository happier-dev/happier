import * as React from 'react';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { getAgentCore, isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { discoverMachineModels } from '@/sync/ops/modelDiscovery';
import {
    getModelOptionsForAgentTypeOrPreflight,
    type PreflightModelList,
} from '@/sync/domains/models/modelOptions';
import { buildDynamicModelProbeCacheKey } from '@/sync/domains/models/dynamicModelProbeCacheKey';
import {
    dynamicModelProbeRetryAt,
    isDynamicModelProbeCacheFresh,
    readDynamicModelProbeCache,
    subscribeDynamicModelProbeCache,
    type DynamicModelProbeCacheEntry,
} from '@/sync/domains/models/dynamicModelProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';

export function useNewSessionPreflightModelsState(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    providerConnectionId?: string | null;
    runtimeCarrierAgentId?: string | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
    enabled?: boolean;
}>): Readonly<{
    preflightModels: PreflightModelList | null;
    preflightModelsTargetKey: string | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        failed: boolean;
        refreshedAt: number | null;
        onRefresh?: () => void;
    }>;
}> {
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const [preflightModelsTargetKey, setPreflightModelsTargetKey] = React.useState<string | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [modelDiscoveryFailed, setModelDiscoveryFailed] = React.useState(false);
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const [retryNonce, setRetryNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const preflightModelsRef = React.useRef<PreflightModelList | null>(null);
    const lastCacheKeyRef = React.useRef<string | null>(null);
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
            || (getAgentCore(agentType)?.model?.dynamicProbe !== 'static-only' && getAgentCore(agentType)?.model?.supportsSelection !== false);
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
        const core = agentType ? getAgentCore(agentType) : null;
        if (!preflightModelsKey || !agentType || core?.model?.dynamicProbe === 'static-only' || core?.model?.supportsSelection === false) {
            setPreflightModels(null);
            preflightModelsRef.current = null;
            setPreflightModelsTargetKey(null);
            setProbePhase('idle');
            setModelDiscoveryFailed(false);
            setRefreshedAt(null);
            lastCacheKeyRef.current = preflightModelsKey;
            return;
        }

        let cancelled = false;
        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey, modelSuccessCacheMaxAgeMs);
        const scopeStable = lastCacheKeyRef.current === preflightModelsKey;
        lastCacheKeyRef.current = preflightModelsKey;
        const applyEntry = (entry: DynamicModelProbeCacheEntry | null) => {
            if (entry?.kind === 'success') {
                setPreflightModels(entry.value);
                preflightModelsRef.current = entry.value;
                setPreflightModelsTargetKey(backendTargetKey);
                setRefreshedAt(entry.staticFallback || entry.value.unavailable ? null : entry.updatedAt);
            }
            setModelDiscoveryFailed(entry?.kind === 'error' || (entry?.kind === 'success' && entry.errorUpdatedAt !== undefined));
        };
        if (cacheEntry?.kind === 'success') {
            applyEntry(cacheEntry);
        } else {
            if (!scopeStable) {
                setPreflightModels(null);
                preflightModelsRef.current = null;
                setPreflightModelsTargetKey(null);
                setRefreshedAt(null);
            }
            applyEntry(cacheEntry);
        }
        setProbePhase('idle');
        const scheduleRetry = (entry: DynamicModelProbeCacheEntry | null) => {
            if (retryTimeout) clearTimeout(retryTimeout);
            retryTimeout = null;
            if (params.enabled === false) return;
            const retryAt = dynamicModelProbeRetryAt(entry);
            if (retryAt === null) return;
            const isStaticFallback = entry?.kind === 'success' && entry.staticFallback;
            const state = staticFallbackRetryRef.current;
            const attempts = state?.scopeKey === preflightModelsKey ? state.attempts : 0;
            // Preserve the existing bounded fast retry lifecycle for failed static fallback.
            if (isStaticFallback && attempts >= 2) return;
            retryTimeout = setTimeout(() => {
                if (isStaticFallback) staticFallbackRetryRef.current = { scopeKey: preflightModelsKey, attempts: attempts + 1 };
                setRetryNonce((n) => n + 1);
            }, Math.max(0, retryAt - Date.now()));
        };
        const unsubscribe = subscribeDynamicModelProbeCache(preflightModelsKey, () => {
            const entry = readDynamicModelProbeCache(preflightModelsKey, modelSuccessCacheMaxAgeMs);
            applyEntry(entry);
            if (dynamicModelProbeRetryAt(entry) === null) staticFallbackRetryRef.current = null;
            scheduleRetry(entry);
        });
        if (params.enabled === false) return unsubscribe;
        const force = refreshNonce !== lastHandledRefreshNonceRef.current;
        lastHandledRefreshNonceRef.current = refreshNonce;
        if (!force && isDynamicModelProbeCacheFresh(cacheEntry)) {
            scheduleRetry(cacheEntry);
        } else {
            setProbePhase(preflightModelsRef.current ? 'refreshing' : 'loading');
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
            void discoverMachineModels({
                cacheKey: preflightModelsKey,
                agentType,
                machineId: params.selectedMachineId!,
                serverId: params.capabilityServerId,
                backendTarget: backendTargetForProbe,
                successMaxAgeMs: modelSuccessCacheMaxAgeMs,
                timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS,
                bypassCache: force,
                capabilityParams: {
                    timeoutMs: NEW_SESSION_MODEL_PROBE_TIMEOUT_MS,
                    ...probeContextCapabilityParams,
                    ...(cwd ? { cwd } : {}),
                },
            }).then((entry) => {
                if (cancelled) return;
                applyEntry(entry);
                setProbePhase('idle');
                if (dynamicModelProbeRetryAt(entry) === null) staticFallbackRetryRef.current = null;
                scheduleRetry(entry);
            });
        }
        return () => {
            cancelled = true;
            unsubscribe();
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTargetForProbe, backendTargetKey, preflightModelsKey, modelSuccessCacheMaxAgeMs, params.enabled, params.capabilityServerId, params.cwd, params.selectedMachineId, refreshNonce, retryNonce, probeContextCapabilityParams]);

    const hasCurrentIdentity = lastCacheKeyRef.current === preflightModelsKey;
    const currentModels = hasCurrentIdentity ? preflightModels : null;
    const modelOptions = React.useMemo(
        () => {
            if (!agentType) {
                return [] as ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
            }
            return getModelOptionsForAgentTypeOrPreflight({
                agentType,
                preflight: currentModels,
                preflightTargetKey: preflightModelsTargetKey,
                currentTargetKey: backendTargetKey,
            });
        },
        [agentType, backendTargetKey, currentModels, preflightModelsTargetKey],
    );

    const probe = React.useMemo(() => ({
        phase: probePhase,
        failed: hasCurrentIdentity && modelDiscoveryFailed,
        refreshedAt: hasCurrentIdentity ? refreshedAt : null,
        ...(dynamicProbeEnabled && preflightModelsKey && params.enabled !== false ? { onRefresh } : {}),
    }), [hasCurrentIdentity, probePhase, modelDiscoveryFailed, refreshedAt, dynamicProbeEnabled, preflightModelsKey, params.enabled, onRefresh]);
    return { preflightModels: currentModels, preflightModelsTargetKey: currentModels ? preflightModelsTargetKey : null, modelOptions, probe };
}
