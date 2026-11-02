import { RpcError, RPC_ERROR_CODES, RPC_ERROR_MESSAGES } from '@happier-dev/protocol/rpcErrors';
import type { ActionOperationRpcContext } from './actionOperationRpcHandlers';
import type { ActionOperationScope, DeploymentTokenOperationOrigin } from './actionOperationTypes';

/** Read only the transport-verified root; public Action input never supplies token custody. */
export function readDeploymentTokenOperationOrigin(input: Readonly<{
  actionId: 'deployments.deploy' | 'action.operations.get';
  scope: ActionOperationScope;
  context?: ActionOperationRpcContext;
  /** Parsed deploy input must agree with its admitted root. */
  environmentId?: string;
}>): DeploymentTokenOperationOrigin | undefined {
  const binding = input.context?.callerInputAuthorization?.binding;
  if (!binding || !('credentialId' in binding)) return undefined;
  const targets = binding.grant.targets;
  const environments = targets?.environments;
  const environmentOnlyRead = input.actionId === 'action.operations.get'
    && targets !== null && targets.machines.length === 0
    && environments !== undefined && environments.length > 0;
  // Ordinary Machine-grant observations retain their existing authority. The
  // fixed CI grant has no Machine target and must use its Home-bound Env scope.
  if (input.actionId === 'action.operations.get' && !binding.environmentId && !environmentOnlyRead) return undefined;
  const machine = input.context?.machineAdmission;
  if (!machine || binding.actionId !== input.actionId || binding.accountId !== input.scope.accountId
    || binding.machineId !== input.scope.machineId || binding.installationId !== machine.installationId
    || binding.custodianAccountId !== machine.custodianAccountId
    || binding.target.kind !== 'machine' || binding.target.machineId !== input.scope.machineId
    || !binding.environmentId || targets !== null && !environments?.includes(binding.environmentId)
    || input.actionId === 'deployments.deploy' && binding.environmentId !== input.environmentId) {
    throw new RpcError(RPC_ERROR_MESSAGES.FORBIDDEN, RPC_ERROR_CODES.FORBIDDEN);
  }
  return { serverIdentityId: binding.serverIdentityId, credentialId: binding.credentialId,
    environmentId: binding.environmentId };
}
