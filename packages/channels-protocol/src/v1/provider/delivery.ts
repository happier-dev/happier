import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1,
    CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
    CONVERSATION_DELIVERY_MENTION_POLICIES_V1,
    CONVERSATION_DELIVERY_RETRY_KINDS_V1,
    MAX_CONVERSATION_DELIVERY_CHUNKS,
    MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES,
    MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
    MAX_CONVERSATION_RETRY_AFTER_MS,
    MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
} from '../bounds.js';
import { ConversationProviderConnectionInputV1Fields } from './connection.js';
import { ConversationResolvedEndpointV1ProtocolSchema } from './resolution.js';

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationProviderMessageIdV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
    minLength: 1,
});

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
    ConversationDeliveryReplyContextV1Schema.jsonSchema;

const conversationDeliveryContentV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES,
    minLength: 1,
});

const conversationDeliveryKeyV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
    minLength: 1,
});

const mentionPolicyV1 = defineProtocolLiteral(CONVERSATION_DELIVERY_MENTION_POLICIES_V1[0]);
const linkPreviewPolicyV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[0]),
    defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[1]),
]);

/** @internal Relative-only input for the required provider delivery role. */
export const ConversationDeliveryInputV1ProtocolSchema = defineProtocolObject({
    ...ConversationProviderConnectionInputV1Fields,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    content: conversationDeliveryContentV1,
    deliveryKey: conversationDeliveryKeyV1,
    replyContext: ConversationDeliveryReplyContextV1ProtocolSchema.optional(),
    mentionPolicy: mentionPolicyV1,
    linkPreviewPolicy: linkPreviewPolicyV1,
}, { policy: 'closed' });

export const ConversationDeliveryInputV1Schema = ConversationDeliveryInputV1ProtocolSchema;
export type ConversationDeliveryInputV1 = ReturnType<typeof ConversationDeliveryInputV1Schema.parse>;
export const ConversationDeliveryInputV1JsonSchema: PluginJsonSchema = ConversationDeliveryInputV1Schema.jsonSchema;

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
    ConversationDeliveryReconcileInputV1Schema.jsonSchema;

const conversationProviderMessageIdsV1 = defineProtocolArray(
    ConversationProviderMessageIdV1ProtocolSchema,
    { maxItems: MAX_CONVERSATION_DELIVERY_CHUNKS },
);

const conversationDeliveredV1 = defineProtocolObject({
    kind: defineProtocolLiteral('delivered'),
    providerMessageIds: conversationProviderMessageIdsV1,
}, { policy: 'closed' });

const conversationPartialDeliveryV1 = defineProtocolObject({
    kind: defineProtocolLiteral('partial'),
    providerMessageIds: conversationProviderMessageIdsV1,
    failedChunk: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_CONVERSATION_DELIVERY_CHUNKS,
    }),
    retrySafe: defineProtocolLiteral(false),
}, { policy: 'closed' });

const conversationNotDeliveredV1 = defineProtocolObject({
    kind: defineProtocolLiteral('notDelivered'),
    retry: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[1]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[2]),
    ]),
    retryAfterMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_CONVERSATION_RETRY_AFTER_MS,
    }).optional(),
}, { policy: 'closed' });

const conversationEndpointArchivedV1 = defineProtocolObject({
    kind: defineProtocolLiteral('endpointArchived'),
    recovery: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1[1]),
    ]),
}, { policy: 'closed' });

const conversationOutcomeUnknownV1 = defineProtocolObject({
    kind: defineProtocolLiteral('outcomeUnknown'),
    providerMessageIds: conversationProviderMessageIdsV1.optional(),
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationDeliveryResultV1ProtocolSchema = defineProtocolUnion([
    conversationDeliveredV1,
    conversationPartialDeliveryV1,
    conversationNotDeliveredV1,
    conversationEndpointArchivedV1,
    conversationOutcomeUnknownV1,
]);

/** Provider delivery effect evidence; delivery/reconciliation inputs remain EU24-held. */
export const ConversationDeliveryResultV1Schema = ConversationDeliveryResultV1ProtocolSchema;
export type ConversationDeliveryResultV1 = ReturnType<typeof ConversationDeliveryResultV1Schema.parse>;
export const ConversationDeliveryResultV1JsonSchema: PluginJsonSchema = ConversationDeliveryResultV1Schema.jsonSchema;
