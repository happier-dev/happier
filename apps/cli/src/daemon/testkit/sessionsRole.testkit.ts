import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineRpcLifecycleRegistration } from '@/api/machine/rpcHandlers';
import { createMachineRoleActivationRuntime, type MachineRoleActivationRuntime } from '@/daemon/roles/machineRoleActivation';

/**
 * Activates the `sessions` Machine role on a Machine client the way machine bootstrap does: the
 * real activation runtime (no stored role set = every role) registers the new-Session family that
 * `setRPCHandlers` composed. Stop the returned runtime with the client.
 */
export async function activateSessionsRoleForMachineClient(
  client: Pick<ApiMachineClient, 'getMachineRoleRpcHandlerManager'>,
  registration: Pick<MachineRpcLifecycleRegistration, 'sessionsRoleFamily'>,
): Promise<MachineRoleActivationRuntime> {
  const runtime = createMachineRoleActivationRuntime({ rpcHandlerManager: client.getMachineRoleRpcHandlerManager(), contexts: {} });
  await runtime.start();
  await runtime.provide('sessions', { family: registration.sessionsRoleFamily });
  return runtime;
}
