import type { ActionExecutorContext } from '@happier-dev/protocol';
import { DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1, isDeploymentReadActionIdV1, isDeploymentTransportActionIdV1, type DeploymentTransportActionIdV1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentEnvironmentCreateIntentInputV1Schema } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { isDeploymentEnvironmentPlacementActionV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { MACHINE_SETUP_APPLY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { createCliActionDeps } from './createCliActionDeps';

/** The coordinator carries the accepted parent, while the receiver carries its own exact child proof. */
export function readControllerDeploymentWorkflowCaller(actionId: string, context: ActionExecutorContext) {
  const caller = context.actionCaller;
  if (caller?.kind !== 'workflowRun' || context.executionRunWorkflowRunId !== caller.runId
    || context.externalActionCredential || context.rpcSessionAuthorization) return null;
  const carried = context.externalActionExecutionAuthorization;
  return !carried || actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
    && carried === caller.authorization.externalActionExecutionAuthorization
    && carried.binding.actionId === MACHINE_SETUP_APPLY_ACTION_ID_V1 ? caller : null;
}

/** Selects the installed deployment dispatch path for original Actions. */
export function readControllerDeploymentDispatch(
  params: Pick<Parameters<typeof createCliActionDeps>[0], 'credentials' | 'deploymentAction' | 'deploymentTemplateInstantiate' | 'deploymentMoveToRepository'>
    & Readonly<{ machineId?: string }>,
  actionId: string, input: unknown, context: ActionExecutorContext,
): Readonly<{ actionId: DeploymentTransportActionIdV1 | typeof DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 | typeof DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1; caller: 'host' | 'workflow' }> | null {
  const authored = actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1
    ? DeploymentEnvironmentCreateIntentInputV1Schema.safeParse(input) : null;
  const previewCreate = authored?.success === true && authored.data.preview !== undefined;
  const semanticRoot = actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || previewCreate;
  const dispatchActionId = actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1
    || actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1
    || (actionId === DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 && previewCreate)
    || isDeploymentTransportActionIdV1(actionId) && !isDeploymentReadActionIdV1(actionId)
      && isDeploymentEnvironmentPlacementActionV1(actionId, input,
        resolveActionExecutionPlacementForInput(getActionSpec(actionId), input, context.actionCaller, context.surface ?? 'cli'),
        { canPrepareAccountBindings: true })
    ? actionId : null;
  if (!dispatchActionId) return null;
  if ((actionId === DEPLOYMENT_TEMPLATE_INSTANTIATE_ACTION_ID_V1 ? params.deploymentTemplateInstantiate
    : actionId === DEPLOYMENT_ENVIRONMENT_MOVE_TO_REPOSITORY_ACTION_ID_V1 ? params.deploymentMoveToRepository : params.deploymentAction)) return null;
  if (readControllerDeploymentWorkflowCaller(actionId, context)) return { actionId: dispatchActionId, caller: 'workflow' };
  if (context.externalActionExecutionAuthorization || context.externalActionCredential || context.rpcSessionAuthorization) return null;
  if (params.credentials && (context.surface === undefined || context.surface === 'cli')
    && (!context.actionCaller || context.actionCaller.kind === 'host')
    && (semanticRoot || !params.machineId)
    && (!context.externalActionTarget || previewCreate) && !context.causalPermissionAuthority
    && !context.approvedActionReplay && !context.presentUserApproval
    && typeof input === 'object' && input !== null
    && (actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 || !('contentArtifactId' in input))) return { actionId: dispatchActionId, caller: 'host' };
  return null;
}
