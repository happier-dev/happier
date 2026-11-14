import type { ExternalActionExecutionAuthorizationBindingV1, ReviewedActionChildHttpProofV1 } from '../../actions/externalActionApi.js';
import { DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1 } from '../../deployments/deploymentActionIdsV1.js';
import { RPC_METHODS } from '../../rpc/methods.js';

/** Existing public roots whose Session birth carries an Action-child creation proof. */
export function isSessionActionChildCreationRootV1(actionId: string): boolean {
  return actionId === 'discussion.second_opinion.start' || actionId === 'deployments.prepare';
}

/** Transport purpose only: signatures, reviewed operands and birth stay with their existing owners. */
export function readSessionActionChildCreationRpcEffectV1(method: string,
  binding: ExternalActionExecutionAuthorizationBindingV1 | undefined,
  selectedTarget?: Readonly<{ machineId: string; installationId: string }>,
  reviewedChild?: ReviewedActionChildHttpProofV1): 'session.spawn_new' | null {
  if (!binding || !isSessionActionChildCreationRootV1(binding.actionId)
    || method !== RPC_METHODS.SESSION_SPAWN_NEW && method !== RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return null;
  if (binding.actionId === 'discussion.second_opinion.start') return 'session.spawn_new';
  return binding.deploymentPreparationAdmission?.operation === 'prepare' && 'authentication' in binding
    && binding.target.kind === 'machine' && binding.target.machineId === binding.machineId
    && (!selectedTarget || selectedTarget.machineId === binding.machineId && selectedTarget.installationId === binding.installationId)
    && reviewedChild?.actionId === 'session.spawn_new' && reviewedChild.role === DEPLOYMENT_PREPARE_SESSION_CHILD_ROLE_V1
    ? 'session.spawn_new' : null;
}
