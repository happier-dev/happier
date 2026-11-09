import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { QualifiedConnectedAccountProfileV4, QualifiedConnectedAccountRef } from '@happier-dev/protocol';
import { waitForChangeOrDeadline } from '@/daemon/lifecycle/waitForChangeOrDeadline';

type Service = QualifiedConnectedAccountRef['service'];
type InventoryRead = {
  valid: boolean;
  pending: boolean;
  isCurrent(): boolean;
  retain(): () => void;
  promise: Promise<readonly QualifiedConnectedAccountProfileV4[]>;
};

/** Shared metadata demand owns its HTTP lifetime, independently of any one coordinator. */
export function createCoordinatorInventory(input: Readonly<{
  isObserved?: () => boolean;
  read(services: readonly Service[], signal: AbortSignal, setCurrentness: (isCurrent: () => boolean) => void,
    observationOnly: boolean): Promise<ReadonlyMap<string, readonly QualifiedConnectedAccountProfileV4[]>>;
}>) {
  const inventories = new Map<string, InventoryRead>();
  const startReads = (services: readonly Service[], observationOnly: boolean) => {
    const reads: InventoryRead[] = [];
    const lifetime = new AbortController();
    let readers = 0;
    let pending = true;
    const inventory = input.read(services, lifetime.signal, isCurrent => {
      for (const read of reads) read.isCurrent = isCurrent;
    }, observationOnly);
    void inventory.then(() => { pending = false; }, () => { pending = false; });
    const retain = () => {
      readers++;
      return () => {
        if (--readers !== 0 || !pending) return;
        // A surviving reader keeps the batch; the final departure ends demand.
        // Withdraw before abort so a fresh reader never joins retired work.
        for (const read of reads) read.valid = false;
        lifetime.abort();
      };
    };
    for (const service of services) {
      const key = buildQualifiedPluginContributionKey(service);
      const read: InventoryRead = { valid: true, pending: true, isCurrent: () => true, retain,
        promise: inventory.then(accounts => accounts.get(key)!) };
      reads.push(read);
      inventories.set(key, read);
      const discard = () => { if (inventories.get(key) === read) inventories.delete(key); };
      void read.promise.then(() => {
        read.pending = false;
        if (input.isObserved?.() !== true) discard();
      }, discard);
    }
  };
  return {
    // A completed observed metadata projection is reusable. Invocation-time
    // credential/configuration/currentness admission remains with its owner.
    async list(services: readonly Service[], signal: AbortSignal, observationOnly = false)
      : Promise<readonly (readonly QualifiedConnectedAccountProfileV4[])[]> {
      const keys = services.map(buildQualifiedPluginContributionKey);
      for (;;) {
        signal.throwIfAborted();
        const missing = services.filter((_, index) => {
          const existing = inventories.get(keys[index]);
          return !(existing?.valid && existing.isCurrent()
            && (existing.pending || observationOnly && input.isObserved?.() === true));
        });
        if (missing.length) startReads(missing, observationOnly);
        const reads = keys.map(key => inventories.get(key)!);
        const releases = reads.map(read => read.retain());
        const invalidated = () => reads.some(read => !read.valid || !read.isCurrent());
        const result = Promise.all(reads.map(read => read.promise));
        try {
          await waitForChangeOrDeadline({ signal, waitForChange: async () => { await result; } });
          signal.throwIfAborted();
          if (invalidated()) continue;
          return await result;
        } catch (error) {
          signal.throwIfAborted();
          if (invalidated()) continue;
          throw error;
        } finally { for (const release of releases) release(); }
      }
    },
    invalidate(keys: ReadonlySet<string> | null) {
      for (const [key, read] of inventories) {
        if (keys && !keys.has(key)) continue;
        read.valid = false;
        inventories.delete(key);
      }
    },
  };
}
