import { getMachineFinitePolicyV1, mutateMachineFinitePolicyV1 } from '@happier-dev/protocol/machines/machineFinitePolicyV1';
import { createAccountServerMachineMetadataClient, type AccountServerMachineMetadataTarget } from './accountServerMachineMetadata';
import type { MachineFinitePolicyClient } from './machineFinitePolicy';

/** Finite policy consumes the shared Account metadata socket on the captured Home. */
export async function createAccountServerMachineFinitePolicyClient(params: AccountServerMachineMetadataTarget): Promise<MachineFinitePolicyClient> {
  const withPort = await createAccountServerMachineMetadataClient(params);
  return {
    get: () => withPort(getMachineFinitePolicyV1),
    set: (input) => withPort(port => mutateMachineFinitePolicyV1(input, port, { signal: params.signal })),
  };
}
