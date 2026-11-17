import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema } from '../deployments/deploymentIdentifiersV1.js';
import { DeploymentBackupRetentionV1Schema } from '../deployments/deploymentBackupRetentionV1.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';
import { AutomationScheduleSchema } from '../automations/automationSchedule.js';
import { HealthCheckAlertChannelV1Schema } from '../deployments/healthCheckSourceV1.js';
import { DeploymentTelemetryCapabilitiesV1Schema } from '../deployments/deploymentTelemetryV1.js';

/** Existing domain setup preview chooses which not-yet-configured leaf to prepare. */
export const DeploymentConfigurationDefaultsForV1Schema = z.enum(['previews', 'backups', 'backupSchedule', 'alerts']);
export type DeploymentConfigurationDefaultsForV1 = z.infer<typeof DeploymentConfigurationDefaultsForV1Schema>;

export const DeploymentRetainPreviousDeploymentsV1Schema = lazyZodSchema(() => z.number().check(
  z.int(), z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER),
));
export const DEFAULT_DEPLOYMENT_RETAIN_PREVIOUS_DEPLOYMENTS_V1 = 1;

/** Deliberate creation preferences; partial layers never materialize domain defaults. */
export const DeploymentCreationDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  telemetryMachineId: z.optional(DeploymentIdentifierV1Schema),
  telemetry: z.optional(DeploymentTelemetryCapabilitiesV1Schema),
  buildMachineId: z.optional(DeploymentIdentifierV1Schema),
  controllerMachineId: z.optional(DeploymentIdentifierV1Schema),
  retainPreviousDeployments: z.optional(DeploymentRetainPreviousDeploymentsV1Schema),
  previewMachineId: z.optional(DeploymentIdentifierV1Schema),
  previewDatabase: z.optional(z.enum(['none', 'own', 'branch'])),
  backupDestination: z.optional(z.nullable(asProtocolZod(PluginContributionIdentityV1Schema))),
  backupSchedule: z.optional(z.nullable(AutomationScheduleSchema)),
  backupRetention: z.optional(DeploymentBackupRetentionV1Schema),
  alertChannels: z.optional(z.array(HealthCheckAlertChannelV1Schema)),
}));
export type DeploymentCreationDefaultsV1 = z.infer<typeof DeploymentCreationDefaultsV1Schema>;

export const DeploymentCreationDefaultSourceV1Schema = z.enum(['explicit', 'project', 'account', 'builtin']);
export type DeploymentCreationDefaultSourceV1 = z.infer<typeof DeploymentCreationDefaultSourceV1Schema>;
/** Review projection of the canonical resolver; only values are persisted on creation. */
export const ResolvedDeploymentCreationDefaultsV1Schema = lazyZodSchema(() => z.strictObject({
  values: z.extend(DeploymentCreationDefaultsV1Schema, { retainPreviousDeployments: DeploymentRetainPreviousDeploymentsV1Schema }),
  sources: z.strictObject({
    telemetryMachineId: z.optional(DeploymentCreationDefaultSourceV1Schema),
    telemetry: z.optional(DeploymentCreationDefaultSourceV1Schema),
    buildMachineId: z.optional(DeploymentCreationDefaultSourceV1Schema),
    controllerMachineId: z.optional(DeploymentCreationDefaultSourceV1Schema),
    retainPreviousDeployments: z.optional(DeploymentCreationDefaultSourceV1Schema),
    previewMachineId: z.optional(DeploymentCreationDefaultSourceV1Schema),
    previewDatabase: z.optional(DeploymentCreationDefaultSourceV1Schema),
    backupDestination: z.optional(DeploymentCreationDefaultSourceV1Schema),
    backupSchedule: z.optional(DeploymentCreationDefaultSourceV1Schema),
    backupRetention: z.optional(DeploymentCreationDefaultSourceV1Schema),
    alertChannels: z.optional(DeploymentCreationDefaultSourceV1Schema),
  }),
}));
export type ResolvedDeploymentCreationDefaultsV1 = z.infer<typeof ResolvedDeploymentCreationDefaultsV1Schema>;
