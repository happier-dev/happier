import { readMachineIsolationSnapshotFromMetadataV1, selectMachineIsolationWorkChoiceV1,
    type MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** The synced fields the policy read needs; a picker's scoped Machine row carries them too. */
export type MachineIsolationPolicySource = Readonly<{
    metadata: unknown; metadataVersion: number; availability?: Machine['availability']; access?: Machine['access'];
}>;

/** Account sync has already opened metadata; offline Machines retain the same policy read. */
export function readSyncedMachineIsolationPolicy(machine: MachineIsolationPolicySource | null): MachineIsolationGetResultV1 {
    if (!machine) return { status: 'unavailable' };
    if (machine.metadata === null || machine.availability?.kind === 'locked'
        || machine.access && machine.access.accessState !== 'ready') return { status: 'locked' };
    return readMachineIsolationSnapshotFromMetadataV1({ metadata: machine.metadata, metadataVersion: machine.metadataVersion });
}

/** Description of a stored Machine policy, not admission, native readiness or other placement defaults. */
export function proposeMachineIsolationOutcome(snapshot: MachineIsolationGetResultV1,
    workKind: keyof MachineIsolationPolicyV1['workKinds'], override?: 'directly') {
    if (snapshot.status !== 'ready' || snapshot.source !== 'stored') return null;
    const selection = selectMachineIsolationWorkChoiceV1(snapshot.policy, { workKind,
        ...(override ? { choice: { kind: override } } : {}),
    });
    return selection.status === 'selected' ? { ...selection, status: 'proposed' as const } : selection;
}
