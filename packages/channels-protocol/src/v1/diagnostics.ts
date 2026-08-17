import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1,
    CONVERSATION_PROVIDER_FAILURE_REASONS_V1,
    MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES,
    MAX_CONVERSATION_RETRY_AFTER_MS,
} from './bounds.js';

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationProviderDiagnosticV1ProtocolSchema = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES,
    minLength: 1,
});

/** Bounded nonsecret provider detail safe for the Channels owner to disclose. */
export const ConversationProviderDiagnosticV1Schema = ConversationProviderDiagnosticV1ProtocolSchema;
export type ConversationProviderDiagnosticV1 = ReturnType<
    typeof ConversationProviderDiagnosticV1Schema.parse
>;
export const ConversationProviderDiagnosticV1JsonSchema: PluginJsonSchema = ConversationProviderDiagnosticV1Schema.jsonSchema;

const conversationProviderFailureReasonV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[0]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[1]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[2]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[3]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[4]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[5]),
    defineProtocolLiteral(CONVERSATION_PROVIDER_FAILURE_REASONS_V1[6]),
]);

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationProviderFailureV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('notReady'),
    reason: conversationProviderFailureReasonV1,
    retryAfterMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_CONVERSATION_RETRY_AFTER_MS,
    }).optional(),
    diagnostic: ConversationProviderDiagnosticV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/** Closed transient outcome for independently valid provider unavailability. */
export const ConversationProviderFailureV1Schema = ConversationProviderFailureV1ProtocolSchema;
export type ConversationProviderFailureV1 = ReturnType<typeof ConversationProviderFailureV1Schema.parse>;
export const ConversationProviderFailureV1JsonSchema: PluginJsonSchema = ConversationProviderFailureV1Schema.jsonSchema;

/** @internal Relative-only fields for composed provider-history schemas. */
export const ConversationProviderHistoryUnavailableV1Fields = {
    reason: defineProtocolLiteral(CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1[0]),
    diagnostic: ConversationProviderDiagnosticV1ProtocolSchema.optional(),
} as const;
export const ConversationProviderHistoryUnavailableV1ProtocolSchema = defineProtocolObject(
    ConversationProviderHistoryUnavailableV1Fields,
    { policy: 'closed' },
);

/** @internal Relative-only fields for composed application-admission schemas. */
export const ConversationApplicationAdmissionLostV1Fields = {
    reason: defineProtocolLiteral(CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1[1]),
} as const;
export const ConversationApplicationAdmissionLostV1ProtocolSchema = defineProtocolObject(
    ConversationApplicationAdmissionLostV1Fields,
    { policy: 'closed' },
);

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationConnectionHistoryGapFactV1ProtocolSchema = defineProtocolUnion([
    ConversationProviderHistoryUnavailableV1ProtocolSchema,
    ConversationApplicationAdmissionLostV1ProtocolSchema,
]);
/**
 * Durable connection evidence shared by poll and transport reporting. Only a
 * provider-history gap may disclose the provider's bounded diagnostic.
 */
export const ConversationConnectionHistoryGapFactV1Schema = ConversationConnectionHistoryGapFactV1ProtocolSchema;
export type ConversationConnectionHistoryGapFactV1 = ReturnType<
    typeof ConversationConnectionHistoryGapFactV1Schema.parse
>;
export const ConversationConnectionHistoryGapFactV1JsonSchema: PluginJsonSchema =
    ConversationConnectionHistoryGapFactV1Schema.jsonSchema;
