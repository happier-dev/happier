import type { ActionExecutorContext, ActionExecutorDeps, ActionExecuteFailure } from '../actions/executor/types.js';
import type { ActionEnvironmentApprovalScopeAdmissionV1 } from '../actions/actionApprovalPolicy.js';
import { readActionFailureEnvelope } from '../actions/executor/actionFailureEnvelope.js';
import { artifactSavedByFromActionContextV1 } from '../artifacts/artifactBinaryV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { isDatabaseActionIdV1 } from '../actions/actionIdsDatabaseV1.js';
import { DatabaseTargetV1Schema } from '../databases/databaseTargetIdentityV1.js';
import { z } from '../zodRuntimePolicy.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentActionFailureV1Schema } from './deploymentActionsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentEnvironmentGetResultV1Schema, DeploymentReceiptGetResultV1Schema,
  type DeploymentActionFailureV1 } from './deploymentActionsV1.js';

export const DeploymentApprovalEnvironmentInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: DeploymentIdentifierV1Schema, environmentId: DeploymentIdentifierV1Schema,
  projection: z.literal('approvalScope'),
}));
export const DeploymentApprovalEnvironmentResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ok: z.literal(true), environment: z.strictObject({
    id: DeploymentIdentifierV1Schema, projectSourceId: DeploymentIdentifierV1Schema,
    purpose: z.enum(['standard', 'preview']), previewTemplateEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
    previewCompanionOfEnvironmentId: z.optional(DeploymentIdentifierV1Schema),
  }) }), DeploymentActionFailureV1Schema,
]));
export type DeploymentApprovalEnvironmentResultV1 = z.infer<typeof DeploymentApprovalEnvironmentResultV1Schema>;
type ApprovalMetadataRead = (input: Readonly<{ serverId: string; environmentId: string; context: ActionExecutorContext }>) =>
  Promise<DeploymentApprovalEnvironmentResultV1 | ActionExecuteFailure>;

/** Shared by execution and policy presenters after the Environment owner admits its header. */
export function readDeploymentEnvironmentApprovalScopeV1(environment: Readonly<{
  id: string; purpose: 'standard' | 'preview'; previewTemplateEnvironmentId?: string;
  previewCompanionOfEnvironmentId?: string;
}>): ActionEnvironmentApprovalScopeAdmissionV1 | ActionExecuteFailure {
  const inheritsTemplate = environment.purpose === 'preview' || Boolean(environment.previewCompanionOfEnvironmentId);
  if (inheritsTemplate && !environment.previewTemplateEnvironmentId) return failure('deployment_unavailable');
  return { scope: { kind: 'environment', environmentId: environment.id,
    ...(inheritsTemplate ? { inheritedEnvironmentId: environment.previewTemplateEnvironmentId } : {}) } };
}

type EnvironmentApprovalRead = Readonly<{
  serverId: string; environmentId: string; context: ActionExecutorContext;
  read: NonNullable<ActionExecutorDeps['deploymentAction']>;
}>;

type FullApprovalReadResult = Readonly<{ ok: true;
  environment: Extract<z.infer<typeof DeploymentEnvironmentGetResultV1Schema>, { ok: true }>['environment'];
}> | ActionExecuteFailure;
function readApprovalEnvironment(input: EnvironmentApprovalRead): Promise<FullApprovalReadResult>;
function readApprovalEnvironment(input: EnvironmentApprovalRead & Readonly<{ readMetadata?: ApprovalMetadataRead }>):
  Promise<Extract<DeploymentApprovalEnvironmentResultV1, { ok: true }> | ActionExecuteFailure>;
