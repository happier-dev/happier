import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

import {
    ConversationCollectionRowRevisionV1ProtocolSchema,
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import type { ConversationActionDeclarationV1 } from '../actionDeclarations.js';

/**
 * A Channels-owned authority epoch. It is advanced by this package rather
 * than persisted as a Collection row revision, so it keeps the wide
 * safe-integer bound instead of the Collection column ceiling.
 */
const authorityEpochV1 = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
/** One exact Account Collection row revision witness; see its Protocol owner. */
const collectionRowRevision = ConversationCollectionRowRevisionV1ProtocolSchema;

const conversationConnectionPollRetryInputV1 = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: collectionRowRevision,
    authorityEpoch: authorityEpochV1,
}, { policy: 'closed' });

const conversationConnectionPollRetryResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('retryScheduled'),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: collectionRowRevision,
    authorityEpoch: authorityEpochV1,
}, { policy: 'closed' });

export const ConversationConnectionPollRetryInputV1Schema = conversationConnectionPollRetryInputV1;
export type ConversationConnectionPollRetryInputV1 = ReturnType<
    typeof ConversationConnectionPollRetryInputV1Schema.parse
>;
export const ConversationConnectionPollRetryInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionPollRetryInputV1Schema.jsonSchema)();

export const ConversationConnectionPollRetryResultV1Schema = conversationConnectionPollRetryResultV1;
export type ConversationConnectionPollRetryResultV1 = ReturnType<
    typeof ConversationConnectionPollRetryResultV1Schema.parse
>;
export const ConversationConnectionPollRetryResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationConnectionPollRetryResultV1Schema.jsonSchema)();

/** The exact manifest-facing declaration for the present-user retry action. */
export const ConversationConnectionPollRetryManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionPollRetryInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionPollRetryResultV1Schema.jsonSchema,
});
