import {
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import { SessionIdSchema } from '@happier-dev/plugin-sdk/sessions';
import { ConversationBindingIdV1Schema } from '../identity.js';
import { ConversationDeliveryContentV1Schema } from '../provider/delivery.js';

/** Audience membership is owner-configured; callers never supply recipients. */
export const ConversationStartInputV1Schema = defineProtocolObject({
    routerBindingId: ConversationBindingIdV1Schema,
    audienceGroupId: defineProtocolString({ minLength: 1 }),
    subject: defineProtocolString({ minLength: 1 }),
    content: ConversationDeliveryContentV1Schema,
    sessionId: SessionIdSchema,
}, { policy: 'closed' });
export type ConversationStartInputV1 = ReturnType<typeof ConversationStartInputV1Schema.parse>;
export const ConversationStartInputV1JsonSchema = /* @__PURE__ */ (() => ConversationStartInputV1Schema.jsonSchema)();

export const ConversationStartResultV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('accepted'),
    custodyId: defineProtocolString({ pattern: '^[A-Za-z0-9_-]{43}$' }),
}, { policy: 'closed' });
export type ConversationStartResultV1 = ReturnType<typeof ConversationStartResultV1Schema.parse>;
export const ConversationStartResultV1JsonSchema = /* @__PURE__ */ (() => ConversationStartResultV1Schema.jsonSchema)();

/** The host invocation identity addresses the existing delivery custody row. */
export const ConversationStartSourceV1Schema = defineProtocolObject({
    kind: defineProtocolLiteral('conversationStart'),
    sessionId: SessionIdSchema,
    requestId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export type ConversationStartSourceV1 = ReturnType<typeof ConversationStartSourceV1Schema.parse>;
export const ConversationStartSourceV1JsonSchema = /* @__PURE__ */ (() => ConversationStartSourceV1Schema.jsonSchema)();
