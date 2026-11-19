import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    ConversationDeliveryResultV1ProtocolSchema,
    ConversationProviderMessageIdV1ProtocolSchema,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
    MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
} from '../bounds.js';
import { ConversationProviderConnectionInputV1Fields } from './connection.js';
import { ConversationResolvedEndpointV1ProtocolSchema } from './resolution.js';
import { ConversationAllowedPrincipalIdsV1Schema } from '../management/targets.js';

export { ConversationProviderMessageIdV1ProtocolSchema };

const conversationDeliveryReplyToMessageV1 = defineProtocolObject({
    replyToMessageId: ConversationProviderMessageIdV1ProtocolSchema,
}, { policy: 'closed' });

const conversationDeliveryThreadV1 = defineProtocolObject({
    threadId: ConversationProviderMessageIdV1ProtocolSchema,
}, { policy: 'closed' });

const conversationDeliveryReplyAndThreadV1 = defineProtocolObject({
    replyToMessageId: ConversationProviderMessageIdV1ProtocolSchema,
    threadId: ConversationProviderMessageIdV1ProtocolSchema,
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationDeliveryReplyContextV1ProtocolSchema = defineProtocolUnion([
    conversationDeliveryReplyToMessageV1,
    conversationDeliveryThreadV1,
    conversationDeliveryReplyAndThreadV1,
]);

/** Provider-native reply/thread addressing with no empty context form. */
export const ConversationDeliveryReplyContextV1Schema = ConversationDeliveryReplyContextV1ProtocolSchema;
export type ConversationDeliveryReplyContextV1 = ReturnType<
    typeof ConversationDeliveryReplyContextV1Schema.parse
>;
export const ConversationDeliveryReplyContextV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationDeliveryReplyContextV1Schema.jsonSchema)();

export const ConversationDeliveryContentV1Schema = defineProtocolObject({
    text: defineProtocolString({ minLength: 1 }),
    html: defineProtocolString().optional(),
}, { policy: 'closed' });
export type ConversationDeliveryContentV1 = ReturnType<typeof ConversationDeliveryContentV1Schema.parse>;
export const ConversationDeliveryContentV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryContentV1Schema.jsonSchema)();

export const ConversationDeliveryNewThreadV1Schema = defineProtocolObject({
    recipients: ConversationAllowedPrincipalIdsV1Schema,
    subject: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
export type ConversationDeliveryNewThreadV1 = ReturnType<typeof ConversationDeliveryNewThreadV1Schema.parse>;
export const ConversationDeliveryNewThreadV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryNewThreadV1Schema.jsonSchema)();

const conversationDeliveryKeyV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
    minLength: 1,
});


const linkPreviewPolicyV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[0]),
    defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[1]),
]);

/** @internal Relative-only input for the required provider delivery role. */
export const ConversationDeliveryInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    content: ConversationDeliveryContentV1Schema,
    newThread: ConversationDeliveryNewThreadV1Schema.optional(),
    deliveryKey: conversationDeliveryKeyV1,
    // Ephemeral core split ordinal: absent/zero is the first provider message.
    chunkIndex: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }).optional(),
    replyContext: ConversationDeliveryReplyContextV1ProtocolSchema.optional(),

    linkPreviewPolicy: linkPreviewPolicyV1,
}, { policy: 'closed' });

export const ConversationDeliveryInputV1Schema = ConversationDeliveryInputV1ProtocolSchema;
export type ConversationDeliveryInputV1 = ReturnType<typeof ConversationDeliveryInputV1Schema.parse>;
export const ConversationDeliveryInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryInputV1Schema.jsonSchema)();

/** @internal Relative-only input for optional delivery reconciliation. */
export const ConversationDeliveryReconcileInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    deliveryKey: conversationDeliveryKeyV1,
}, { policy: 'closed' });

export const ConversationDeliveryReconcileInputV1Schema = ConversationDeliveryReconcileInputV1ProtocolSchema;
export type ConversationDeliveryReconcileInputV1 = ReturnType<
    typeof ConversationDeliveryReconcileInputV1Schema.parse
>;
export const ConversationDeliveryReconcileInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationDeliveryReconcileInputV1Schema.jsonSchema)();

/** Provider delivery effect evidence; delivery/reconciliation inputs remain EU24-held. */
export const ConversationDeliveryResultV1Schema = ConversationDeliveryResultV1ProtocolSchema;
export type ConversationDeliveryResultV1 = ReturnType<typeof ConversationDeliveryResultV1Schema.parse>;
export const ConversationDeliveryResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryResultV1Schema.jsonSchema)();
