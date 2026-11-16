import { readMachineIsolationSnapshotFromMetadataV1, type MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** Account sync has already opened metadata; offline Machines retain the same policy read. */
export function readSyncedMachineIsolationPolicy(machine: Machine | null): MachineIsolationGetResultV1 {
    if (!machine) return { status: 'unavailable' };
    if (machine.metadata === null || machine.availability?.kind === 'locked'
        || machine.access && machine.access.accessState !== 'ready') return { status: 'locked' };
    return readMachineIsolationSnapshotFromMetadataV1({ metadata: machine.metadata, metadataVersion: machine.metadataVersion });
}
