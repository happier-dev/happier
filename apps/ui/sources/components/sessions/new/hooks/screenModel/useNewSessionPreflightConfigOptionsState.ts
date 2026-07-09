import * as React from 'react';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol';

import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isAgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { normalizeAcpConfigOptionsArray, type AcpConfigOption } from '@/sync/domains/sessionControl/configOptionsControl';
import { buildDynamicConfigOptionsProbeCacheKey } from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCacheKey';
import {
    DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS,
    readDynamicConfigOptionsProbeCache,
    runDynamicConfigOptionsProbeDedupe,
    writeDynamicConfigOptionsProbeCacheError,
    writeDynamicConfigOptionsProbeCacheSuccess,
    writeDynamicConfigOptionsProbeCacheUnavailable,
} from '@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import {
    scheduleProbedResourceRetryAfterDelay,
    scheduleProbedResourceRetryAfterExpiry,
} from './probedResourceRetrySchedule';

export function useNewSessionPreflightConfigOptionsState(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    runtimeCarrierAgentId?: string | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
}>): Readonly<{
    configOptions: readonly AcpConfigOption[] | null;
    unavailable: boolean;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        onRefresh: () => void;
    }>;
}> {
    const [configOptions, setConfigOptions] = React.useState<readonly AcpConfigOption[] | null>(null);
    const [unavailable, setUnavailable] = React.useState(false);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const configOptionsRef = React.useRef<readonly AcpConfigOption[] | null>(null);
    const refreshedAtRef = React.useRef<number | null>(null);
    const lastScopeKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        configOptionsRef.current = configOptions;
        refreshedAtRef.current = refreshedAt;
    }, [configOptions, refreshedAt]);

    const onRefresh = React.useCallback(() => {
        setRefreshNonce((current) => current + 1);
    }, []);

    const backendTargetInput = params.backendTarget;
    const probeKey = React.useMemo(() => resolveBackendTargetKeyV2(backendTargetInput), [backendTargetInput]);
    const backendTargetForProbe = React.useMemo(() => {
        // Stabilize by semantic identity (probeKey) so effects don't thrash on object identity churn.
        return readBackendTargetRefV2(backendTargetInput);
    }, [probeKey]);

    const agentType = React.useMemo(() => {
        if (isAgentId(params.runtimeCarrierAgentId)) {
            return params.runtimeCarrierAgentId;
        }
        // For built-in backends the backend id is already a canonical agent id.
        // For plugin-contributed backends the provider may still override it.
        return resolveProviderAgentIdForBackendTarget(backendTargetForProbe)
            ?? (isAgentId(backendTargetForProbe.backendId) ? backendTargetForProbe.backendId : null);
    }, [backendTargetForProbe, params.runtimeCarrierAgentId]);
    const probeContextKey = buildNewSessionCapabilityProbeContextKey(params.probeContext);
    const probeContextCacheKeySuffixParts = React.useMemo(
        () => normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(params.probeContext),
        [probeContextKey],
    );
    const probeContextCapabilityParams = React.useMemo(
        () => params.probeContext?.capabilityParams ?? null,
        [probeContextKey],
    );

    const cacheKey = React.useMemo(() => buildDynamicConfigOptionsProbeCacheKey({
        machineId: params.selectedMachineId,
        targetKey: probeKey,
        serverId: params.capabilityServerId,
        cwd: params.cwd ?? null,
        extraKeySuffixParts: probeContextCacheKeySuffixParts,
    }), [params.capabilityServerId, params.cwd, params.selectedMachineId, probeContextCacheKeySuffixParts, probeKey]);

    const probeScopeKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        return JSON.stringify([
            'dynamicConfigOptionsProbeScope',
            serverId,
            machineId,
            probeKey,
            ...(probeContextCacheKeySuffixParts ?? []),
        ]);
    }, [params.capabilityServerId, params.selectedMachineId, probeContextCacheKeySuffixParts, probeKey]);

    React.useEffect(() => {
        if (!cacheKey || !agentType) {
            setConfigOptions(null);
            configOptionsRef.current = null;
            setUnavailable(false);
            setProbePhase('idle');
            setRefreshedAt(null);
            refreshedAtRef.current = null;
            lastScopeKeyRef.current = probeScopeKey;
            return;
        }

        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const shouldForceProbe = refreshNonce !== 0 && refreshNonce !== lastHandledRefreshNonceRef.current;
        if (shouldForceProbe) {
            lastHandledRefreshNonceRef.current = refreshNonce;
        }

        const cacheEntry = readDynamicConfigOptionsProbeCache(cacheKey);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        const scopeStable = lastScopeKeyRef.current !== null && probeScopeKey !== null && lastScopeKeyRef.current === probeScopeKey;
        lastScopeKeyRef.current = probeScopeKey;
        if (cached) {
            setConfigOptions(cached);
            configOptionsRef.current = cached;
            setUnavailable(cacheEntry?.kind === 'success' && cacheEntry.unavailable === true);
            const cachedUpdatedAt = cacheEntry?.updatedAt ?? null;
            setRefreshedAt(cachedUpdatedAt);
            refreshedAtRef.current = cachedUpdatedAt;
        } else if (!scopeStable) {
            setConfigOptions(null);
            configOptionsRef.current = null;
            setUnavailable(false);
            setRefreshedAt(null);
            refreshedAtRef.current = null;
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
            if (!params.selectedMachineId) return;
            setProbePhase(configOptionsRef.current ? 'refreshing' : 'loading');
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
            const attempt = await runDynamicConfigOptionsProbeDedupe<Readonly<{
                value: readonly AcpConfigOption[];
                cacheable: boolean;
                unavailable?: boolean;
            }> | null>(cacheKey, async () => {
                const response = await machineCapabilitiesInvoke(
                    params.selectedMachineId!,
                    {
                        id: buildProviderCliCapabilityId(probeAgentType),
                        method: 'probeConfigOptions',
                        params: {
                            timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                            backendTarget: backendTargetForProbe,
                            ...(probeContextCapabilityParams ? probeContextCapabilityParams : {}),
                            ...(cwd ? { cwd } : {}),
                        },
                    },
                    {
                        serverId: params.capabilityServerId,
                    },
                );

                if (!response.supported) return null;
                if (!response.response.ok) return null;
                const result = response.response.result as any;
                const source = typeof result?.source === 'string' ? result.source : null;
                if (source === 'unavailable') {
                    return { value: [], cacheable: false, unavailable: true };
                }
                const normalized = normalizeAcpConfigOptionsArray(result?.configOptions);
                if (!normalized) return null;
                const cacheable = source !== 'static';
                return { value: normalized, cacheable };
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            const value = attempt?.value ?? null;
            const nextUnavailable = attempt?.unavailable === true;

            if (value && attempt?.cacheable !== false) {
                writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, value, commitNowMs);
                setConfigOptions(value);
                setUnavailable(false);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (value && attempt?.cacheable === false && nextUnavailable) {
                writeDynamicConfigOptionsProbeCacheUnavailable(cacheKey, commitNowMs);
                setConfigOptions(value);
                setUnavailable(true);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                retryTimeout = scheduleProbedResourceRetryAfterDelay(DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS, () => {
                    setRefreshNonce((n) => n + 1);
                });
                return;
            }

            if (value && attempt?.cacheable === false && !cached) {
                writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs);
                setConfigOptions(value);
                setUnavailable(false);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (cached) {
                const cachedUnavailable = cacheEntry?.kind === 'success' && cacheEntry.unavailable === true;
                if (cachedUnavailable) {
                    writeDynamicConfigOptionsProbeCacheUnavailable(cacheKey, commitNowMs);
                } else {
                    writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, cached, commitNowMs);
                }
                setConfigOptions(cached);
                setUnavailable(cachedUnavailable);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            const stale = configOptionsRef.current;
            const staleUpdatedAt = refreshedAtRef.current;
            if (stale && staleUpdatedAt) {
                writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, stale, commitNowMs);
                setConfigOptions(stale);
                setUnavailable(false);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs);
            setUnavailable(false);
            setProbePhase('idle');
            retryTimeout = setTimeout(() => {
                setRefreshNonce((n) => n + 1);
            }, DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS);
        };

        void run();
        return () => {
            cancelled = true;
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTargetForProbe, cacheKey, params.capabilityServerId, params.cwd, params.selectedMachineId, probeContextCapabilityParams, probeContextKey, probeScopeKey, refreshNonce]);

    return {
        configOptions,
        unavailable,
        probe: {
            phase: probePhase,
            refreshedAt,
            onRefresh,
        },
    };
}
