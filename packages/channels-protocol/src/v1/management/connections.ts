import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';
import {
    PluginTargetedContributionSelectionV1Schema,
} from '@happier-dev/plugin-sdk/contributions';

import {
    MAX_CONVERSATION_OBSERVATION_AGE_MS,
    MIN_CONVERSATION_OBSERVATION_AGE_MS,
} from '../bounds.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import { ConversationJsonValueV1ProtocolSchema } from '../json.js';
import { ConversationQualifiedConnectedAccountRefV1ProtocolSchema } from '../provider/connection.js';

const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
const observationAgeV1 = defineProtocolNumber({
    integer: true,
    minimum: MIN_CONVERSATION_OBSERVATION_AGE_MS,
    maximum: MAX_CONVERSATION_OBSERVATION_AGE_MS,
});
const protocolBoolean = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);
const selectableTransportV1 = defineProtocolUnion([
    defineProtocolLiteral('checkpointedPull'),
    defineProtocolLiteral('socket'),
]);
const targetedContributionSelectionV1 = PluginTargetedContributionSelectionV1Schema;

const conversationConnectionMutationResultV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('updated'),
        defineProtocolLiteral('unchanged'),
    ]),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
}, { policy: 'closed' });

const conversationConnectionCreateResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('created'),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('rejoined'),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
    }, { policy: 'closed' }),
    ConversationProviderFailureV1ProtocolSchema,
]);

const conversationConnectionTransferResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolUnion([
            defineProtocolLiteral('transferred'),
            defineProtocolLiteral('rejoined'),
            defineProtocolLiteral('transferPendingOldStop'),
        ]),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
        revision: positiveSafeInteger,
        authorityEpoch: positiveSafeInteger,
    }, { policy: 'closed' }),
    ConversationProviderFailureV1ProtocolSchema,
]);

const conversationConnectionDeleteResultV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('deletePending'),
        defineProtocolLiteral('deleteFinalizing'),
        defineProtocolLiteral('rejoined'),
    ]),
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    revision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
    acceptedPossibleLoss: protocolBoolean,
}, { policy: 'closed' });

/**
 * Durable-push creation is deliberately outside this public contract until
 * the generic endpoint ensure/correspondence lifecycle is available as one
 * consumed vertical. This arm retains only the transports whose create input
 * has no caller-owned endpoint or preallocated-connection authority.
 */
const conversationConnectionCreateInputV1 = defineProtocolObject({
    providerSelection: targetedContributionSelectionV1,
    providerSetupInput: ConversationJsonValueV1ProtocolSchema,
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
    selectedTransport: selectableTransportV1,
    maximumObservationAgeMs: observationAgeV1,
}, { policy: 'closed' });

/**
 * The present-user create contract for transports that need no webhook
 * endpoint authority. The admitted selection is the only setup-role identity.
 */
export const ConversationConnectionCreateInputV1Schema = conversationConnectionCreateInputV1;
export type ConversationConnectionCreateInputV1 = ReturnType<
    typeof ConversationConnectionCreateInputV1Schema.parse
>;
export const ConversationConnectionCreateInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionCreateInputV1Schema.jsonSchema;

/**
 * A transfer selects a newly admitted provider contribution and setup contract
 * for one existing connection revision. It deliberately omits policy fields,
 * caller-owned origins, and durable-push endpoint authority.
 */
export const ConversationConnectionTransferInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    providerSelection: targetedContributionSelectionV1,
    providerSetupInput: ConversationJsonValueV1ProtocolSchema,
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
    selectedTransport: selectableTransportV1,
}, { policy: 'closed' });
export type ConversationConnectionTransferInputV1 = ReturnType<
    typeof ConversationConnectionTransferInputV1Schema.parse
>;
export const ConversationConnectionTransferInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionTransferInputV1Schema.jsonSchema;

export const ConversationConnectionUpdateInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    enabled: protocolBoolean,
    maximumObservationAgeMs: observationAgeV1,
}, { policy: 'closed' });
export type ConversationConnectionUpdateInputV1 = ReturnType<
    typeof ConversationConnectionUpdateInputV1Schema.parse
>;
export const ConversationConnectionUpdateInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionUpdateInputV1Schema.jsonSchema;

export const ConversationConnectionUpdateResultV1Schema = conversationConnectionMutationResultV1;
export type ConversationConnectionUpdateResultV1 = ReturnType<
    typeof ConversationConnectionUpdateResultV1Schema.parse
>;
export const ConversationConnectionUpdateResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionUpdateResultV1Schema.jsonSchema;

export const ConversationConnectionSetEnabledInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    enabled: protocolBoolean,
}, { policy: 'closed' });
export type ConversationConnectionSetEnabledInputV1 = ReturnType<
    typeof ConversationConnectionSetEnabledInputV1Schema.parse
>;
export const ConversationConnectionSetEnabledInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionSetEnabledInputV1Schema.jsonSchema;

export const ConversationConnectionDeleteInputV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
}, { policy: 'closed' });
export type ConversationConnectionDeleteInputV1 = ReturnType<
    typeof ConversationConnectionDeleteInputV1Schema.parse
>;
export const ConversationConnectionDeleteInputV1JsonSchema: PluginJsonSchema =
    ConversationConnectionDeleteInputV1Schema.jsonSchema;

export const ConversationConnectionDeleteResultV1Schema = conversationConnectionDeleteResultV1;
export type ConversationConnectionDeleteResultV1 = ReturnType<
    typeof ConversationConnectionDeleteResultV1Schema.parse
>;
export const ConversationConnectionDeleteResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionDeleteResultV1Schema.jsonSchema;

export const ConversationConnectionCreateResultV1Schema = conversationConnectionCreateResultV1;
export type ConversationConnectionCreateResultV1 = ReturnType<
    typeof ConversationConnectionCreateResultV1Schema.parse
>;
export const ConversationConnectionCreateResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionCreateResultV1Schema.jsonSchema;

export const ConversationConnectionTransferResultV1Schema = conversationConnectionTransferResultV1;
export type ConversationConnectionTransferResultV1 = ReturnType<
    typeof ConversationConnectionTransferResultV1Schema.parse
>;
export const ConversationConnectionTransferResultV1JsonSchema: PluginJsonSchema =
    ConversationConnectionTransferResultV1Schema.jsonSchema;
