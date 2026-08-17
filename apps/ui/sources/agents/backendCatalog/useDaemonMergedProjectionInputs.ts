import * as React from 'react';
import type { DaemonContributionRegistryProjectionMountedTargetV1 } from '@happier-dev/protocol';

import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

import {
    entryIsFresh,
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
    retainMountedTargetProjectionCacheScope,
    type DaemonMergedProjectionInputs,
} from './loadDaemonMergedProjectionInputs';

/**
 * Why the merged projection is not currently authoritative. `unsupported` and
 * `error` are daemon-side answers, not transport state: a consumer must not
 * report them as a disconnected machine.
 */
export type DaemonMergedProjectionPhase = 'idle' | 'loading' | 'ready' | 'unsupported' | 'error';

export type DaemonMergedProjectionInputsState = Readonly<{
    phase: DaemonMergedProjectionPhase;
    inputs: DaemonMergedProjectionInputs | null;
}>;

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

export function useDaemonMergedProjectionInputs(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
    enabled?: boolean;
    staleMs?: number;
    refreshKey?: unknown;
    /** One exact target key for a cold-admitted contribution snapshot. */
    mountedTarget?: DaemonContributionRegistryProjectionMountedTargetV1;
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
    // Targeted projections retain an executable validator. Capture the one
    // incumbent Account lifetime once per render and pass that exact object to
    // every cache/request operation; this hook owns no Account epoch itself.
    const accountLifetime = params.mountedTarget
        ? captureActiveServerAccountScopeLifetime()
        : null;
    const targetRequest = React.useMemo(() => (
        params.mountedTarget
            ? Object.freeze({ mountedTarget: params.mountedTarget, accountLifetime })
            : null
    ), [accountLifetime, params.mountedTarget?.immutableGenerationId, params.mountedTarget?.pluginId]);
    const hasProjectionScope = enabled && Boolean(machineId);
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

    const refreshKeyRef = React.useRef(params.refreshKey);
    const projectionRevisionRef = React.useRef(projectionRevision);
    const machineIdRef = React.useRef(machineId);

    const [state, setState] = React.useState<DaemonMergedProjectionInputsState>(() => {
        if (!hasProjectionScope) {
            return { phase: 'idle', inputs: null };
        }
        if (params.mountedTarget && !accountLifetime) {
            return { phase: 'loading', inputs: null };
        }
        const cached = readCachedDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
            ...(targetRequest ?? {}),
        });
        if (!cached) {
            return { phase: 'loading', inputs: null };
        }
        if (cached.kind === 'ready') {
            return { phase: 'ready', inputs: cached.inputs };
        }
        if (cached.kind === 'error') {
            // A cached failure is not an authoritative answer: revalidate instead of
            // serving it, while keeping any stale inputs as inert metadata.
            return { phase: 'loading', inputs: cached.inputs ?? null };
        }
        return { phase: cached.kind, inputs: null };
    });
    // A target cache response is never visible under a successor Account. The
    // effect below publishes the new Account's state; this render-time fence
    // prevents one stale render before that effect has run.
    const stateAccountLifetimeRef = React.useRef<ActiveServerAccountScopeLifetime | null>(accountLifetime);

    // Keep the target-generation cache resident for the mounted host's own
    // lifetime, independently of revision/refresh fetch effects. In
    // particular, a refresh of G must retain G's already compiled validator;
    // replacement by H or unmount retires the exact target entry.
    React.useEffect(() => {
        if (!hasProjectionScope || !machineId || !targetRequest?.accountLifetime) return;
        return retainMountedTargetProjectionCacheScope({
            machineId,
            serverId: serverId || null,
            ...targetRequest,
        });
    }, [
        hasProjectionScope,
        machineId,
        serverId,
        targetRequest,
    ]);

    React.useEffect(() => {
        const forceReload = refreshKeyRef.current !== params.refreshKey
            || projectionRevisionRef.current !== projectionRevision;
        const previousMachineId = machineIdRef.current;
        const accountLifetimeChanged = params.mountedTarget !== undefined
            && stateAccountLifetimeRef.current !== accountLifetime;
        refreshKeyRef.current = params.refreshKey;
        projectionRevisionRef.current = projectionRevision;
        machineIdRef.current = machineId;
        if (!hasProjectionScope || !machineId) {
            stateAccountLifetimeRef.current = accountLifetime;
            setState({ phase: 'idle', inputs: null });
            return;
        }
        if (params.mountedTarget && !accountLifetime) {
            stateAccountLifetimeRef.current = accountLifetime;
            setState({ phase: 'loading', inputs: null });
            return;
        }

        const cached = readCachedDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
            ...(targetRequest ?? {}),
        });
        if (cached) {
            stateAccountLifetimeRef.current = accountLifetime;
            if (forceReload || cached.kind === 'error') {
                setState({
                    phase: 'loading',
                    inputs: cached.kind === 'ready' || cached.kind === 'error'
                        ? (cached.inputs ?? null)
                        : null,
                });
            } else if (cached.kind === 'ready') {
                setState({ phase: 'ready', inputs: cached.inputs });
            } else {
                setState({ phase: cached.kind, inputs: null });
            }
            // `unsupported` is a real daemon answer and keeps the freshness gate;
            // a cached failure never suppresses revalidation.
            if (!forceReload && cached.kind !== 'error' && entryIsFresh(cached, staleMs)) {
                return;
            }
        } else {
            stateAccountLifetimeRef.current = accountLifetime;
            setState((previous) => ({
                phase: 'loading',
                inputs: !accountLifetimeChanged
                    && (params.retainInputsAcrossScopeChange === true || previousMachineId === machineId)
                    ? previous.inputs
                    : null,
            }));
        }

        let alive = true;
        void (async () => {
            try {
                const entry = await loadDaemonMergedProjectionCacheEntry({
                    machineId,
                    serverId: serverId || null,
                    ...(targetRequest ?? {}),
                });
                if (!alive || !entry) return;
                stateAccountLifetimeRef.current = accountLifetime;
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
                stateAccountLifetimeRef.current = accountLifetime;
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
        accountLifetime,
        hasProjectionScope,
        machineId,
        params.refreshKey,
        params.retainInputsAcrossScopeChange,
        projectionRevision,
        serverId,
        staleMs,
        targetRequest,
    ]);

    return params.mountedTarget && stateAccountLifetimeRef.current !== accountLifetime
        ? { phase: 'loading', inputs: null }
        : state;
}
