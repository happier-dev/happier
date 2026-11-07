import * as React from 'react';
import { isEmbedWindowContext } from '@/embed/isEmbedWindowContext';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';

import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import {
    areServerProfileIdentifiersEquivalent,
    captureServerProfileScopeResolver,
    getServerProfileById,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { prepareSessionListAccountScope } from '@/sync/runtime/orchestration/concurrentSessionCache';
import { preparePluginUiProjectionWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import {
    type ServerAccountScope,
    type ServerAccountScopeLifetime,
} from './serverAccountScope';
import {
    resolveAdmittedEmbedServerCredentialAccountScope,
    resolveServerCredentialAccountScope,
    captureServerCredentialAccountScopeLifetime,
    subscribeServerCredentialAccountScopeRetry,
    type ServerCredentialAccountScopeResolution,
} from './serverCredentialAccountScope';

export type { ServerCredentialAccountScopeResolution } from './serverCredentialAccountScope';

export type ServerCredentialAccountScopeBinding = ServerAccountScopeLifetime & Readonly<{
    serverId: string;
    accountId: string;
    revision: number;
    /** Exact credential/material fingerprint for retained display data; never an authorization verdict. */
    credentialKey?: string;
}>;

type UnboundScopeResolution =
    | Readonly<{ kind: 'resolving' }>
    | Readonly<{ kind: 'unknown_home' }>
    | Readonly<{ kind: 'unavailable' }>
    | Readonly<{ kind: 'signed_out' }>;
type BoundScopeResolution = Readonly<{ kind: 'bound'; scope: ServerAccountScope }>;
type ScopeResolutionLifetime = Readonly<{ revision: number; isCurrent: () => boolean }>;

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

export function normalizeCredentialScopeServerId(serverId: string | null | undefined): string {
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
    const resolveScopeId = embedded
        ? (serverId: string | null | undefined) => serverId?.trim() ?? ''
        : captureServerProfileScopeResolver();
    const normalizedServerIds = [...new Set(serverIds
        .map(resolveScopeId)
        .filter(Boolean))].sort();
    const serverIdsKey = JSON.stringify(normalizedServerIds);
    // Credential lookup consumes the exact Home's URL. Labels, last-used times
    // and unrelated Home publications do not change credential custody.
    const credentialTargets = React.useMemo(() => new Map(normalizedServerIds.map(serverId => [serverId, getServerProfileById(serverId)?.serverUrl ?? null])),
        // The sorted set and profile publication are the complete lookup inputs.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [profilesGeneration, serverIdsKey]);
    const credentialTargetsKey = JSON.stringify([...credentialTargets]);
    const embedEntriesRef = React.useRef<ReadonlyMap<string, ScopeEntry>>(new Map());
    const embedEntries = React.useMemo(() => {
        if (!embedded) return embedEntriesRef.current;
        const next = new Map<string, ScopeEntry>();
        for (const serverId of normalizedServerIds) {
            const resolution = resolveAdmittedEmbedServerCredentialAccountScope(serverId);
            if (resolution.kind === 'bound' && resolution.lifetime) {
                next.set(serverId, { resolution: { kind: 'bound', scope: resolution.scope }, binding: {
                    ...resolution.lifetime, serverId, accountId: resolution.scope.accountId,
                    credentialKey: resolution.credentialKey,
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
    const resolutionLifetimesRef = React.useRef(new Map<string, ScopeResolutionLifetime>());
    const retirementCallbacksRef = React.useRef(new Map<string, Set<() => void>>());
    const mountedRef = React.useRef(true);
    // The first render already reads every requested Home as resolving, so the effect's resolving
    // publication below is not a state change and costs no render.
    const [entries, setEntries] = React.useState<ReadonlyMap<string, ScopeEntry>>(
        () => new Map(embedded ? [] : normalizedServerIds.map((serverId) => [serverId, RESOLVING_ENTRY] as const)),
    );
    /** Homes whose latest settled read failed on this device's secure storage. */
    const unreadableServerIdsRef = React.useRef(new Set<string>());
    const committedHomesRef = React.useRef<ReadonlyMap<string, string | null> | null>(null);
    // Projection callbacks observe credential transitions; their identity is
    // not a credential transition. Read the latest committed callbacks without
    // retiring and republishing a binding on each consumer render.
    const projectionLifecycleRef = React.useRef(projectionLifecycle);
    React.useLayoutEffect(() => {
        projectionLifecycleRef.current = projectionLifecycle;
    }, [projectionLifecycle]);
    // A retained Suspense tree disconnects layout effects without unmounting. Credential
    // authority follows the subscription's passive lifetime, not that visibility transition.
    React.useEffect(() => {
        mountedRef.current = true;
        return () => { mountedRef.current = false; };
    }, []);
    React.useLayoutEffect(() => {
        committedHomesRef.current = credentialTargets;
        // Only committed selections may retire Home bindings; a suspended render owns none.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [credentialTargetsKey]);

    React.useEffect(() => {
        if (embedded) return;
        const trackedServerIds = new Set(normalizedServerIds);
        if ([...entries.keys()].some((serverId) => !trackedServerIds.has(serverId))) {
            setEntries((current) => {
                if ([...current.keys()].every((serverId) => trackedServerIds.has(serverId))) return current;
                return new Map([...current].filter(([serverId]) => trackedServerIds.has(serverId)));
            });
        }

        const publishEntry = (serverId: string, entry: ScopeEntry): void => {
            setEntries((current) => {
                if (current.get(serverId) === entry) return current;
                const next = new Map(current);
                next.set(serverId, entry);
                return next;
            });
        };

        const invalidate = (serverId: string, replacement: ScopeEntry | null = RESOLVING_ENTRY): ScopeResolutionLifetime => {
            const revision = (resolutionLifetimesRef.current.get(serverId)?.revision ?? 0) + 1;
            const requestedServerUrl = credentialTargets.get(serverId);
            const lifetime: ScopeResolutionLifetime = {
                revision,
                // Cleanup retires this read permanently, including effect replay on remount.
                isCurrent: replacement === null ? () => false : () => mountedRef.current
                    && resolutionLifetimesRef.current.get(serverId)?.revision === revision
                    && committedHomesRef.current?.has(serverId) === true
                    && committedHomesRef.current.get(serverId) === requestedServerUrl,
            };
            resolutionLifetimesRef.current.set(serverId, lifetime);
            const retirements = retirementCallbacksRef.current.get(serverId);
            retirementCallbacksRef.current.delete(serverId);
            for (const retire of retirements ?? []) {
                try {
                    retire();
                } catch {
                    // One consumer cannot prevent sibling scope retirement.
                }
            }
            if (replacement) publishEntry(serverId, replacement);
            return lifetime;
        };

        const resolveBinding = async (requestedServerId: string, { revision, isCurrent }: ScopeResolutionLifetime): Promise<void> => {
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
                credentialKey: resolution.credentialKey,
                accountLifetime: captureServerCredentialAccountScopeLifetime(resolution),
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
            preparePluginUiProjectionWarmCacheEntries(scope.serverId, scope.accountId);
            projectionLifecycleRef.current?.beforeBinding?.(binding);
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
            const previous = entries.get(serverId);
            // Pending and settled reads belong to the exact lookup target, even
            // when no credential was bound. A sibling's selection cannot restart them.
            if (resolutionLifetimesRef.current.get(serverId)?.isCurrent()) continue;
            // An actual lookup-target change retires authority immediately.
            // Keep its identity while resolving the new credential; metadata-only
            // publications retain the current binding through the guard above.
            // A binding-less entry is already the retained identity; republishing a copy would only
            // render every reader of it again.
            const retainedEntry: ScopeEntry = previous
                ? 'binding' in previous ? Object.freeze({ resolution: previous.resolution }) : previous
                : RESOLVING_ENTRY;
            const lifetime = invalidate(serverId, retainedEntry);
            void resolveBinding(serverId, lifetime);
        }

        const unsubscribe = subscribeHomeCredentialChange((event) => {
            const resolveScopeId = captureServerProfileScopeResolver();
            for (const serverId of trackedServerIds) {
                if (!areServerProfileIdentifiersEquivalent(event.serverId, serverId, resolveScopeId)) continue;
                projectionLifecycleRef.current?.onCredentialMutation?.(serverId);
                const lifetime = invalidate(serverId);
                void resolveBinding(serverId, lifetime);
            }
        });

        // Only an unreadable credential store has anything to gain from a
        // re-read; a settled binding or confirmed absence is left alone.
        const unsubscribeRetry = subscribeServerCredentialAccountScopeRetry((retryServerId) => {
            if (!trackedServerIds.has(retryServerId)) return;
            if (!unreadableServerIdsRef.current.has(retryServerId)) return;
            unreadableServerIdsRef.current.delete(retryServerId);
            const lifetime = invalidate(retryServerId);
            void resolveBinding(retryServerId, lifetime);
        });

        return () => {
            unsubscribe();
            unsubscribeRetry();
            const committedHomes = committedHomesRef.current;
            for (const serverId of trackedServerIds) {
                if (!mountedRef.current || !committedHomes?.has(serverId)
                    || committedHomes.get(serverId) !== credentialTargets.get(serverId)) invalidate(serverId, null);
            }
        };
        // The exact lookup targets identify the Home set. Credentials themselves
        // still retire through their canonical mutation subscription.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [credentialTargetsKey, embedScopeRevision]);

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

/** Identity and current authority together, for multi-Home projections with terminal signed-out states. */
export function useServerCredentialAccountScopeStates(
    serverIds: readonly (string | null | undefined)[],
): ReadonlyMap<string, ServerCredentialAccountScopeBindingState> {
    const entries = useCredentialScopeEntries(serverIds);
    return React.useMemo(() => new Map([...entries].map(([serverId, entry]) => [serverId, {
        resolution: entry.resolution,
        binding: 'binding' in entry ? entry.binding ?? null : null,
    }])), [entries]);
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
    projectionLifecycle?: ServerCredentialAccountScopeProjectionLifecycle,
): ServerCredentialAccountScopeBindingState {
    const normalized = normalizeCredentialScopeServerId(serverId);
    // A reader below a scope that already resolves this Home shares that resolution (and its lifetime)
    // instead of reading the credential again. A projection lifecycle keeps its own observed resolution.
    const inheritedScope = React.useContext(InheritedServerCredentialAccountScopeContext);
    const inherited = !projectionLifecycle && normalized && inheritedScope?.serverId === normalized ? inheritedScope.state : null;
    const inherits = inherited !== null;
    const requested = React.useMemo(() => (normalized && !inherits ? [normalized] : []), [inherits, normalized]);
    const entries = useCredentialScopeEntries(requested, projectionLifecycle);
    const entry = normalized ? entries.get(normalized) : undefined;
    const own = React.useMemo(() => {
        if (!normalized) return Object.freeze({ resolution: UNKNOWN_HOME, binding: null });
        if (!entry) return Object.freeze({ resolution: RESOLVING, binding: null });
        return Object.freeze({
            resolution: entry.resolution,
            binding: 'binding' in entry ? entry.binding ?? null : null,
        });
    }, [entry, normalized]);
    return inherited ?? own;
}

const InheritedServerCredentialAccountScopeContext = React.createContext<Readonly<{
    serverId: string;
    state: ServerCredentialAccountScopeBindingState;
}> | null>(null);

/**
 * Publishes one Home's already-resolved credential state to the readers below it (a Session
 * destination's Board, approvals, plugin and hosted-HTML runtimes), so they share its one resolution.
 */
export function ServerCredentialAccountScopeBindingProvider(props: React.PropsWithChildren<Readonly<{
    serverId: string | null;
    state: ServerCredentialAccountScopeBindingState;
}>>): React.ReactElement {
    const serverId = normalizeCredentialScopeServerId(props.serverId);
    const value = React.useMemo(() => serverId ? { serverId, state: props.state } : null, [props.state, serverId]);
    return React.createElement(InheritedServerCredentialAccountScopeContext.Provider, { value }, props.children);
}
