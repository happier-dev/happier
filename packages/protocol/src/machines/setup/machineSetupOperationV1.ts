import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineSetupBackupReceiverResultV1Schema } from './backupReceiverV1.js';

const id = () => z.string().check(z.trim(), z.minLength(1));

/** Ordinary Setup operation links, shared by its result and partial recovery. */
export const MachineSetupOperationReferenceV1Schema = lazyZodSchema(() => z.strictObject({
    operationId: id(), terminalId: z.optional(id()), runId: z.optional(id()),
}));
export type MachineSetupOperationReferenceV1 = z.infer<typeof MachineSetupOperationReferenceV1Schema>;

export const MachineSetupApplyResultV1Schema = lazyZodSchema(() => z.extend(MachineSetupOperationReferenceV1Schema, {
    backupReceivers: z.optional(z.array(MachineSetupBackupReceiverResultV1Schema)),
}));
