import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentHealthReadInputV1Schema, DeploymentHealthCurrentInputV1Schema,
  DeploymentDriftReadInputV1Schema, DeploymentLogsReadInputV1Schema, DeploymentStageLogsReadInputV1Schema } from './deploymentReadsV1.js';

import { DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1,
  DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, isDeploymentReadAdmissionActionIdV1 } from './deploymentActionIdsV1.js';
import { ProjectReadinessReadInputV1Schema } from '../projects/readinessInputV1.js';
import { PROJECT_READINESS_ACTION_IDS_V1 } from '../actions/projectReadinessActionIdsV1.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from '../actions/actionIds.js';
import { readDeploymentReviewedChildV1 } from '../actions/specs/deploymentPreparationScope.js';
import type { DeploymentReviewedChildPlanEntryV1 } from '../actions/externalActionApi.js';
import { DeploymentDataSizeInputV1Schema } from './deploymentReadsV1.js';
import { ActionInvokeInputSchema } from '../actions/actionInvokeInput.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { DatabaseDeploymentServiceTargetV1Schema, DatabaseManagedDeploymentTargetV1Schema, DatabaseTargetV1Schema } from '../databases/databaseTargetIdentityV1.js';
import { DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1, DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1, DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1, DATABASE_TARGETS_LIST_ACTION_ID_V1,
  isDatabaseActionIdV1, telemetryCollectorActionSourceV1 } from '../actions/actionIdsDatabaseV1.js';
import { DeploymentEnvironmentRefV1Schema } from './deploymentEnvironmentRefV1.js';
import { databaseActionOperationClass } from '../actions/databaseActionMetadata.js';
import { formatQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { DatabaseAgentLevelV1Schema } from './deploymentEnvironmentDeployerV1.js';
import { readRecord } from '../inputs/inputRecords.js';
import { DeploymentTelemetryCapabilitiesV1Schema } from './deploymentTelemetryV1.js';
export { isDeploymentReadActionIdV1, isDeploymentNativeReadActionIdV1, isDeploymentReadAdmissionActionIdV1 } from './deploymentActionIdsV1.js';

const references = { environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id };
const deploymentDatabaseTarget = z.union([DatabaseDeploymentServiceTargetV1Schema, DatabaseManagedDeploymentTargetV1Schema]);

const telemetryCollector = z.strictObject({ serverId: id, environmentIds: z.array(id).check(z.minLength(1)) });
const telemetryEnvironment = z.object({ serverId: id, environmentId: id });
const telemetryEnvironmentSource = z.extend(telemetryEnvironment, { kind: z.literal('environment') });

/** The same selected Environment operand drives collector placement and Clear approval scope. */
export function readDeploymentTelemetryEnvironmentSourceV1(input: unknown) {
  return telemetryEnvironmentSource.safeParse(readRecord(input).source);
}

/** Home's accepted metadata for the sealed collector Action. No Environment content crosses this carrier. */
export const DeploymentTelemetryReadFactsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  environmentId: id, revision, capabilities: DeploymentTelemetryCapabilitiesV1Schema,
  /** Only capture.status receives the assignment marker. The digest stays with the assignment owner. */
  assignmentStamped: z.optional(z.boolean()),
  clearApproval: z.optional(z.strictObject({
    purpose: z.enum(['standard', 'preview']), previewTemplateEnvironmentId: z.optional(id),
    previewCompanionOfEnvironmentId: z.optional(id), dataAgentAccess: DatabaseAgentLevelV1Schema,
  })),
})).check(z.minLength(1)));

