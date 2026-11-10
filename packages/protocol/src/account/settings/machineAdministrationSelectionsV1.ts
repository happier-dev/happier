import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';

import { SERVER_IDENTITY_ID_PATTERN } from '../../features/payload/capabilities/serverIdentityCapabilities.js';
import { PluginMachineExecutionOriginV1Schema } from '../../machines/administration/pluginMachineExecutionOriginV1.js';
import { MAX_PLUGIN_IDENTIFIER_BYTES } from '../../plugins/pluginId.js';

// Local Run-on entries namespace a canonical plugin id; valid ids must fit in full.
export const MACHINE_ADMINISTRATION_SELECTION_KEY_MAX_LENGTH_V1 = Math.max(200, 'plugin.runOn:'.length + MAX_PLUGIN_IDENTIFIER_BYTES);
export const MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1 = 256;

export const MachineAdministrationSelectionKeyV1Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(MACHINE_ADMINISTRATION_SELECTION_KEY_MAX_LENGTH_V1)));

export const MachineAdministrationTargetV1Schema = lazyZodSchema(() => z.strictObject({
  serverIdentityId: z.string().check(z.trim(), z.regex(SERVER_IDENTITY_ID_PATTERN)),
  machineId: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)),
}));

export type MachineAdministrationTargetV1 = z.infer<typeof MachineAdministrationTargetV1Schema>;

function boundedRecord<T extends z.ZodMiniType>(valueSchema: T) {
  return z.record(MachineAdministrationSelectionKeyV1Schema, valueSchema).check(z.superRefine((value, ctx) => {
    if (Object.keys(value).length > MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1) {
      ctx.addIssue({
        code: 'custom',
        message: `At most ${MACHINE_ADMINISTRATION_SELECTION_MAX_ENTRIES_V1} selections are allowed`,
      });
    }
  }));
}

/** Device-local Administration memory; never part of the Account policy document. */
export const MachineAdministrationTargetsV1Schema = z._default(boundedRecord(MachineAdministrationTargetV1Schema), {});
export type MachineAdministrationTargetsV1 = z.infer<typeof MachineAdministrationTargetsV1Schema>;

/** Retired Account carrier. Stored readers tolerate it; Run-on uses only local target memory. */
export const MachineAdministrationSelectionsV1Schema = lazyZodSchema(() => z.strictObject({
  v: z._default(z.literal(1), 1),
  pluginExecutionOriginsByPluginId: z._default(boundedRecord(PluginMachineExecutionOriginV1Schema), {}),
}));

export type MachineAdministrationSelectionsV1 = z.infer<typeof MachineAdministrationSelectionsV1Schema>;

export const DEFAULT_MACHINE_ADMINISTRATION_SELECTIONS_V1: MachineAdministrationSelectionsV1 =
  Object.freeze(MachineAdministrationSelectionsV1Schema.parse({}));