async function readApprovalEnvironment(input: EnvironmentApprovalRead & Readonly<{ readMetadata?: ApprovalMetadataRead }>) {
  const loaded = input.readMetadata ? await input.readMetadata(input)
    : await input.read('deployments.environments.get', { serverId: input.serverId, environmentId: input.environmentId }, input.context);
  const transportFailure = readActionFailureEnvelope(loaded);
  if (transportFailure) return transportFailure;
  const current = (input.readMetadata ? DeploymentApprovalEnvironmentResultV1Schema : DeploymentEnvironmentGetResultV1Schema).safeParse(loaded);
  if (!current.success) return failure('invalid_action_output');
  if (!current.data.ok) return failure(current.data.error, current.data);
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
  readMetadata?: ApprovalMetadataRead,
): NonNullable<ActionExecutorDeps['resolveEnvironmentApprovalScope']> {
  return async ({ actionId, input, context }): Promise<ActionEnvironmentApprovalScopeAdmissionV1 | ActionExecuteFailure> => {
    if (isDatabaseActionIdV1(actionId)) return resolveDatabaseTargetApprovalScope(read, readRecord(input).target, context);
    const target = readRecord(input);
    const serverId = actionId === 'deployments.prepare' ? context.serverId : target.serverId;
    if (typeof serverId !== 'string') return failure('invalid_parameters');
    let environmentId = typeof target.environmentId === 'string' ? target.environmentId : undefined;
    if (actionId === 'deployments.environments.create') {
      const preview = readRecord(target.preview);
      environmentId = typeof preview.templateEnvironmentId === 'string' ? preview.templateEnvironmentId : undefined;
    }
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
      const loaded = await read('deployments.receipts.get', { serverId, deploymentId: target.deploymentId,
        ...(environmentId === undefined ? {} : { environmentId }) }, context);
      const transportFailure = readActionFailureEnvelope(loaded);
      if (transportFailure) return transportFailure;
      const receipt = DeploymentReceiptGetResultV1Schema.safeParse(loaded);
      if (!receipt.success) return failure('invalid_action_output');
      if (!receipt.data.ok) return failure(receipt.data.error, receipt.data);
      if (receipt.data.deployment.id !== target.deploymentId
        || environmentId && receipt.data.deployment.environmentId !== environmentId) return failure('deployment_unavailable');
      environmentId = receipt.data.deployment.environmentId;
    }
    if (!environmentId) return failure('invalid_parameters');
    const current = await readApprovalEnvironment({ read, readMetadata, serverId, environmentId, context });
    if (!current.ok) return current;
    const environment = current.environment;
    if ((actionId === 'deployments.prepare' || actionId === 'deployments.templates.instantiate'
      || actionId === 'deployments.environments.create')
      && environment.projectSourceId !== target.projectSourceId) return failure('deployment_access_denied');
    return readDeploymentEnvironmentApprovalScopeV1(environment);
  };
}

/** A database Action names its Environment inside its target; Machine-local databases have no Environment scope. */
async function resolveDatabaseTargetApprovalScope(read: NonNullable<ActionExecutorDeps['deploymentAction']>, operand: unknown,
  context: ActionExecutorContext): Promise<ActionEnvironmentApprovalScopeAdmissionV1 | ActionExecuteFailure> {
  const target = DatabaseTargetV1Schema.safeParse(operand);
  if (!target.success) return failure('invalid_parameters');
  if (target.data.kind !== 'deployment_service' && target.data.kind !== 'managed_deployment') return { scope: null };
  const { serverId, environmentId, projectSourceId } = target.data.environment;
  const current = await readApprovalEnvironment({ read, serverId, environmentId, context });
  if (!current.ok) return current;
  if (current.environment.projectSourceId !== projectSourceId) return failure('deployment_access_denied');
  const admitted = readDeploymentEnvironmentApprovalScopeV1(current.environment);
  return 'ok' in admitted ? admitted
    : { ...admitted, targetApproval: { databaseAgentLevel: current.environment.dataAgentAccess } };
}

function failure(errorCode: string, refusal?: DeploymentActionFailureV1): ActionExecuteFailure {
  return { ok: false, errorCode, error: errorCode,
    ...(refusal?.error === 'deployment_invalid' && refusal.diagnostic ? { details: refusal } : {}) };
}
