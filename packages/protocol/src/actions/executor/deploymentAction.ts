import type { DeploymentActionInputV1, DeploymentEnvironmentCreationReviewV1 } from '../../deployments/deploymentActionsV1.js';
import type { DeploymentTransportActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from './types.js';

/** Shared admitted deployment transport and domain-result owner, including file-export reads. */
export async function executeDeploymentAction(
  actionId: DeploymentTransportActionIdV1,
  input: DeploymentActionInputV1,
  context: ActionExecutorContext,
  deps: ActionExecutorDeps,
  review?: DeploymentEnvironmentCreationReviewV1,
): Promise<ActionExecuteResult> {
  if (!deps.deploymentAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
  const result = await deps.deploymentAction(actionId, input, context, review);
  if ('errorCode' in result) return result;
  if ('kind' in result) return { ok: true, result };
  if (!result.ok) return { ok: false, errorCode: result.error, error: result.error, details: result };
  return { ok: true, result };
}
