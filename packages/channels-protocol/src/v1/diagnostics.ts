import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    ConversationProviderDiagnosticV1ProtocolSchema,
    ConversationProviderFailureV1ProtocolSchema,
    defineProtocolLiteral,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import { CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1 } from './bounds.js';

/** Bounded nonsecret provider detail safe for the Channels owner to disclose. */
export const ConversationProviderDiagnosticV1Schema = ConversationProviderDiagnosticV1ProtocolSchema;
export type ConversationProviderDiagnosticV1 = ReturnType<
    typeof ConversationProviderDiagnosticV1Schema.parse
>;
export const ConversationProviderDiagnosticV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationProviderDiagnosticV1Schema.jsonSchema)();

/** Closed transient outcome for independently valid provider unavailability. */
export const ConversationProviderFailureV1Schema = ConversationProviderFailureV1ProtocolSchema;
export type ConversationProviderFailureV1 = ReturnType<typeof ConversationProviderFailureV1Schema.parse>;
export const ConversationProviderFailureV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationProviderFailureV1Schema.jsonSchema)();

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
    /* @__PURE__ */ (() => ConversationConnectionHistoryGapFactV1Schema.jsonSchema)();

export { ConversationProviderDiagnosticV1ProtocolSchema, ConversationProviderFailureV1ProtocolSchema };
