import { readMachineIsolationSnapshotFromMetadataV1, type MachineIsolationGetResultV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import { MachineContentKeyUnavailableError } from './machineDataEncryptionKey';
import type { Machine } from '../types';

/** Account reads remain available offline through the incumbent opened Machine metadata. */
export async function readMachineIsolationSnapshot(dependencies: Readonly<{
  machineId: string; readMachine: () => Promise<Machine | null>; isCurrent: () => boolean | Promise<boolean>;
}>): Promise<MachineIsolationGetResultV1> {
  if (!await dependencies.isCurrent()) return { status: 'unavailable' };
  let machine: Machine | null;
  try { machine = await dependencies.readMachine(); } catch (error) {
    return { status: error instanceof MachineContentKeyUnavailableError ? 'locked' : 'unavailable' };
  }
  if (!machine || machine.id !== dependencies.machineId || !await dependencies.isCurrent()) return { status: 'unavailable' };
  return readMachineIsolationSnapshotFromMetadataV1({ metadata: machine.metadata, metadataVersion: machine.metadataVersion });
}
