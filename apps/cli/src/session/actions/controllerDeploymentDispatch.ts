import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentEnvironmentCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { createCliActionDeps, isControllerDeploymentAction, type ControllerDeploymentActionId } from './createCliActionDeps';

/** Selects the installed deployment dispatch path for original Actions. */
export function readControllerDeploymentDispatch(
  params: Pick<Parameters<typeof createCliActionDeps>[0], 'credentials' | 'deploymentAction' | 'deploymentTemplateInstantiate' | 'deploymentMoveToRepository'>
    & Readonly<{ machineId?: string }>,
  actionId: string, input: unknown, context: ActionExecutorContext,
): Readonly<{ actionId: ControllerDeploymentActionId | 'deployments.templates.instantiate' | 'deployments.environments.moveToRepository' | 'deployments.environments.create'; caller: 'host' | 'workflow' }> | null {
  const authored = actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
    ? DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input) : null;
  const previewCreate = authored?.success === true && authored.data.preview !== undefined;
  const semanticRoot = actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || previewCreate;
  const dispatchActionId = actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
    || (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && previewCreate)
    || isControllerDeploymentAction(actionId, input) ? actionId : null;
  if (!dispatchActionId) return null;
  if ((actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 ? params.deploymentTemplateInstantiate
    : actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 ? params.deploymentMoveToRepository : params.deploymentAction)
    || context.externalActionExecutionAuthorization || context.externalActionCredential || context.rpcSessionAuthorization) return null;
  if (context.actionCaller?.kind === 'workflowRun'
    && context.executionRunWorkflowRunId === context.actionCaller.runId) return { actionId: dispatchActionId, caller: 'workflow' };
  if (params.credentials && (context.surface === undefined || context.surface === 'cli')
    && (!context.actionCaller || context.actionCaller.kind === 'host')
    && (semanticRoot || !params.machineId)
    && (!context.externalActionTarget || previewCreate) && !context.causalPermissionAuthority
    && !context.approvedActionReplay && !context.presentUserApproval
    && typeof input === 'object' && input !== null
    && (actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || !('contentArtifactId' in input))) return { actionId: dispatchActionId, caller: 'host' };
  return null;
}
