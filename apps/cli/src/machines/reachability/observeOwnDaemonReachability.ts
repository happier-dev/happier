import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineReachabilityObservationV1 } from '@happier-dev/protocol/machines/reachability/machineReachabilityPostureV1';
import { isMachineRequestReachabilityFailureV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createRpcCallError, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type OwnDaemonReachabilityProof = Readonly<{
  status: MachineReachabilityObservationV1['management']['daemon'];
  errorCode?: string;
}>;

/** The already-admitted daemon factory captures its target/client together.
 * The ACK is an actual Home-routed call to THIS client's Machine, never
 * invokeLocal or a replacement walk. The existing transport registration
 * owner supplies readiness at settlement, not guessed presence or a Home GET.
 * This is a post-change product observation, not another admission check. */
export async function observeOwnDaemonReachability(input: Readonly<{
  client: Pick<ApiMachineClient, 'callConnectedClientRpc' | 'isMachineControlRegistrationReady'>;
  signal?: AbortSignal;
}>): Promise<OwnDaemonReachabilityProof> {
  try {
    const reply = await input.client.callConnectedClientRpc(RPC_METHODS.CAPABILITIES_DESCRIBE, {}, { signal: input.signal, timeoutMs: null });
    const registered = input.client.isMachineControlRegistrationReady();
    const status = !registered || !reply.ok && isMachineRequestReachabilityFailureV1(createRpcCallError({
      error: reply.error ?? 'Daemon observation failed', errorCode: reply.errorCode,
    })) ? 'unavailable' : reply.ok ? 'ready' : 'unknown';
    return { status, ...(!reply.ok && reply.errorCode ? { errorCode: reply.errorCode } : {}) };
  } catch (error) {
    const errorCode = readRpcErrorCode(error);
    return { status: 'unknown', ...(errorCode ? { errorCode } : {}) };
  }
}
