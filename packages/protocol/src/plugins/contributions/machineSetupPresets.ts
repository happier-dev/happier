import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { MachineSetupV1Schema } from '../../machines/managed/machineSetupV1.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginLocalizedStringV2Schema } from './publicTypes.js';

/** Immutable bundled data carries the identical Account/Team Preset setup value. */
export const MachineSetupPresetContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  revision: z.string().check(z.minLength(1)),
  title: PluginLocalizedStringV2Schema,
  description: PluginLocalizedStringV2Schema,
  setup: MachineSetupV1Schema,
}));
export type MachineSetupPresetContributionV1 = z.infer<typeof MachineSetupPresetContributionV1Schema>;
