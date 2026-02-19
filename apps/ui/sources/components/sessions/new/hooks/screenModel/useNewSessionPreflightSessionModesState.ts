import * as React from 'react';

import { getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import {
    getSessionModeOptionsForPreflightModeList,
    type PreflightSessionModeList,
    type SessionModeOption,
} from '@/sync/domains/sessionModes/sessionModeOptions';
import { buildDynamicSessionModeProbeCacheKey } from '@/sync/domains/sessionModes/dynamicSessionModeProbeCacheKey';
import {
    readDynamicSessionModeProbeCache,
    runDynamicSessionModeProbeDedupe,
    writeDynamicSessionModeProbeCacheError,
    writeDynamicSessionModeProbeCacheSuccess,
} from '@/sync/domains/sessionModes/dynamicSessionModeProbeCache';

export function useNewSessionPreflightSessionModesState(params: Readonly<{
    agentType: AgentId;
    selectedMachineId: string | null;
    capabilityServerId: string;
    cwd?: string | null;
}>): Readonly<{
    preflightModes: PreflightSessionModeList | null;
    modeOptions: readonly SessionModeOption[];
    probe: Readonly<{
        phase: 'idle' | 'loading' | 'refreshing';
        refreshedAt: number | null;
        refresh: () => void;
    }>;
}> {
    const [preflightModes, setPreflightModes] = React.useState<PreflightSessionModeList | null>(null);
    const [probePhase, setProbePhase] = React.useState<'idle' | 'loading' | 'refreshing'>('idle');
    const [refreshedAt, setRefreshedAt] = React.useState<number | null>(null);
    const [refreshNonce, setRefreshNonce] = React.useState(0);
    const lastHandledRefreshNonceRef = React.useRef(0);

    const refresh = React.useCallback(() => {
        setRefreshNonce((n) => n + 1);
    }, []);

    const preflightModesKey = React.useMemo(() => {
        return buildDynamicSessionModeProbeCacheKey({
            machineId: params.selectedMachineId,
            agentType: params.agentType,
            serverId: params.capabilityServerId,
            cwd: params.cwd ?? null,
        });
    }, [params.agentType, params.capabilityServerId, params.cwd, params.selectedMachineId]);

    const supportsPreflightModeProbe = React.useMemo(() => {
        const core = getAgentCore(params.agentType);
        return core.sessionModes.kind === 'acpAgentModes';
    }, [params.agentType]);

    React.useEffect(() => {
        if (!preflightModesKey) {
            setPreflightModes(null);
            setProbePhase('idle');
            setRefreshedAt(null);
            return;
        }

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
            return;
        }

        let cancelled = false;
        const run = async () => {
            if (!supportsPreflightModeProbe) return;
            if (!params.selectedMachineId) return;
            const cwd = typeof params.cwd === 'string' ? params.cwd.trim() : '';

            setProbePhase(cached ? 'refreshing' : 'loading');
            const list = await runDynamicSessionModeProbeDedupe(preflightModesKey, async () => {
                const res = await machineCapabilitiesInvoke(
                    params.selectedMachineId!,
                    {
                        id: `cli.${params.agentType}` as any,
                        method: 'probeModes',
                        params: {
                            timeoutMs: 15_000,
                            ...(cwd ? { cwd } : {}),
                        },
                    },
                    {
                        serverId: params.capabilityServerId,
                    },
                );

                if (!res.supported) return null;
                if (!res.response.ok) return null;

                const raw = res.response.result as any;
                const modesRaw = raw?.availableModes;
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
                return parsed;
            });

            if (cancelled) return;
            const commitNowMs = Date.now();
            if (list) {
                writeDynamicSessionModeProbeCacheSuccess(preflightModesKey, list, commitNowMs);
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
        };

        void run();
        return () => {
            cancelled = true;
        };
    }, [preflightModesKey, params.agentType, params.selectedMachineId, params.capabilityServerId, params.cwd, refreshNonce, supportsPreflightModeProbe]);

    const modeOptions = React.useMemo(() => {
        if (preflightModes && Array.isArray(preflightModes.availableModes) && preflightModes.availableModes.length > 0) {
            return getSessionModeOptionsForPreflightModeList(preflightModes);
        }
        if (supportsPreflightModeProbe && params.selectedMachineId) {
            // Provide a stable placeholder so the UI can show loading/refreshing states.
            return [{ id: 'default', name: 'Default' }];
        }
        return [];
    }, [params.selectedMachineId, preflightModes, supportsPreflightModeProbe]);

    return {
        preflightModes,
        modeOptions,
        probe: {
            phase: probePhase,
            refreshedAt,
            refresh,
        },
    };
}
