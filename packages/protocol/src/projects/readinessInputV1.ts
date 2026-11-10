import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from '../deployments/deploymentIdentifiersV1.js';
import { DeploymentBackupInventoryInputV1Schema } from '../deployments/deploymentBackupActionsV1.js';

export const ProjectReadinessEnvironmentSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: id, expectedRevision: revision,
  backups: z.optional(DeploymentBackupInventoryInputV1Schema),
}));
export const ProjectReadinessReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id,
  /** Canonical Project Source Artifact identity; this read does not select a checkout. */
  projectId: id,
  environments: z.array(ProjectReadinessEnvironmentSelectionV1Schema),
}).check(z.refine(value => new Set(value.environments.map(item => item.environmentId)).size === value.environments.length,
  { message: 'Selected Environments must be unique.' }),
z.refine(value => value.environments.every(item => !item.backups || (item.backups.serverId === value.serverId
  && item.backups.environmentId === item.environmentId && item.backups.expectedRevision === item.expectedRevision)),
{ message: 'Owner reads must address the exact selected Home and Environment.' })));
export type ProjectReadinessReadInputV1 = z.infer<typeof ProjectReadinessReadInputV1Schema>;
export type ProjectReadinessEnvironmentSelectionV1 = z.infer<typeof ProjectReadinessEnvironmentSelectionV1Schema>;
