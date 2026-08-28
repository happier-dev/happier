import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES,
} from '../bounds.js';
import {
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import {
    ConversationIngressAutomationEventCandidateV1ProtocolSchema,
} from '../core/ingress.js';

const conversationOccurrenceIdV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES,
    minLength: 1,
});
const nonNegativeSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

/** @internal Relative-only provider Action input for one frozen Channels Event obligation. */
export const ConversationProviderAutomationEventAdmitInputV1ProtocolSchema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    candidate: ConversationIngressAutomationEventCandidateV1ProtocolSchema,
    occurrenceId: conversationOccurrenceIdV1,
    occurredAt: nonNegativeSafeInteger,
    observationReceivedAt: nonNegativeSafeInteger,
    observedDelta: defineProtocolUnion([
        defineProtocolLiteral(0),
        defineProtocolLiteral(1),
    ]),
}, { policy: 'closed' });

/**
 * The core invokes this only through the selected provider contribution and
 * its frozen execution origin. The provider may list and admit its current
 * Automation definitions, but owns no cursor, retry scheduler, or checkpoint.
 */
export const ConversationProviderAutomationEventAdmitInputV1Schema =
    ConversationProviderAutomationEventAdmitInputV1ProtocolSchema;
export type ConversationProviderAutomationEventAdmitInputV1 = ReturnType<
    typeof ConversationProviderAutomationEventAdmitInputV1Schema.parse
>;
export const ConversationProviderAutomationEventAdmitInputV1JsonSchema: PluginJsonSchema =
    ConversationProviderAutomationEventAdmitInputV1Schema.jsonSchema;

/** @internal Relative-only bounded settlement returned to Channels' checkpoint owner. */
export const ConversationProviderAutomationEventAdmitResultV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('checkpointSafe') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('unsettled') }, { policy: 'closed' }),
]);

export const ConversationProviderAutomationEventAdmitResultV1Schema =
    ConversationProviderAutomationEventAdmitResultV1ProtocolSchema;
export type ConversationProviderAutomationEventAdmitResultV1 = ReturnType<
    typeof ConversationProviderAutomationEventAdmitResultV1Schema.parse
>;
export const ConversationProviderAutomationEventAdmitResultV1JsonSchema: PluginJsonSchema =
    ConversationProviderAutomationEventAdmitResultV1Schema.jsonSchema;
