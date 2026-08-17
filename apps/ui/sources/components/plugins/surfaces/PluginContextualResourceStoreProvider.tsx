import * as React from 'react';

import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import { createPluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type {
    PluginUiResourceReference,
    PluginUiResourceSnapshot,
} from '@happier-dev/plugin-ui/hostApi';

import { createPluginContextualResourceReadClient } from './pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient } from './pluginSurfaceResourceWatch';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';

type PluginContextualResourceStore = ReturnType<typeof createPluginUiResourceStore>;

export type PluginContextualResourceStoreLease = Readonly<{
    store: PluginContextualResourceStore;
    dispose(): void;
    /** Retires a confirmed terminal target for every current consumer. */
    retire(): void;
}>;

export type PluginContextualResourceStoreOwner = Readonly<{
    /**
     * Acquires one mounted-provider-local store for an exact host-stamped
     * binding. Callers cannot supply their own transport, cache, or Session
     * identity.
     */
    acquire(input: Readonly<{
        accountLifetime: ActiveServerAccountScopeLifetime;
        pluginId: string;
        machineId: string;
        serverId: string | null;
        expectedGeneration: string;
        context: PluginResourceContextV1;
    }>): PluginContextualResourceStoreLease | null;
}>;

type ResourceStoreEntry = {
    readonly store: PluginContextualResourceStore;
    readonly bindingFamilyKey: string;
    accountRetirement: Readonly<{ dispose(): void }> | null;
    consumers: number;
    disposed: boolean;
};

export type PluginContextualResourceBinding = Parameters<PluginContextualResourceStoreOwner['acquire']>[0];

type ResourceStoreBinding = PluginContextualResourceBinding;

function accountBindingKey(input: ResourceStoreBinding): readonly [string, string] {
    // Account coordinates are the existing Account owner's identity. Including
    // them in this mounted-provider-local key prevents a brief A/B overlap
    // from sharing one contextual store; retirement removes the old entry
    // before a same-coordinate lifetime can be reused.
    return [input.accountLifetime.scope.serverId, input.accountLifetime.scope.accountId];
}

function resourceBindingKey(input: ResourceStoreBinding): string {
    return JSON.stringify([
        accountBindingKey(input),
        input.pluginId,
        input.machineId,
        input.serverId,
        input.expectedGeneration,
        input.context,
    ]);
}

/** The same target across projection generations; generation remains exact in the store key. */
function resourceBindingFamilyKey(input: ResourceStoreBinding): string {
    return JSON.stringify([
        accountBindingKey(input),
        input.pluginId,
        input.machineId,
        input.serverId,
        input.context,
    ]);
}

function subscriptionIdPrefix(input: ResourceStoreBinding): string {
    // This is only a mounted-provider-local transport identifier. The store
    // below is never a process-global or app-root Session cache.
    return `contextual-resource:${encodeURIComponent(resourceBindingKey(input))}`;
}

function createPluginContextualResourceStoreOwner(): PluginContextualResourceStoreOwner {
    // The provider lifetime is the sharing boundary. An entry exists only
    // while one of its mounted consumers holds it; no Account-keyed outer map
    // and no zero-consumer retention survives navigation.
    const entries = new Map<string, ResourceStoreEntry>();

    const disposeEntry = (key: string, entry: ResourceStoreEntry): void => {
        if (entries.get(key) !== entry || entry.disposed) return;
        // Delete before stopping descendants so synchronous Account retirement
        // cannot reenter through a stale map key.
        entries.delete(key);
        entry.disposed = true;
        entry.accountRetirement?.dispose();
        entry.accountRetirement = null;
        entry.store.dispose();
    };

    return Object.freeze({
        acquire(input) {
            if (!input.accountLifetime.isCurrent()) return null;

            const key = resourceBindingKey(input);
            const bindingFamilyKey = resourceBindingFamilyKey(input);
            // A new generation is an authoritative replacement, not an idle
            // cache policy. A still-mounted old consumer cannot keep bytes or
            // a long poll after the exact binding changes.
            for (const [otherKey, otherEntry] of [...entries]) {
                if (otherKey === key || otherEntry.bindingFamilyKey !== bindingFamilyKey) continue;
                disposeEntry(otherKey, otherEntry);
            }

            let entry = entries.get(key);
            if (!entry || entry.disposed) {
                let createdEntry: ResourceStoreEntry | null = null;
                const resource = Object.freeze({
                    machineId: input.machineId,
                    serverId: input.serverId,
                    expectedGeneration: input.expectedGeneration,
                    context: input.context,
                });
                const isCurrent = (): boolean => (
                    createdEntry?.disposed !== true
                    && input.accountLifetime.isCurrent()
                );
                const client = Object.freeze({
                    ...createPluginContextualResourceReadClient({
                        pluginId: input.pluginId,
                        resource,
                        isCurrent,
                    }),
                    ...createPluginContextualResourceWatchClient({
                        pluginId: input.pluginId,
                        resource,
                        subscriptionIdPrefix: subscriptionIdPrefix(input),
                        isCurrent,
                    }),
                });
                createdEntry = {
                    // This contextual owner already owns the captured Account
                    // retirement callback below. The generic store retains
                    // only its read/watch lifecycle and receives currentness
                    // through the bound client, avoiding a duplicate lifetime
                    // registration for the same mounted binding.
                    store: createPluginUiResourceStore({
                        client,
                        pluginId: input.pluginId,
                    }),
                    bindingFamilyKey,
                    accountRetirement: null,
                    consumers: 0,
                    disposed: false,
                };
                entries.set(key, createdEntry);
                const retirement = input.accountLifetime.onRetire(() => {
                    disposeEntry(key, createdEntry!);
                });
                // A raced retirement invokes the callback synchronously. Do
                // not reattach a cleanup or return a retired store afterward.
                if (entries.get(key) !== createdEntry || !input.accountLifetime.isCurrent()) {
                    retirement.dispose();
                    return null;
                }
                createdEntry.accountRetirement = retirement;
                entry = createdEntry;
            }

            entry.consumers += 1;
            let released = false;
            const release = (retire: boolean): void => {
                if (released) return;
                released = true;
                if (retire) {
                    disposeEntry(key, entry!);
                    return;
                }
                entry!.consumers -= 1;
                if (entry!.consumers === 0) disposeEntry(key, entry!);
            };
            return Object.freeze({
                store: entry.store,
                dispose(): void {
                    release(false);
                },
                retire(): void {
                    release(true);
                },
            });
        },
    });
}

const PluginContextualResourceStoreContext = React.createContext<PluginContextualResourceStoreOwner | null>(null);

/**
 * A mounted pane-level owner for concurrent exact contextual Resource
 * consumers. It owns no asynchronous provider cleanup: each consumer release
 * synchronously disposes the final store, which also makes StrictMode replay
 * an ordinary acquire/release sequence rather than a special fenced lifetime.
 */
export function PluginContextualResourceStoreProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const nearestOwner = React.useContext(PluginContextualResourceStoreContext);
    const ownerRef = React.useRef<PluginContextualResourceStoreOwner | null>(null);
    if (nearestOwner === null && ownerRef.current === null) {
        ownerRef.current = createPluginContextualResourceStoreOwner();
    }
    return (
        <PluginContextualResourceStoreContext.Provider value={nearestOwner ?? ownerRef.current}>
            {props.children}
        </PluginContextualResourceStoreContext.Provider>
    );
}

