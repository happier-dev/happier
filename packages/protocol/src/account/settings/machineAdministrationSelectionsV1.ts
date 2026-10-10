import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { PluginMachineExecutionOriginV1Schema } from '../../machines/administration/pluginMachineExecutionOriginV1.js';

export const MACHINE_ADMINISTRATION_SELECTION_KEY_MAX_LENGTH_V1 = 200;
export const MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1 = 256;

const MachineAdministrationSelectionKeyV1Schema = lazyZodSchema(() => z.string()
  .trim()
  .min(1)
  .max(MACHINE_ADMINISTRATION_SELECTION_KEY_MAX_LENGTH_V1));

export const MachineAdministrationTargetV1Schema = lazyZodSchema(() => z.object({
  serverIdentityId: z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN),
  machineId: z.string().trim().min(1).max(256),
}).strict());

export type MachineAdministrationTargetV1 = z.infer<typeof MachineAdministrationTargetV1Schema>;

function boundedRecord<T extends z.ZodType>(valueSchema: T) {
  return z.record(MachineAdministrationSelectionKeyV1Schema, valueSchema).superRefine((value, ctx) => {
    if (Object.keys(value).length > MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1} selections are allowed`,
      });
    }
  });
}

/** Device-local Administration memory; never part of the Account policy document. */
export const MachineAdministrationTargetsV1Schema = boundedRecord(MachineAdministrationTargetV1Schema).default({});
export type MachineAdministrationTargetsV1 = z.infer<typeof MachineAdministrationTargetsV1Schema>;

/** Portable execution-origin policy, distinct from device target memory. */
export const MachineAdministrationSelectionsV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1).default(1),
  pluginExecutionOriginsByPluginId: boundedRecord(PluginMachineExecutionOriginV1Schema).default({}),
}).strict());

export type MachineAdministrationSelectionsV1 = z.infer<typeof MachineAdministrationSelectionsV1Schema>;

export const DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1: MachineAdministrationSelectionsV1 =
  Object.freeze(MachineAdministrationSelectionsV1Schema.parse({}));
