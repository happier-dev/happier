import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
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
    findRetainedDynamicModelName,
    isDynamicModelProbeCacheFresh,
    isDynamicModelProbePending,
    readDynamicModelProbeCache,
    subscribeDynamicModelProbeCache,
    type DynamicModelProbeCacheEntry,
} from '@/sync/domains/models/dynamicModelProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    withoutNewSessionConfigOptionKeyParts,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_MODEL_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import type { SpawnFailureV1 } from '@happier-dev/protocol/machines/processes/spawnFailureV1';
import type { ProbedResourceFailure } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams';

export function useNewSessionPreflightModelsState(params: Readonly<{
    backendTarget: BackendTargetRefV2 | null | undefined;
    providerConnectionId?: string | null;
    runtimeCarrierAgentId?: string | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
    selectedTeamCredentialModel?: TeamCredentialProviderModelSelectionV1 | null;
    enabled?: boolean;
}>): Readonly<{
    preflightModels: PreflightModelList | null;
    preflightModelsTargetKey: string | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        failed: boolean;
        refreshedAt: number | null;
        spawnFailure: SpawnFailureV1 | null;
        reason?: ProbedResourceFailure['reason'];
        requestDisposition?: ProbedResourceFailure['requestDisposition'];
        onRefresh?: () => void;
        /** The catalog has not answered yet, so a model missing from it is not known to be unknown. */
        namesPending: boolean;
        retainedModelName?: (modelId: string) => string | null;
    }>;
}> {
    const presented = useLayoutPresentationActive();
    const enabled = params.enabled !== false && presented;
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const [preflightModelsTargetKey, setPreflightModelsTargetKey] = React.useState<string | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [modelDiscoveryFailed, setModelDiscoveryFailed] = React.useState(false);
    const [spawnFailure, setSpawnFailure] = React.useState<SpawnFailureV1 | null>(null);
    const [failure, setFailure] = React.useState<ProbedResourceFailure>({});
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

    // Team catalog rows are already provided by the recipient-safe catalog.
    // Native operation probes have no Session authority for either Team delivery
    // mode, and a previous native observation must not become the Team's list.
    const teamCatalogSelected = params.selectedTeamCredentialModel?.agentTargetKey === backendTargetKey
        || Object.values(params.probeContext?.capabilityParams?.connectedServices?.bindingsByServiceId ?? {})
            .some(selection => selection.source === 'team_resource');

    const backendTargetForProbe = React.useMemo(() => {
        if (!backendTarget) return null;
        // Stabilize by semantic identity (backendTargetKey) so effects don't thrash on object identity churn.
        return readBackendTargetRefV2(backendTarget);
    }, [backendTargetKey]);

    const agentType = React.useMemo<string | null>(() => {
        if (!backendTarget || teamCatalogSelected) return null;
        if (backendTarget.configuredBackendId) {
            return params.runtimeCarrierAgentId ?? null;
        }
        if (!isBundledAgentId(backendTarget.backendId)) {
            return params.runtimeCarrierAgentId ?? null;
        }
        // For built-in backends the backend id is already a canonical agent id.
        // For plugin-contributed backends the provider may still override it.
        return resolveCatalogAgentIdForBackendTarget(backendTarget) ?? backendTarget.backendId;
    }, [backendTarget, params.runtimeCarrierAgentId, teamCatalogSelected]);

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

    // The identity of the rows this hook holds. A config-only re-key reads again but keeps showing them.
    const catalogScopeKey = React.useMemo(() => {
        if (!backendTargetKey || !agentType) return null;
        return buildDynamicModelProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            providerConnectionId: params.providerConnectionId ?? null,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
            extraKeySuffixParts: withoutNewSessionConfigOptionKeyParts(probeContextCacheKeySuffixParts),
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
            setSpawnFailure(null);
            setFailure({});
            setRefreshedAt(null);
            lastCacheKeyRef.current = catalogScopeKey;
            return;
        }

        let cancelled = false;
        const controller = new AbortController();
        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey, modelSuccessCacheMaxAgeMs);
        const scopeStable = lastCacheKeyRef.current === catalogScopeKey;
        lastCacheKeyRef.current = catalogScopeKey;
        const applyEntry = (entry: DynamicModelProbeCacheEntry | null) => {
            if (entry?.kind === 'success') {
                setPreflightModels(entry.value);
                preflightModelsRef.current = entry.value;
                setPreflightModelsTargetKey(backendTargetKey);
                setRefreshedAt(entry.staticFallback || entry.value.unavailable ? null : entry.updatedAt);
            }
            setModelDiscoveryFailed(entry?.kind === 'error' || (entry?.kind === 'success' && entry.errorUpdatedAt !== undefined));
            setSpawnFailure(entry?.spawnFailure ?? null);
            setFailure({ reason: entry?.reason, errorCode: entry?.errorCode, requestDisposition: entry?.requestDisposition });
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
            if (!enabled) return;
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
        if (!enabled) return;
        let firstObserver = false;
        const unsubscribe = subscribeDynamicModelProbeCache(preflightModelsKey, () => {
            const entry = readDynamicModelProbeCache(preflightModelsKey, modelSuccessCacheMaxAgeMs);
            applyEntry(entry);
            if (dynamicModelProbeRetryAt(entry) === null) staticFallbackRetryRef.current = null;
            scheduleRetry(entry);
        }, () => { firstObserver = true; });
        const force = refreshNonce !== lastHandledRefreshNonceRef.current;
        lastHandledRefreshNonceRef.current = refreshNonce;
        // A successful catalog is retained for immediate display, but a new demand
        // interval still revalidates. Overlapping observers join the same probe;
        // unavailable/unknown outcomes keep their existing retry/Action policy.
        const revalidate = cacheEntry?.kind === 'success' && dynamicModelProbeRetryAt(cacheEntry) === null
            && cacheEntry.reason !== 'outcomeUnknown' && (firstObserver || isDynamicModelProbePending(preflightModelsKey));
        if (!force && !revalidate && isDynamicModelProbeCacheFresh(cacheEntry)) {
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
                revalidate,
                signal: controller.signal,
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
            }).catch(() => {
                if (!cancelled) setProbePhase('idle');
            });
        }
        return () => {
            cancelled = true;
            controller.abort();
            unsubscribe();
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTargetForProbe, backendTargetKey, preflightModelsKey, modelSuccessCacheMaxAgeMs, enabled, params.capabilityServerId, params.cwd, params.selectedMachineId, refreshNonce, retryNonce, probeContextCapabilityParams]);

    const hasCurrentIdentity = lastCacheKeyRef.current === catalogScopeKey;
    // A remounted picker renders before its effect can adopt the retained
    // snapshot. Read that exact current key so the first frame keeps its rows.
    const retainedEntry = dynamicProbeEnabled && !hasCurrentIdentity && preflightModelsKey
        ? readDynamicModelProbeCache(preflightModelsKey, modelSuccessCacheMaxAgeMs) : null;
    const currentModels = hasCurrentIdentity ? preflightModels
        : retainedEntry?.kind === 'success' ? retainedEntry.value : null;
    const currentModelsTargetKey = hasCurrentIdentity ? preflightModelsTargetKey : backendTargetKey;
    const modelOptions = React.useMemo(
        () => {
            if (!agentType) {
                return [] as ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
            }
            return getModelOptionsForAgentTypeOrPreflight({
                agentType,
                preflight: currentModels,
                preflightTargetKey: currentModelsTargetKey,
                currentTargetKey: backendTargetKey,
            });
        },
        [agentType, backendTargetKey, currentModels, currentModelsTargetKey],
    );

    const namesPending = dynamicProbeEnabled && !currentModels && !(hasCurrentIdentity && modelDiscoveryFailed);
    const retainedModelName = React.useCallback((modelId: string) => (
        preflightModelsKey ? findRetainedDynamicModelName(preflightModelsKey, modelId) : null
    ), [preflightModelsKey]);

    const probe = React.useMemo(() => ({
        namesPending,
        ...(dynamicProbeEnabled ? { retainedModelName } : {}),
        phase: teamCatalogSelected ? 'idle' : probePhase,
        failed: hasCurrentIdentity && modelDiscoveryFailed,
        refreshedAt: hasCurrentIdentity ? refreshedAt : null,
        spawnFailure: hasCurrentIdentity ? spawnFailure : null,
        ...(hasCurrentIdentity ? failure : {}),
        ...(dynamicProbeEnabled && preflightModelsKey && enabled ? { onRefresh } : {}),
    }), [namesPending, retainedModelName, hasCurrentIdentity, probePhase, modelDiscoveryFailed, refreshedAt, spawnFailure, failure, dynamicProbeEnabled, preflightModelsKey, enabled, onRefresh, teamCatalogSelected]);
    return { preflightModels: currentModels, preflightModelsTargetKey: currentModels ? currentModelsTargetKey : null, modelOptions, probe };
}
