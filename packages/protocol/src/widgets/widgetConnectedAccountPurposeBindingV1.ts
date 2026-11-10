import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { PluginActionConnectedAccountPurposeBindingV2Schema } from '../plugins/actions/connectedAccountPurposeBindingV2.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

/** The declared read consumer owns the purpose; an instance never selects credentials. */
export const WidgetConnectedAccountPurposeBindingV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(PluginActionConnectedAccountPurposeBindingV2Schema, {
    consumer: asProtocolZod(PluginContributionIdentityV1Schema),
})));
export type WidgetConnectedAccountPurposeBindingV1 = z.infer<typeof WidgetConnectedAccountPurposeBindingV1Schema>;
