import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineReachabilityObservationV1 } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError } from '@happier-dev/protocol/rpcErrors';

/** The already-admitted daemon factory captures its target/client together.
 * The ACK is an actual Home-routed call to THIS client's Machine, never
 * invokeLocal or a replacement walk. The existing transport registration
 * owner supplies readiness at settlement, not guessed presence or a Home GET.
 * This is a post-change product observation, not another admission check. */
export async function observeOwnDaemonReachability(input: Readonly<{
  client: Pick<ApiMachineClient, 'callConnectedClientRpc' | 'isMachineControlRegistrationReady'>;
  signal?: AbortSignal;
}>): Promise<MachineReachabilityObservationV1['management']['daemon']> {
  const reply = await input.client.callConnectedClientRpc(RPC_METHODS.CAPABILITIES_DESCRIBE, {}, { signal: input.signal, timeoutMs: null });
  const registered = input.client.isMachineControlRegistrationReady();
  if (!registered || !reply.ok && isMachineRequestReachabilityFailureV1(createRpcCallError({
    error: reply.error ?? 'Daemon observation failed', errorCode: reply.errorCode,
  }))) return 'unavailable';
  return reply.ok ? 'ready' : 'unknown';
}
