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
    const bind = () => {
        const state = store.getState();
        const activeServerId = getActiveServerSnapshot().serverId;
        const keys = target.serverId ? resolveServerScopedMachineInventoryKeys({
            serverId: target.serverId, machineListByServerId: state.machineListByServerId,
        }) : [];
        const records: PropertyKey[][] = keys.map(key => ['state', 'machineRecordsByServerId', key, target.machineId]);
        if (!target.serverId || areServerProfileIdentifiersEquivalent(target.serverId, activeServerId)) {
            records.push(['state', 'machines', target.machineId]);
        }
        const paths = records.flatMap(record => [
            [...record, target.section, target.field],
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
