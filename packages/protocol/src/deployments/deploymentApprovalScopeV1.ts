import type { ActionExecutorDeps, ActionExecuteFailure } from '../actions/executor/types.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema } from './deploymentActionsV1.js';

/** The same exact admitted metadata read serves CLI, daemon and UI policy preparation. */
export function createDeploymentApprovalScopeResolverV1(
  read: NonNullable<ActionExecutorDeps['deploymentAction']>,
): NonNullable<ActionExecutorDeps['resolveEnvironmentApprovalScope']> {
  return async ({ actionId, input, context }) => {
    const target = readRecord(input);
    const serverId = actionId === 'deployments.prepare' ? context.serverId : target.serverId;
    if (typeof serverId !== 'string') return failure('invalid_parameters');
    let environmentId = typeof target.environmentId === 'string' ? target.environmentId : undefined;
    if (actionId === 'deployments.templates.instantiate') {
      const environment = readRecord(target.environment);
      if (environment.kind === 'create') return { scope: null };
      environmentId = typeof environment.environmentId === 'string' ? environment.environmentId : undefined;
    }
    if (actionId === 'deployments.prepare' && !environmentId) {
      const deploymentTarget = readRecord(target.target);
      environmentId = typeof deploymentTarget.environmentId === 'string' ? deploymentTarget.environmentId : undefined;
    }
    if (actionId === 'deployments.prepare' && !environmentId) return { scope: null };
    if (actionId === 'deployments.receipts.get' || !environmentId && typeof target.deploymentId === 'string') {
      if (typeof target.deploymentId !== 'string') return failure('invalid_parameters');
      const loaded = await read('deployments.receipts.get', { serverId, deploymentId: target.deploymentId }, context);
      if ('errorCode' in loaded) return loaded;
      const receipt = DeploymentReceiptGetResultV1Schema.safeParse(loaded);
      if (!receipt.success) return failure('invalid_action_output');
      if (!receipt.data.ok) return failure(receipt.data.error);
      if (receipt.data.deployment.id !== target.deploymentId
        || environmentId && receipt.data.deployment.environmentId !== environmentId) return failure('deployment_unavailable');
      environmentId = receipt.data.deployment.environmentId;
    }
    if (!environmentId) return failure('invalid_parameters');
    const loaded = await read('deployments.environments.get', { serverId, environmentId }, context);
    if ('errorCode' in loaded) return loaded;
    const current = DeploymentEnvironmentGetResultV1Schema.safeParse(loaded);
    if (!current.success) return failure('invalid_action_output');
    if (!current.data.ok) return failure(current.data.error);
    if (context.signal?.aborted) return failure('cancelled');
    const environment = current.data.environment;
    if (environment.id !== environmentId) return failure('deployment_unavailable');
    if ((actionId === 'deployments.prepare' || actionId === 'deployments.templates.instantiate')
      && environment.projectSourceId !== target.projectSourceId) return failure('deployment_access_denied');
    // The storage owner admits retained history and refuses effects on tombstones.
    // P44 must prove the current child/template Source/provenance and exact head.
    // Its absent relation producer cannot silently turn a preview into an ordinary scope.
    if (environment.purpose === 'preview') return failure('deployment_unavailable');
    return { scope: { kind: 'environment', environmentId: environment.id } };
  };
}

function failure(errorCode: string): ActionExecuteFailure {
  return { ok: false, errorCode, error: errorCode };
}
