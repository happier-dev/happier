import * as React from 'react';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceEntry, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiResourceProjection } from '@happier-dev/plugin-ui/hostApi';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createPluginContextualResourceReadClient } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient } from '@/components/plugins/surfaces/pluginSurfaceResourceWatch';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { randomUUID } from '@/platform/randomUUID';

type MachineReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'machines.services.list' | 'deployments.logs' | 'deployments.health.edge' }>;
type Projection<T> = PluginUiResourceProjection<T>;
type Snapshot<T> = Readonly<Omit<ReturnType<PluginUiResourceEntry['getSnapshot']>, 'value'> & { value?: T }>;
type Input<T> = Readonly<{ accountLifetime: ServerAccountScopeLifetime | null; reference: MachineReference | null;
    /** Credential lookup is pending; the current Account's admitted selection stays readable. */
    resolving?: boolean; active: boolean; follow: boolean; projection: Projection<T> }>;
type Read<T> = Snapshot<T> & Readonly<{ refresh(): Promise<void> }>;
const noSubscribe = () => () => {};
const noSnapshot = () => null;
type RetainedResource = { store: PluginUiResourceStore; consumers: number };
const resources = new WeakMap<ServerAccountScopeLifetime, Map<string, RetainedResource>>();
const emptySnapshot = Object.freeze({ freshness: 'unknown' as const, pending: 'initial' as const,
    subscription: 'unsupported' as const });

/** The existing Resource owner, usable by a mounted hook or the shared Environment controller. */
export function createMachineServiceResourceBinding<T>(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime; reference: MachineReference; projection: Projection<T>;
}>) {
    const { reference } = input;
    const lifetime = readServerAccountScopeOwnerLifetime(input.accountLifetime);
    const key = pluginUiResourceReferenceKey(reference, null);
    const select = (store: PluginUiResourceStore) => store.getEntry(reference).select<T, Snapshot<T>>(input.projection, snapshot => snapshot);
    let selected: Readonly<{ store: PluginUiResourceStore; selection: ReturnType<typeof select> }> | undefined;
    const readSelection = () => {
        const store = resources.get(lifetime)?.get(key)?.store;
        if (store && selected?.store !== store) selected = { store, selection: select(store) };
        return selected?.selection;
    };
    // Construction happens during render. Only committed mounts and subscriptions
    // retain an Account store or register its retirement.
    const retain = () => {
        if (!lifetime.isCurrent()) return () => {};
        let stores = resources.get(lifetime);
        if (!stores) { stores = new Map(); resources.set(lifetime, stores); }
        const registry = stores;
        let retained = registry.get(key);
        if (!retained) {
            const current = () => lifetime.isCurrent()
                && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, reference.input.serverId);
            const resource = { machineId: reference.input.machineId, serverId: reference.input.serverId,
                accountId: lifetime.scope.accountId, hostResource: reference };
            const store = createPluginUiResourceStore({ accountLifetime: {
                isCurrent: () => lifetime.isCurrent(),
                onRetire: cancel => lifetime.onRetire(() => {
                    registry.delete(key);
                    if (registry.size === 0) resources.delete(lifetime);
                    cancel();
                }),
            }, client: {
                ...createPluginContextualResourceReadClient({ resource, isCurrent: current }),
                ...createPluginContextualResourceWatchClient({ resource, isCurrent: current,
                    subscriptionIdPrefix: `machine-service:${randomUUID()}` }),
            } });
            retained = { store, consumers: 0 };
            registry.set(key, retained);
        }
        const held = retained;
        held.consumers++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--held.consumers !== 0) return;
            registry.delete(key);
            if (registry.size === 0) resources.delete(lifetime);
            held.store.dispose();
        };
    };
    const selection = {
        getSnapshot: (): Snapshot<T> => readSelection()?.getSnapshot() ?? emptySnapshot,
        subscribe(listener: () => void, live: boolean) {
            const release = retain();
            const unsubscribe = readSelection()?.subscribe(listener, live) ?? (() => {});
            return () => { unsubscribe(); release(); };
        },
        async refresh(options?: Parameters<PluginUiResourceEntry['refresh']>[0]) {
            await readSelection()?.refresh(options);
        },
    };
    return { retain, selection };
}

/** One Account Resource binding shared by the native list and logs projections. */
export function useMachineServiceResource<T>(input: Input<T> & Readonly<{
    accountLifetime: ServerAccountScopeLifetime; reference: MachineReference;
}>): Read<T>;
export function useMachineServiceResource<T>(input: Input<T>): Read<T> | null;
export function useMachineServiceResource<T>(input: Input<T>): Read<T> | null {
    const key = input.reference ? pluginUiResourceReferenceKey(input.reference, null) : null;
    const retainedLifetime = React.useRef<Readonly<{ key: string | null; lifetime: ServerAccountScopeLifetime }> | null>(null);
    const lifetime = input.accountLifetime ? readServerAccountScopeOwnerLifetime(input.accountLifetime)
        : input.resolving && retainedLifetime.current?.key === key && retainedLifetime.current.lifetime.isCurrent()
            ? retainedLifetime.current.lifetime : null;
    retainedLifetime.current = lifetime ? { key, lifetime } : null;
    const owner = React.useMemo(() => {
        const reference = input.reference;
        if (!reference || !lifetime) return null;
        return createMachineServiceResourceBinding({ reference, accountLifetime: lifetime, projection: input.projection });
    }, [lifetime, key, input.projection]);
    // A mounted hidden view keeps its finite snapshot; replacing its live/static
    // subscription must not dispose the store beneath useSyncExternalStore.
    React.useEffect(() => owner?.retain(), [owner]);
    const subscribe = React.useCallback((listener: () => void) => input.active && owner
        ? owner.selection.subscribe(listener, input.follow) : noSubscribe(), [owner, input.active, input.follow]);
    const snapshot = React.useSyncExternalStore(subscribe, owner?.selection.getSnapshot ?? noSnapshot,
        owner?.selection.getSnapshot ?? noSnapshot);
    const refresh = React.useCallback(() => input.active && owner ? owner.selection.refresh() : Promise.resolve(), [input.active, owner]);
    return snapshot ? { ...snapshot, refresh } : null;
}
