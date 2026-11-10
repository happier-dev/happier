import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { createCliActionDeps, isControllerDeploymentMutationAction, type ControllerDeploymentMutationActionId } from './createCliActionDeps';

/** One placement decision shared by original CLI ingress and its executor. */
export function readControllerDeploymentDispatch(
  params: Pick<Parameters<typeof createCliActionDeps>[0], 'credentials' | 'deploymentAction' | 'deploymentTemplateInstantiate' | 'deploymentMoveToRepository'>
    & Readonly<{ machineId?: string }>,
  actionId: string, input: unknown, context: ActionExecutorContext,
): Readonly<{ actionId: ControllerDeploymentMutationActionId | 'deployments.templates.instantiate' | 'deployments.environments.moveToRepository'; caller: 'host' | 'workflow' }> | null {
  const semanticRoot = actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1;
  if (!semanticRoot && !isControllerDeploymentMutationAction(actionId)) return null;
  if ((actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 ? params.deploymentTemplateInstantiate
    : actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 ? params.deploymentMoveToRepository : params.deploymentAction)
    || context.externalActionExecutionAuthorization || context.externalActionCredential || context.rpcSessionAuthorization) return null;
  if (context.actionCaller?.kind === 'workflowRun'
    && context.executionRunWorkflowRunId === context.actionCaller.runId) return { actionId, caller: 'workflow' };
  if (params.credentials && (context.surface === undefined || context.surface === 'cli')
    && (!context.actionCaller || context.actionCaller.kind === 'host')
    && (semanticRoot || !params.machineId)
    && !context.externalActionTarget && !context.causalPermissionAuthority
    && !context.approvedActionReplay && !context.presentUserApproval
    && typeof input === 'object' && input !== null
    && (actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || !('contentArtifactId' in input))) return { actionId, caller: 'host' };
  return null;
}
