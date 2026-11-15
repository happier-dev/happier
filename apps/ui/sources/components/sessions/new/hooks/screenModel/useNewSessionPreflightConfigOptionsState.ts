import * as React from 'react';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { isBundledAgentId } from '@/agents/catalog/catalog';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { invokeAgentInventoryProbeAction } from '@/sync/ops/actions/agentInventoryActionDeps';
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
import type { ProbedResourceFailure } from '@/sync/runtime/probedResources/createPersistentProbedResourceCache';
import { readCapabilityInvokeFailure } from '@happier-dev/protocol/capabilities';
import { readSessionRuntimeFailureCause } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
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
    enabled?: boolean;
}>): Readonly<{
    configOptions: readonly AcpConfigOption[] | null;
    modelConfigOptionId?: string;
    unavailable: boolean;
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        failed: boolean;
        refreshErrorMessage?: string;
        rejectedConfigOptionOverrides?: Readonly<Record<string, string>>;
        refreshedAt: number | null;
        reason?: ProbedResourceFailure['reason'];
        errorCode?: string;
        retryable?: boolean;
        requestDisposition?: ProbedResourceFailure['requestDisposition'];
        failureCause?: ProbedResourceFailure['failureCause'];
        onRefresh: () => void;
    }>;
}> {
    const [configOptions, setConfigOptions] = React.useState<readonly AcpConfigOption[] | null>(null);
    const [modelConfigOptionId, setModelConfigOptionId] = React.useState<string | undefined>();
    const [unavailable, setUnavailable] = React.useState(false);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [failure, setFailure] = React.useState<ProbedResourceFailure>({});
    const [refreshFailure, setRefreshFailure] = React.useState<Readonly<{
        refreshErrorMessage?: string;
        rejectedConfigOptionOverrides: Readonly<Record<string, string>>;
    }> | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const configOptionsRef = React.useRef<readonly AcpConfigOption[] | null>(null);
    const modelConfigOptionIdRef = React.useRef<string | undefined>(undefined);
    const refreshedAtRef = React.useRef<number | null>(null);
    const lastCacheKeyRef = React.useRef<string | null>(null);

    React.useEffect(() => {
        configOptionsRef.current = configOptions;
        modelConfigOptionIdRef.current = modelConfigOptionId;
        refreshedAtRef.current = refreshedAt;
    }, [configOptions, modelConfigOptionId, refreshedAt]);

    const onRefresh = React.useCallback(() => {
        setRefreshFailure(null);
        setRefreshNonce((current) => current + 1);
    }, []);

    const backendTargetInput = params.backendTarget;
    const probeKey = React.useMemo(() => resolveBackendTargetKeyV2(backendTargetInput), [backendTargetInput]);
    React.useEffect(() => {
        setRefreshFailure(null);
    }, [probeKey, params.selectedMachineId, params.capabilityServerId, params.cwd]);
    const backendTargetForProbe = React.useMemo(() => {
        // Stabilize by semantic identity (probeKey) so effects don't thrash on object identity churn.
        return readBackendTargetRefV2(backendTargetInput);
    }, [probeKey]);

    const agentType = React.useMemo(() => {
        if (isBundledAgentId(params.runtimeCarrierAgentId)) {
            return params.runtimeCarrierAgentId;
        }
        // For built-in backends the backend id is already a canonical agent id.
        // For plugin-contributed backends the provider may still override it.
        const bundledProbeAgentId = resolveCatalogAgentIdForBackendTarget(backendTargetForProbe)
            ?? (isBundledAgentId(backendTargetForProbe.backendId) ? backendTargetForProbe.backendId : null);
        if (bundledProbeAgentId) return bundledProbeAgentId;
        // An installed Agent owns its own `cli.<agentId>` capability, so its
        // operational runtime carrier is the probe identity — the same rule the
        // models probe already applies. Narrowing the probe identity to the
        // closed bundled set is what removes ACP configuration options from
        // every installed Agent.
        return params.runtimeCarrierAgentId?.trim() || null;
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

    React.useEffect(() => {
        if (params.enabled === false) {
            setFailure({});
            setRefreshFailure(null);
            setConfigOptions(null);
            setModelConfigOptionId(undefined);
            configOptionsRef.current = null;
            setUnavailable(false);
            setProbePhase('idle');
            setRefreshedAt(null);
            refreshedAtRef.current = null;
            lastCacheKeyRef.current = cacheKey;
            return;
        }
        if (!cacheKey || !agentType) {
            setFailure({});
            setConfigOptions(null);
            setModelConfigOptionId(undefined);
            configOptionsRef.current = null;
            setUnavailable(false);
            setProbePhase('idle');
            setRefreshedAt(null);
            refreshedAtRef.current = null;
            lastCacheKeyRef.current = cacheKey;
            return;
        }

        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const shouldForceProbe = refreshNonce !== 0 && refreshNonce !== lastHandledRefreshNonceRef.current;
        if (shouldForceProbe) {
            lastHandledRefreshNonceRef.current = refreshNonce;
        }

        const cacheEntry = readDynamicConfigOptionsProbeCache(cacheKey);
        setFailure({ reason: cacheEntry?.reason, errorCode: cacheEntry?.errorCode, retryable: cacheEntry?.retryable,
            requestDisposition: cacheEntry?.requestDisposition, failureCause: cacheEntry?.failureCause });
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        const scopeStable = lastCacheKeyRef.current !== null && lastCacheKeyRef.current === cacheKey;
        lastCacheKeyRef.current = cacheKey;
        if (cached) {
            setConfigOptions(cached);
            setModelConfigOptionId(cacheEntry?.kind === 'success' ? cacheEntry.modelConfigOptionId : undefined);
            configOptionsRef.current = cached;
            setUnavailable(cacheEntry?.kind === 'success' && cacheEntry.unavailable === true);
            const cachedUpdatedAt = cacheEntry?.updatedAt ?? null;
            setRefreshedAt(cachedUpdatedAt);
            refreshedAtRef.current = cachedUpdatedAt;
        } else if (!scopeStable) {
            setConfigOptions(null);
            setModelConfigOptionId(undefined);
            configOptionsRef.current = null;
            setUnavailable(false);
            setRefreshedAt(null);
            refreshedAtRef.current = null;
        }

        const nowMs = Date.now();
        if (!shouldForceProbe && cacheEntry && (cacheEntry.reason === 'outcomeUnknown' || (nowMs >= 0 && nowMs < cacheEntry.expiresAt))) {
            setProbePhase('idle');
            retryTimeout = cacheEntry.reason === 'outcomeUnknown' ? null : scheduleProbedResourceRetryAfterExpiry(cacheEntry, nowMs, () => {
                setRefreshNonce((n) => n + 1);
            });
            return () => {
                if (retryTimeout) clearTimeout(retryTimeout);
            };
        }

        let cancelled = false;
        const controller = new AbortController();
        const run = async () => {
            const probeAgentType = agentType;
            if (!probeAgentType) return;
            if (!params.selectedMachineId) return;
            setProbePhase(configOptionsRef.current ? 'refreshing' : 'loading');
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';
            const attempt = await runDynamicConfigOptionsProbeDedupe<Readonly<{
                value?: readonly AcpConfigOption[];
                modelConfigOptionId?: string;
                cacheable?: boolean;
                unavailable?: boolean;
                failure?: ProbedResourceFailure;
                refreshError?: boolean;
                refreshErrorMessage?: string;
            }> | null>(cacheKey, async (signal) => {
                const response = await invokeAgentInventoryProbeAction({
                    agentId: probeAgentType,
                    machineId: params.selectedMachineId!,
                    serverId: params.capabilityServerId,
                    backendTarget: backendTargetForProbe,
                    signal,
                    capabilityParams: {
                            timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                            ...(probeContextCapabilityParams ? probeContextCapabilityParams : {}),
                            ...(cwd ? { cwd } : {}),
                    },
                }, 'probeConfigOptions');

                if (!response.supported) return { failure: {
                    reason: response.reason,
                    ...(response.errorCode ? { errorCode: response.errorCode } : {}),
                    ...(response.retryable === undefined ? {} : { retryable: response.retryable }),
                    ...(response.requestDisposition ? { requestDisposition: response.requestDisposition } : {}),
                    ...(response.failureCause ? { failureCause: response.failureCause } : {}),
                } };
                if (!response.response.ok) return { failure: { reason: 'error',
                    ...readCapabilityInvokeFailure({ ...response.response.error, errorCode: response.response.error.code }) } };
                const result = response.response.result;
                if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
                const record = result as Record<string, unknown>;
                const source = typeof record.source === 'string' ? record.source : null;
                const failureCause = readSessionRuntimeFailureCause(record);
                const failure: ProbedResourceFailure | undefined = failureCause ? { failureCause } : undefined;
                if (source === 'unavailable') {
                    return { value: [], cacheable: false, unavailable: true, failure };
                }
                const normalized = normalizeAcpConfigOptionsArray(record.configOptions);
                if (!normalized) return null;
                const cacheable = source !== 'static';
                return { value: normalized, cacheable, failure,
                    ...(record.refreshError === true ? { refreshError: true } : {}),
                    ...(typeof record.refreshErrorMessage === 'string' ? { refreshErrorMessage: record.refreshErrorMessage } : {}),
                    ...(typeof record.modelConfigOptionId === 'string' && record.modelConfigOptionId.trim()
                        ? { modelConfigOptionId: record.modelConfigOptionId } : {}) };
            }, controller.signal);

            if (cancelled) return;
            const commitNowMs = Date.now();
            const probeFailure = attempt?.failure;
            setFailure(probeFailure ?? {});
            if (probeFailure?.reason === 'outcomeUnknown') {
                writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs, probeFailure);
                setProbePhase('idle');
                return;
            }
            const value = attempt?.value ?? null;
            const nextUnavailable = attempt?.unavailable === true;

            if (attempt?.refreshError) {
                const refreshFailure: ProbedResourceFailure = { reason: 'error', ...probeFailure };
                writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs, refreshFailure);
                const observed = configOptionsRef.current ?? value;
                if (observed) {
                    setConfigOptions(observed);
                    setModelConfigOptionId(configOptionsRef.current ? modelConfigOptionIdRef.current : attempt.modelConfigOptionId);
                }
                setRefreshFailure({
                    ...(attempt.refreshErrorMessage === undefined ? {} : { refreshErrorMessage: attempt.refreshErrorMessage }),
                    rejectedConfigOptionOverrides: probeContextCapabilityParams?.configOptionOverrides ?? {},
                });
                setFailure(refreshFailure);
                setUnavailable(false);
                setProbePhase('idle');
                return;
            }

            if (value && attempt?.cacheable !== false) {
                setRefreshFailure(null);
                writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, value, commitNowMs, attempt?.modelConfigOptionId);
                setConfigOptions(value);
                setModelConfigOptionId(attempt?.modelConfigOptionId);
                setUnavailable(false);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (value && attempt?.cacheable === false && nextUnavailable) {
                writeDynamicConfigOptionsProbeCacheUnavailable(cacheKey, commitNowMs, probeFailure);
                setConfigOptions(value);
                setModelConfigOptionId(undefined);
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
                setModelConfigOptionId(attempt?.modelConfigOptionId);
                setUnavailable(false);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (cached) {
                const cachedUnavailable = cacheEntry?.kind === 'success' && cacheEntry.unavailable === true;
                if (cachedUnavailable) {
                    writeDynamicConfigOptionsProbeCacheUnavailable(cacheKey, commitNowMs, probeFailure);
                } else if (probeFailure) {
                    writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs, probeFailure);
                } else {
                    writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, cached, commitNowMs, cacheEntry?.kind === 'success' ? cacheEntry.modelConfigOptionId : undefined);
                }
                setConfigOptions(cached);
                setModelConfigOptionId(cacheEntry?.kind === 'success' ? cacheEntry.modelConfigOptionId : undefined);
                setUnavailable(cachedUnavailable);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            const stale = configOptionsRef.current;
            const staleUpdatedAt = refreshedAtRef.current;
            if (stale && staleUpdatedAt) {
                if (probeFailure) writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs, probeFailure);
                else writeDynamicConfigOptionsProbeCacheSuccess(cacheKey, stale, commitNowMs, modelConfigOptionIdRef.current);
                setConfigOptions(stale);
                setUnavailable(false);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            writeDynamicConfigOptionsProbeCacheError(cacheKey, commitNowMs, probeFailure);
            setUnavailable(false);
            setProbePhase('idle');
            retryTimeout = setTimeout(() => {
                setRefreshNonce((n) => n + 1);
            }, DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS);
        };

        void run().catch(() => {
            if (!cancelled) setProbePhase('idle');
        });
        return () => {
            cancelled = true;
            controller.abort();
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTargetForProbe, cacheKey, params.enabled, params.capabilityServerId, params.cwd, params.selectedMachineId, probeContextCapabilityParams, probeContextKey, refreshNonce]);

    // Match the model observation owner: a render for a different request must
    // not lend the previous draft's catalog authority before effects adopt it.
    const hasCurrentIdentity = lastCacheKeyRef.current === cacheKey;
    const retainedEntry = !hasCurrentIdentity && cacheKey && params.enabled !== false
        ? readDynamicConfigOptionsProbeCache(cacheKey) : null;
    const retainedCatalog = retainedEntry?.kind === 'success' ? retainedEntry : null;

    return {
        configOptions: hasCurrentIdentity ? configOptions : retainedCatalog?.value ?? null,
        modelConfigOptionId: hasCurrentIdentity ? modelConfigOptionId : retainedCatalog?.modelConfigOptionId,
        unavailable: hasCurrentIdentity ? unavailable : retainedCatalog?.unavailable === true,
        probe: {
            phase: probePhase,
            failed: refreshFailure !== null || failure.reason === 'error' || failure.reason === 'outcomeUnknown',
            ...(refreshFailure ?? {}),
            refreshedAt,
            ...failure,
            onRefresh,
        },
    };
}
