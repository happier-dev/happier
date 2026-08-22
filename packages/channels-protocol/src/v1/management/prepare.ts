import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUniqueArray,
} from '@happier-dev/plugin-sdk/protocol';
import {
    PluginTargetedContributionSelectionV1Schema,
} from '@happier-dev/plugin-sdk/contributions';

import {
    CONVERSATION_OUTBOUND_TEXT_UNITS_V1,
} from '../bounds.js';
import { ConversationConnectionSelectableTransportV1ProtocolSchema } from './connections.js';
import { ConversationEndpointDisplayLabelV1ProtocolSchema } from '../provider/resolution.js';
import { ConversationQualifiedConnectedAccountRefV1ProtocolSchema } from '../provider/connection.js';
import {
    ConversationProviderSetupRemediationV1ProtocolSchema,
} from '../provider/setup.js';
import { ConversationJsonValueV1ProtocolSchema } from '../json.js';

export {
    ConversationProviderSetupRemediationV1JsonSchema,
    ConversationProviderSetupRemediationV1Schema,
} from '../provider/setup.js';
export type { ConversationProviderSetupRemediationV1 } from '../provider/setup.js';

const targetedContributionSelectionV1 = PluginTargetedContributionSelectionV1Schema;

const conversationConnectionPrepareSelectableTransportsV1 = defineProtocolUniqueArray(
    ConversationConnectionSelectableTransportV1ProtocolSchema,
    { minItems: 1, maxItems: 2 },
);

/** @internal Relative-only input for no-invoke provider setup selection. */
export const ConversationConnectionPrepareInputV1ProtocolSchema = defineProtocolObject({
    providerSelection: targetedContributionSelectionV1,
    providerSetupInput: ConversationJsonValueV1ProtocolSchema,
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
}, { policy: 'closed' });

/**
 * Transport-free setup selection. The host-admitted target selection is the
 * only setup Action authority; callers cannot inject an Action identity.
 */
export const ConversationConnectionPrepareInputV1Schema = ConversationConnectionPrepareInputV1ProtocolSchema;
export type ConversationConnectionPrepareInputV1 = ReturnType<
    typeof ConversationConnectionPrepareInputV1Schema.parse
>;
export const ConversationConnectionPrepareInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionPrepareInputV1Schema.jsonSchema;

const conversationConnectionPrepareOutboundTextLimitV1 = defineProtocolObject({
    maximum: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    unit: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_OUTBOUND_TEXT_UNITS_V1[0]),
        defineProtocolLiteral(CONVERSATION_OUTBOUND_TEXT_UNITS_V1[1]),
        defineProtocolLiteral(CONVERSATION_OUTBOUND_TEXT_UNITS_V1[2]),
    ]),
}, { policy: 'closed' });

const conversationConnectionPrepareReadyV1 = defineProtocolObject({
    kind: defineProtocolLiteral('ready'),
    supportedTransports: conversationConnectionPrepareSelectableTransportsV1,
    recommendedTransport: ConversationConnectionSelectableTransportV1ProtocolSchema,
    overlapSafety: defineProtocolUnion([
        defineProtocolLiteral('safe'),
        defineProtocolLiteral('providerExclusive'),
        defineProtocolLiteral('destructive'),
    ]),
    replayContinuity: defineProtocolUnion([
        defineProtocolLiteral('checkpointed'),
        defineProtocolLiteral('sessionBound'),
        defineProtocolLiteral('none'),
    ]),
    outboundTextLimit: conversationConnectionPrepareOutboundTextLimitV1,
    destinationLabel: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
}, { policy: 'closed' });

/**
 * Transport-free preparation projects only the transports current connection
 * creation can select. Final setup, account correspondence, testing, and
 * persistence stay elsewhere.
 */
export const ConversationConnectionPrepareResultV1Schema = defineProtocolUnion([
    conversationConnectionPrepareReadyV1,
    ConversationProviderSetupRemediationV1ProtocolSchema,
]);
export type ConversationConnectionPrepareResultV1 = ReturnType<
    typeof ConversationConnectionPrepareResultV1Schema.parse
>;
export const ConversationConnectionPrepareResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionPrepareResultV1Schema.jsonSchema;