/** Structural credential scope only; SQL, search inputs and parameters remain sealed. */
export const DeploymentReadAdmissionV1Schema = lazyZodSchema(() => z.union([z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal(PROJECT_READINESS_ACTION_IDS_V1[0]), projectId: id, machineId: id,
    environments: z.array(z.strictObject({ environmentId: id, expectedRevision: revision })) }),
  z.strictObject({ actionId: z.literal('deployments.health.current'), environmentId: id, targetLinkId: id, machineId: id }),
  z.strictObject({ actionId: z.literal('deployments.health.read'), ...references }),
  z.strictObject({ actionId: z.literal('deployments.drift.read'), ...references, expectedRevision: revision }),
  z.extend(z.omit(DeploymentStageLogsReadInputV1Schema, { serverId: true, ref: true, tail: true, cursor: true, kind: true }),
    { actionId: z.literal('deployments.logs.read'), kind: z.enum(['build', 'runtime']) }),
  z.extend(z.omit(DeploymentDataSizeInputV1Schema, { serverId: true, previous: true }),
    { actionId: z.literal(DEPLOYMENT_DATA_SIZE_ACTION_ID_V1) }),
]), z.strictObject({ actionId: z.literal(ACTION_INVOKE_ACTION_ID_V1), action: asProtocolZod(PluginContributionIdentityV1Schema).check(
    z.refine(action => isDatabaseActionIdV1(formatQualifiedPluginActionId(action)))),
  environmentId: id, targetLinkId: id, databaseTarget: deploymentDatabaseTarget, access: z.enum(['read', 'write']),
  databaseReadAccessMode: z.optional(z.enum(['preview', 'apply'])) }).check(z.refine(scope => {
    const qualifiedId = formatQualifiedPluginActionId(scope.action);
    if (qualifiedId === DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1) {
      return scope.databaseTarget.kind === 'managed_deployment' && scope.access === 'write' && scope.databaseReadAccessMode !== undefined;
    }
    return scope.databaseReadAccessMode === undefined && (qualifiedId !== DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1
      || scope.databaseTarget.kind === 'managed_deployment' && scope.access === 'write');
  })),
  z.strictObject({ actionId: z.literal(ACTION_INVOKE_ACTION_ID_V1), action: asProtocolZod(PluginContributionIdentityV1Schema).check(
    z.refine(action => telemetryCollectorActionSourceV1(formatQualifiedPluginActionId(action)) !== undefined)),
    telemetryCollector }),
  // The Environment database listing (mounted Data page) reads one Environment before any target is chosen.
  z.strictObject({ actionId: z.literal(ACTION_INVOKE_ACTION_ID_V1), action: asProtocolZod(PluginContributionIdentityV1Schema).check(
    z.refine(action => formatQualifiedPluginActionId(action) === DATABASE_TARGETS_LIST_ACTION_ID_V1)),
    environmentId: id, databaseEnvironment: DeploymentEnvironmentRefV1Schema }).check(z.refine(scope =>
    scope.databaseEnvironment.environmentId === scope.environmentId))]));

export type DeploymentReadAdmissionV1 = z.infer<typeof DeploymentReadAdmissionV1Schema>;

export type DeploymentTelemetryReadAdmissionV1 = Extract<DeploymentReadAdmissionV1, { telemetryCollector: unknown }>;

/**
 * One decision for Machine Use: an admission that reads or writes an Environment's database
 * (a database Action on `databaseTarget`, the Environment listing, or a service size read). Home
 * admits the person through the Environment owner, so the Machine carries it with Use.
 */
export function isEnvironmentDatabaseAdmissionV1(admission: DeploymentReadAdmissionV1 | undefined): boolean {
  return admission !== undefined && ('databaseTarget' in admission || 'databaseEnvironment' in admission
    || admission.actionId === DEPLOYMENT_DATA_SIZE_ACTION_ID_V1);
}

/** The Home an admitted read names, which the receiving daemon matches to its own Home identity. */
export function readDeploymentReadAdmissionHomeIdV1(admission: DeploymentReadAdmissionV1, input: unknown): string | null {
  if ('databaseTarget' in admission) return admission.databaseTarget.environment.serverId;
  if ('databaseEnvironment' in admission) return admission.databaseEnvironment.serverId;
  if ('telemetryCollector' in admission) return admission.telemetryCollector.serverId;
  const serverId = readRecord(input).serverId;
  return typeof serverId === 'string' ? serverId : null;
}

