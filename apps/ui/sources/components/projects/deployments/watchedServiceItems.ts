import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import type { ManagedWatchedServiceRow } from '@/components/store/inventory/managedOperationalInventory';

/** One Machine's service read as the Watched view holds it: its last listed rows and how the latest read went. */
export type WatchedMachineRead = Readonly<{
  status: 'listed' | 'failed';
  rows: readonly MachineServiceRowV1[] | null;
}> | Readonly<{
  /** This Home cannot reach the Machine: its read cannot answer, so its band says the Machine's presence instead. */
  status: 'unreachable';
  rows: readonly MachineServiceRowV1[] | null;
  /** The Machine presence owner's word ("Can't reach from this Home", "Offline · seen 2 h ago"). */
  presence: string;
}>;

export type WatchedServiceItem = Readonly<{
  key: string;
  machineId: string;
  /** The name the person gave the watch; the listed service's own name replaces it once read. */
  name: string;
  lifecyclePurpose: ManagedWatchedServiceRow['native']['lifecyclePurpose'];
  service: MachineServiceRowV1 | null;
  /** How its Machine's service read stands: still reading, last read failed, or listed. */
  read: 'reading' | 'failed' | 'listed' | 'unreachable';
}>;

/**
 * Each watch with the service its Machine lists for it (Services → Watched). An adopted row carries the identity of
 * the watch it stands for (`watchId`; its `serviceId` changes with each started instance), so that is the join. A
 * Machine not read yet, or whose read failed, keeps its last listed rows and says so; the native resource id is the
 * adapter's opaque key and is never something to show.
 */
export function watchedServiceItems(
  watches: readonly Pick<
    ManagedWatchedServiceRow,
    'key' | 'machineId' | 'native'
  >[],
  reads: ReadonlyMap<string, WatchedMachineRead>,
): readonly WatchedServiceItem[] {
  return watches.map((watch) => {
    const read = reads.get(watch.machineId);
    return {
      key: watch.key,
      machineId: watch.machineId,
      name: watch.native.name,
      lifecyclePurpose: watch.native.lifecyclePurpose,
      service:
        read?.rows?.find(
          (service) => service.watchId === watch.native.watchId,
        ) ?? null,
      read: !read ? 'reading' : read.status,
    };
  });
}

export type WatchedServiceBand = Readonly<{
  key: string;
  /** The Machine's name, when the reach owner has one. */
  title: string | null;
  read: WatchedServiceItem['read'];
  /** An unreachable Machine's presence word, said on its band; null otherwise. */
  presence: string | null;
}>;

/** One band per Machine with watches, carrying that Machine's read state once (its rows never repeat it). */
export function watchedServiceBands(
  machineIds: readonly string[],
  reads: ReadonlyMap<string, WatchedMachineRead>,
  names: Readonly<Record<string, string | undefined>>,
): readonly WatchedServiceBand[] {
  return machineIds.map((machineId) => {
    const read = reads.get(machineId);
    return { key: machineId, title: names[machineId] ?? null, read: !read ? 'reading' : read.status,
      presence: read?.status === 'unreachable' ? read.presence : null };
  });
}
