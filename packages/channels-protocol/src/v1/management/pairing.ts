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
    MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
} from '../bounds.js';
import {
    ConversationCollectionRowRevisionV1ProtocolSchema,
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import { ConversationEndpointDisplayLabelV1ProtocolSchema, ConversationResolvedEndpointV1ProtocolSchema } from '../provider/resolution.js';
import {
    ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema,
    ConversationBindingEndpointSelectionV1ProtocolSchema,
} from './bindings.js';
import {
    ConversationBindingTargetV1ProtocolSchema,
    ConversationBindingV1ProtocolSchema,
    ConversationPrincipalIdV1ProtocolSchema,
} from './targets.js';

const pairingIdentifier = defineProtocolString({
    minLength: 1,
    maxLength: 256,
    pattern: '^(?!\\s)[\\s\\S]*\\S$',
});
/** One exact Account Collection row revision witness; see its Protocol owner. */
const collectionRowRevision = ConversationCollectionRowRevisionV1ProtocolSchema;

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
    proofEndpoint: ConversationResolvedEndpointV1ProtocolSchema.optional(),
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
    expectedConnectionRevision: collectionRowRevision,
    pairingRequestId: pairingIdentifier,
    ...conversationPairingChallengePresentationV1,
}, { policy: 'closed' });

/** Owner review sees the actual sender and proof location, never mutation overrides or binding custody. */
const conversationPairingProposalResourceEntryV1 = defineProtocolObject({
    challengeId: pairingIdentifier,
    proposalId: pairingIdentifier,
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: collectionRowRevision,
    expiresAt: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    endpointLabel: ConversationEndpointDisplayLabelV1ProtocolSchema.nullable(),
    proofEndpoint: ConversationResolvedEndpointV1ProtocolSchema,
    principalId: ConversationPrincipalIdV1ProtocolSchema,
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
    challenges: defineProtocolArray(conversationPairingChallengeResourceEntryV1, {}),
    proposals: defineProtocolArray(conversationPairingProposalResourceEntryV1, {}),
}, { policy: 'closed' });

/**
 * @internal Relative-only input for pairing creation.
 *
 * Pairing proves an external human through a private message or one explicitly
 * selected shared proof endpoint, but the
 * conversation it binds is the one the owner selected. The two are separate
 * facts, so the selected destination travels with the challenge instead of
 * being inferred from wherever the proof happened to arrive.
 *
 * `pairingRequestId` is one client-generated opaque correlation key. A
 * response-loss retry repeats the exact same key and rejoins the challenge
 * this request created; a different key deliberately supersedes it. Recovery
 * therefore matches the exact request key and never merely a connection and
 * revision, so a second device's superseding challenge cannot be adopted by
 * the first device's unknown-outcome recovery.
 */
export const ConversationPairingCreateInputV1ProtocolSchema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: collectionRowRevision,
    pairingRequestId: pairingIdentifier,
    endpointSelection: ConversationBindingEndpointSelectionV1ProtocolSchema,
    proofEndpointSelection: ConversationBindingEndpointSelectionV1ProtocolSchema.optional(),
    target: ConversationBindingTargetV1ProtocolSchema,
}, { policy: 'closed' });

export const ConversationPairingCreateInputV1Schema = ConversationPairingCreateInputV1ProtocolSchema;
export type ConversationPairingCreateInputV1 = ReturnType<
    typeof ConversationPairingCreateInputV1Schema.parse
>;
export const ConversationPairingCreateInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPairingCreateInputV1Schema.jsonSchema)();

export const ConversationPairingCancelInputV1Schema = defineProtocolUnion([
    conversationPairingCancelByChallengeInputV1,
    conversationPairingCancelByProposalInputV1,
]);
export type ConversationPairingCancelInputV1 = ReturnType<
    typeof ConversationPairingCancelInputV1Schema.parse
>;
export const ConversationPairingCancelInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPairingCancelInputV1Schema.jsonSchema)();

export const ConversationPairingCancelResultV1Schema = conversationPairingCancelResultV1;
export type ConversationPairingCancelResultV1 = ReturnType<
    typeof ConversationPairingCancelResultV1Schema.parse
>;
export const ConversationPairingCancelResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPairingCancelResultV1Schema.jsonSchema)();

export const ConversationPairingCreateResultV1Schema = conversationPairingCreateResultV1;
export type ConversationPairingCreateResultV1 = ReturnType<
    typeof ConversationPairingCreateResultV1Schema.parse
>;
export const ConversationPairingCreateResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPairingCreateResultV1Schema.jsonSchema)();

/** Strict owner-visible snapshot of the current daemon-memory pairing manager. */
export const ConversationPairingResourceV1Schema = conversationPairingResourceV1;
export type ConversationPairingResourceV1 = ReturnType<
    typeof ConversationPairingResourceV1Schema.parse
>;
export const ConversationPairingResourceV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPairingResourceV1Schema.jsonSchema)();

export const ConversationPairingFinalizeInputV1Schema = defineProtocolObject({
    generationId: pairingIdentifier,
    proposalId: pairingIdentifier,
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: collectionRowRevision,
    finalizeIdempotencyKey: pairingIdentifier,
}, { policy: 'closed' });
export type ConversationPairingFinalizeInputV1 = ReturnType<
    typeof ConversationPairingFinalizeInputV1Schema.parse
>;
export const ConversationPairingFinalizeInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationPairingFinalizeInputV1Schema.jsonSchema)();

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
    /* @__PURE__ */ (() => ConversationPairingFinalizeResultV1Schema.jsonSchema)();
