import * as React from 'react';

import type { PluginResourceContextV1 } from '@happier-dev/protocol';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type {
    PluginUiResourceReference,
    PluginUiResourceSnapshot,
} from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

import { createPluginContextualResourceReadClient } from './pluginSurfaceResourceRead';
import { readPluginSurfaceResourceReference } from './pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient } from './pluginSurfaceResourceWatch';
import { logPluginSurfaceDiagnostic } from '@/components/plugins/shared/pluginSurfaceDiagnosticLog';
import { captureActiveServerAccountScopeLifetime, type ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { randomUUID } from '@/platform/randomUUID';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useWidgetFrameResourceActivity } from '@/components/widgets/frame/widgetFrameResourceActivity';

type PluginContextualResourceStore = ReturnType<typeof createPluginUiResourceStore>;

export type PluginContextualResourceStoreLease = Readonly<{
    store: PluginContextualResourceStore;
    dispose(): void;
    /** Retires a confirmed terminal target for every current consumer. */
    retire(): void;
}>;

export type PluginContextualResourceStoreOwner = Readonly<{
    /**
     * Acquires one captured active-Account store for an exact host-stamped
     * binding. Callers cannot supply their own transport, cache, or Session
     * identity.
     */
    acquire(input: Readonly<{
        accountLifetime: ActiveServerAccountScopeLifetime;
        pluginId: string;
        machineId: string;
        serverId: string | null;
        expectedCallerOccurrenceId: string;
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
    // them in this key prevents a brief A/B overlap
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
        input.expectedCallerOccurrenceId,
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

/** Host chrome mounts these stores; there is no plugin-authored surface id to name. */
const CONTEXTUAL_RESOURCE_SURFACE_ID = 'host:plugin-contextual-resource';

function createPluginContextualResourceStoreOwner(): PluginContextualResourceStoreOwner {
    // The captured active Account is the sharing boundary. An entry exists only
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
        acquire(requestedBinding) {
            const accountLifetime = captureActiveServerAccountScopeLifetime();
            if (!requestedBinding.accountLifetime.isCurrent() || !accountLifetime?.isCurrent()
                || accountLifetime.scope.serverId !== requestedBinding.accountLifetime.scope.serverId
                || accountLifetime.scope.accountId !== requestedBinding.accountLifetime.scope.accountId) return null;
            // An Action's invocation lifetime may retire independently. The shared
            // transport belongs to the canonical Account, never its first caller.
            const input = { ...requestedBinding, accountLifetime };

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
                    expectedCallerOccurrenceId: input.expectedCallerOccurrenceId,
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
                        // Transport identity is bounded independently of context;
                        // Account and Resource authority stay in the binding above.
                        subscriptionIdPrefix: `contextual-resource:${randomUUID()}`,
                        isCurrent,
                    }),
                    // A contextual mount has no plugin-authored surface to route
                    // `hostApi.diagnostic` through, but its author still needs to
                    // learn when the store refused their Resource. Report into the
                    // one Plugin UI diagnostic sink the surface transport also uses.
                    diagnostic: (data: unknown) => {
                        logPluginSurfaceDiagnostic(
                            {
                                pluginId: input.pluginId,
                                contributionId: null,
                                surfaceId: CONTEXTUAL_RESOURCE_SURFACE_ID,
                            },
                            data,
                        );
                    },
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
const activeAccountResourceStoreOwner = createPluginContextualResourceStoreOwner();

/** Shares the existing exact-binding owner with host mounts and Account Actions. */
export function acquirePluginContextualResourceStore(binding: PluginContextualResourceBinding): PluginContextualResourceStoreLease | null {
    return activeAccountResourceStoreOwner.acquire(binding);
}

/** A private mount facade: declaration scope selects an existing exact-context entry. */
export function createPluginDeclaredResourceStore(input: Omit<PluginContextualResourceBinding, 'context'> & Readonly<{
    resourcesById: PluginUiProjectionModel['resourcesById'];
    sessionId?: string;
    surfaceContext?: Extract<PluginResourceContextV1, { kind: 'surface' }>;
}>): PluginUiResourceStore | null {
    const declarations = Object.values(input.resourcesById).filter(row => row.pluginId === input.pluginId);
    // Older admitted projections can still use ordinary read/watch transport,
    // but cannot lend the new sharing path a guessed Resource namespace.
    if (!declarations.length || declarations.some(row => row.scope === undefined)) return null;
    const leases = new Map<string, PluginContextualResourceStoreLease>();
    let disposed = false;
    const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    return Object.freeze({
        getEntry(resource) {
            if (disposed || !input.accountLifetime.isCurrent()) return fail('plugin_surface_retired');
            const reference = readPluginSurfaceResourceReference(input.pluginId, resource);
            const declaration = reference?.pluginId === input.pluginId
                ? declarations.find(row => row.id === reference.localId) : undefined;
            if (!declaration) return fail('plugin_resource_not_found');
            const context: PluginResourceContextV1 | undefined = declaration.scope === 'global' ? { kind: 'global' }
                : declaration.scope === 'session' && input.sessionId ? { kind: 'session', sessionId: input.sessionId }
                : declaration.scope === 'surface' ? input.surfaceContext : undefined;
            if (!context) return fail('plugin_resource_context_unavailable');
            const key = JSON.stringify(context);
            let lease = leases.get(key);
            if (!lease) {
                lease = acquirePluginContextualResourceStore({ ...input, context }) ?? undefined;
                if (!lease) return fail('plugin_surface_retired');
                leases.set(key, lease);
            }
            return lease.store.getEntry(reference!);
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const lease of leases.values()) lease.dispose();
            leases.clear();
        },
    });
}

/**
 * A mounted access boundary for concurrent exact contextual Resource
 * consumers. It owns no asynchronous provider cleanup: each consumer release
 * synchronously disposes the final store, which also makes StrictMode replay
 * an ordinary acquire/release sequence rather than a special fenced lifetime.
 */
export function PluginContextualResourceStoreProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const nearestOwner = React.useContext(PluginContextualResourceStoreContext);
    return (
        <PluginContextualResourceStoreContext.Provider value={nearestOwner ?? activeAccountResourceStoreOwner}>
            {props.children}
        </PluginContextualResourceStoreContext.Provider>
    );
}

/** Missing provider fails closed; it never recreates a consumer-local store. */
export function usePluginContextualResourceStoreOwner(): PluginContextualResourceStoreOwner | null {
    return React.useContext(PluginContextualResourceStoreContext);
}

function resourceRenderKey(resource: PluginUiResourceReference): string {
    return pluginUiResourceReferenceKey(resource);
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
    /** Demand follows the containing host; identity and retained data keep the existing lease. */
    active?: boolean;
    /** `refresh` re-reads through the same leased entry (a Retry); it settles even on failure or retirement. */
    children: (snapshot: PluginUiResourceSnapshot | null, controls: PluginContextualResourceControls) => React.ReactNode;
}>): React.ReactElement | null {
    const owner = usePluginContextualResourceStoreOwner();
    const presented = useLayoutPresentationActive();
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
        (listener: () => void): (() => void) => presented && props.active !== false ? entry?.subscribe(listener, true) ?? (() => {}) : () => {},
        [entry, presented, props.active],
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
    useWidgetFrameResourceActivity(presented && props.active !== false && snapshot?.pending === 'refresh');
    const controls = React.useMemo<PluginContextualResourceControls>(() => ({
        refresh: async () => { if (entry && currentRef.current?.() !== false) await entry.refresh(); },
    }), [entry]);

    return <>{props.children(snapshot, controls)}</>;
}

export type PluginContextualResourceControls = Readonly<{ refresh: () => Promise<void> }>;
