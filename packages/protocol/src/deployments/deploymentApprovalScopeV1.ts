import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure } from '../actions/executor/types.js';
import { artifactSavedByFromActionContextV1 } from '../artifacts/artifactBinaryV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema } from './deploymentActionsV1.js';

type EnvironmentApprovalRead = Readonly<{
  serverId: string; environmentId: string; context: ActionExecutorContext;
  read: NonNullable<ActionExecutorDeps['deploymentAction']>;
}>;

async function readApprovalEnvironment(input: EnvironmentApprovalRead) {
  const loaded = await input.read('deployments.environments.get', { serverId: input.serverId, environmentId: input.environmentId }, input.context);
  if ('errorCode' in loaded) return loaded;
  const current = DeploymentEnvironmentGetResultV1Schema.safeParse(loaded);
  if (!current.success) return failure('invalid_action_output');
  if (!current.data.ok) return failure(current.data.error);
  if (input.context.signal?.aborted) return failure('cancelled');
  if (current.data.environment.id !== input.environmentId) return failure('deployment_unavailable');
  return { ok: true as const, environment: current.data.environment };
}

/** Initial authoring choice only; saved consent and its readers never call this. */
export async function resolveInitialDeploymentApprovalV1(input: Omit<EnvironmentApprovalRead, 'read'> & Readonly<{
  mode?: 'automatic' | 'ask';
  read?: EnvironmentApprovalRead['read'];
}>): Promise<Readonly<{ ok: true; mode: 'automatic' | 'ask' }> | ActionExecuteFailure> {
  if (input.mode !== undefined) return { ok: true, mode: input.mode };
  if (artifactSavedByFromActionContextV1(input.context)?.kind !== 'person') return { ok: true, mode: 'ask' };
  if (!input.read) return failure('target_unavailable');
  const current = await readApprovalEnvironment({ ...input, read: input.read });
  return current.ok ? { ok: true, mode: current.environment.protection === 'production' ? 'ask' : 'automatic' } : current;
}

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
    const current = await readApprovalEnvironment({ read, serverId, environmentId, context });
    if (!current.ok) return current;
    const environment = current.environment;
    if ((actionId === 'deployments.prepare' || actionId === 'deployments.templates.instantiate')
      && environment.projectSourceId !== target.projectSourceId) return failure('deployment_access_denied');
    // The metadata owner admits the non-content child/template relation.
    // All previews spend the template's live preference, never a copied waiver.
    if (environment.purpose === 'preview') {
      if (!environment.previewTemplateEnvironmentId) return failure('deployment_unavailable');
      return { scope: { kind: 'environment', environmentId: environment.previewTemplateEnvironmentId } };
    }
    return { scope: { kind: 'environment', environmentId: environment.id } };
  };
}

function failure(errorCode: string): ActionExecuteFailure {
  return { ok: false, errorCode, error: errorCode };
}
