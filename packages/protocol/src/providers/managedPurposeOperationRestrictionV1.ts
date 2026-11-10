import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { PluginLocalizedStringV2Schema } from '../plugins/contributions/publicTypes.js';

/** Author-owned presentation of an existing operation restriction; never an admission policy. */
export const ProviderManagedPurposeOperationRestrictionV1Schema = lazyZodSchema(() => z.strictObject({
  summary: PluginLocalizedStringV2Schema,
  sentence: PluginLocalizedStringV2Schema,
}));
