import { readMachineResourcesPolicyV1SnapshotFromMetadata, type MachineResourcesPolicyGetResultV1 } from '@happier-dev/protocol/machines/resources/machineResourcesPolicyV1';
import { MachinePublishedResourceSummaryV1Schema } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachinePickerPresence } from '@/sync/domains/machines/identity/resolveMachinePickerPresence';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';

export type MachineResourcesPolicyReadOnlyReason = 'offline' | 'unknown' | 'not_custodian' | 'older_happier' | null;

/** Synced metadata is already opened by the Account-mode-aware sync owner. */
export function readSyncedMachineResourcesPolicy(machine: Machine | null): MachineResourcesPolicyGetResultV1 {
    if (!machine) return { status: 'unavailable' };
    if (machine.availability?.kind === 'locked' || (machine.access && machine.access.accessState !== 'ready')) return { status: 'locked' };
    return readMachineResourcesPolicyV1SnapshotFromMetadata({ metadata: machine.metadata, metadataVersion: machine.metadataVersion, hasContentKey: machine.metadata !== null });
}

export function readMachineResourcesPolicyReadOnlyReason(machine: Machine | null, scope: MachineReachabilityScope | null): MachineResourcesPolicyReadOnlyReason {
    if (!machine) return 'unknown';
    const presence = resolveMachinePickerPresence(machine, undefined, scope);
    if (presence.status === 'unknown') return 'unknown';
    if (presence.status !== 'online') return 'offline';
    const state: unknown = machine.daemonState;
    const resources = typeof state === 'object' && state !== null && 'resources' in state ? state.resources : null;
    if (!MachinePublishedResourceSummaryV1Schema.safeParse(resources).success) return 'older_happier';
    if (machine.isShared !== false && machine.access?.role !== 'manage') return 'not_custodian';
    return null;
}
