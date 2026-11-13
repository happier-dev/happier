import { projectMachineRolesListV1, readMachineRolesSnapshotFromMetadataV1, readPublishedPluginMachineRolesV1, type MachineRolesGetResultV1, type MachineRolesListResultV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import type { Machine } from '@/sync/domains/state/storageTypes';

/** Synced metadata is already opened by the Account-mode-aware sync owner; offline Machines stay readable. */
function readable(machine: Machine | null): machine is Machine & { metadata: NonNullable<Machine['metadata']> } {
    return !!machine && machine.metadata !== null
        && machine.availability?.kind !== 'locked' && !(machine.access && machine.access.accessState !== 'ready');
}

export function readSyncedMachineRolesList(machine: Machine | null): MachineRolesListResultV1 {
    if (!machine) return { status: 'unavailable' };
    if (!readable(machine)) return { status: 'locked' };
    // Plugin roles come from the daemon's published plugin summary; the toggle state is the synced metadata.
    return projectMachineRolesListV1({ metadata: machine.metadata, metadataVersion: machine.metadataVersion,
        plugins: readPublishedPluginMachineRolesV1(machine.daemonState) });
}

export function readSyncedMachineRoles(machine: Machine | null): MachineRolesGetResultV1 {
    if (!machine) return { status: 'unavailable' };
    if (!readable(machine)) return { status: 'locked' };
    return readMachineRolesSnapshotFromMetadataV1({ metadata: machine.metadata, metadataVersion: machine.metadataVersion });
}
