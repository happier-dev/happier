import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
    type PluginJsonSchema,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationProviderConnectionInputV1Fields } from './connection.js';
import { ConversationProviderMessageIdV1ProtocolSchema } from './delivery.js';
import { ConversationResolvedEndpointV1ProtocolSchema } from './resolution.js';

/** Content-free Session work state, optionally editing the provider's existing status message. */
export const ConversationSessionStatusInputV1Schema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    status: defineProtocolUnion([
        defineProtocolLiteral('received'),
        defineProtocolLiteral('working'),
        defineProtocolLiteral('waitingForApproval'),
        defineProtocolLiteral('idle'),
    ]),
    providerMessageId: ConversationProviderMessageIdV1ProtocolSchema.optional(),
}, { policy: 'closed' });

export type ConversationSessionStatusInputV1 = ReturnType<typeof ConversationSessionStatusInputV1Schema.parse>;
export const ConversationSessionStatusInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationSessionStatusInputV1Schema.jsonSchema)();
