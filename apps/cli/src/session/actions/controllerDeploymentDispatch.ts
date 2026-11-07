import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createCliActionDeps, isControllerDeploymentMutationAction, type ControllerDeploymentMutationActionId } from './createCliActionDeps';

/** One placement decision shared by original CLI ingress and its executor. */
export function readControllerDeploymentDispatch(
  params: Pick<Parameters<typeof createCliActionDeps>[0], 'credentials' | 'deploymentAction' | 'deploymentTemplateInstantiate'>
    & Readonly<{ machineId?: string }>,
  actionId: string, input: unknown, context: ActionExecutorContext,
): Readonly<{ actionId: ControllerDeploymentMutationActionId | 'deployments.templates.instantiate'; caller: 'host' | 'workflow' }> | null {
  if (actionId !== DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 && !isControllerDeploymentMutationAction(actionId)) return null;
  if ((actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 ? params.deploymentTemplateInstantiate : params.deploymentAction)
    || context.externalActionExecutionAuthorization || context.externalActionCredential || context.rpcSessionAuthorization) return null;
  if (context.actionCaller?.kind === 'workflowRun'
    && context.executionRunWorkflowRunId === context.actionCaller.runId) return { actionId, caller: 'workflow' };
  if (params.credentials && (context.surface === undefined || context.surface === 'cli')
    && (!context.actionCaller || context.actionCaller.kind === 'host')
    && (actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || !params.machineId)
    && !context.externalActionTarget && !context.causalPermissionAuthority
    && !context.approvedActionReplay && !context.presentUserApproval
    && typeof input === 'object' && input !== null && !('contentArtifactId' in input)) return { actionId, caller: 'host' };
  return null;
}
