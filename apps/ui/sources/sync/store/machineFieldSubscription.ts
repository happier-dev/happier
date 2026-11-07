import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { areServerProfileIdentifiersEquivalent, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { resolveServerScopedMachineInventoryKeys } from '@/sync/domains/machines/resolveServerScopedMachines';
import { subscribeStoragePaths } from '@/sync/domains/state/storageSubscriptions';
import type { ScopedStorage } from '@/sync/domains/state/scopedStorage';

/** Subscribe to admitted field identity and the existing Machine availability inputs. */
export function subscribeMachineField(
    store: Pick<ScopedStorage, 'getState'>,
    target: Readonly<{ machineId: string; serverId: string | null; section: string; field: PropertyKey }>,
    listener: () => void,
): () => void {
    return subscribeMachineFields(store, {
        machineIds: [target.machineId], serverId: target.serverId,
        fields: [{ section: target.section, field: target.field }],
    }, listener);
}

/** Several admitted fields share one notification, Home binding and availability subscription. */
export function subscribeMachineFields(
    store: Pick<ScopedStorage, 'getState'>,
    target: Readonly<{ machineIds: readonly string[]; serverId: string | null;
        fields: readonly Readonly<{ section: string; field: PropertyKey }>[] }>,
    listener: () => void,
): () => void {
    const bind = () => {
        const state = store.getState();
        const activeServerId = getActiveServerSnapshot().serverId;
        const keys = target.serverId ? resolveServerScopedMachineInventoryKeys({
            serverId: target.serverId, machineListByServerId: state.machineListByServerId,
        }) : [];
        const records = target.machineIds.flatMap(machineId => {
            const paths: PropertyKey[][] = keys.map(key => ['state', 'machineRecordsByServerId', key, machineId]);
            if (!target.serverId || areServerProfileIdentifiersEquivalent(target.serverId, activeServerId)) {
                paths.push(['state', 'machines', machineId]);
            }
            return paths;
        });
        const paths = records.flatMap(record => [
            ...target.fields.map(({ section, field }) => [...record, section, field]),
            [...record, 'revokedAt'],
            [...record, 'availability', 'kind'],
            [...record, 'access', 'accessState'],
        ]);
        paths.push(['state', 'profileScope']);
        for (const key of keys) paths.push(['state', 'machineListStatusByServerId', key]);
        return subscribeStoragePaths(paths, event => { if (event.kind === 'state') listener(); });
    };
    let stop = bind();
    const rebind = () => { stop(); stop = bind(); listener(); };
    const stopHome = target.serverId ? subscribeActiveServer(rebind) : () => {};
    const stopProfiles = target.serverId ? subscribeServerProfiles(rebind) : () => {};
    return () => { stop(); stopHome(); stopProfiles(); };
}
