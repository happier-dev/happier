import { DeploymentEnvironmentListResultV1Schema, projectDeploymentTargetLinkFailureV1, type DeploymentActionInputV1, type DeploymentActionOutputV1, type DeploymentEnvironmentCreationReviewV1, type DeploymentReceiptHeaderV1 } from '../../deployments/deploymentActionsV1.js';
import { readDeploymentArtifactHeaderV1 } from '../../deployments/deploymentArtifactContentReferenceV1.js';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1 } from '../../artifacts/deploymentArtifactKindsV1.js';
import { DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1, DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1, type DeploymentTransportActionIdV1 } from '../../deployments/deploymentActionIdsV1.js';
import { projectDeploymentFailureRecoveryV1 } from '../../deployments/deploymentFailureRecoveryV1.js';
import { readDeploymentReceiptFailureCodeV1 } from '../../deployments/deploymentReceiptResultV1.js';
import type { ActionExecuteResult, ActionExecutorContext, ActionExecutorDeps } from './types.js';
import { readActionFailureEnvelope } from './actionFailureEnvelope.js';

/** Shared admitted deployment transport and domain-result owner, including file-export reads. */
export async function executeDeploymentAction(
  actionId: DeploymentTransportActionIdV1,
  input: DeploymentActionInputV1,
  context: ActionExecutorContext,
  deps: ActionExecutorDeps,
  review?: DeploymentEnvironmentCreationReviewV1,
  options?: Readonly<{
    environmentListProjection?: 'metadata';
    retireRemovedEnvironmentApprovals?: (environmentId: string) => Promise<void>;
  }>,
): Promise<ActionExecuteResult> {
  if (!deps.deploymentAction) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
  const result = await deps.deploymentAction(actionId, input, context, review);
  const failure = readActionFailureEnvelope(result);
  if (failure) return failure;
  const linkFailure = projectDeploymentTargetLinkFailureV1(actionId, result);
  if (linkFailure) return linkFailure;
  if ('kind' in result) return { ok: true, result };
  if (!result.ok) return { ok: false, errorCode: result.error, error: result.error, details: result,
    ...('effectAttempted' in result && result.effectAttempted === false ? { effectAttempted: false } : {}) };
  if (actionId === 'deployments.environments.delete'
    || (actionId === 'deployments.teardown' && 'environmentRemoved' in result && result.environmentRemoved === true)) {
    if ('environmentId' in input && input.environmentId) await options?.retireRemovedEnvironmentApprovals?.(input.environmentId);
  }
  if (actionId === DEPLOYMENT_RECEIPT_LIST_ACTION_ID_V1 && 'items' in result) {
    // The Action's transport validates the page; the aggregate result union loses that correlation.
    const page = result as Extract<DeploymentActionOutputV1, { ok: true; items: DeploymentReceiptHeaderV1[] }>;
    const items = page.items.map(receipt => {
      const code = readDeploymentReceiptFailureCodeV1(receipt.state);
      return code ? projectDeploymentFailureRecoveryV1(receipt, code) : receipt;
    });
    return { ok: true, result: { ...page, items } };
  }
  if (actionId === DEPLOYMENT_ENVIRONMENT_LIST_ACTION_ID_V1 && options?.environmentListProjection !== 'metadata'
    && deps.deploymentReadArtifactHeaders) {
    const page = DeploymentEnvironmentListResultV1Schema.parse(result);
    if (!page.ok) return { ok: false, errorCode: page.error, error: page.error };
    const headers = await deps.deploymentReadArtifactHeaders(page.items.map(row => row.contentArtifactId), context);
    let coverage = page.coverage;
    const items = page.items.map((row, index) => {
      const read = headers[index];
      const label = readDeploymentArtifactHeaderV1(row, read?.status === 'fulfilled' ? read.value : null,
        DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1);
      const { name: _name, ...environment } = row;
      if (label.ok) return { ...environment, name: label.title };
      coverage = 'partial';
      return environment;
    });
    return { ok: true, result: { ...page, items, ...(coverage ? { coverage } : {}) } };
  }
  return { ok: true, result };
}
