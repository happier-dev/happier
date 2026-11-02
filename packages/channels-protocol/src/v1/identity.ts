import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolNumber,
    defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import { PLUGIN_COLLECTION_REVISION_MAX } from '@happier-dev/plugin-sdk/collections';

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
export const ConversationChannelRelationIdV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationChannelRelationIdV1Schema.jsonSchema)();

export const ConversationConnectionIdV1Schema = ConversationChannelRelationIdV1Schema;
export type ConversationConnectionIdV1 = ConversationChannelRelationIdV1;
export const ConversationConnectionIdV1JsonSchema: PluginJsonSchema = ConversationChannelRelationIdV1JsonSchema;
/** @internal Relative-only alias; do not export from the public V1 barrel. */
export const ConversationConnectionIdV1ProtocolSchema = ConversationChannelRelationIdV1ProtocolSchema;

/**
 * @internal Relative-only witness of one exact Account Collection row revision.
 *
 * Binding, obligation, frontier, and delivery-custody revision witnesses name
 * that row's `PluginCollectionRow.revision`. Connection management instead
 * projects its logical configuration revision, initialized by migration from
 * the physical row revision and advanced only by semantic connection changes.
 * It cannot advance faster than the physical row. Their ceiling therefore
 * belongs to the Collection owner's persisted `Int` column, not to a Channels
 * policy number: admitting a wider value would let a caller name an exact-CAS
 * revision only the SQLite provider can ever reproduce.
 *
 * Authority epochs and Channels-owned payload counters are separate spaces that
 * this package advances itself, and they keep their own safe-integer bound.
 */
export const ConversationCollectionRowRevisionV1ProtocolSchema = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: PLUGIN_COLLECTION_REVISION_MAX,
});

export const ConversationBindingIdV1Schema = ConversationChannelRelationIdV1Schema;
export type ConversationBindingIdV1 = ConversationChannelRelationIdV1;
export const ConversationBindingIdV1JsonSchema: PluginJsonSchema = ConversationChannelRelationIdV1JsonSchema;
/** @internal Relative-only alias; do not export from the public V1 barrel. */
export const ConversationBindingIdV1ProtocolSchema = ConversationChannelRelationIdV1ProtocolSchema;
