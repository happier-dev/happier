import type { MachineServiceRowV1 } from '@happier-dev/protocol';

import type { ManagedWatchedServiceRow } from '@/components/store/inventory/managedOperationalInventory';

/** One Machine's service read as the Watched view holds it: its last listed rows and how the latest read went. */
export type WatchedMachineRead = Readonly<{
  status: 'listed' | 'failed';
  rows: readonly MachineServiceRowV1[] | null;
}>;

export type WatchedServiceItem = Readonly<{
  key: string;
  machineId: string;
  /** The name the person gave the watch; the listed service's own name replaces it once read. */
  name: string;
  lifecyclePurpose: ManagedWatchedServiceRow['native']['lifecyclePurpose'];
  service: MachineServiceRowV1 | null;
  /** How its Machine's service read stands: still reading, last read failed, or listed. */
  read: 'reading' | 'failed' | 'listed';
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
