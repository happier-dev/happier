import {
  getMachineFinitePolicyV1,
  mutateMachineFinitePolicyV1,
  type MachineFinitePolicyGetResultV1,
  type MachineFinitePolicyMutationResultV1,
} from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { createMachineMetadataFieldPort, type MachineMetadataFieldClientDependencies } from './machineMetadataField';

export type MachineFinitePolicyClient = Readonly<{
  get: () => Promise<MachineFinitePolicyGetResultV1>;
  set: (input: unknown) => Promise<MachineFinitePolicyMutationResultV1>;
}>;

/** Finite policy consumes the same Account-mode metadata field port as other Machine fields. */
export function createMachineFinitePolicyClient(dependencies: MachineMetadataFieldClientDependencies): MachineFinitePolicyClient {
  return {
    get: () => getMachineFinitePolicyV1(createMachineMetadataFieldPort(dependencies)),
    set: (input: unknown) => mutateMachineFinitePolicyV1(input, createMachineMetadataFieldPort(dependencies), { signal: dependencies.signal }),
  };
}
