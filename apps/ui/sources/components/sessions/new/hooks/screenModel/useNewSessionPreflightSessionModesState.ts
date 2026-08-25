import * as React from 'react';
import { readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol';

import { getAgentCore, isBundledAgentId, type AgentId } from '@/agents/catalog/catalog';
import { resolveCatalogAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { tLoose, type TranslationKeyNoParams } from '@/text';
import {
    getSessionModeOptionsForPreflightModeList,
    type PreflightSessionModeList,
    type SessionModeOption,
} from '@/sync/domains/sessionModes/sessionModeOptions';
import { buildDynamicSessionModeProbeCacheKey } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCacheKey';
import {
    DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS,
    readDynamicSessionModeProbeCache,
    runDynamicSessionModeProbeDedupe,
    writeDynamicSessionModeProbeCacheError,
    writeDynamicSessionModeProbeCacheSuccess,
    writeDynamicSessionModeProbeCacheUnavailable,
} from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
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

export function useNewSessionPreflightSessionModesState(params: Readonly<{
    backendTarget: BackendTargetRefV2;
    runtimeCarrierAgentId?: AgentId | null;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
    probeContext?: NewSessionCapabilityProbeContext | null;
}>): Readonly<{
    preflightModes: PreflightSessionModeList | null;
    modeOptions: readonly SessionModeOption[];
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        onRefresh?: () => void;
    }>;
}> {
    const [preflightModes, setPreflightModes] = React.useState<PreflightSessionModeList | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);
    const preflightModesRef = React.useRef<PreflightSessionModeList | null>(null);
    const refreshedAtRef = React.useRef<number | null>(null);
    const lastScopeKeyRef = React.useRef<string | null>(null);

    const onRefresh = React.useCallback(() => {
        setRefreshNonce((n) => n + 1);
    }, []);

    const backendTarget = params.backendTarget;

    const agentType = React.useMemo<AgentId | null>(() => {
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

    const backendTargetKey = React.useMemo(() => resolveBackendTargetKeyV2(backendTarget), [backendTarget]);
    const backendTargetForProbe = React.useMemo(() => {
        // Stabilize by semantic identity (backendTargetKey) so effects don't thrash on object identity churn.
        return readBackendTargetRefV2(backendTarget);
    }, [backendTargetKey]);

    const probeContextKey = buildNewSessionCapabilityProbeContextKey(params.probeContext);
    const probeContextCacheKeySuffixParts = React.useMemo(
        () => normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts(params.probeContext),
        [probeContextKey],
    );
    const probeContextCapabilityParams = React.useMemo(
        () => params.probeContext?.capabilityParams ?? null,
        [probeContextKey],
    );

    const preflightModesKey = React.useMemo(() => {
        return buildDynamicSessionModeProbeCacheKey({
            machineId: params.selectedMachineId,
            targetKey: backendTargetKey,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
            extraKeySuffixParts: probeContextCacheKeySuffixParts,
        });
    }, [backendTargetKey, params.capabilityServerId, params.cwd, params.selectedMachineId, probeContextCacheKeySuffixParts]);

    const probeScopeKey = React.useMemo(() => {
        const machineId = String(params.selectedMachineId ?? '').trim();
        if (!machineId) return null;
        const serverId = String(params.capabilityServerId ?? '').trim() || 'active';
        return JSON.stringify([
            'dynamicSessionModeProbeScope',
            serverId,
            machineId,
            backendTargetKey,
            ...(probeContextCacheKeySuffixParts ?? []),
        ]);
    }, [backendTargetKey, params.capabilityServerId, params.selectedMachineId, probeContextCacheKeySuffixParts]);

    const supportsPreflightModeProbe = React.useMemo(() => {
        if (!agentType) return false;
        const core = getAgentCore(agentType);
        // `sessionModes` is a bundled-only declaration, so an installed Agent
        // has no core to name an ACP mode kind. Treating that absence as a veto
        // is what makes the session-mode probe structurally unreachable for
        // every installed Agent; it declares its modes through its own
        // contribution, exactly as the models probe already assumes.
        if (!core) return true;
        const kind = core.sessionModes.kind;
        return kind === 'acpAgentModes' || kind === 'acpPolicyPresets';
    }, [agentType]);

    const staticModeOptions = React.useMemo((): readonly SessionModeOption[] => {
        if (!agentType) return [];
        const core = getAgentCore(agentType);
        if (core?.sessionModes.kind !== 'staticAgentModes') return [];

        const raw = core.sessionModes.staticOptions ?? [];
        if (!Array.isArray(raw) || raw.length === 0) return [];

        const mapped: SessionModeOption[] = raw
            .filter((opt): opt is Readonly<{ id: string; nameKey: TranslationKeyNoParams; descriptionKey?: TranslationKeyNoParams }> =>
                Boolean(opt && typeof opt.id === 'string' && typeof (opt as any).nameKey === 'string'))
            .map((opt) => ({
                id: opt.id,
                name: tLoose(opt.nameKey),
                ...(opt.descriptionKey ? { description: tLoose(opt.descriptionKey) } : {}),
            }))
            .filter((opt) => opt.id.trim().length > 0 && opt.name.trim().length > 0);

        const seen = new Set<string>();
        const deduped = mapped.filter((opt) => {
            if (seen.has(opt.id)) return false;
            seen.add(opt.id);
            return true;
        });

        const hasDefault = deduped.some((opt) => opt.id === 'default');
        return hasDefault
            ? [
                ...deduped.filter((opt) => opt.id === 'default'),
                ...deduped.filter((opt) => opt.id !== 'default'),
            ]
            : [
                { id: 'default', name: tLoose('common.default') },
                ...deduped,
            ];
    }, [agentType]);

    React.useEffect(() => {
        preflightModesRef.current = preflightModes;
        refreshedAtRef.current = refreshedAt;
    }, [preflightModes, refreshedAt]);

    React.useEffect(() => {
        if (!preflightModesKey) {
            setPreflightModes(null);
            preflightModesRef.current = null;
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

        const cacheEntry = readDynamicSessionModeProbeCache(preflightModesKey);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        const scopeStable = lastScopeKeyRef.current !== null && probeScopeKey !== null && lastScopeKeyRef.current === probeScopeKey;
        lastScopeKeyRef.current = probeScopeKey;
        if (cached) {
            setPreflightModes(cached);
            preflightModesRef.current = cached;
            setRefreshedAt(cacheEntry?.updatedAt ?? null);
            refreshedAtRef.current = cacheEntry?.updatedAt ?? null;
        } else if (!scopeStable) {
            setPreflightModes(null);
            preflightModesRef.current = null;
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
            if (!probeAgentType || !supportsPreflightModeProbe) return;
            if (!params.selectedMachineId) return;
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';

            setProbePhase(preflightModesRef.current ? 'refreshing' : 'loading');
            const attempt = await runDynamicSessionModeProbeDedupe<Readonly<{
                list: PreflightSessionModeList;
                cacheable: boolean;
            }> | null>(preflightModesKey, async () => {
                const res = await machineCapabilitiesInvoke(
                    params.selectedMachineId!,
                    {
                        id: buildProviderCliCapabilityId(probeAgentType),
                        method: 'probeModes',
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

                if (!res.supported) return null;
                if (!res.response.ok) return null;

                const result = res.response.result;
                if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
                const rec = result as Record<string, unknown>;
                const source = typeof rec.source === 'string' ? rec.source : null;
                const unavailable = source === 'unavailable';
                const modesRaw = (rec as { availableModes?: unknown }).availableModes;
                if (!Array.isArray(modesRaw)) return null;

                const availableModes = modesRaw
                    .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                    .map((m: any) => ({
                        id: String(m.id),
                        name: String(m.name),
                        ...(typeof m.description === 'string' ? { description: m.description } : {}),
                    }));
                if (availableModes.length === 0 && !unavailable) return null;
                const parsed: PreflightSessionModeList = {
                    availableModes,
                    ...(unavailable ? { unavailable: true } : {}),
                };
                const cacheable = source !== 'static' && source !== 'unavailable';
                return { list: parsed, cacheable };
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            const list = attempt?.list ?? null;
            if (list && attempt?.cacheable !== false) {
                writeDynamicSessionModeProbeCacheSuccess(preflightModesKey, list, commitNowMs);
                setPreflightModes(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }
            if (list?.unavailable === true && attempt?.cacheable === false) {
                writeDynamicSessionModeProbeCacheUnavailable(preflightModesKey, list, commitNowMs);
                setPreflightModes(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                retryTimeout = scheduleProbedResourceRetryAfterDelay(DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS, () => {
                    setRefreshNonce((n) => n + 1);
                });
                return;
            }

            if (list && attempt?.cacheable === false && !cached) {
                writeDynamicSessionModeProbeCacheError(preflightModesKey, commitNowMs);
                setPreflightModes(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (cached) {
                // Keep stale-but-usable mode lists sticky if a refresh probe fails.
                if (cached.unavailable === true) {
                    writeDynamicSessionModeProbeCacheUnavailable(preflightModesKey, cached, commitNowMs);
                } else {
                    writeDynamicSessionModeProbeCacheSuccess(preflightModesKey, cached, commitNowMs);
                }
                setPreflightModes(cached);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            const stale = preflightModesRef.current;
            const staleUpdatedAt = refreshedAtRef.current;
            if (stale && staleUpdatedAt) {
                setPreflightModes(stale);
                setRefreshedAt(staleUpdatedAt);
                setProbePhase('idle');
                return;
            }

            writeDynamicSessionModeProbeCacheError(preflightModesKey, commitNowMs);
            setProbePhase('idle');
            retryTimeout = setTimeout(() => {
                setRefreshNonce((n) => n + 1);
            }, DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS);
        };

        void run();
        return () => {
            cancelled = true;
            if (retryTimeout) clearTimeout(retryTimeout);
        };
    }, [agentType, backendTargetForProbe, preflightModesKey, params.selectedMachineId, params.capabilityServerId, params.cwd, probeContextKey, probeContextCapabilityParams, probeScopeKey, refreshNonce, supportsPreflightModeProbe]);

    const modeOptions = React.useMemo(() => {
        if (staticModeOptions.length > 0) return staticModeOptions;
        if (preflightModes) {
            return getSessionModeOptionsForPreflightModeList(preflightModes);
        }
        if (supportsPreflightModeProbe && params.selectedMachineId) {
            // Provide a stable placeholder so the UI can show loading/refreshing states.
            return [{ id: 'default', name: 'Default' }];
        }
        return [];
    }, [params.selectedMachineId, preflightModes, staticModeOptions, supportsPreflightModeProbe]);

    return {
        preflightModes,
        modeOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            ...(supportsPreflightModeProbe ? { onRefresh } : {}),
        },
    };
}
