import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from '../deployments/deploymentIdentifiersV1.js';
import { DeploymentDomainHealthFactsV1Schema } from '../deployments/deploymentReadsV1.js';
import { DeploymentBackupRecordedFactsV1Schema } from '../deployments/deploymentBackupHistoryV1.js';
import { HealthCheckAlertsV1Schema } from '../deployments/healthCheckSourceV1.js';
import { DeploymentEnvironmentSecretScopeV1Schema } from '../deployments/deploymentBindingPatchV1.js';
import { ScmHostingProjectReadinessSourceFactV1Schema } from '../plugins/contributions/scmHostingProviders.js';

export const PROJECT_READINESS_FACT_KINDS_V1 = ['ci', 'health', 'backups', 'alerts', 'secrets', 'security'] as const;
export type ProjectReadinessFactKindV1 = typeof PROJECT_READINESS_FACT_KINDS_V1[number];
export const PROJECT_READINESS_FACT_OWNERS_V1 = {
  ci: 'forgeCI', health: 'healthChecks', backups: 'deploymentBackups', alerts: 'alertSources',
  secrets: 'environmentSecrets', security: 'forgeSecurity',
} as const satisfies Record<ProjectReadinessFactKindV1, string>;

export { ProjectReadinessReadInputV1Schema, ProjectReadinessEnvironmentSelectionV1Schema,
  type ProjectReadinessReadInputV1, type ProjectReadinessEnvironmentSelectionV1 } from './readinessInputV1.js';

/** Recorded operation receipts only: reading readiness never opens a backup repository. */
export const DeploymentBackupRecordedHealthV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.enum(['ready', 'actionNeeded', 'unavailable']), reason: id,
  backups: DeploymentBackupRecordedFactsV1Schema,
}));
export type DeploymentBackupRecordedHealthV1 = z.infer<typeof DeploymentBackupRecordedHealthV1Schema>;

export const ProjectReadinessFactOutcomeV1Schema = lazyZodSchema(() => z.strictObject({
  ...ScmHostingProjectReadinessSourceFactV1Schema.shape,
  // Composite facts retain the existing Action-operation identifier boundary.
  reason: id,
  backups: z.optional(DeploymentBackupRecordedHealthV1Schema.shape.backups),
  healthCoverage: z.optional(z.strictObject({ sourceRevision: id, observerMachineId: z.nullable(id),
    checkCount: z.number().check(z.int(), z.nonnegative()),
    domains: z.array(z.strictObject({ domainId: id, domainRevision: revision, facts: DeploymentDomainHealthFactsV1Schema })),
  })),
  alertWiring: z.optional(z.strictObject({ sourceRevision: id, observerMachineId: z.nullable(id),
    controllerMachineId: id, channelIds: z.array(id), phases: HealthCheckAlertsV1Schema.shape.phases,
  })),
  secretScope: z.optional(z.pick(DeploymentEnvironmentSecretScopeV1Schema, { requiredGrantCount: true, missingGrantCount: true })),
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
