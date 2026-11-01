import * as React from 'react';
import { getPreferredLanguage } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';

import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionFailureReason,
} from '@/sync/ops/machineContributionRegistryProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

import {
    loadDaemonMergedProjectionCacheEntry,
    readCachedDaemonMergedProjectionCacheEntry,
    readReusableDaemonMergedProjectionCacheEntry,
    readObservedDaemonMergedProjectionCacheEntry,
    subscribeDaemonMergedProjectionSummary,
    captureDaemonMergedProjectionReader,
    type DaemonMergedProjectionInputs,
    type DaemonMergedProjectionSummary,
} from './loadDaemonMergedProjectionInputs';

/**
 * Why the merged projection is not currently authoritative. `unsupported` is
 * a daemon fact; `error` includes read/transport failures. Neither phase alone
 * establishes that the Machine is disconnected or has no integrations.
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

/** Inert session chrome shares the cache owner's summary and binding, never the detail hook's lifecycle. */
export function useDaemonMergedProjectionSummary(params: Readonly<{
    machineId: string | null | undefined;
    serverId?: string | null;
}>): DaemonMergedProjectionSummary {
    useSetting('preferredLanguage');
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const active = useActiveServerSnapshot(!serverId);
    const effectiveServerId = serverId || active.serverId;
    const profilesGeneration = useServerProfilesGeneration();
    const reader = React.useMemo(() => captureDaemonMergedProjectionReader({ machineId, serverId: effectiveServerId }),
        [effectiveServerId, machineId, profilesGeneration]);
    return React.useSyncExternalStore(reader.subscribeSummary, reader.readSummary, reader.readSummary);
}

