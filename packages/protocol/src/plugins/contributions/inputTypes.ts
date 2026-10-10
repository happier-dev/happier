import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema } from '../actions/protocolComposableSchema.js';
import { PluginContributionLocalIdSchema } from '../contributionIdentity.js';
import { PluginContributionReferenceV2Schema, PluginJsonSchemaV2Schema, PluginLocalizedStringV2Schema } from './publicTypes.js';

/** Data-only declarations; Resources and UI renderers keep their executable owners. */
export const PluginInputTypeContributionV1Schema = lazyZodSchema(() => z.object({
  id: asProtocolZod(PluginContributionLocalIdSchema),
  title: PluginLocalizedStringV2Schema,
  semantic: z.string().trim().min(1),
  valueSchema: PluginJsonSchemaV2Schema.transform((schema, ctx) => {
    try { return normalizePluginJsonSchema(schema); }
    catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : 'Invalid value schema' });
      return z.NEVER;
    }
  }),
  options: z.object({
    resource: asProtocolZod(PluginContributionReferenceV2Schema),
  }).strict().optional(),
  picker: asProtocolZod(PluginContributionReferenceV2Schema).optional(),
}).strict());
export type PluginInputTypeContributionV1 = z.infer<typeof PluginInputTypeContributionV1Schema>;
