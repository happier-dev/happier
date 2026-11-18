import { PluginUiResourceIntentV1Schema as canonicalSchema, PluginUiOpenResourceIntentV1Schema as canonicalOpenSchema,
    type PluginUiResourceIntentV1 as CanonicalPluginUiResourceIntentV1, type PluginUiOpenResourceIntentV1 as CanonicalPluginUiOpenResourceIntentV1 } from '@happier-dev/protocol/plugins/contributions/ui/resourceLinks';
import type { ProtocolComposableSchema } from './protocolFacade.js';

export type PluginUiResourceIntentV1 = CanonicalPluginUiResourceIntentV1;
/** The host's exact resource intent grammar, embeddable in feature protocols. */
export const PluginUiResourceIntentV1Schema: ProtocolComposableSchema<PluginUiResourceIntentV1> = canonicalSchema;
export type PluginUiOpenResourceIntentV1 = CanonicalPluginUiOpenResourceIntentV1;
export const PluginUiOpenResourceIntentV1Schema: ProtocolComposableSchema<PluginUiOpenResourceIntentV1> = canonicalOpenSchema;
