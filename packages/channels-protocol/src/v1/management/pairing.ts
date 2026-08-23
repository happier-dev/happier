import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
    MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
    MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
} from '../bounds.js';
import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import { ConversationEndpointDisplayLabelV1ProtocolSchema } from '../provider/resolution.js';
import {
    ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema,
} from './bindings.js';
import {
    ConversationBindingTargetMutationV1ProtocolSchema,
    ConversationBindingV1ProtocolSchema,
} from './targets.js';

const pairingIdentifier = defineProtocolString({
    minLength: 1,
    maxLength: 256,
    pattern: '^(?!\\s)[\\s\\S]*\\S$',
});
const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});

const conversationPairingCancelByChallengeInputV1 = defineProtocolObject({
    generationId: pairingIdentifier,
    challengeId: pairingIdentifier,
}, { policy: 'closed' });

const conversationPairingCancelByProposalInputV1 = defineProtocolObject({
    generationId: pairingIdentifier,
    proposalId: pairingIdentifier,
}, { policy: 'closed' });

const conversationPairingCancelResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('cancelled'),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('notCancelled'),
        reason: defineProtocolUnion([
            defineProtocolLiteral('restarted'),
            defineProtocolLiteral('unavailable'),
            defineProtocolLiteral('finalizeInProgress'),
            defineProtocolLiteral('bindingCreated'),
        ]),
    }, { policy: 'closed' }),
]);

/**
 * One live challenge's presentation, projected identically by the create result
 * and by the authenticated challenge Resource entry. A person sees the same
 * deadline, remaining attempts, destination, manual token, and deep link in
 * both, so the two projections read one declaration instead of drifting apart.
 */
const conversationPairingChallengePresentationV1 = {
    expiresAt: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    attemptsRemaining: defineProtocolNumber({ integer: true, minimum: 0, maximum: 5 }),
    destinationLabel: ConversationEndpointDisplayLabelV1ProtocolSchema,
    manualToken: defineProtocolString({ pattern: '^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$' }),
    deepLinkUrl: defineProtocolUtf8String({
        maxUtf8Bytes: MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
        minLength: 1,
    }).nullable(),
} as const;

const conversationPairingCreateResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('created'),
        generationId: pairingIdentifier,
        challengeId: pairingIdentifier,
        ...conversationPairingChallengePresentationV1,
    }, { policy: 'closed' }),
    ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema,
]);

/** One active challenge remains readable only through its authenticated owner Resource. */
const conversationPairingChallengeResourceEntryV1 = defineProtocolObject({
    challengeId: pairingIdentifier,
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: positiveSafeInteger,
    ...conversationPairingChallengePresentationV1,
}, { policy: 'closed' });

/** The proposal omits frozen target, endpoint identity, materialization, and binding custody. */
const conversationPairingProposalResourceEntryV1 = defineProtocolObject({
    challengeId: pairingIdentifier,
    proposalId: pairingIdentifier,
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: positiveSafeInteger,
    expiresAt: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    endpointLabel: ConversationEndpointDisplayLabelV1ProtocolSchema.nullable(),
    state: defineProtocolUnion([
        defineProtocolLiteral('proposed'),
        defineProtocolLiteral('finalizing'),
        defineProtocolLiteral('finalized'),
    ]),
}, { policy: 'closed' });

const conversationPairingResourceV1 = defineProtocolObject({
    generationId: pairingIdentifier,
    observedAt: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    challenges: defineProtocolArray(conversationPairingChallengeResourceEntryV1, {
        maxItems: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
    }),
    proposals: defineProtocolArray(conversationPairingProposalResourceEntryV1, {
        maxItems: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
    }),
}, { policy: 'closed' });

/** @internal Relative-only input for pairing creation. */
export const ConversationPairingCreateInputV1ProtocolSchema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: positiveSafeInteger,
    target: ConversationBindingTargetMutationV1ProtocolSchema,
}, { policy: 'closed' });

export const ConversationPairingCreateInputV1Schema = ConversationPairingCreateInputV1ProtocolSchema;
export type ConversationPairingCreateInputV1 = ReturnType<
    typeof ConversationPairingCreateInputV1Schema.parse
>;
export const ConversationPairingCreateInputV1JsonSchema: PluginJsonSchema =
    ConversationPairingCreateInputV1Schema.jsonSchema;

export const ConversationPairingCancelInputV1Schema = defineProtocolUnion([
    conversationPairingCancelByChallengeInputV1,
    conversationPairingCancelByProposalInputV1,
]);
export type ConversationPairingCancelInputV1 = ReturnType<
    typeof ConversationPairingCancelInputV1Schema.parse
>;
export const ConversationPairingCancelInputV1JsonSchema: PluginJsonSchema =
    ConversationPairingCancelInputV1Schema.jsonSchema;

export const ConversationPairingCancelResultV1Schema = conversationPairingCancelResultV1;
export type ConversationPairingCancelResultV1 = ReturnType<
    typeof ConversationPairingCancelResultV1Schema.parse
>;
export const ConversationPairingCancelResultV1JsonSchema: PluginJsonSchema =
    ConversationPairingCancelResultV1Schema.jsonSchema;

export const ConversationPairingCreateResultV1Schema = conversationPairingCreateResultV1;
export type ConversationPairingCreateResultV1 = ReturnType<
    typeof ConversationPairingCreateResultV1Schema.parse
>;
export const ConversationPairingCreateResultV1JsonSchema: PluginJsonSchema =
    ConversationPairingCreateResultV1Schema.jsonSchema;

/** Strict owner-visible snapshot of the current daemon-memory pairing manager. */
export const ConversationPairingResourceV1Schema = conversationPairingResourceV1;
export type ConversationPairingResourceV1 = ReturnType<
    typeof ConversationPairingResourceV1Schema.parse
>;
export const ConversationPairingResourceV1JsonSchema: PluginJsonSchema =
    ConversationPairingResourceV1Schema.jsonSchema;

export const ConversationPairingFinalizeInputV1Schema = defineProtocolObject({
    generationId: pairingIdentifier,
    proposalId: pairingIdentifier,
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: positiveSafeInteger,
    finalizeIdempotencyKey: pairingIdentifier,
}, { policy: 'closed' });
export type ConversationPairingFinalizeInputV1 = ReturnType<
    typeof ConversationPairingFinalizeInputV1Schema.parse
>;
export const ConversationPairingFinalizeInputV1JsonSchema: PluginJsonSchema =
    ConversationPairingFinalizeInputV1Schema.jsonSchema;

export const ConversationPairingFinalizeResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolUnion([
            defineProtocolLiteral('created'),
            defineProtocolLiteral('rejoined'),
        ]),
        binding: ConversationBindingV1ProtocolSchema,
    }, { policy: 'closed' }),
    ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema,
    defineProtocolObject({
        kind: defineProtocolUnion([
            defineProtocolLiteral('expired'),
            defineProtocolLiteral('restarted'),
            defineProtocolLiteral('wrongConnection'),
            defineProtocolLiteral('wrongMaterialization'),
            defineProtocolLiteral('alreadyConsumed'),
            defineProtocolLiteral('staleConnectionRevision'),
            defineProtocolLiteral('conflict'),
            defineProtocolLiteral('retryableFailure'),
        ]),
    }, { policy: 'closed' }),
]);
export type ConversationPairingFinalizeResultV1 = ReturnType<
    typeof ConversationPairingFinalizeResultV1Schema.parse
>;
export const ConversationPairingFinalizeResultV1JsonSchema: PluginJsonSchema =
    ConversationPairingFinalizeResultV1Schema.jsonSchema;
