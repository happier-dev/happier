import * as React from 'react';

import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';

import {
    entryIsFresh,
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
    type DaemonMergedProjectionInputs,
} from './loadDaemonMergedProjectionInputs';

type DaemonMergedProjectionInputsState = Readonly<{
    phase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    inputs: DaemonMergedProjectionInputs | null;
}>;

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

function buildCacheKey(machineId: string, serverId: string | null | undefined): string {
    return `${normalizeKeyPart(serverId)}::${normalizeKeyPart(machineId)}`;
}

export function useDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    enabled?: boolean;
    staleMs?: number;
    refreshKey?: unknown;
    /**
     * Keeps the last projection available as stale metadata while a route-driven scope
     * replacement loads. Callers must gate daemon-authoritative mutations on `phase === 'ready'`.
     */
    retainInputsAcrossScopeChange?: boolean;
}>): DaemonMergedProjectionInputsState {
    const enabled = params.enabled !== false;
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : 60_000;
    const projectionScope = React.useMemo(() => (
        enabled && machineId
            ? { machineId, serverId: serverId || null }
            : null
    ), [enabled, machineId, serverId]);
    const subscribeProjectionInvalidation = React.useCallback((listener: () => void) => (
        projectionScope
            ? subscribeMachineContributionRegistryProjectionInvalidation(projectionScope, listener)
            : () => {}
    ), [projectionScope]);
    const getProjectionRevision = React.useCallback(() => (
        projectionScope
            ? getMachineContributionRegistryProjectionRevision(projectionScope)
            : 0
    ), [projectionScope]);
    const projectionRevision = React.useSyncExternalStore(
        subscribeProjectionInvalidation,
        getProjectionRevision,
        getProjectionRevision,
    );

    const cacheKey = React.useMemo(() => {
        if (!enabled || !machineId) return null;
        return buildCacheKey(machineId, serverId || null);
    }, [enabled, machineId, serverId]);
    const refreshKeyRef = React.useRef(params.refreshKey);
    const projectionRevisionRef = React.useRef(projectionRevision);
    const machineIdRef = React.useRef(machineId);

    const [state, setState] = React.useState<DaemonMergedProjectionInputsState>(() => {
        if (!cacheKey) {
            return { phase: 'idle', inputs: null };
        }
        const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null });
        if (!cached) {
            return { phase: 'loading', inputs: null };
        }
        if (cached.kind === 'ready') {
            return { phase: 'ready', inputs: cached.inputs };
        }
        return {
            phase: cached.kind,
            inputs: cached.kind === 'error' ? (cached.inputs ?? null) : null,
        };
    });

    React.useEffect(() => {
        const forceReload = refreshKeyRef.current !== params.refreshKey
            || projectionRevisionRef.current !== projectionRevision;
        const previousMachineId = machineIdRef.current;
        refreshKeyRef.current = params.refreshKey;
        projectionRevisionRef.current = projectionRevision;
        machineIdRef.current = machineId;
        if (!cacheKey || !machineId) {
            setState({ phase: 'idle', inputs: null });
            return;
        }

        const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null });
        if (cached) {
            if (forceReload) {
                setState({
                    phase: 'loading',
                    inputs: cached.kind === 'ready' || cached.kind === 'error'
                        ? (cached.inputs ?? null)
                        : null,
                });
            } else if (cached.kind === 'ready') {
                setState({ phase: 'ready', inputs: cached.inputs });
            } else {
                setState({
                    phase: cached.kind,
                    inputs: cached.kind === 'error' ? (cached.inputs ?? null) : null,
                });
            }
            if (!forceReload && entryIsFresh(cached, staleMs)) {
                return;
            }
        } else {
            setState((previous) => ({
                phase: 'loading',
                inputs: params.retainInputsAcrossScopeChange === true || previousMachineId === machineId
                    ? previous.inputs
                    : null,
            }));
        }

        let alive = true;
        void (async () => {
            try {
                const entry = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null });
                if (!alive) return;
                if (entry.kind === 'ready') {
                    setState({ phase: 'ready', inputs: entry.inputs });
                } else if (entry.kind === 'error') {
                    setState((previous) => ({
                        phase: 'error',
                        inputs: entry.inputs ?? previous.inputs,
                    }));
                } else {
                    setState({ phase: entry.kind, inputs: null });
                }
            } catch {
                if (!alive) return;
                setState((previous) => ({
                    phase: 'error',
                    inputs: previous.inputs,
                }));
            }
        })();

        return () => {
            alive = false;
        };
    }, [
        cacheKey,
        machineId,
        params.refreshKey,
        params.retainInputsAcrossScopeChange,
        projectionRevision,
        serverId,
        staleMs,
    ]);

    return state;
}
