import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentHealthReadInputV1Schema, DeploymentHealthCurrentInputV1Schema,
  DeploymentDriftReadInputV1Schema, DeploymentLogsReadInputV1Schema } from './deploymentReadsV1.js';

export function isDeploymentReadActionIdV1(value: string): value is
  'deployments.health.current' | 'deployments.health.read' | 'deployments.drift.read' | 'deployments.logs.read' {
  return value === 'deployments.health.current' || isDeploymentNativeReadActionIdV1(value);
}

export function isDeploymentNativeReadActionIdV1(value: string): value is
  'deployments.health.read' | 'deployments.drift.read' | 'deployments.logs.read' {
  return value === 'deployments.health.read' || value === 'deployments.drift.read' || value === 'deployments.logs.read';
}

const references = { environmentId: id, deploymentId: id, targetLinkId: id, machineId: id, installationId: id };

/** Non-content purpose only; the signed binding owns Home and the sealed input owns service identity. */
export const DeploymentReadAdmissionV1Schema = lazyZodSchema(() => z.discriminatedUnion('actionId', [
  z.strictObject({ actionId: z.literal('deployments.health.current'), environmentId: id, targetLinkId: id, machineId: id }),
  z.strictObject({ actionId: z.literal('deployments.health.read'), ...references }),
  z.strictObject({ actionId: z.literal('deployments.drift.read'), ...references, expectedRevision: revision }),
  z.strictObject({ actionId: z.literal('deployments.logs.read'), ...references, kind: z.enum(['build', 'runtime']) }),
]));
export type DeploymentReadAdmissionV1 = z.infer<typeof DeploymentReadAdmissionV1Schema>;

export function projectDeploymentReadAdmissionV1(actionId: string, input: unknown): DeploymentReadAdmissionV1 | undefined {
  if (!isDeploymentReadActionIdV1(actionId)) return undefined;
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
    return { actionId, environmentId, deploymentId, targetLinkId, machineId, installationId, kind };
  }
  const { environmentId, deploymentId, targetLinkId, machineId, installationId } = DeploymentHealthReadInputV1Schema.parse(input);
  return { actionId, environmentId, deploymentId, targetLinkId, machineId, installationId };
}
