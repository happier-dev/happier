import * as zMini from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from '../../zodRuntimePolicy.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginContributionReferenceV2Schema, PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';

/** Data-only declarations; Resources and UI renderers keep their executable owners. */
export const PluginInputTypeContributionV1Schema = lazyZodSchema(() => z.strictObject({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  semantic: z.string().check(z.trim(), z.minLength(1)),
  valueSchema: zMini.pipe(PluginJsonSchemaV2Schema, zMini.transform((schema, ctx) => {
    try { return normalizePluginJsonSchema(schema); }
    catch (error) {
      ctx.issues.push({ code: "custom", message: error instanceof Error ? error.message : 'Invalid value schema', input: ctx.value });
      return z.NEVER;
    }
  })),
  options: z.optional(z.strictObject({
    resource: asProtocolZod(PluginContributionReferenceV2Schema),
  })),
  picker: zMini.optional(asProtocolZod(PluginContributionReferenceV2Schema)),
}));
export type PluginInputTypeContributionV1 = z.infer<typeof PluginInputTypeContributionV1Schema>;
