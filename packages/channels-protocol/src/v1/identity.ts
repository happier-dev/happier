import { ConversationChannelRelationIdV1ProtocolSchema, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

export {
    CONVERSATION_CHANNEL_RELATION_ID_PRINTABLE_ASCII_PATTERN_V1,
    ConversationChannelRelationIdV1ProtocolSchema,
    ConversationCollectionRowRevisionV1ProtocolSchema,
} from '@happier-dev/plugin-sdk/protocol';

export const ConversationChannelRelationIdV1Schema = ConversationChannelRelationIdV1ProtocolSchema;
export type ConversationChannelRelationIdV1 = ReturnType<
    typeof ConversationChannelRelationIdV1Schema.parse
>;
export const ConversationChannelRelationIdV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationChannelRelationIdV1Schema.jsonSchema)();

export const ConversationConnectionIdV1Schema = ConversationChannelRelationIdV1Schema;
export type ConversationConnectionIdV1 = ConversationChannelRelationIdV1;
export const ConversationConnectionIdV1JsonSchema: PluginJsonSchema = ConversationChannelRelationIdV1JsonSchema;
/** @internal Relative-only alias; do not export from the public V1 barrel. */
export const ConversationConnectionIdV1ProtocolSchema = ConversationChannelRelationIdV1ProtocolSchema;

export const ConversationBindingIdV1Schema = ConversationChannelRelationIdV1Schema;
export type ConversationBindingIdV1 = ConversationChannelRelationIdV1;
export const ConversationBindingIdV1JsonSchema: PluginJsonSchema = ConversationChannelRelationIdV1JsonSchema;
/** @internal Relative-only alias; do not export from the public V1 barrel. */
export const ConversationBindingIdV1ProtocolSchema = ConversationChannelRelationIdV1ProtocolSchema;
