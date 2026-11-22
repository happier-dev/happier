import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineSetupBackupReceiverResultV1Schema } from './backupReceiverV1.js';
import { WorkflowInvocationRecordIdSchema, WorkflowRunIdV1Schema } from '../../workflows/workflowIdsV1.js';
import { PluginLocalizedStringV2Schema } from '../../plugins/contributions/publicTypes.js';

const id = () => z.string().check(z.trim(), z.minLength(1));

/** Display identity shared by the reviewed Plan and its native operation. */
export const MachineSetupReviewedStepV1Schema = lazyZodSchema(() => z.strictObject({
    planIndex: z.number().check(z.int(), z.nonnegative()),
    stepId: z.string().check(z.minLength(1)),
    label: PluginLocalizedStringV2Schema,
}));
export type MachineSetupReviewedStepV1 = z.infer<typeof MachineSetupReviewedStepV1Schema>;

/** Ordinary Setup operation links, shared by its result and partial recovery. */
export const MachineSetupOperationReferenceV1Schema = lazyZodSchema(() => z.strictObject({
    operationId: id(), terminalId: z.optional(id()), runId: z.optional(id()),
}));
export type MachineSetupOperationReferenceV1 = z.infer<typeof MachineSetupOperationReferenceV1Schema>;

export const MachineSetupRetryV1Schema = lazyZodSchema(() => z.strictObject({
    runId: WorkflowRunIdV1Schema,
    invocationId: WorkflowInvocationRecordIdSchema,
}));
export type MachineSetupRetryV1 = z.infer<typeof MachineSetupRetryV1Schema>;

export const MachineSetupApplyResultV1Schema = lazyZodSchema(() => z.extend(MachineSetupOperationReferenceV1Schema, {
    backupReceivers: z.optional(z.array(MachineSetupBackupReceiverResultV1Schema)),
}));
