import * as React from 'react';
import { getPreferredLanguage } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionFailureReason,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

import {
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
    readReusableDaemonMergedProjectionCacheEntry,
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
    /** Present with `phase: 'error'`: the classified reason the read failed. */
    failureReason?: MachineContributionRegistryProjectionFailureReason;
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
    /**
     * Keeps the last projection available as stale metadata while a route-driven scope
     * replacement loads. Callers must gate daemon-authoritative mutations on `phase === 'ready'`.
     */
    retainInputsAcrossScopeChange?: boolean;
    /**
     * `false`: serve only what is already cached and never ask the machine (a summary on a page
     * that should not start daemon work). Defaults to loading when stale or missing.
     */
    load?: boolean;
}>): DaemonMergedProjectionInputsState {
    // Settings updates also arrive remotely; subscribe only to the language field.
    useSetting('preferredLanguage');
    const locale = getPreferredLanguage();
    const enabled = params.enabled !== false;
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : 60_000;
    const routedBindings = useServerCredentialAccountScopeBindings(
        serverId ? [serverId] : [],
    );
    // A routed projection uses that Home's credential-bound lifetime, even
    // while another Home is focused. The binding is itself the lifetime.
    const routedAccountLifetime: ActiveServerAccountScopeLifetime | null = routedBindings.values().next().value ?? null;
    const accountLifetime = serverId
        ? routedAccountLifetime
        : captureActiveServerAccountScopeLifetime();
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
    const localeRef = React.useRef(locale);
    const machineIdRef = React.useRef(machineId);
    const serverIdRef = React.useRef(serverId);
    const hasProjectionScopeRef = React.useRef(hasProjectionScope);

    const [state, setState] = React.useState<DaemonMergedProjectionInputsState>(() => {
        if (!hasProjectionScope) {
            return { phase: 'idle', inputs: null };
        }
        if (!accountLifetime) {
            return { phase: 'loading', inputs: null };
        }
        const cached = readReusableDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
            accountLifetime,
            staleMs,
        });
        if (!cached) {
            const stale = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null });
            return { phase: 'loading', inputs: stale?.kind === 'ready' || stale?.kind === 'error' ? stale.inputs ?? null : null };
        }
        if (cached.kind === 'ready') {
            return { phase: 'ready', inputs: cached.inputs };
        }
        return { phase: cached.kind, inputs: null };
    });
    // A response is never visible under a successor Account. The effect below
    // publishes the new Account's state; this render-time fence prevents one
    // stale render before that effect has run.
    const stateAccountLifetimeRef = React.useRef<ActiveServerAccountScopeLifetime | null>(accountLifetime);

    React.useEffect(() => {
        const forceReload = refreshKeyRef.current !== params.refreshKey
            || projectionRevisionRef.current !== projectionRevision
            || localeRef.current !== locale;
        const previousMachineId = machineIdRef.current;
        const previousServerId = serverIdRef.current;
        const accountLifetimeChanged = stateAccountLifetimeRef.current !== accountLifetime;
        refreshKeyRef.current = params.refreshKey;
        projectionRevisionRef.current = projectionRevision;
        localeRef.current = locale;
        machineIdRef.current = machineId;
        serverIdRef.current = serverId;
        hasProjectionScopeRef.current = hasProjectionScope;
        if (!hasProjectionScope || !machineId) {
            stateAccountLifetimeRef.current = accountLifetime;
            setState({ phase: 'idle', inputs: null });
            return;
        }
        if (!accountLifetime) {
            const previousStateServerId = stateAccountLifetimeRef.current?.scope.serverId;
            const retainRouteMetadata = params.retainInputsAcrossScopeChange === true
                && Boolean(serverId && (
                    (previousServerId && !areServerProfileIdentifiersEquivalent(previousServerId, serverId))
                    || (previousStateServerId && !areServerProfileIdentifiersEquivalent(previousStateServerId, serverId))
                ));
            // A route replacement may keep inert catalog labels while its Home
            // binds. A missing binding on the same Home withdraws Account data.
            stateAccountLifetimeRef.current = accountLifetime;
            setState((previous) => ({
                phase: 'loading',
                inputs: retainRouteMetadata ? previous.inputs : null,
            }));
            return;
        }

        const cached = readCachedDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
        });
        const reusable = readReusableDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
            accountLifetime,
            staleMs,
        });
        if (params.load === false) {
            stateAccountLifetimeRef.current = accountLifetime;
            setState(reusable?.kind === 'ready'
                ? { phase: 'ready', inputs: reusable.inputs }
                : reusable?.kind === 'unsupported'
                    ? { phase: 'unsupported', inputs: null }
                    : cached?.kind === 'error'
                        && cached.projectionRevision === projectionRevision
                        && accountLifetime?.isCurrent()
                        && areServerAccountScopesEqual(cached.accountScope, accountLifetime.scope)
                        && cached.accountCurrentness?.isCurrent() !== false
                        ? { phase: 'error', inputs: cached.inputs ?? null, failureReason: cached.reason }
                    : { phase: 'idle', inputs: cached?.kind === 'ready' || cached?.kind === 'error' ? cached.inputs ?? null : null });
            return;
        }
        if (cached) {
            stateAccountLifetimeRef.current = accountLifetime;
            if (forceReload || !reusable) {
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
            if (!forceReload && reusable) {
                return;
            }
        } else {
            stateAccountLifetimeRef.current = accountLifetime;
            setState((previous) => ({
                phase: 'loading',
                inputs: params.retainInputsAcrossScopeChange === true
                    || (!accountLifetimeChanged
                        && previousMachineId === machineId
                        && previousServerId === serverId)
                    ? previous.inputs : null,
            }));
        }

        let alive = true;
        void (async () => {
            try {
                const entry = await loadDaemonMergedProjectionCacheEntry({
                    machineId,
                    serverId: serverId || null,
                    ...(accountLifetime ? { accountLifetime } : {}),
                });
                if (!alive || !entry) return;
                stateAccountLifetimeRef.current = accountLifetime;
                if (entry.kind === 'ready') {
                    setState({ phase: 'ready', inputs: entry.inputs });
                } else if (entry.kind === 'error') {
                    setState((previous) => ({
                        phase: 'error',
                        inputs: entry.inputs ?? previous.inputs,
                        failureReason: entry.reason,
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
        locale,
        machineId,
        params.load,
        params.refreshKey,
        params.retainInputsAcrossScopeChange,
        projectionRevision,
        serverId,
        staleMs,
    ]);

    if (hasProjectionScope && stateAccountLifetimeRef.current !== accountLifetime) {
        return {
            phase: 'loading',
            inputs: params.retainInputsAcrossScopeChange === true ? state.inputs : null,
        };
    }
    // Scope/revision changes are first visible during render; the effect that
    // publishes their loading state runs after commit. Fence that render so a
    // consumer cannot start work for B with A's still-ready projection.
    const scopeChanged = hasProjectionScopeRef.current !== hasProjectionScope
        || machineIdRef.current !== machineId
        || serverIdRef.current !== serverId;
    if (scopeChanged) {
        return {
            phase: 'loading',
            inputs: params.retainInputsAcrossScopeChange === true ? state.inputs : null,
        };
    }
    if (
        refreshKeyRef.current !== params.refreshKey
        || projectionRevisionRef.current !== projectionRevision
        || localeRef.current !== locale
    ) {
        return { phase: 'loading', inputs: state.inputs };
    }
    return state;
}
