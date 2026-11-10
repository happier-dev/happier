import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { DeploymentIdentifierV1Schema as id, DeploymentRevisionV1Schema as revision } from './deploymentIdentifiersV1.js';
import { DeploymentBackupConfigurationV1Schema, DeploymentBackupRetentionV1Schema,
  DeploymentBackupTestResultV1Schema } from './deploymentBackupActionsV1.js';
import { DeploymentCreationDefaultsV1Schema, ResolvedDeploymentCreationDefaultsV1Schema } from '../projects/deploymentCreationDefaultsV1.js';
import { DeploymentBackupAnotherMachineSetupV1Schema, DeploymentBackupReceiverSetupOperationV1Schema } from './deploymentBackupAnotherMachineV1.js';
import { EnvironmentBackupDestinationBindingInputV1Schema } from './storedAppInputV1.js';
import { StoragePathCapacityV1Schema } from '../storage/storageV1.js';

export const DEPLOYMENT_BACKUP_CONFIGURE_INTENT_OPTIONS_V1 = [
  { value: 'test', label: 'Test destination' }, { value: 'save', label: 'Save existing repository' },
  { value: 'initializeAndSave', label: 'Initialize repository and save' }, { value: 'markNotNeeded', label: 'Backups not needed' },
] as const;
export const DeploymentBackupConfigureIntentV1Schema = z.enum(DEPLOYMENT_BACKUP_CONFIGURE_INTENT_OPTIONS_V1.map(option => option.value));
const header = () => ({ serverId: id, environmentId: id, expectedRevision: revision });
const candidate = lazyZodSchema(() => z.extend(z.omit(DeploymentBackupConfigurationV1Schema, { retention: true }), {
  retention: z.optional(DeploymentBackupRetentionV1Schema),
}));
const choices = lazyZodSchema(() => z.pick(DeploymentCreationDefaultsV1Schema, {
  backupDestination: true, backupRetention: true, backupSchedule: true,
}));
const preparation = () => ({ ...header(), configuration: candidate, explicit: z.optional(choices),
  backupBindings: z.optional(z.array(EnvironmentBackupDestinationBindingInputV1Schema)),
  destinationSetup: z.optional(DeploymentBackupAnotherMachineSetupV1Schema) });

/** Controller-owned setup does not require a linked or deployed runtime target. */
export const DeploymentBackupConfigureInputV1Schema = lazyZodSchema(() => z.discriminatedUnion('intent', [
  z.strictObject({ ...preparation(), intent: z.literal('test') }),
  z.strictObject({ ...preparation(), intent: z.literal('save') }),
  z.strictObject({ ...preparation(), intent: z.literal('initializeAndSave') }),
  z.strictObject({ ...header(), intent: z.literal('markNotNeeded') }),
]));
export type DeploymentBackupConfigureInputV1 = z.infer<typeof DeploymentBackupConfigureInputV1Schema>;

const review = () => ({ review: z.optional(z.strictObject({
  creationDefaults: z.optional(ResolvedDeploymentCreationDefaultsV1Schema),
  capacity: z.optional(StoragePathCapacityV1Schema),
})) });
const recovery = () => ({ destinationSetup: z.optional(DeploymentBackupAnotherMachineSetupV1Schema),
  setupOperation: z.optional(DeploymentBackupReceiverSetupOperationV1Schema) });
/** Native failures retain their actual facts; only configured/notNeeded persisted. */
export const DeploymentBackupConfigureResultV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('tested'), test: DeploymentBackupTestResultV1Schema, ...review(), ...recovery() }),
  z.strictObject({ kind: z.literal('configured'), environmentId: id, revision,
    configuration: DeploymentBackupConfigurationV1Schema, ...review(), ...recovery() }),
  z.strictObject({ kind: z.literal('needsBinding'), configuration: DeploymentBackupConfigurationV1Schema,
    missingRoles: z.array(z.string()), ...review(), ...recovery() }),
  z.strictObject({ kind: z.literal('setupIncomplete'), destinationSetup: DeploymentBackupAnotherMachineSetupV1Schema,
    errorCode: z.string(), setupOperation: z.optional(DeploymentBackupReceiverSetupOperationV1Schema), ...review() }),
  z.strictObject({ kind: z.literal('notNeeded'), environmentId: id, revision, ...review() }),
]));
export type DeploymentBackupConfigureResultV1 = z.infer<typeof DeploymentBackupConfigureResultV1Schema>;
