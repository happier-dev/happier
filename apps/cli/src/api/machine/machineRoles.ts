import { projectMachineRolesListV1, readMachineRolesSnapshotFromMetadataV1, readPublishedPluginMachineRolesV1, type MachineRolesGetResultV1, type MachineRolesListResultV1 } from '@happier-dev/protocol/machines/roles/machineRolesV1';
import { MachineContentKeyUnavailableError } from './machineDataEncryptionKey';
import type { Machine } from '../types';

/** The Account reader returns opened metadata; roles read through the one protocol owner. */
export async function readMachineRolesSnapshot(dependencies: Readonly<{
  actionId: 'machines.roles.list' | 'machines.roles.get';
  machineId: string;
  readMachine: () => Promise<Machine | null>;
  isCurrent: () => boolean | Promise<boolean>;
}>): Promise<MachineRolesGetResultV1 | MachineRolesListResultV1> {
  if (!await dependencies.isCurrent()) return { status: 'unavailable' };
  let machine: Machine | null;
  try { machine = await dependencies.readMachine(); } catch (error) {
    return { status: error instanceof MachineContentKeyUnavailableError ? 'locked' : 'unavailable' };
  }
  if (!machine || machine.id !== dependencies.machineId || !await dependencies.isCurrent()) return { status: 'unavailable' };
  const snapshot = { metadata: machine.metadata, metadataVersion: machine.metadataVersion };
  return dependencies.actionId === 'machines.roles.list'
    ? projectMachineRolesListV1({ ...snapshot, plugins: readPublishedPluginMachineRolesV1(machine.daemonState) })
    : readMachineRolesSnapshotFromMetadataV1(snapshot);
}
