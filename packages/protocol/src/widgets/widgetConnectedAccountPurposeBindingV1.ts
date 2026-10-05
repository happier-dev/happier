import { z } from 'zod';
import { PluginActionConnectedAccountPurposeBindingV2Schema } from '../plugins/actions/connectedAccountPurposeBindingV2.js';
import { PluginContributionIdentityV1Schema } from '../plugins/contributionIdentity.js';
import { asProtocolZod } from '../plugins/actions/internalProtocolZodAdapter.js';

/** The declared read consumer owns the purpose; an instance never selects credentials. */
export const WidgetConnectedAccountPurposeBindingV1Schema = PluginActionConnectedAccountPurposeBindingV2Schema.extend({
    consumer: asProtocolZod(PluginContributionIdentityV1Schema),
}).strict();
export type WidgetConnectedAccountPurposeBindingV1 = z.infer<typeof WidgetConnectedAccountPurposeBindingV1Schema>;
