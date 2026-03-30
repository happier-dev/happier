import * as React from 'react';
import { buildBackendTargetKey, isBuiltInAgentTarget, type BackendTargetRefV1 } from '@happier-dev/protocol';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { resolveProviderAgentIdForBackendTarget } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
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
} from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';
import {
    buildNewSessionCapabilityProbeContextKey,
    normalizeNewSessionCapabilityProbeContextCacheKeySuffixParts,
    type NewSessionCapabilityProbeContext,
} from '@/components/sessions/new/modules/newSessionCapabilityProbeContext';
import { NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from '@/components/sessions/new/modules/newSessionCapabilityProbeTimeoutMs';
import { scheduleProbedResourceRetryAfterExpiry } from './probedResourceRetrySchedule';

export function useNewSessionPreflightSessionModesState(params: Readonly<{
    backendTarget: BackendTargetRefV1;
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

    const supportsPreflightModeProbe = React.useMemo(() => {
        const core = getAgentCore(agentType);
        return core.sessionModes.kind === 'acpAgentModes' || core.sessionModes.kind === 'acpPolicyPresets';
    }, [agentType]);

    const staticModeOptions = React.useMemo((): readonly SessionModeOption[] => {
        const core = getAgentCore(agentType);
        if (core.sessionModes.kind !== 'staticAgentModes') return [];

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
        if (!preflightModesKey) {
            setPreflightModes(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            return;
        }

        let retryTimeout: ReturnType<typeof setTimeout> | null = null;
        const shouldForceProbe = refreshNonce !== 0 && refreshNonce !== lastHandledRefreshNonceRef.current;
        if (shouldForceProbe) {
            lastHandledRefreshNonceRef.current = refreshNonce;
        }

        const cacheEntry = readDynamicSessionModeProbeCache(preflightModesKey);
        const cached = cacheEntry?.kind === 'success' ? cacheEntry.value : null;
        setPreflightModes(cached);
        setRefreshedAt(cacheEntry?.kind === 'success' ? cacheEntry.updatedAt : null);

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
            if (!supportsPreflightModeProbe) return;
            if (!params.selectedMachineId) return;
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';

            setProbePhase(cached ? 'refreshing' : 'loading');
            const attempt = await runDynamicSessionModeProbeDedupe<Readonly<{
                list: PreflightSessionModeList;
                cacheable: boolean;
            }> | null>(preflightModesKey, async () => {
                const res = await machineCapabilitiesInvoke(
                    params.selectedMachineId!,
                    {
                        id: `cli.${agentType}` as any,
                        method: 'probeModes',
                        params: {
                            timeoutMs: NEW_SESSION_CAPABILITY_PROBE_TIMEOUT_MS,
                            backendTarget,
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
                const modesRaw = (rec as { availableModes?: unknown }).availableModes;
                if (!Array.isArray(modesRaw) || modesRaw.length === 0) return null;

                const parsed: PreflightSessionModeList = {
                    availableModes: modesRaw
                        .filter((m: any) => m && typeof m.id === 'string' && typeof m.name === 'string')
                        .map((m: any) => ({
                            id: String(m.id),
                            name: String(m.name),
                            ...(typeof m.description === 'string' ? { description: m.description } : {}),
                        })),
                };
                if (parsed.availableModes.length === 0) return null;
                const source = typeof rec.source === 'string' ? rec.source : null;
                const cacheable = source !== 'static';
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
            if (list && attempt?.cacheable === false && !cached) {
                writeDynamicSessionModeProbeCacheError(preflightModesKey, commitNowMs);
                setPreflightModes(list);
                setRefreshedAt(commitNowMs);
                setProbePhase('idle');
                return;
            }

            if (cached) {
                // Keep stale-but-usable mode lists sticky if a refresh probe fails.
                writeDynamicSessionModeProbeCacheSuccess(preflightModesKey, cached, commitNowMs);
                setPreflightModes(cached);
                setRefreshedAt(commitNowMs);
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
    }, [agentType, backendTarget, preflightModesKey, params.selectedMachineId, params.capabilityServerId, params.cwd, probeContextKey, probeContextCapabilityParams, refreshNonce, supportsPreflightModeProbe]);

    const modeOptions = React.useMemo(() => {
        if (staticModeOptions.length > 0) return staticModeOptions;
        if (preflightModes && Array.isArray(preflightModes.availableModes) && preflightModes.availableModes.length > 0) {
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
