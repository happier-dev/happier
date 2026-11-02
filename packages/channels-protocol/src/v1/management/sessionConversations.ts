import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationBindingIdV1ProtocolSchema } from '../identity.js';

export const ConversationSessionLastDeliveryOutcomeV1Schema = defineProtocolUnion([
    defineProtocolLiteral('delivered'),
    defineProtocolLiteral('notDelivered'),
    defineProtocolLiteral('pending'),
    defineProtocolLiteral('unknown'),
]);
export const ConversationSessionLastDeliveryOutcomeV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationSessionLastDeliveryOutcomeV1Schema.jsonSchema)();

/** A read-only custody summary; resolution never proves complete provider delivery. */
export const ConversationSessionLastDeliveryV1Schema = defineProtocolObject({
    bindingId: ConversationBindingIdV1ProtocolSchema,
    /** Existing custody row update time, not an exact provider send time. */
    atMs: defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    outcome: ConversationSessionLastDeliveryOutcomeV1Schema,
}, { policy: 'closed' });
export type ConversationSessionLastDeliveryV1 = ReturnType<typeof ConversationSessionLastDeliveryV1Schema.parse>;
export type ConversationSessionLastDeliveryOutcomeV1 = ConversationSessionLastDeliveryV1['outcome'];
export const ConversationSessionLastDeliveryV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationSessionLastDeliveryV1Schema.jsonSchema)();

/** Optional `lastDeliveries` sibling in `session-conversations-v1`, at most one per binding. */
export const ConversationSessionLastDeliveriesV1Schema = defineProtocolArray(
    ConversationSessionLastDeliveryV1Schema,
);
export type ConversationSessionLastDeliveriesV1 = ReturnType<typeof ConversationSessionLastDeliveriesV1Schema.parse>;
export const ConversationSessionLastDeliveriesV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationSessionLastDeliveriesV1Schema.jsonSchema)();
