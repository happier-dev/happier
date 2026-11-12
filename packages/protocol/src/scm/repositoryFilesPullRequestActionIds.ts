import type { DeploymentMoveToRepositoryInputV1 } from '../deployments/deploymentMoveToRepositoryV1.js';
import { DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 } from '../deployments/deploymentActionIdsV1.js';

export const DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1 = 'move.definition';
/**
 * Move's only reviewed child. Its repository effects run on the placed Machine
 * inside the admitted checkout, never as reviewed children.
 */
export type DeploymentMoveToRepositoryChildActionIdV1 = typeof DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1;

/** Move's reviewed switch uses the incumbent Environment writer after its merge reads. */
export function deploymentMoveToRepositoryChildRoleV1(actionId: DeploymentMoveToRepositoryChildActionIdV1): string;
export function deploymentMoveToRepositoryChildRoleV1(actionId: string): string | undefined;
export function deploymentMoveToRepositoryChildRoleV1(actionId: string): string | undefined {
  return actionId === DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1 ? DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1 : undefined;
}

/** Preparation declares the Environment switch only when the selected branch can reach it. */
export function deploymentMoveToRepositoryReviewedChildrenV1(
  input: DeploymentMoveToRepositoryInputV1,
): Readonly<{ children: readonly Readonly<{ action: DeploymentMoveToRepositoryChildActionIdV1; role: string;
  scopeInput?: Readonly<{ serverId: string; environmentId: string }> }>[] }> {
  return { children: (input.continuation || input.pullRequestReference) && input.mode === 'apply'
    ? [{ action: DEPLOYMENT_ENVIRONMENT_UPDATE_ACTION_ID_V1, role: DEPLOYMENT_MOVE_DEFINITION_CHILD_ROLE_V1,
      scopeInput: { serverId: input.serverId, environmentId: input.environmentId } }] : [] };
}
