import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1,
    CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
    CONVERSATION_DELIVERY_MENTION_POLICIES_V1,
    CONVERSATION_DELIVERY_RETRY_KINDS_V1,
    MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
    MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
} from '../bounds.js';
import { ConversationProviderConnectionInputV1Fields } from './connection.js';
import { ConversationResolvedEndpointV1ProtocolSchema } from './resolution.js';
import { ConversationAllowedPrincipalIdsV1Schema } from '../management/targets.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';

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

const mentionPolicyV1 = defineProtocolLiteral(CONVERSATION_DELIVERY_MENTION_POLICIES_V1[0]);
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
    mentionPolicy: mentionPolicyV1,
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

const conversationProviderMessageIdsV1 = defineProtocolArray(
    ConversationProviderMessageIdV1ProtocolSchema,
);

const conversationDeliveredV1 = defineProtocolObject({
    kind: defineProtocolLiteral('delivered'),
    providerMessageIds: conversationProviderMessageIdsV1,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema.optional(),
}, { policy: 'closed' });

const conversationPartialDeliveryV1 = defineProtocolObject({
    kind: defineProtocolLiteral('partial'),
    providerMessageIds: conversationProviderMessageIdsV1,
    failedChunk: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    retrySafe: defineProtocolLiteral(false),
}, { policy: 'closed' });

// Content-free effect evidence only: codes never carry provider prose, addresses,
// message identities or credentials, and never decide custody retry policy.
const conversationDeliveryResultCodeV1 = defineProtocolUnion([
    defineProtocolLiteral('invalidConfiguration'),
    defineProtocolLiteral('invalidEndpoint'),
    defineProtocolLiteral('replyContextMissing'),
    defineProtocolLiteral('replyMessageMismatch'),
    defineProtocolLiteral('replyThreadMismatch'),
    defineProtocolLiteral('senderUntrusted'),
    defineProtocolLiteral('senderNotHuman'),
    defineProtocolLiteral('integrationSelf'),
    defineProtocolLiteral('recipientInvalid'),
    defineProtocolLiteral('credentialInvalid'),
    defineProtocolLiteral('permissionMissing'),
    defineProtocolLiteral('network'),
    defineProtocolLiteral('rateLimited'),
    defineProtocolLiteral('providerConflict'),
    defineProtocolLiteral('unsupported'),
    defineProtocolLiteral('submissionNotStarted'),
    defineProtocolLiteral('submissionOutcomeUnknown'),
    defineProtocolLiteral('noRecipientsAccepted'),
    defineProtocolLiteral('submissionRejected'),
    defineProtocolLiteral('submissionTemporarilyRejected'),
    defineProtocolLiteral('sentCopyUnconfirmed'),
    defineProtocolLiteral('reconciliationUnsupported'),
    defineProtocolLiteral('reconciliationNotFound'),
    defineProtocolLiteral('reconciliationMismatch'),
    defineProtocolLiteral('providerResultInvalid'),
    defineProtocolLiteral('providerInvocationFailed'),
    defineProtocolLiteral('providerInvocationUnavailable'),
    defineProtocolLiteral('contentUnrepresentable'),
]);

const conversationNotDeliveredV1 = defineProtocolObject({
    kind: defineProtocolLiteral('notDelivered'),
    code: conversationDeliveryResultCodeV1.optional(),
    retry: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[1]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_RETRY_KINDS_V1[2]),
    ]),
    retryAfterMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
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
    code: conversationDeliveryResultCodeV1.optional(),
    providerMessageIds: conversationProviderMessageIdsV1.optional(),
    endpoint: ConversationResolvedEndpointV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationDeliveryResultV1ProtocolSchema = defineProtocolUnion([
    ConversationProviderFailureV1ProtocolSchema,
    conversationDeliveredV1,
    conversationPartialDeliveryV1,
    conversationNotDeliveredV1,
    conversationEndpointArchivedV1,
    conversationOutcomeUnknownV1,
]);

/** Provider delivery effect evidence; delivery/reconciliation inputs remain EU24-held. */
export const ConversationDeliveryResultV1Schema = ConversationDeliveryResultV1ProtocolSchema;
export type ConversationDeliveryResultV1 = ReturnType<typeof ConversationDeliveryResultV1Schema.parse>;
export const ConversationDeliveryResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryResultV1Schema.jsonSchema)();
