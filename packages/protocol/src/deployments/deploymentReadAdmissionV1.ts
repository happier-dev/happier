import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentHealthReadInputV1Schema, DeploymentHealthCurrentInputV1Schema,
  DeploymentDriftReadInputV1Schema, DeploymentLogsReadInputV1Schema, DeploymentStageLogsReadInputV1Schema } from './deploymentReadsV1.js';

import { isDeploymentReadAdmissionActionIdV1 } from './deploymentActionIdsV1.js';
import { ProjectReadinessReadInputV1Schema } from '../projects/readinessInputV1.js';
import { PROJECT_READINESS_ACTION_IDS_V1 } from '../actions/projectReadinessActionIdsV1.js';
import { ACTION_INVOKE_ACTION_ID_V1 } from '../actions/actionIds.js';
import { DeploymentDataQueryInputV1Schema } from './deploymentReadsV1.js';
import { ActionInvokeInputSchema } from '../actions/actionInvokeInput.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { DeploymentTargetDataQueryInputV1Schema } from '../plugins/contributions/deploymentTargetRolesV1.js';
export { isDeploymentReadActionIdV1, isDeploymentNativeReadActionIdV1, isDeploymentReadAdmissionActionIdV1 } from './deploymentActionIdsV1.js';

const references = { environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id };

/** Non-content purpose only; the signed binding owns Home and the sealed input owns service identity. */
export const DeploymentReadAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal(PROJECT_READINESS_ACTION_IDS_V1[0]), projectId: id, machineId: id,
    environments: z.array(z.strictObject({ environmentId: id, expectedRevision: revision })) }),
  z.strictObject({ actionId: z.literal('deployments.health.current'), environmentId: id, targetLinkId: id, machineId: id }),
  z.strictObject({ actionId: z.literal('deployments.health.read'), ...references }),
  z.strictObject({ actionId: z.literal('deployments.drift.read'), ...references, expectedRevision: revision }),
  z.extend(z.omit(DeploymentStageLogsReadInputV1Schema, { serverId: true, ref: true, tail: true, cursor: true, kind: true }),
    { actionId: z.literal('deployments.logs.read'), kind: z.enum(['build', 'runtime']) }),
  z.strictObject({ actionId: z.literal('deployments.data.query'), ...references, expectedRevision: revision }),
  z.strictObject({ actionId: z.literal(ACTION_INVOKE_ACTION_ID_V1), action: asProtocolZod(PluginContributionIdentityV1Schema),
    environmentId: id, targetLinkId: id, expectedRevision: revision, expectedTargetLinkRevision: revision }),
]));
export type DeploymentReadAdmissionV1 = z.infer<typeof DeploymentReadAdmissionV1Schema>;

export function projectDeploymentReadAdmissionV1(actionId: string, input: unknown): DeploymentReadAdmissionV1 | undefined {
  if (actionId === ACTION_INVOKE_ACTION_ID_V1) {
    const invoked = ActionInvokeInputSchema.safeParse(input);
    if (!invoked.success || invoked.data.input === undefined) return undefined;
    const query = DeploymentTargetDataQueryInputV1Schema.safeParse(invoked.data.input);
    if (!query.success) return undefined;
    const { environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision } = query.data;
    return { actionId: ACTION_INVOKE_ACTION_ID_V1, action: invoked.data.action, environmentId, targetLinkId, expectedRevision, expectedTargetLinkRevision };
  }
  if (!isDeploymentReadAdmissionActionIdV1(actionId)) return undefined;
  if (actionId === PROJECT_READINESS_ACTION_IDS_V1[0]) {
    const { projectId, machineId, environments } = ProjectReadinessReadInputV1Schema.parse(input);
    return { actionId, projectId, machineId,
      environments: environments.map(({ environmentId, expectedRevision }) => ({ environmentId, expectedRevision })) };
  }
  if (actionId === 'deployments.data.query') {
    const { environmentId, deploymentId, targetLinkId, machineId, installationId, expectedRevision } = DeploymentDataQueryInputV1Schema.parse(input);
    return { actionId, environmentId, deploymentId, targetLinkId, machineId, installationId, expectedRevision };
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
  const { environmentId, deploymentId, targetLinkId, machineId, installationId } = DeploymentHealthReadInputV1Schema.parse(input);
  return { actionId, environmentId, deploymentId, targetLinkId, machineId, installationId };
}
