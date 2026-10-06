import * as React from 'react';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { prepareSessionListAccountScope } from '@/sync/runtime/orchestration/concurrentSessionCache';
import {
    type ServerAccountScope,
    type ServerAccountScopeLifetime,
} from './serverAccountScope';
import {
    resolveAdmittedEmbedServerCredentialAccountScope,
    resolveServerCredentialAccountScope,
    subscribeServerCredentialAccountScopeRetry,
    type ServerCredentialAccountScopeResolution,
} from './serverCredentialAccountScope';

export type { ServerCredentialAccountScopeResolution } from './serverCredentialAccountScope';

export type ServerCredentialAccountScopeBinding = ServerAccountScopeLifetime & Readonly<{
    serverId: string;
    accountId: string;
    revision: number;
}>;

type UnboundScopeResolution =
    | Readonly<{ kind: 'resolving' }>
    | Readonly<{ kind: 'unknown_home' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'signed_out' }>;
type BoundScopeResolution = Readonly<{ kind: 'bound'; scope: ServerAccountScope }>;

type ScopeEntry =
    | Readonly<{ resolution: UnboundScopeResolution }>
    | Readonly<{
        resolution: BoundScopeResolution;
        /** Present only while this exact credential binding remains current. */
        binding?: ServerCredentialAccountScopeBinding;
    }>;

export type ServerCredentialAccountScopeProjectionLifecycle = Readonly<{
    beforeBinding?: (binding: ServerCredentialAccountScopeBinding) => void;
    onCredentialMutation?: (serverId: string) => void;
}>;

const RESOLVING = Object.freeze({ kind: 'resolving' } as const);
const UNKNOWN_HOME = Object.freeze({ kind: 'unknown_home' } as const);
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' } as const);
const SIGNED_OUT = Object.freeze({ kind: 'signed_out' } as const);
const RESOLVING_ENTRY: ScopeEntry = Object.freeze({ resolution: RESOLVING });
const UNKNOWN_HOME_ENTRY: ScopeEntry = Object.freeze({ resolution: UNKNOWN_HOME });
const UNAVAILABLE_ENTRY: ScopeEntry = Object.freeze({ resolution: UNAVAILABLE });
const SIGNED_OUT_ENTRY: ScopeEntry = Object.freeze({ resolution: SIGNED_OUT });
const EMPTY_SCOPE_BINDINGS: ReadonlyMap<string, ServerCredentialAccountScopeBinding> = new Map();

function normalizeCredentialScopeServerId(serverId: string | null | undefined): string {
    return isEmbedWindowContext() ? serverId?.trim() ?? '' : resolveServerProfileScopeIdForIdentifier(serverId);
}

/**
 * One credential-resolution and retirement lifecycle for every exact Home.
 * Domain projections may clean up their own rows at the binding boundary;
 * credential identity and currentness always remain owned here.
 */