/** Setup authority is separate from the Action approval class and ordinary SQL edit authority. */
export function readDeploymentDatabaseReadAccessSetupV1(admission: DeploymentReadAdmissionV1 | undefined) {
  if (!admission || !('databaseTarget' in admission) || admission.databaseTarget.kind !== 'managed_deployment') return undefined;
  const action = formatQualifiedPluginActionId(admission.action);
  const create = action === DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1;
  if (!create && action !== DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1) return undefined;
  return {
    environmentId: admission.environmentId, targetLinkId: admission.targetLinkId,
    requiresDatabaseWriter: create, allowsBindingWrite: !create || admission.databaseReadAccessMode === 'apply',
  };
}

export function readDeploymentDatabaseReadAccessBindingChildV1(root: Readonly<{
  deploymentReadAdmission?: DeploymentReadAdmissionV1;
  deploymentReviewedChildPlan?: readonly DeploymentReviewedChildPlanEntryV1[];
}> | undefined,
  reviewedChild: Readonly<{ actionId: string; role: string }> | undefined,
) {
  // A database read admission is the signed root of its own `action.invoke`, whose plan names this child.
  if (!readDeploymentReviewedChildV1(root, reviewedChild, DEPLOYMENT_BINDINGS_SET_ACTION_ID_V1)) return undefined;
  const setup = readDeploymentDatabaseReadAccessSetupV1(root?.deploymentReadAdmission);
  return setup?.allowsBindingWrite ? setup : undefined;
}

/** Recognize the Environment collector transport for a contributed Action. */
export function projectDeploymentTelemetryReadAdmissionV1(actionId: string, input: unknown): DeploymentTelemetryReadAdmissionV1 | undefined {
  if (actionId !== ACTION_INVOKE_ACTION_ID_V1) return undefined;
  const read = projectDeploymentReadAdmissionV1(actionId, input);
  return read && 'telemetryCollector' in read ? read : undefined;
}

/** Home sees the ordinary database target for a protected mounted read. */
export function projectPrivateMountedDatabaseReadInputV1(input: unknown) {
  const sourceRead = ActionInvokeInputSchema.safeParse(input);
  if (sourceRead.success && formatQualifiedPluginActionId(sourceRead.data.action) === DATABASE_INSIGHTS_SOURCES_READ_ACTION_ID_V1) {
    const target = DatabaseTargetV1Schema.safeParse(readRecord(sourceRead.data.input).target);
    if (target.success) return { action: sourceRead.data.action, input: { target: target.data } };
  }
  const admission = projectDeploymentReadAdmissionV1(ACTION_INVOKE_ACTION_ID_V1, input);
  return isSelectedDeploymentDatabaseReadV1(admission)
    ? { action: admission.action, input: { target: admission.databaseTarget } } : undefined;
}

export function isSelectedDeploymentDatabaseReadV1(admission: DeploymentReadAdmissionV1 | undefined):
  admission is Extract<DeploymentReadAdmissionV1, { databaseTarget: unknown }> & { access: 'read' } {
  return admission !== undefined && 'databaseTarget' in admission && admission.access === 'read';
}