export function useDaemonMergedProjectionInputs(params: Readonly<{
    /** Reuse a mounted caller's exact routed lifetime instead of resolving it again. */
    accountLifetime?: ActiveServerAccountScopeLifetime | null;
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
    sections?: readonly string[];
}>): DaemonMergedProjectionInputsState {
    // Settings updates also arrive remotely; subscribe only to the language field.
    useSetting('preferredLanguage');
    const locale = getPreferredLanguage();
    const sectionsKey = params.sections?.join('\0') ?? null;
    const sections = React.useMemo(() => sectionsKey === null ? undefined : sectionsKey.split('\0'), [sectionsKey]);
    const stateSectionsKeyRef = React.useRef(sectionsKey);
    const enabled = params.enabled !== false;
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const staleMs = typeof params.staleMs === 'number' && Number.isFinite(params.staleMs) && params.staleMs >= 0
        ? Math.max(0, Math.floor(params.staleMs))
        : undefined;
    const hasProjectionScope = enabled && Boolean(machineId);
    const routedBindings = useServerCredentialAccountScopeBindings(
        params.accountLifetime === undefined && hasProjectionScope && serverId ? [serverId] : [],
    );
    // A routed projection uses that Home's credential-bound lifetime, even
    // while another Home is focused. The binding is itself the lifetime.
    const routedAccountLifetime: ActiveServerAccountScopeLifetime | null = routedBindings.values().next().value ?? null;
    const activeAccountLifetime = useActiveServerAccountScopeLifetime();
    const accountLifetime = params.accountLifetime !== undefined ? params.accountLifetime : serverId
        ? routedAccountLifetime
        : activeAccountLifetime;
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

    const [state, replaceState] = React.useState<DaemonMergedProjectionInputsState>(() => {
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
            sections,
        });
        if (!cached) {
            const stale = readCachedDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null, sections });
            return { phase: 'loading', inputs: stale?.kind === 'ready' || stale?.kind === 'error' ? stale.inputs ?? null : null };
        }
        if (cached.kind === 'ready') {
            return { phase: 'ready', inputs: cached.inputs };
        }
        return { phase: cached.kind, inputs: null };
    });
    // Cache observation and this reader's own load can deliver the same answer.
    // Keep one publication boundary for both, including warm cached demand.
    const setState = React.useCallback((update: React.SetStateAction<DaemonMergedProjectionInputsState>) => {
        replaceState(previous => {
            const next = typeof update === 'function' ? update(previous) : update;
            return previous.phase === next.phase && previous.inputs === next.inputs
                && previous.failureReason === next.failureReason ? previous : next;
        });
    }, []);
    // A response is never visible under a successor Account. The effect below
    // publishes the new Account's state; this render-time fence prevents one
    // stale render before that effect has run.
    const stateAccountLifetimeRef = React.useRef<ActiveServerAccountScopeLifetime | null>(accountLifetime);

    const readObservedCacheState = React.useCallback((): DaemonMergedProjectionInputsState | null => {
        const reusable = readReusableDaemonMergedProjectionCacheEntry({ machineId, serverId, accountLifetime, staleMs, sections });
        if (reusable?.kind === 'ready') return { phase: 'ready', inputs: reusable.inputs };
        if (reusable?.kind === 'unsupported') return { phase: 'unsupported', inputs: null };
        const cached = readObservedDaemonMergedProjectionCacheEntry({ machineId, serverId, accountLifetime, sections });
        // A failed read is observable state, never an answer that suppresses
        // renewed demand. All mounted readers must withdraw its old authority.
        if (cached?.kind === 'error') {
            return { phase: 'error', inputs: cached.inputs ?? null, failureReason: cached.reason };
        }
        return null;
    }, [accountLifetime, machineId, serverId, staleMs, sections]);

    React.useEffect(() => {
        if (!hasProjectionScope || !accountLifetime) return;
        // App-shell and detail readers publish through this same cache. A
        // mounted reader must observe their answers even when it owns no RPC.
        return subscribeDaemonMergedProjectionSummary({ machineId, serverId }, () => {
            const observed = readObservedCacheState();
            if (!observed) return;
            stateAccountLifetimeRef.current = accountLifetime;
            setState(observed);
        });
    }, [accountLifetime, hasProjectionScope, machineId, readObservedCacheState, serverId, setState]);

    React.useEffect(() => {
        const forceReload = refreshKeyRef.current !== params.refreshKey
            || projectionRevisionRef.current !== projectionRevision
            || localeRef.current !== locale;
        const scopeChanged = hasProjectionScopeRef.current !== hasProjectionScope
            || machineIdRef.current !== machineId
            || serverIdRef.current !== serverId
            || stateSectionsKeyRef.current !== sectionsKey;
        stateSectionsKeyRef.current = sectionsKey;
        const previousMachineId = machineIdRef.current;
        const previousServerId = serverIdRef.current;
        const accountLifetimeChanged = stateAccountLifetimeRef.current !== accountLifetime;
        // A changed scope must settle the render-time fence even when its
        // cached payload is shared with the previous scope.
        const publishState = scopeChanged || accountLifetimeChanged ? replaceState : setState;
        refreshKeyRef.current = params.refreshKey;
        projectionRevisionRef.current = projectionRevision;
        localeRef.current = locale;
        machineIdRef.current = machineId;
        serverIdRef.current = serverId;
        hasProjectionScopeRef.current = hasProjectionScope;
        if (!hasProjectionScope || !machineId) {
            stateAccountLifetimeRef.current = accountLifetime;
            publishState({ phase: 'idle', inputs: null });
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
            publishState(previous => ({ phase: 'loading', inputs: retainRouteMetadata ? previous.inputs : null }));
            return;
        }

        const cached = readCachedDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
            sections,
        });
        const reusable = readReusableDaemonMergedProjectionCacheEntry({
            machineId,
            serverId: serverId || null,
            accountLifetime,
            staleMs,
            sections,
        });
        if (params.load === false) {
            stateAccountLifetimeRef.current = accountLifetime;
            publishState(readObservedCacheState()
                ?? { phase: 'idle', inputs: cached?.kind === 'ready' || cached?.kind === 'error' ? cached.inputs ?? null : null });
            return;
        }
        if (cached) {
            stateAccountLifetimeRef.current = accountLifetime;
            if (forceReload || !reusable) {
                publishState({
                    phase: 'loading',
                    inputs: cached.kind === 'ready' || cached.kind === 'error'
                        ? (cached.inputs ?? null)
                        : null,
                });
            } else if (cached.kind === 'ready') {
                publishState({ phase: 'ready', inputs: cached.inputs });
            } else {
                publishState({ phase: cached.kind, inputs: null });
            }
            // `unsupported` is a real daemon answer and keeps the freshness gate;
            // a cached failure never suppresses revalidation.
            if (!forceReload && reusable) {
                return;
            }
        } else {
            stateAccountLifetimeRef.current = accountLifetime;
            publishState((previous) => ({
                phase: 'loading',
                inputs: params.retainInputsAcrossScopeChange === true
                    || (!accountLifetimeChanged
                        && previousMachineId === machineId
                        && previousServerId === serverId)
                    ? previous.inputs : null,
            }));
        }

        let alive = true;
        const abort = new AbortController();
        void (async () => {
            try {
                const entry = await loadDaemonMergedProjectionCacheEntry({
                    machineId,
                    sections,
                    reuseFreshReady: !forceReload && readReusableDaemonMergedProjectionCacheEntry({
                        machineId, serverId: serverId || null, accountLifetime, staleMs, sections: [],
                    }) !== null,
                    serverId: serverId || null,
                    ...(accountLifetime ? { accountLifetime } : {}),
                    signal: abort.signal,
                });
                if (!alive || !entry) return;
                stateAccountLifetimeRef.current = accountLifetime;
                if (entry.kind === 'ready') {
                    publishState({ phase: 'ready', inputs: entry.inputs });
                } else if (entry.kind === 'error') {
                    publishState((previous) => ({
                        phase: 'error',
                        inputs: entry.inputs ?? previous.inputs,
                        failureReason: entry.reason,
                    }));
                } else {
                    publishState({ phase: entry.kind, inputs: null });
                }
            } catch {
                if (!alive) return;
                stateAccountLifetimeRef.current = accountLifetime;
                publishState((previous) => ({
                    phase: 'error',
                    inputs: previous.inputs,
                }));
            }
        })();

        return () => {
            alive = false;
            abort.abort();
        };
    }, [
        accountLifetime,
        hasProjectionScope,
        locale,
        machineId,
        setState,
        params.load,
        params.refreshKey,
        params.retainInputsAcrossScopeChange,
        projectionRevision,
        readObservedCacheState,
        serverId,
        staleMs,
        sections,
        sectionsKey,
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
        || serverIdRef.current !== serverId
        || stateSectionsKeyRef.current !== sectionsKey;
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