function useCredentialScopeEntries(
    serverIds: readonly (string | null | undefined)[],
    projectionLifecycle?: ServerCredentialAccountScopeProjectionLifecycle,
): ReadonlyMap<string, ScopeEntry> {
    const profilesGeneration = useServerProfilesGeneration();
    // The runtime renders this frame on admission/renewal. Rebind to that exact
    // Sync lifetime without reading or subscribing to ambient Account custody.
    const embedded = isEmbedWindowContext();
    const embedScopeRevision = embedded ? getSyncSingleton().getEmbedSessionRequestContext()?.revision : undefined;
    const normalizedServerIds = [...new Set(serverIds
        .map((serverId) => normalizeCredentialScopeServerId(serverId))
        .filter(Boolean))].sort();
    const serverIdsKey = JSON.stringify(normalizedServerIds);
    const embedEntriesRef = React.useRef<ReadonlyMap<string, ScopeEntry>>(new Map());
    const embedEntries = React.useMemo(() => {
        if (!embedded) return embedEntriesRef.current;
        const next = new Map<string, ScopeEntry>();
        for (const serverId of normalizedServerIds) {
            const resolution = resolveAdmittedEmbedServerCredentialAccountScope(serverId);
            if (resolution.kind === 'bound' && resolution.lifetime) {
                next.set(serverId, { resolution: { kind: 'bound', scope: resolution.scope }, binding: {
                    ...resolution.lifetime, serverId, accountId: resolution.scope.accountId,
                } });
            } else {
                // Keep document identity during renewal, not current authority.
                next.set(serverId, embedEntriesRef.current.get(serverId) ?? UNAVAILABLE_ENTRY);
            }
        }
        embedEntriesRef.current = next;
        return next;
        // The exact set and Sync's existing admission revision are the binding inputs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [embedded, embedScopeRevision, serverIdsKey]);
    const revisionsRef = React.useRef(new Map<string, number>());
    const retirementCallbacksRef = React.useRef(new Map<string, Set<() => void>>());
    const mountedRef = React.useRef(true);
    const [entries, setEntries] = React.useState<ReadonlyMap<string, ScopeEntry>>(() => new Map());
    /** Homes whose latest settled read failed on this device's secure storage. */
    const unreadableServerIdsRef = React.useRef(new Set<string>());

    React.useEffect(() => {
        if (embedded) return;
        mountedRef.current = true;
        const trackedServerIds = new Set(normalizedServerIds);
        setEntries((current) => {
            if ([...current.keys()].every((serverId) => trackedServerIds.has(serverId))) return current;
            return new Map([...current].filter(([serverId]) => trackedServerIds.has(serverId)));
        });

        const publishEntry = (serverId: string, entry: ScopeEntry): void => {
            setEntries((current) => {
                if (current.get(serverId) === entry) return current;
                const next = new Map(current);
                next.set(serverId, entry);
                return next;
            });
        };

        const invalidate = (serverId: string, replacement: ScopeEntry | null = RESOLVING_ENTRY): number => {
            const retirements = retirementCallbacksRef.current.get(serverId);
            retirementCallbacksRef.current.delete(serverId);
            for (const retire of retirements ?? []) {
                try {
                    retire();
                } catch {
                    // One consumer cannot prevent sibling scope retirement.
                }
            }
            const revision = (revisionsRef.current.get(serverId) ?? 0) + 1;
            revisionsRef.current.set(serverId, revision);
            if (replacement) publishEntry(serverId, replacement);
            return revision;
        };

        const resolveBinding = async (requestedServerId: string, revision: number): Promise<void> => {
            const isCurrent = () => mountedRef.current
                && revisionsRef.current.get(requestedServerId) === revision;
            const resolution = await resolveServerCredentialAccountScope(requestedServerId);
            if (!isCurrent()) return;
            if (resolution.kind === 'unavailable') unreadableServerIdsRef.current.add(requestedServerId);
            else unreadableServerIdsRef.current.delete(requestedServerId);
            if (resolution.kind !== 'bound') {
                publishEntry(requestedServerId, resolution.kind === 'unknown_home'
                    ? UNKNOWN_HOME_ENTRY
                    : resolution.kind === 'unavailable'
                        ? UNAVAILABLE_ENTRY
                        : SIGNED_OUT_ENTRY);
                return;
            }
            const scope = resolution.scope;
            const binding: ServerCredentialAccountScopeBinding = Object.freeze({
                serverId: requestedServerId,
                accountId: scope.accountId,
                scope,
                revision,
                isCurrent,
                onRetire: (cancel) => {
                    if (!isCurrent()) {
                        cancel();
                        return Object.freeze({ dispose(): void {} });
                    }
                    const callbacks = retirementCallbacksRef.current.get(requestedServerId) ?? new Set<() => void>();
                    callbacks.add(cancel);
                    retirementCallbacksRef.current.set(requestedServerId, callbacks);
                    return Object.freeze({
                        dispose(): void {
                            callbacks.delete(cancel);
                            if (callbacks.size === 0) retirementCallbacksRef.current.delete(requestedServerId);
                        },
                    });
                },
            });
            projectionLifecycle?.beforeBinding?.(binding);
            setEntries((current) => {
                if (!binding.isCurrent()) return current;
                const next = new Map(current);
                next.set(requestedServerId, Object.freeze({
                    resolution: Object.freeze({ kind: 'bound' as const, scope }),
                    binding,
                }));
                return next;
            });
        };

        for (const serverId of normalizedServerIds) {
            // A profile publication can change transport metadata without
            // changing the Home or Account this credential resolves to. Retire
            // the old binding immediately, but keep its settled projection on
            // screen while the replacement is checked. Publishing a transient
            // `resolving` row here made every profile refresh withdraw Settings
            // destinations such as Home Administration, then add them back a
            // microtask later. New Homes still begin in `resolving`; explicit
            // credential mutations below continue to publish it because the
            // previous Account claim is no longer safe to show.
            const previous = entries.get(serverId);
            const retainedEntry: ScopeEntry = previous
                ? previous.resolution.kind === 'bound'
                    ? Object.freeze({ resolution: previous.resolution })
                    : Object.freeze({ resolution: previous.resolution })
                : RESOLVING_ENTRY;
            const revision = invalidate(serverId, retainedEntry);
            void resolveBinding(serverId, revision);
        }

        const unsubscribe = subscribeHomeCredentialChange((event) => {
            for (const serverId of trackedServerIds) {
                if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId)) continue;
                projectionLifecycle?.onCredentialMutation?.(serverId);
                const revision = invalidate(serverId);
                void resolveBinding(serverId, revision);
            }
        });

        // Only an unreadable credential store has anything to gain from a
        // re-read; a settled binding or confirmed absence is left alone.
        const unsubscribeRetry = subscribeServerCredentialAccountScopeRetry((retryServerId) => {
            if (!trackedServerIds.has(retryServerId)) return;
            if (!unreadableServerIdsRef.current.has(retryServerId)) return;
            unreadableServerIdsRef.current.delete(retryServerId);
            const revision = invalidate(retryServerId);
            void resolveBinding(retryServerId, revision);
        });

        return () => {
            mountedRef.current = false;
            unsubscribe();
            unsubscribeRetry();
            for (const serverId of trackedServerIds) invalidate(serverId, null);
        };
        // The sorted key identifies the Home set. Profile changes retire and
        // re-resolve bindings without making profile data Account authority.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [profilesGeneration, serverIdsKey, projectionLifecycle, embedScopeRevision]);

    return embedded ? embedEntries : entries;
}

const SESSION_PROJECTION_LIFECYCLE: ServerCredentialAccountScopeProjectionLifecycle = {
    beforeBinding(binding) {
        prepareSessionListAccountScope(binding.scope);
    },
};

/** Cancellable bindings for the existing Session/Search projection consumers. */
export function useServerCredentialAccountScopes(
    serverIds: readonly (string | null | undefined)[],
): ReadonlyMap<string, ServerCredentialAccountScopeBinding> {
    const entries = useCredentialScopeEntries(serverIds, SESSION_PROJECTION_LIFECYCLE);
    return React.useMemo(() => boundScopeEntries(entries), [entries]);
}

function boundScopeEntries(entries: ReadonlyMap<string, ScopeEntry>): ReadonlyMap<string, ServerCredentialAccountScopeBinding> {
    const bindings = new Map<string, ServerCredentialAccountScopeBinding>();
    for (const [serverId, entry] of entries) {
        if ('binding' in entry && entry.binding) bindings.set(serverId, entry.binding);
    }
    // Resolution-only transitions do not change an empty authority projection.
    return bindings.size === 0 ? EMPTY_SCOPE_BINDINGS : bindings;
}

/** Exact Home credential lifetimes without Session-projection cleanup effects. */
export function useServerCredentialAccountScopeBindings(
    serverIds: readonly (string | null | undefined)[],
): ReadonlyMap<string, ServerCredentialAccountScopeBinding> {
    const entries = useCredentialScopeEntries(serverIds);
    return React.useMemo(() => {
        return boundScopeEntries(entries);
    }, [entries]);
}

/** Exact Home identity states without Session projection side effects. */
export function useServerCredentialAccountScopeResolutions(
    serverIds: readonly (string | null | undefined)[],
    projectionLifecycle?: ServerCredentialAccountScopeProjectionLifecycle,
): ReadonlyMap<string, ServerCredentialAccountScopeResolution> {
    const entries = useCredentialScopeEntries(serverIds, projectionLifecycle);
    return React.useMemo(() => new Map(
        [...entries].map(([serverId, entry]) => [serverId, entry.resolution] as const),
    ), [entries]);
}

export function useServerCredentialAccountScopeResolution(
    serverId: string | null | undefined,
): ServerCredentialAccountScopeResolution {
    return useServerCredentialAccountScopeBinding(serverId).resolution;
}

export type ServerCredentialAccountScopeBindingState = Readonly<{
    resolution: ServerCredentialAccountScopeResolution;
    /**
     * The exact credential lifetime while it is current; `null` before it is bound and while a
     * profile refresh re-checks it. A surface that must act only for the Account it showed (a
     * destructive confirmation) captures this and checks `isCurrent()` before acting.
     */
    binding: ServerCredentialAccountScopeBinding | null;
}>;

/** One exact Home's identity state together with its current credential lifetime, from one resolution. */
export function useServerCredentialAccountScopeBinding(
    serverId: string | null | undefined,
): ServerCredentialAccountScopeBindingState {
    const normalized = normalizeCredentialScopeServerId(serverId);
    const requested = React.useMemo(() => (normalized ? [normalized] : []), [normalized]);
    const entries = useCredentialScopeEntries(requested);
    const entry = normalized ? entries.get(normalized) : undefined;
    return React.useMemo(() => {
        if (!normalized) return Object.freeze({ resolution: UNKNOWN_HOME, binding: null });
        if (!entry) return Object.freeze({ resolution: RESOLVING, binding: null });
        return Object.freeze({
            resolution: entry.resolution,
            binding: 'binding' in entry ? entry.binding ?? null : null,
        });
    }, [entry, normalized]);
}
