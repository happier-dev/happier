import * as React from 'react';
import { createPluginUiResourceStore, pluginUiResourceReferenceKey, type PluginUiResourceEntry, type PluginUiResourceStore } from '@happier-dev/plugin-ui/advanced';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import { readServerAccountScopeOwnerLifetime, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { createPluginContextualResourceReadClient } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { createPluginContextualResourceWatchClient } from '@/components/plugins/surfaces/pluginSurfaceResourceWatch';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { randomUUID } from '@/platform/randomUUID';

type MachineReference = Extract<PluginUiHostReadReferenceV1, { hostRead: 'machines.services.logs' | 'machines.services.list' | 'deployments.logs' | 'deployments.health.edge' }>;
type Projection<T> = Readonly<{ decode(content: Readonly<{ bytes: Uint8Array }>, previous: T | undefined): T }>;
type Snapshot<T> = Readonly<Omit<ReturnType<PluginUiResourceEntry['getSnapshot']>, 'value'> & { value?: T }>;
type Input<T> = Readonly<{ accountLifetime: ServerAccountScopeLifetime | null; reference: MachineReference | null;
    active: boolean; follow: boolean; projection: Projection<T> }>;
type Read<T> = Snapshot<T> & Readonly<{ refresh(): Promise<void> }>;
const noSubscribe = () => () => {};
const noSnapshot = () => null;
const resources = new WeakMap<ServerAccountScopeLifetime, Map<string, PluginUiResourceStore>>();

/** The existing Resource owner, usable by a mounted hook or the shared Environment controller. */
export function createMachineServiceResourceBinding<T>(input: Readonly<{
    accountLifetime: ServerAccountScopeLifetime; reference: MachineReference; projection: Projection<T>;
}>) {
    const { reference } = input;
    const lifetime = readServerAccountScopeOwnerLifetime(input.accountLifetime);
    let stores = resources.get(lifetime);
    if (!stores) {
        stores = new Map();
        resources.set(lifetime, stores);
        lifetime.onRetire(() => { resources.delete(lifetime); });
    }
    const key = pluginUiResourceReferenceKey(reference, null);
    let store = stores.get(key);
    if (!store) {
        const current = () => lifetime.isCurrent()
            && areServerProfileIdentifiersEquivalent(lifetime.scope.serverId, reference.input.serverId);
        const resource = { machineId: reference.input.machineId, serverId: reference.input.serverId,
            accountId: lifetime.scope.accountId, hostResource: reference };
        store = createPluginUiResourceStore({ accountLifetime: lifetime, client: {
            ...createPluginContextualResourceReadClient({ resource, isCurrent: current }),
            ...createPluginContextualResourceWatchClient({ resource, isCurrent: current,
                subscriptionIdPrefix: `machine-service:${randomUUID()}` }),
        } });
        stores.set(key, store);
    }
    const selection = store.getEntry(reference).select<T, Snapshot<T>>(input.projection, snapshot => snapshot);
    return { store, selection };
}

/** One Account Resource binding shared by the native list and logs projections. */
export function useMachineServiceResource<T>(input: Input<T> & Readonly<{
    accountLifetime: ServerAccountScopeLifetime; reference: MachineReference;
}>): Read<T>;
export function useMachineServiceResource<T>(input: Input<T>): Read<T> | null;
export function useMachineServiceResource<T>(input: Input<T>): Read<T> | null {
    const key = input.reference ? pluginUiResourceReferenceKey(input.reference, null) : null;
    const owner = React.useMemo(() => {
        const reference = input.reference, lifetime = input.accountLifetime;
        if (!reference || !lifetime) return null;
        return createMachineServiceResourceBinding({ reference, accountLifetime: lifetime, projection: input.projection });
    }, [input.accountLifetime, key, input.projection]);
    const subscribe = React.useCallback((listener: () => void) => input.active && owner
        ? owner.selection.subscribe(listener, input.follow) : noSubscribe(), [owner, input.active, input.follow]);
    const snapshot = React.useSyncExternalStore(subscribe, owner?.selection.getSnapshot ?? noSnapshot,
        owner?.selection.getSnapshot ?? noSnapshot);
    const refresh = React.useCallback(() => input.active && owner ? owner.selection.refresh() : Promise.resolve(), [input.active, owner]);
    return snapshot ? { ...snapshot, refresh } : null;
}
