import { registerMachineSessionRpcHandlers, type MachineSessionRpcFamily } from '@/api/machine/rpcHandlers.sessions';
import type { SessionSpawnDirectTargetTransport } from '@/session/actions/createCliActionDeps';

import type { MachineRoleRpcRegistrar, MachineRoleStopReason } from '../types';

/** The new-Session family inputs, composed by the Machine client's RPC registration. */
export type SessionsRoleContext = Readonly<{ family: MachineSessionRpcFamily }>;

export type SessionsRoleActivation = Readonly<{
  /** Exact-daemon Session spawn transport shared with host Action ingress (absent without server start). */
  sessionSpawnDirectTargetTransport?: SessionSpawnDirectTargetTransport;
  stop: (reason?: MachineRoleStopReason) => Promise<void>;
}>;

/**
 * `sessions` role, Machine RPC part: starting new Sessions on this Machine. While the role is
 * inactive these methods are never registered, so the dispatcher answers `machine_role_inactive`.
 * Stop and running-Session control stay in machine core, so running Sessions can finish.
 */
export async function activateSessionsRole(
  ctx: SessionsRoleContext,
  registerRpc: MachineRoleRpcRegistrar,
): Promise<SessionsRoleActivation> {
  const registration = registerRpc(rpcHandlerManager => registerMachineSessionRpcHandlers({ rpcHandlerManager, ...ctx.family }));
  return {
    ...registration,
    // The family holds no runtime of its own; the activation owner withdraws the handlers.
    stop: async () => {},
  };
}
