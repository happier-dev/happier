import { getMachineResourcesPolicyV1, mutateMachineResourcesPolicyV1, readMachineResourcesPolicyV1SnapshotFromMetadata, MachineResourcesPolicyMutationV1Schema, type MachineResourcesPolicyV1, type MachineResourcesPolicyGetResultV1, type MachineResourcesPolicyMutationResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import type { MachineGuardStateV1 } from '@happier-dev/protocol/machines/guard/guardStateV1';
import { readGuardCeilingCapability } from '../platform/linux/systemdUserResourceGovernor';

export type MachineResourcesPolicyRuntime = Readonly<{
  read: () => MachineResourcesPolicyGetResultV1;
  reload: () => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  subscribeKey: (key: keyof MachineResourcesPolicyV1, listener: () => void) => () => void;
  set: (input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<MachineResourcesPolicyMutationResultV1>;
  stop: () => void;
}>;
export function createMachineResourcesPolicyRuntime(dependencies: Readonly<{
  port: MachineMetadataFieldPortV1;
  readVolumeCapacityBytes?: () => readonly number[];
  readGuardCeilingCapability?: () => Promise<MachineGuardStateV1['capabilities']['ceiling']>;
}>): MachineResourcesPolicyRuntime {
  let snapshot: MachineResourcesPolicyGetResultV1 = { status: 'unavailable' };
  let stopped = false;
  const listeners = new Set<() => void>();
  const keyListeners = new Map<keyof MachineResourcesPolicyV1, Set<() => void>>();
  const publish = (next: MachineResourcesPolicyGetResultV1) => {
    if (stopped || next.status === 'ready' && snapshot.status === 'ready' && next.revision < snapshot.revision
      || sameStrictJsonValue(snapshot, next)) return;
    const previous = snapshot;
    snapshot = next;
    for (const [key, subscribed] of keyListeners) {
      const before = previous.status === 'ready' ? previous.policy[key] : null;
      const after = next.status === 'ready' ? next.policy[key] : null;
      if (!sameStrictJsonValue(before, after)) for (const listener of subscribed) listener();
    }
    for (const listener of listeners) listener();
  };
  const reload = async () => {
    if (stopped) return;
    const next = await getMachineResourcesPolicyV1(dependencies.port);
    publish(next);
  };
  return { read: () => snapshot, reload, subscribe(listener) { if (!stopped) listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeKey(key, listener) {
      if (stopped) return () => {};
      let subscribed = keyListeners.get(key);
      if (!subscribed) { subscribed = new Set(); keyListeners.set(key, subscribed); }
      subscribed.add(listener);
      return () => { subscribed.delete(listener); if (!subscribed.size && keyListeners.get(key) === subscribed) keyListeners.delete(key); };
    },
    async set(input, options) {
      if (stopped) return { status: 'unavailable', reason: 'stopped' };
      const parsed = MachineResourcesPolicyMutationV1Schema.safeParse(input);
      if (!parsed.success) return { status: 'unavailable', reason: 'invalid_policy_patch' };
      const ceiling = parsed.data.patch.guard?.sessionMemoryCeiling?.bytes;
      if (ceiling !== undefined && ceiling !== null) {
        const capability = await (dependencies.readGuardCeilingCapability ?? readGuardCeilingCapability)();
        if (capability.status === 'unavailable') return { status: 'unsupported', reason: capability.reason };
        if (stopped || options?.signal?.aborted) return { status: 'unavailable', reason: 'stopped' };
      }
      const threshold = parsed.data.patch.alerts?.disk?.threshold;
      if (threshold && 'freeBytes' in threshold) {
        const capacities = dependencies.readVolumeCapacityBytes?.() ?? [];
        if (!capacities.length) return { status: 'unavailable', reason: 'volume_capacity_unavailable' };
        if (!capacities.some(totalBytes => threshold.freeBytes <= totalBytes)) return { status: 'unsupported', reason: 'disk_threshold_exceeds_volume_capacity' };
      }
      let observed: MachineResourcesPolicyGetResultV1 = snapshot;
      let metadataWriteAttempted = false;
      const port: MachineMetadataFieldPortV1 = { ...dependencies.port, read: async () => {
        const read = await dependencies.port.read();
        observed = read.status === 'ready' ? readMachineResourcesPolicyV1SnapshotFromMetadata({
          metadata: read.metadata, metadataVersion: read.metadataVersion, hasContentKey: true,
        }) : { status: read.status };
        return read;
      }, compareAndSwap: async input => {
        if (stopped || options?.signal?.aborted) return { status: 'unavailable' };
        metadataWriteAttempted = true;
        const answer = await dependencies.port.compareAndSwap(input);
        if (answer.status === 'locked' || answer.status === 'invalid') observed = { status: answer.status };
        return answer;
      } };
      const result = await mutateMachineResourcesPolicyV1(input, port, options);
      // No-write reads still respect local shutdown/cancellation. Remote
      // revocation is admitted on the next request, not during this receipt.
      if ('policy' in result && !metadataWriteAttempted) {
        if (stopped || options?.signal?.aborted) return { status: 'unavailable', reason: 'admission_withdrawn' };
      }
      // CAS (including lost-ACK reconciliation) already returned the canonical field.
      // Do not serialize another read and identical policy reapplication after it.
      if ('policy' in result) publish({ status: 'ready', policy: result.policy, revision: result.revision,
        source: observed.status === 'ready' && observed.revision === result.revision ? observed.source : 'stored' });
      else if (observed.status !== 'ready') publish(observed);
      return result;
    },
    stop() { stopped = true; snapshot = { status: 'unavailable' }; listeners.clear(); keyListeners.clear(); },
  };
}

/** One preparation-time allocation from the database filesystem's available bytes. */
export async function resolveMachineDatabaseAllocation(input: Readonly<{
  readPolicy: () => MachineResourcesPolicyGetResultV1;
  readCapacity: (path: string) => ReturnType<typeof import('../../storage/pathCapacity').readStoragePathCapacity>;
  directory: string;
  retainedBytes: number;
}>): Promise<number | null> {
  const snapshot = input.readPolicy();
  if (snapshot.status !== 'ready') return null;
  const capacity = await input.readCapacity(input.directory);
  if (capacity.status !== 'known') return null;
  const threshold = snapshot.policy.alerts.disk.threshold;
  // Percentage thresholds describe disk pressure for alerts. An explicit
  // byte threshold can reserve a fixed amount of space on the database volume.
  const reservedBytes = 'freeBytes' in threshold ? threshold.freeBytes : 0;
  const allocation = input.retainedBytes + Math.max(0, capacity.freeBytes - reservedBytes);
  return Number.isSafeInteger(allocation) ? allocation : null;
}
