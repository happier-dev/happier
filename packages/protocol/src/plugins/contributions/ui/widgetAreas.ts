import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema } from '../../actions/protocolComposableSchema.js';
import { PluginJsonSchemaV2Schema } from '../publicTypes.js';

/** Page-local readable data only. The host derives all area identity and access. */
export const PluginUiWidgetAreaDeclarationV1Schema = lazyZodSchema(() => z.object({
    name: asProtocolZod(PluginContributionLocalIdSchema),
    contextSchema: PluginJsonSchemaV2Schema.transform((schema, ctx) => {
        try { return normalizePluginJsonSchema(schema); }
        catch (error) { ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid area context schema' }); return z.NEVER; }
    }),
}).strict());
export type PluginUiWidgetAreaDeclarationV1 = z.infer<typeof PluginUiWidgetAreaDeclarationV1Schema>;
export const PluginUiWidgetAreaDeclarationsV1Schema = lazyZodSchema(() => z.array(PluginUiWidgetAreaDeclarationV1Schema).refine(
    areas => new Set(areas.map(area => area.name)).size === areas.length, 'Duplicate area name'));
