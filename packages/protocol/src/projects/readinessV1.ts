import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from '../deployments/deploymentIdentifiersV1.js';
import { DeploymentHealthReadInputV1Schema } from '../deployments/deploymentReadsV1.js';
import { DeploymentHealthReadResultV1Schema } from '../deployments/deploymentActionsV1.js';
import { DeploymentBackupInventoryInputV1Schema } from '../deployments/deploymentBackupActionsV1.js';
import { DeploymentBackupRecordedFactsV1Schema } from '../deployments/deploymentBackupHistoryV1.js';

export const PROJECT_READINESS_FACT_KINDS_V1 = ['ci', 'health', 'backups', 'alerts', 'secrets', 'security'] as const;
export type ProjectReadinessFactKindV1 = typeof PROJECT_READINESS_FACT_KINDS_V1[number];
export const PROJECT_READINESS_FACT_OWNERS_V1 = {
  ci: 'forgeCI', health: 'healthChecks', backups: 'deploymentBackups', alerts: 'alertSources',
  secrets: 'environmentSecrets', security: 'forgeSecurity',
} as const satisfies Record<ProjectReadinessFactKindV1, string>;

export const ProjectReadinessEnvironmentSelectionV1Schema = lazyZodSchema(() => z.strictObject({
  environmentId: id, expectedRevision: revision,
  health: z.optional(DeploymentHealthReadInputV1Schema),
  backups: z.optional(DeploymentBackupInventoryInputV1Schema),
}));
export const ProjectReadinessReadInputV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, machineId: id,
  /** Canonical Project Source Artifact identity; this read does not select a checkout. */
  projectId: id,
  environments: z.array(ProjectReadinessEnvironmentSelectionV1Schema),
}).check(z.refine(value => new Set(value.environments.map(item => item.environmentId)).size === value.environments.length,
  { message: 'Selected Environments must be unique.' }),
z.refine(value => value.environments.every(item => (!item.health || item.health.serverId === value.serverId
  && item.health.environmentId === item.environmentId) && (!item.backups || item.backups.serverId === value.serverId
  && item.backups.environmentId === item.environmentId && item.backups.expectedRevision === item.expectedRevision)),
{ message: 'Owner reads must address the exact selected Home and Environment.' })));
export type ProjectReadinessReadInputV1 = z.infer<typeof ProjectReadinessReadInputV1Schema>;
export type ProjectReadinessEnvironmentSelectionV1 = z.infer<typeof ProjectReadinessEnvironmentSelectionV1Schema>;

/** Recorded operation receipts only: reading readiness never opens a backup repository. */
export const DeploymentBackupRecordedHealthV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'actionNeeded', 'unavailable']), reason: id,
  backups: DeploymentBackupRecordedFactsV1Schema,
}));
export type DeploymentBackupRecordedHealthV1 = z.infer<typeof DeploymentBackupRecordedHealthV1Schema>;

export const ProjectReadinessFactOutcomeV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'actionNeeded', 'unavailable']), reason: id,
  health: z.optional(DeploymentHealthReadResultV1Schema),
  backups: z.optional(DeploymentBackupRecordedHealthV1Schema.shape.backups),
}));
export type ProjectReadinessFactOutcomeV1 = z.infer<typeof ProjectReadinessFactOutcomeV1Schema>;
export const ProjectReadinessFactV1Schema = lazyZodSchema(() => z.strictObject({
  ...ProjectReadinessFactOutcomeV1Schema.shape, kind: z.enum(PROJECT_READINESS_FACT_KINDS_V1),
  owner: id, environmentId: z.optional(id),
}));
export type ProjectReadinessFactV1 = z.infer<typeof ProjectReadinessFactV1Schema>;
export const ProjectReadinessReadResultV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: id, projectId: id, status: z.enum(['ready', 'actionNeeded', 'unavailable']),
  facts: z.array(ProjectReadinessFactV1Schema),
}));
export type ProjectReadinessReadResultV1 = z.infer<typeof ProjectReadinessReadResultV1Schema>;
