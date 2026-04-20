import * as React from 'react';

import {
    entryIsFresh,
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
    type DaemonMergedProjectionInputs,
} from './loadDaemonMergedProjectionInputs';

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
}>): Readonly<{
    phase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
    inputs: DaemonMergedProjectionInputs | null;
}> {
    const enabled = params.enabled !== false;
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : 60_000;

    const cacheKey = React.useMemo(() => {
        if (!enabled || !machineId) return null;
        return buildCacheKey(machineId, serverId || null);
    }, [enabled, machineId, serverId]);
    const refreshKeyRef = React.useRef(params.refreshKey);

    const [state, setState] = React.useState<Readonly<{
        phase: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';
        inputs: DaemonMergedProjectionInputs | null;
    }>>(() => {
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
        return { phase: cached.kind, inputs: null };
    });

    React.useEffect(() => {
        const forceReload = refreshKeyRef.current !== params.refreshKey;
        refreshKeyRef.current = params.refreshKey;
        if (!cacheKey || !machineId) {
            setState({ phase: 'idle', inputs: null });
            return;
        }

        const cached = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null });
        if (cached) {
            if (cached.kind === 'ready') {
                setState({ phase: 'ready', inputs: cached.inputs });
            } else {
                setState({ phase: cached.kind, inputs: null });
            }
            if (!forceReload && entryIsFresh(cached, staleMs)) {
                return;
            }
        } else {
            setState({ phase: 'loading', inputs: null });
        }

        let alive = true;
        void (async () => {
            try {
                const entry = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null });
                if (!alive) return;
                if (entry.kind === 'ready') {
                    setState({ phase: 'ready', inputs: entry.inputs });
                } else {
                    setState({ phase: entry.kind, inputs: null });
                }
            } catch {
                if (!alive) return;
                setState({ phase: 'error', inputs: null });
            }
        })();

        return () => {
            alive = false;
        };
    }, [cacheKey, machineId, params.refreshKey, serverId, staleMs]);

    return state;
}
