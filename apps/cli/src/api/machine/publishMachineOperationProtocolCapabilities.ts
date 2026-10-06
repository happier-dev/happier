import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1, MachineUpdateOperationProtocolCapabilitiesRequestV1Schema, MachineUpdateOperationProtocolCapabilitiesResponseV1Schema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import type { MachineOperationProtocolCapabilitiesV1 } from '@happier-dev/protocol';
import type { Socket } from 'socket.io-client';

import type { DaemonToServerEvents, ServerToDaemonEvents } from './socketTypes';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';

/**
 * Capability leaves shared by every current host Session runtime, including a
 * restricted Runner. The Pending admission version remains a caller-supplied
 * negotiated fact: ordinary daemons may need to retain V1 for an older Home,
 * while the unreleased Runner can start only against its current V2 Home.
 */
export const CURRENT_SESSION_RUNTIME_OPERATION_PROTOCOL_CAPABILITIES_V1 = Object.freeze({
  sessionFollow: { contextV1: true },
}) satisfies MachineOperationProtocolCapabilitiesV1;

/** Replaces the exact Machine's persisted capability projection through its authenticated socket. */
export async function publishMachineOperationProtocolCapabilitiesOnSocket(input: Readonly<{
  socket: Socket<ServerToDaemonEvents, DaemonToServerEvents>;
  machineId: string;
  capabilities: MachineOperationProtocolCapabilitiesV1;
}>): Promise<number> {
  const request = MachineUpdateOperationProtocolCapabilitiesRequestV1Schema.parse({
    machineId: input.machineId,
    capabilities: input.capabilities,
  });
  const raw = await emitSocketWithAck({
    socket: input.socket,
    event: MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
    payload: request,
  });
  const response = MachineUpdateOperationProtocolCapabilitiesResponseV1Schema.parse(raw);
  if (response.result !== 'success') {
    throw new Error(`Machine operation protocol capability update failed: ${response.code}`);
  }
  return response.revision;
}
