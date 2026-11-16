import type { RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';
import { MachineIsolationSetInputV1Schema } from '@happier-dev/protocol/actions/specs/machineIsolation';
import { mutateMachineIsolationV1,
  type MachineIsolationReferenceValidationV1 } from '@happier-dev/protocol/machines/machineIsolationPolicyV1';
import type { MachineIsolationPolicyV1 } from '@happier-dev/protocol/machines/machineIsolationV1';
import type { MachineMetadataFieldPortV1 } from '@happier-dev/protocol/machines/machineMetadataFieldV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES, RpcError } from '@happier-dev/protocol/rpcErrors';
import { doesMachineRpcTargetMatchAdmission } from '@/api/machine/machineRpcAuthorization';

export type DaemonMachineIsolationRoutes = Readonly<{
  target: () => Readonly<{ serverId: string; machineId: string; installationId: string; custodianAccountId: string }> | null;
}>;
export type DaemonMachineIsolationHandlerDependencies = DaemonMachineIsolationRoutes & Readonly<{
  captureMetadataPort: () => MachineMetadataFieldPortV1;
  validateConfiguredSandboxes: (entries: MachineIsolationPolicyV1['configuredSandboxes'], context: RpcHandlerContext) => Promise<MachineIsolationReferenceValidationV1>;
}>;

/** Machine core: policy remains writable while the Sessions role is disabled. */
export function registerDaemonMachineIsolationRpcHandlers(rpc: RpcHandlerRegistrar, options: DaemonMachineIsolationHandlerDependencies): void {
  rpc.registerHandler(RPC_METHODS.MACHINES_ISOLATION_SET, async (raw: unknown, context?: RpcHandlerContext) => {
    const request = MachineIsolationSetInputV1Schema.parse(raw);
    const target = options.target();
    const admission = context?.machineAdmission;
    if (!target || !context || !admission || admission.role !== 'manage'
      || !doesMachineRpcTargetMatchAdmission(request, admission, target)) {
      throw new RpcError('Machine isolation requires Machine Manage access', RPC_ERROR_CODES.FORBIDDEN);
    }
    const { serverId: _serverId, machineId: _machineId, ...mutation } = request;
    return mutateMachineIsolationV1(mutation, options.captureMetadataPort(), {
      signal: context.signal, validateConfiguredSandboxes: entry => options.validateConfiguredSandboxes(entry, context),
    });
  });
}
