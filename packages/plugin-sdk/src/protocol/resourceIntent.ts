import { PluginUiResourceIntentV1Schema as canonicalSchema, type PluginUiResourceIntentV1 as CanonicalPluginUiResourceIntentV1 } from '@happier-dev/protocol/plugins/ui';
import type { ProtocolComposableSchema } from './protocolFacade.js';

export type PluginUiResourceIntentV1 = CanonicalPluginUiResourceIntentV1;
/** The host's exact resource intent grammar, embeddable in feature protocols. */
export const PluginUiResourceIntentV1Schema: ProtocolComposableSchema<PluginUiResourceIntentV1> = canonicalSchema;
