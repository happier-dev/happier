import { z } from 'zod';

import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { PluginMachineExecutionOriginV1Schema } from '../../machines/administration/pluginMachineExecutionOriginV1.js';

export const MACHINE_ADMINISTRATION_SELECTION_KEY_MAX_LENGTH_V1 = 200;
export const MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1 = 256;

const MachineAdministrationSelectionKeyV1Schema = z.string()
  .trim()
  .min(1)
  .max(MACHINE_ADMINISTRATION_SELECTION_KEY_MAX_LENGTH_V1);

export const MachineAdministrationTargetV1Schema = z.object({
  serverIdentityId: z.string().trim().regex(SERVER_IDENTITY_ID_PATTERN),
  machineId: z.string().trim().min(1).max(256),
}).strict();

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

/**
 * Settings owns this versioned Account preference container. Administration
 * owns the meaning of each key and supplies exact validated values.
 *
 * Administration supplies the execution-origin value schema; Settings owns
 * its bounded container and persists values without interpreting selection.
 */
export const MachineAdministrationSelectionsV1Schema = z.object({
  v: z.literal(1).default(1),
  targetsByKey: boundedRecord(MachineAdministrationTargetV1Schema).default({}),
  pluginExecutionOriginsByPluginId: boundedRecord(PluginMachineExecutionOriginV1Schema).default({}),
}).strict();

export type MachineAdministrationSelectionsV1 = z.infer<typeof MachineAdministrationSelectionsV1Schema>;

export const DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1: MachineAdministrationSelectionsV1 =
  Object.freeze(MachineAdministrationSelectionsV1Schema.parse({}));
