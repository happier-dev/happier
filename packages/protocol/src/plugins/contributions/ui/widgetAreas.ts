import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from '../../../zodRuntimePolicy.js';
import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { asProtocolZod } from '../../actions/internalProtocolZodAdapter.js';
import { normalizePluginJsonSchema } from '../../actions/protocolComposableSchema.js';
import { PluginJsonSchemaV2Schema } from '../publicTypes.js';

/** Page-local readable data only. The host derives all area identity and access. */
export const PluginUiWidgetAreaDeclarationV1Schema = lazyZodSchema(() => z.strictObject({
    name: asProtocolZod(PluginContributionLocalIdSchema),
    contextSchema: z.pipe(PluginJsonSchemaV2Schema, z.transform((schema, ctx) => {
        try { return normalizePluginJsonSchema(schema); }
        catch (error) { ctx.issues.push({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid area context schema', input: ctx.value }); return z.NEVER; }
    })),
}));
export type PluginUiWidgetAreaDeclarationV1 = z.infer<typeof PluginUiWidgetAreaDeclarationV1Schema>;
export const PluginUiWidgetAreaDeclarationsV1Schema = lazyZodSchema(() => z.array(PluginUiWidgetAreaDeclarationV1Schema).check(z.refine(areas => new Set(areas.map(area => area.name)).size === areas.length, 'Duplicate area name')));
