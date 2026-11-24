import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { DeploymentIdentifierV1Schema } from './deploymentIdentifiersV1.js';
import { DeploymentSecretBindingSourceV1Schema } from './storedAppInputV1.js';
import { MachineAvailabilityDiagnosticV1Schema } from '../machines/machineAccessV1.js';
import { WorkflowTargetUnavailableReasonV1Schema } from '../workflows/workflowTargetUnavailableReasonV1.js';
import { MachineSetupOperationReferenceV1Schema } from '../machines/setup/machineSetupOperationV1.js';

/** Ordinary Setup operation addresses, without receiver evidence or a second lifecycle. */
export const DeploymentBackupReceiverSetupOperationV1Schema = MachineSetupOperationReferenceV1Schema;
export type DeploymentBackupReceiverSetupOperationV1 = z.infer<typeof DeploymentBackupReceiverSetupOperationV1Schema>;

/** Partial custody retains the saved key while a separately saved password can be retried. */
export const DeploymentBackupSenderIdentityV1Schema = lazyZodSchema(() => z.strictObject({
    publicKey: z.string().check(z.minLength(1)),
    sshPrivateKey: DeploymentSecretBindingSourceV1Schema,
    repositoryPassword: z.optional(DeploymentSecretBindingSourceV1Schema),
}));
export type DeploymentBackupSenderIdentityV1 = z.infer<typeof DeploymentBackupSenderIdentityV1Schema>;

/** Recipe declarations own their inputs; configure owns only the selected Machine and retained refs. */
export const DeploymentBackupAnotherMachineSetupV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.literal('anotherMachine'),
    machineId: DeploymentIdentifierV1Schema,
    expectedInstallationId: DeploymentIdentifierV1Schema,
    receiverInputs: z.record(z.string(), StrictJsonValueSchema),
    senderIdentity: z.optional(DeploymentBackupSenderIdentityV1Schema),
}));
export type DeploymentBackupAnotherMachineSetupV1 = z.infer<typeof DeploymentBackupAnotherMachineSetupV1Schema>;

/** Identifies the selected receiver and the first refused Setup child. */
export const DeploymentBackupReceiverFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
    receiver: z.strictObject({
        machineId: DeploymentIdentifierV1Schema,
        step: z.enum(['read', 'plan', 'apply']),
        diagnostic: z.optional(MachineAvailabilityDiagnosticV1Schema),
        workflowReason: z.optional(WorkflowTargetUnavailableReasonV1Schema),
    }),
}));
