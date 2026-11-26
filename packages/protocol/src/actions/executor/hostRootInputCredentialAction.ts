import type { ActionExecutorContext } from './types.js';
import { readRecord } from '../../inputs/inputRecords.js';
import { readDeploymentRoleRootInputV1 } from './deploymentRoleChild.js';
import { PROJECT_SETUP_SET_ACTION_ID_V1 } from '../projectActionIdsV1.js';
import { isProjectSetupSetChildInputV1 } from '../../projects/projectSetupSetV1.js';
import { isScmRefineInputPurposeV1, readScmRefineRootActionIdV1 } from './scmRefineInputPurpose.js';

/** Only an actual host child can spend the parent; possessing its carrier does not authorize direct sends. */
export function readHostRootInputCredentialActionV1(actionId: string, input: unknown,
  context: ActionExecutorContext, hostInternal: boolean): NonNullable<ReturnType<typeof readScmRefineRootActionIdV1>> | typeof PROJECT_SETUP_SET_ACTION_ID_V1
    | NonNullable<ReturnType<typeof readDeploymentRoleRootInputV1>>['actionId'] | null {
  if (hostInternal && context.projectSetupSetRootInput
    && context.externalActionExecutionAuthorization?.binding.actionId === PROJECT_SETUP_SET_ACTION_ID_V1
    && isProjectSetupSetChildInputV1(context.projectSetupSetRootInput, actionId, input,
      context.externalActionExecutionAuthorization.binding.serverIdentityId)) return PROJECT_SETUP_SET_ACTION_ID_V1;
  const deployment = readDeploymentRoleRootInputV1(context, actionId, input, hostInternal);
  if (deployment) return deployment.actionId;
  const authorization = context.externalActionExecutionAuthorization;
  const data = readRecord(input);
  return hostInternal && authorization && isScmRefineInputPurposeV1({ authorization, effectActionId: actionId,
    sessionId: data.sessionId, machineId: context.defaultSessionMachineId
      ?? (context.externalActionTarget?.kind === 'machine' ? context.externalActionTarget.machineId : undefined),
    localId: data.localId, requestedAction: data.requestedAction, recipient: data.recipient })
    ? readScmRefineRootActionIdV1(authorization.binding.actionId) ?? null : null;
}
