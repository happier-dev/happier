import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentHealthReadInputV1Schema, DeploymentHealthCurrentInputV1Schema,
  DeploymentDriftReadInputV1Schema, DeploymentLogsReadInputV1Schema, DeploymentStageLogsReadInputV1Schema } from './deploymentReadsV1.js';

import { DEPLOYMENT_DATA_SIZE_ACTION_ID_V1, isDeploymentReadAdmissionActionIdV1 } from './deploymentActionIdsV1.js';
import { ProjectReadinessReadInputV1Schema } from '../projects/readinessInputV1.js';
import { PROJECT_READINESS_ACTION_IDS_V1 } from '../actions/projectReadinessActionIdsV1.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from '../actions/actionIds.js';
import { DeploymentDataSizeInputV1Schema } from './deploymentReadsV1.js';
import { ActionInvokeInputSchema } from '../actions/actionInvokeInput.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { DatabaseDeploymentServiceTargetV1Schema, DatabaseManagedDeploymentTargetV1Schema } from '../databases/databaseTargetIdentityV1.js';
import { isDatabaseActionIdV1, telemetryCollectorReadSourceV1 } from '../actions/actionIdsDatabaseV1.js';
import { databaseActionOperationClass } from '../actions/databaseActionMetadata.js';
import { formatQualifiedPluginActionId } from '../plugins/actions/qualifiedActionId.js';
import { DeploymentTelemetryCapabilitiesV1Schema } from './deploymentTelemetryV1.js';
export { isDeploymentReadActionIdV1, isDeploymentNativeReadActionIdV1, isDeploymentReadAdmissionActionIdV1 } from './deploymentActionIdsV1.js';

const references = { environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id };
const deploymentDatabaseTarget = z.union([DatabaseDeploymentServiceTargetV1Schema, DatabaseManagedDeploymentTargetV1Schema]);

const telemetryCollector = z.strictObject({ serverId: id, environmentIds: z.array(id).check(z.minLength(1)) });
const telemetryEnvironment = z.object({ serverId: id, environmentId: id });
const telemetryEnvironmentSource = z.extend(telemetryEnvironment, { kind: z.literal('environment') });

/** Home's accepted metadata for the sealed read. No Environment content is required on this carrier. */
export const DeploymentTelemetryReadFactsV1Schema = lazyZodSchema(() => z.array(z.strictObject({
  environmentId: id, revision, capabilities: DeploymentTelemetryCapabilitiesV1Schema,
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
  environmentId: id, targetLinkId: id, databaseTarget: deploymentDatabaseTarget, access: z.enum(['read', 'write']) }),
  z.strictObject({ actionId: z.literal(ACTION_INVOKE_ACTION_ID_V1), action: asProtocolZod(PluginContributionIdentityV1Schema).check(
    z.refine(action => telemetryCollectorReadSourceV1(formatQualifiedPluginActionId(action)) !== undefined)),
    telemetryCollector })]));

export type DeploymentReadAdmissionV1 = z.infer<typeof DeploymentReadAdmissionV1Schema>;

export type DeploymentTelemetryReadAdmissionV1 = Extract<DeploymentReadAdmissionV1, { telemetryCollector: unknown }>;

/** Recognize the Environment collector transport for a contributed Action. */
export function projectDeploymentTelemetryReadAdmissionV1(actionId: string, input: unknown): DeploymentTelemetryReadAdmissionV1 | undefined {
  if (actionId !== ACTION_INVOKE_ACTION_ID_V1) return undefined;
  const read = projectDeploymentReadAdmissionV1(actionId, input);
  return read && 'telemetryCollector' in read ? read : undefined;
}

export function projectDeploymentReadAdmissionV1(actionId: string, input: unknown): DeploymentReadAdmissionV1 | undefined {
  if (actionId === ACTION_INVOKE_ACTION_ID_V1) {
    const invoked = ActionInvokeInputSchema.safeParse(input);
    if (!invoked.success || invoked.data.input === undefined) return undefined;
    const qualifiedId = formatQualifiedPluginActionId(invoked.data.action);
    const sourceKind = telemetryCollectorReadSourceV1(qualifiedId);
    if (sourceKind) {
      const operands = invoked.data.input;
      if (sourceKind === 'metrics' && operands && typeof operands === 'object' && 'environmentIds' in operands) {
        const batch = z.object(telemetryCollector.shape).safeParse(operands);
        return batch.success ? { actionId, action: invoked.data.action, telemetryCollector: {
          serverId: batch.data.serverId, environmentIds: [...new Set(batch.data.environmentIds)],
        } } : undefined;
      }
      const selected = sourceKind === 'source'
        ? telemetryEnvironmentSource.safeParse(operands && typeof operands === 'object' && 'source' in operands ? operands.source : undefined)
        : telemetryEnvironment.safeParse(operands);
      return selected.success ? { actionId, action: invoked.data.action,
        telemetryCollector: { serverId: selected.data.serverId, environmentIds: [selected.data.environmentId] } } : undefined;
    }
    if (isDatabaseActionIdV1(qualifiedId)) {
      const operands = invoked.data.input;
      if (!operands || typeof operands !== 'object' || !('target' in operands)) return undefined;
      const target = deploymentDatabaseTarget.safeParse(operands.target);
      if (!target.success) return undefined;
      return { actionId: ACTION_INVOKE_ACTION_ID_V1, action: invoked.data.action,
        environmentId: target.data.environment.environmentId, targetLinkId: target.data.targetLinkId, databaseTarget: target.data,
        access: databaseActionOperationClass(qualifiedId, operands) };
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