/** Missing provider fails closed; it never recreates a consumer-local store. */
export function usePluginContextualResourceStoreOwner(): PluginContextualResourceStoreOwner | null {
    return React.useContext(PluginContextualResourceStoreContext);
}

function resourceRenderKey(resource: PluginUiResourceReference): string {
    return typeof resource === 'string'
        ? `local:${resource}`
        : `qualified:${resource.pluginId}\u0000${resource.localId}`;
}

type AcquiredPluginContextualResource = Readonly<{
    owner: PluginContextualResourceStoreOwner;
    bindingKey: string;
    lease: PluginContextualResourceStoreLease;
}>;

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

/**
 * Reads one exact contextual Resource through the mounted provider's existing
 * store. This is deliberately schema-agnostic: a consumer owns its content
 * type decoder and any last-known-good presentation policy, while this
 * boundary owns only lease, currentness, cancellation, and subscription.
 */
export function PluginContextualResourceState(props: Readonly<{
    binding: PluginContextualResourceBinding;
    resource: PluginUiResourceReference;
    isCurrent?: () => boolean;
    signal?: AbortSignal;
    children: (snapshot: PluginUiResourceSnapshot | null) => React.ReactNode;
}>): React.ReactElement | null {
    const owner = usePluginContextualResourceStoreOwner();
    const bindingKey = resourceBindingKey(props.binding);
    const resourceKey = resourceRenderKey(props.resource);
    // Callers commonly reconstruct a `{ pluginId, localId }` reference during
    // their own projection. Keep the generic store entry stable by its exact
    // Resource identity, not that incidental wrapper identity.
    const stableResource = React.useMemo(() => props.resource, [resourceKey]);
    const currentRef = React.useRef(props.isCurrent);
    currentRef.current = props.isCurrent;
    const currentAtRender = !isAbortSignalAborted(props.signal) && currentRef.current?.() !== false;
    const [acquired, setAcquired] = React.useState<AcquiredPluginContextualResource | null>(null);

    React.useEffect(() => {
        if (owner === null || !currentAtRender) {
            setAcquired((previous) => previous?.bindingKey === bindingKey ? null : previous);
            return;
        }

        const lease = owner.acquire(props.binding);
        if (lease === null || isAbortSignalAborted(props.signal) || currentRef.current?.() === false) {
            lease?.dispose();
            setAcquired((previous) => previous?.bindingKey === bindingKey ? null : previous);
            return;
        }

        const next = Object.freeze({ owner, bindingKey, lease });
        setAcquired(next);
        const release = (): void => {
            lease.dispose();
            setAcquired((previous) => previous?.lease === lease ? null : previous);
        };
        const onAbort = (): void => { release(); };
        props.signal?.addEventListener('abort', onAbort, { once: true });
        const accountRetirement = props.binding.accountLifetime.onRetire(release);
        return () => {
            props.signal?.removeEventListener('abort', onAbort);
            accountRetirement.dispose();
            lease.dispose();
        };
    }, [bindingKey, currentAtRender, owner, props.binding.accountLifetime, props.signal]);

    const entry = React.useMemo(() => {
        if (
            acquired === null
            || acquired.owner !== owner
            || acquired.bindingKey !== bindingKey
            || !currentAtRender
        ) {
            return null;
        }
        return acquired.lease.store.getEntry(stableResource);
    }, [acquired, bindingKey, currentAtRender, owner, stableResource]);
    const subscribe = React.useCallback(
        (listener: () => void): (() => void) => entry?.subscribe(listener, true) ?? (() => {}),
        [entry],
    );
    const getSnapshot = React.useCallback(
        (): PluginUiResourceSnapshot | null => (
            currentRef.current?.() === false || props.signal?.aborted === true
                ? null
                : entry?.getSnapshot() ?? null
        ),
        [entry, props.signal],
    );
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    return <>{props.children(snapshot)}</>;
}
