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

/** Count each visible host once per configured preset, including its synced offline policy. */
export function projectSandboxPresetHostCounts(machines: readonly MachineIsolationPolicySource[]): Readonly<{
    counts: ReadonlyMap<string, number>;
    complete: boolean;
}> {
    const counts = new Map<string, number>();
    let complete = true;
    for (const machine of machines) {
        const snapshot = readSyncedMachineIsolationPolicy(machine);
        if (snapshot.status !== 'ready') {
            complete = false;
            continue;
        }
        const presets = new Set(Object.values(snapshot.policy.configuredSandboxes).map(entry => entry.presetId));
        for (const presetId of presets) counts.set(presetId, (counts.get(presetId) ?? 0) + 1);
    }
    return { counts, complete };
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
