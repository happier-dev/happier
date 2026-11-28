import * as React from 'react';
import {
    buildBackendTargetKey,
    isBuiltInAgentTarget,
    type BackendTargetRefV1,
    type ConnectedServiceBindingsV1,
} from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { discoverMachineModels, type LaunchModelAdvisoryTarget } from '@/sync/ops/modelDiscovery';
import { getModelOptionsForAgentTypeOrPreflight, type PreflightModelList } from '@/sync/domains/models/modelOptions';
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
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export function useNewSessionPreflightModelsState(params: Readonly<{
    enabled?: boolean;
    observeConfiguredModel?: boolean;
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
    readMissingConfiguredModel: (target: LaunchModelAdvisoryTarget) => string | null;
    modelOptions: ReturnType<typeof getModelOptionsForAgentTypeOrPreflight>;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        error: boolean;
        onRefresh?: () => void;
    }>;
}> {
    const [preflightModels, setPreflightModels] = React.useState<PreflightModelList | null>(null);
    const [preflightModelsTargetKey, setPreflightModelsTargetKey] = React.useState<string | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const [retryNonce, setRetryNonce] = React.useState(0);
    const [probeError, setProbeError] = React.useState(false);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const preflightModelsRef = React.useRef<PreflightModelList | null>(null);
    const lastCacheKeyRef = React.useRef<string | null>(null);
    const staticFallbackRetryRef = React.useRef<Readonly<{ scopeKey: string | null; attempts: number }> | null>(null);

    const missingConfiguredModel = React.useRef<{ key: string; modelId: string; list: PreflightModelList } | null>(null);
    const onRefresh = React.useCallback(() => {
        missingConfiguredModel.current = null;
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
        return core.model.dynamicProbe !== 'static-only' && core.model.supportsSelection === true;
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
    const connectedServicesKey = stableJsonStringify(params.connectedServices ?? null);
    const connectedServices = React.useMemo(() => params.connectedServices, [connectedServicesKey]);
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

    const modelProbeParams = React.useMemo(() => ({
        timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
        ...(profileId ? { profileId } : {}),
        ...probeContextCapabilityParams,
        ...(connectedServices ? { connectedServices } : {}),
    }), [profileId, probeContextCapabilityParams, connectedServices]);
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

    const cwd = params.cwd?.trim() ?? '';
    const { capabilityServerId, selectedMachineId, observeConfiguredModel } = params;
    const readMissingConfiguredModel = React.useCallback((target: LaunchModelAdvisoryTarget): string | null => {
        const observation = missingConfiguredModel.current;
        return params.enabled !== false && observeConfiguredModel && observation?.key === preflightModelsKey
            && observation.list === preflightModelsRef.current
            && target.cwd === cwd && target.serverId === capabilityServerId && target.machineId === selectedMachineId
            ? observation.modelId : null;
    }, [capabilityServerId, cwd, observeConfiguredModel, params.enabled, preflightModelsKey, selectedMachineId]);

    React.useEffect(() => {
        missingConfiguredModel.current = null;
        const core = getAgentCore(agentType);
        if (!preflightModelsKey || core.model.dynamicProbe === 'static-only' || core.model.supportsSelection !== true) {
            setPreflightModels(null);
            preflightModelsRef.current = null;
            setPreflightModelsTargetKey(null);
            setProbePhase('idle');
            setProbeError(false);
            setRefreshedAt(null);
            lastCacheKeyRef.current = preflightModelsKey;
            return;
        }

        let cancelled = false;
        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const cacheEntry = readDynamicModelProbeCache(preflightModelsKey);
        const scopeStable = lastCacheKeyRef.current === preflightModelsKey;
        lastCacheKeyRef.current = preflightModelsKey;
        const applyEntry = (entry: DynamicModelProbeCacheEntry | null) => {
            if (entry?.kind !== 'success' || entry.errorUpdatedAt !== undefined
                || entry.value !== missingConfiguredModel.current?.list) {
                missingConfiguredModel.current = null;
            }
            if (entry?.kind === 'success') {
                setPreflightModels(entry.value);
                preflightModelsRef.current = entry.value;
                setPreflightModelsTargetKey(backendTargetKey);
                setRefreshedAt(entry.staticFallback ? null : entry.updatedAt);
            }
            setProbeError(entry?.kind === 'error' || (entry?.kind === 'success' && entry.errorUpdatedAt !== undefined));
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
            const entry = readDynamicModelProbeCache(preflightModelsKey);
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
            void discoverMachineModels({
                cacheKey: preflightModelsKey,
                agentType,
                machineId: params.selectedMachineId!,
                serverId: params.capabilityServerId,
                backendTarget,
                bypassCache: force,
                includeConfiguredModel: observeConfiguredModel && cwd !== '',
                capabilityParams: {
                    ...modelProbeParams,
                    ...(cwd ? { cwd } : {}),
                },
            }).then(({ entry, missingConfiguredModelId }) => {
                if (cancelled) return;
                applyEntry(entry);
                if (missingConfiguredModelId && entry?.kind === 'success') {
                    missingConfiguredModel.current = { key: preflightModelsKey, modelId: missingConfiguredModelId, list: entry.value };
                }
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
    }, [agentType, backendTarget, backendTargetKey, preflightModelsKey, params.enabled, capabilityServerId, cwd, selectedMachineId, observeConfiguredModel, refreshNonce, retryNonce, modelProbeParams]);

    const hasCurrentIdentity = lastCacheKeyRef.current === preflightModelsKey;
    const currentModels = hasCurrentIdentity ? preflightModels : null;
    const modelOptions = React.useMemo(
        () => getModelOptionsForAgentTypeOrPreflight({ agentType, preflight: currentModels }),
        [agentType, currentModels],
    );

    const probe = React.useMemo(() => ({
        phase: probePhase,
        refreshedAt: hasCurrentIdentity ? refreshedAt : null,
        error: hasCurrentIdentity && probeError,
        ...(dynamicProbeEnabled && preflightModelsKey && params.enabled !== false ? { onRefresh } : {}),
    }), [hasCurrentIdentity, probePhase, refreshedAt, probeError, dynamicProbeEnabled, preflightModelsKey, params.enabled, onRefresh]);

    return {
        preflightModels: currentModels,
        preflightModelsTargetKey: currentModels ? preflightModelsTargetKey : null,
        readMissingConfiguredModel,
        modelOptions,
        probe,
    };
}
