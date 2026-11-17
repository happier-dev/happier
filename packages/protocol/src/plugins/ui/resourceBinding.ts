import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { PluginResourceContextV1Schema } from './surfaceContext.js';
import { PluginUiRuntimeOccurrenceIdV1Schema, type PluginUiRuntimeOccurrenceIdV1 } from './targetedContributions.js';
import { asProtocolZod } from '../actions/internalProtocolZodAdapter.js';

type PluginUiDeclaredResourceBindingShapeV1 = {
    expectedCallerOccurrenceId: z.ZodMiniType<PluginUiRuntimeOccurrenceIdV1, PluginUiRuntimeOccurrenceIdV1>;
    callerPluginId: z.ZodMiniString;
    resource: z.ZodMiniObject<{
        pluginId: z.ZodMiniString;
        localId: z.ZodMiniString;
    }, z.core.$strict>;
    context: z.ZodMiniOptional<typeof PluginResourceContextV1Schema>;
};

/** The mounted caller and contextual Resource selected by the existing UI host. */
export const PluginUiDeclaredResourceBindingV1Schema: z.ZodMiniObject<PluginUiDeclaredResourceBindingShapeV1, z.core.$strict> = lazyZodSchema(() => z.strictObject({
    expectedCallerOccurrenceId: asProtocolZod(PluginUiRuntimeOccurrenceIdV1Schema),
    callerPluginId: z.string().check(z.trim(), z.minLength(1)),
    resource: z.strictObject({ pluginId: z.string().check(z.trim(), z.minLength(1)),
        localId: z.string().check(z.trim(), z.minLength(1)) }),
    context: z.optional(PluginResourceContextV1Schema),
}));