export function projectDeploymentReadAdmissionV1(actionId: string, input: unknown): DeploymentReadAdmissionV1 | undefined {
  if (actionId === ACTION_INVOKE_ACTION_ID_V1) {
    const invoked = ActionInvokeInputSchema.safeParse(input);
    if (!invoked.success || invoked.data.input === undefined) return undefined;
    const qualifiedId = formatQualifiedPluginActionId(invoked.data.action);
    const sourceKind = telemetryCollectorActionSourceV1(qualifiedId);
    if (sourceKind) {
      const operands = invoked.data.input;
      if (sourceKind === 'metrics' && operands && typeof operands === 'object' && 'environmentIds' in operands) {
        const batch = z.object(telemetryCollector.shape).safeParse(operands);
        return batch.success ? { actionId, action: invoked.data.action, telemetryCollector: {
          serverId: batch.data.serverId, environmentIds: [...new Set(batch.data.environmentIds)],
        } } : undefined;
      }
      const selected = sourceKind === 'source'
        ? readDeploymentTelemetryEnvironmentSourceV1(operands)
        : telemetryEnvironment.safeParse(operands);
      return selected.success ? { actionId, action: invoked.data.action,
        telemetryCollector: { serverId: selected.data.serverId, environmentIds: [selected.data.environmentId] } } : undefined;
    }
    if (qualifiedId === DATABASE_TARGETS_LIST_ACTION_ID_V1) {
      const scope = readRecord(invoked.data.input).scope;
      if (readRecord(scope).kind !== 'environment') return undefined;
      const environment = DeploymentEnvironmentRefV1Schema.safeParse(readRecord(scope).environment);
      return environment.success ? { actionId: ACTION_INVOKE_ACTION_ID_V1, action: invoked.data.action,
        environmentId: environment.data.environmentId, databaseEnvironment: environment.data } : undefined;
    }
    if (isDatabaseActionIdV1(qualifiedId)) {
      const operands = invoked.data.input;
      if (!operands || typeof operands !== 'object' || !('target' in operands)) return undefined;
      const target = deploymentDatabaseTarget.safeParse(operands.target);
      if (!target.success) return undefined;
      const attach = qualifiedId === DATABASE_READ_ACCESS_ATTACH_ACTION_ID_V1;
      const create = qualifiedId === DATABASE_READ_ACCESS_CREATE_ACTION_ID_V1;
      if ((create || attach) && target.data.kind !== 'managed_deployment') return undefined;
      const mode = 'mode' in operands ? operands.mode : undefined;
      if (create && mode !== 'preview' && mode !== 'apply') return undefined;
      return { actionId: ACTION_INVOKE_ACTION_ID_V1, action: invoked.data.action,
        environmentId: target.data.environment.environmentId, targetLinkId: target.data.targetLinkId, databaseTarget: target.data,
        access: create || attach ? 'write' : databaseActionOperationClass(qualifiedId, operands),
        ...(create && (mode === 'preview' || mode === 'apply') ? { databaseReadAccessMode: mode } : {}) };
    }
    return undefined;
  }
  if (!isDeploymentReadAdmissionActionIdV1(actionId)) return undefined;
  if (actionId === DEPLOYMENT_DATA_SIZE_ACTION_ID_V1) {
    const { serverId: _serverId, previous: _previous, ...scope } = DeploymentDataSizeInputV1Schema.parse(input);
    return { actionId, ...scope };
  }
  if (actionId === PROJECT_READINESS_ACTION_IDS_V1[0]) {
    const { projectId, machineId, environments } = ProjectReadinessReadInputV1Schema.parse(input);
    return { actionId, projectId, machineId,
      environments: environments.map(({ environmentId, expectedRevision }) => ({ environmentId, expectedRevision })) };
  }

  if (actionId === 'deployments.health.current') {
    const { environmentId, targetLinkId, machineId } = DeploymentHealthCurrentInputV1Schema.parse(input);
    return { actionId, environmentId, targetLinkId, machineId };
  }
  if (actionId === 'deployments.drift.read') {
    const { environmentId, deploymentId, targetLinkId, machineId, installationId, expectedRevision } = DeploymentDriftReadInputV1Schema.parse(input);
    return { actionId, environmentId, deploymentId, targetLinkId, machineId, installationId, expectedRevision };
  }
  if (actionId === 'deployments.logs.read') {
    const { environmentId, deploymentId, targetLinkId, machineId, installationId, kind } = DeploymentLogsReadInputV1Schema.parse(input);
    return { actionId, environmentId, deploymentId, kind, ...(targetLinkId ? { targetLinkId } : {}),
      ...(machineId ? { machineId } : {}), ...(installationId ? { installationId } : {}) };
  }
  if (actionId === 'deployments.health.read') {
    const { environmentId, deploymentId, targetLinkId, machineId, installationId } = DeploymentHealthReadInputV1Schema.parse(input);
    return { actionId, environmentId, deploymentId, targetLinkId, machineId, installationId };
  }
  return undefined;
}
