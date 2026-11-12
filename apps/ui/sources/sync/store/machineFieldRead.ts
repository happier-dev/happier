import type { MachinePublishedDaemonStateV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { StorageState } from './types';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';

export type MachineFieldContent = {
  metadata: NonNullable<Machine['metadata']>;
  daemonState: MachinePublishedDaemonStateV1;
};

/** Shared admission of opened Machine content for single-field and page reads. */
export function readMachineField<Section extends keyof MachineFieldContent, Field extends keyof MachineFieldContent[Section]>(
  state: StorageState, machineId: string, section: Section, field: Field, serverId: string | null,
): MachineFieldContent[Section][Field] | null {
  const machine = serverId ? resolveServerScopedMachine(state, serverId, machineId) : state.machines[machineId];
  if (!machine || machine.revokedAt || machine.availability?.kind !== 'available'
    || machine.access && machine.access.accessState !== 'ready') return null;
  const content = machine[section] as MachineFieldContent[Section] | null;
  return content?.[field] ?? null;
}
