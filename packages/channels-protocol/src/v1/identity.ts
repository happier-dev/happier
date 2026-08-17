import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES,
} from './bounds.js';

/** Printable ASCII keeps the character and UTF-8 byte limits identical. */
export const CONVERSATION_CHANNEL_RELATION_ID_PRINTABLE_ASCII_PATTERN_V1 = '^[\\x21-\\x7E]+$';

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationChannelRelationIdV1ProtocolSchema = defineProtocolString({
    minLength: 1,
    maxLength: MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES,
    pattern: CONVERSATION_CHANNEL_RELATION_ID_PRINTABLE_ASCII_PATTERN_V1,
});

export const ConversationChannelRelationIdV1Schema = ConversationChannelRelationIdV1ProtocolSchema;
export type ConversationChannelRelationIdV1 = ReturnType<
    typeof ConversationChannelRelationIdV1Schema.parse
>;
export const ConversationChannelRelationIdV1JsonSchema: PluginJsonSchema = ConversationChannelRelationIdV1Schema.jsonSchema;

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
