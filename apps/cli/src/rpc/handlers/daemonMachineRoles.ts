import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import type { MachineRolesRuntime } from '@/daemon/roles/machineRolesRuntime';
import { MachineRolesSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machineRoles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';

export type DaemonMachineRolesRoutes = Readonly<{
  roles: MachineRolesRuntime;
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
}>;

/** Machine core: role selection stays reachable whatever roles are active. */
export function registerDaemonMachineRolesRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineRolesRoutes): void {
  rpc.registerHandler(RPC_METHODS.MACHINES_ROLES_SET, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineRolesSetInputV1Schema.parse(raw);
    const target = options.target();
    const current = options.target();
    const admission = context?.machineAdmission;
    // Same authority as resources policy: Machine Manage (owner/administrator).
    if (!target || !current || current.serverId !== target.serverId || !admission || admission.role !== 'manage'
      || !doesMachineRpcTargetMatchAdmission(request, admission, current)) {
      throw new RpcError('Machine roles require Machine Manage access', RPC_ERROR_CODES.FORBIDDEN);
    }
    const { serverId: _serverId, machineId: _machineId, ...mutation } = request;
    return options.roles.set(mutation, { signal: context?.signal });
  });
}
