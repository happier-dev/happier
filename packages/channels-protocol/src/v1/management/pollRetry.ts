import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
} from '@happier-dev/plugin-sdk/protocol';

import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import type { ConversationActionDeclarationV1 } from '../actionDeclarations.js';

const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});

const conversationConnectionPollRetryInputV1 = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
}, { policy: 'closed' });

const conversationConnectionPollRetryResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('retryScheduled'),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
}, { policy: 'closed' });

export const ConversationConnectionPollRetryInputV1Schema = conversationConnectionPollRetryInputV1;
export type ConversationConnectionPollRetryInputV1 = ReturnType<
    typeof ConversationConnectionPollRetryInputV1Schema.parse
>;
export const ConversationConnectionPollRetryInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionPollRetryInputV1Schema.jsonSchema;

export const ConversationConnectionPollRetryResultV1Schema = conversationConnectionPollRetryResultV1;
export type ConversationConnectionPollRetryResultV1 = ReturnType<
    typeof ConversationConnectionPollRetryResultV1Schema.parse
>;
export const ConversationConnectionPollRetryResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionPollRetryResultV1Schema.jsonSchema;

/** The exact manifest-facing declaration for the present-user retry action. */
export const ConversationConnectionPollRetryManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionPollRetryInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionPollRetryResultV1Schema.jsonSchema,
});
