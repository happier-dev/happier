import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1,
    CONVERSATION_OBSERVATION_ACTOR_KINDS_V1,
    CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1,
    CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1,
    MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES,
    MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES,
    MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES,
    MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
} from '../bounds.js';
import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import {
    ConversationEndpointDisplayLabelV1ProtocolSchema,
    ConversationResolvedEndpointV1ProtocolSchema,
} from '../provider/resolution.js';

const conversationOccurrenceIdV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES,
    minLength: 1,
});
const conversationActorPrincipalIdV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES,
    minLength: 1,
});
const conversationProviderMessageIdV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
    minLength: 1,
});
const conversationIngressTextV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES,
    minLength: 1,
});

const conversationObservationTransportV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1[1]),
        defineProtocolLiteral(CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1[2]),
    ]),
    providerDeliveryId: conversationProviderMessageIdV1.optional(),
}, { policy: 'closed' });

const conversationObservationActorV1 = defineProtocolObject({
    principalId: conversationActorPrincipalIdV1.nullable(),
    label: ConversationEndpointDisplayLabelV1ProtocolSchema.optional(),
    kind: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_OBSERVATION_ACTOR_KINDS_V1[0]),
        defineProtocolLiteral(CONVERSATION_OBSERVATION_ACTOR_KINDS_V1[1]),
        defineProtocolLiteral(CONVERSATION_OBSERVATION_ACTOR_KINDS_V1[2]),
        defineProtocolLiteral(CONVERSATION_OBSERVATION_ACTOR_KINDS_V1[3]),
    ]),
    isIntegrationSelf: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]),
}, { policy: 'closed' });

const [
    noAddressingEvidence,
    directIntegrationMentionEvidence,
    integrationRoleMentionEvidence,
    replyToIntegrationEvidence,
] = CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1;

const conversationMessageBaseFields = {
    id: conversationProviderMessageIdV1,
    contentProvenance: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1[0]),
        defineProtocolLiteral(CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1[1]),
        defineProtocolLiteral(CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1[2]),
    ]),
    providerTimestamp: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
} as const;

const nonReplyAddressingEvidenceV1 = defineProtocolUnion([
    defineProtocolLiteral(noAddressingEvidence),
    defineProtocolLiteral(directIntegrationMentionEvidence),
    defineProtocolLiteral(integrationRoleMentionEvidence),
]);

const conversationFullTextMessageV1 = defineProtocolUnion([
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        text: conversationIngressTextV1,
        replyToMessageId: conversationProviderMessageIdV1,
        addressingEvidence: defineProtocolLiteral(replyToIntegrationEvidence),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        text: conversationIngressTextV1,
        replyToMessageId: conversationProviderMessageIdV1.optional(),
        addressingEvidence: nonReplyAddressingEvidenceV1,
    }, { policy: 'closed' }),
]);

const conversationAuthenticatedObservationShellMessageV1 = defineProtocolUnion([
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        replyToMessageId: conversationProviderMessageIdV1,
        addressingEvidence: defineProtocolLiteral(replyToIntegrationEvidence),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        replyToMessageId: conversationProviderMessageIdV1.optional(),
        addressingEvidence: nonReplyAddressingEvidenceV1,
    }, { policy: 'closed' }),
]);

const conversationUnsupportedEditShellMessageV1 = defineProtocolUnion([
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1,
        replyToMessageId: conversationProviderMessageIdV1,
        addressingEvidence: defineProtocolLiteral(replyToIntegrationEvidence),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1,
        replyToMessageId: conversationProviderMessageIdV1.optional(),
        addressingEvidence: nonReplyAddressingEvidenceV1,
    }, { policy: 'closed' }),
]);

const conversationAuthenticatedObservationEnvelopeFields = {
    v: defineProtocolLiteral(1),
    occurrenceId: conversationOccurrenceIdV1,
    occurredAt: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    transport: conversationObservationTransportV1,
    endpoint: ConversationResolvedEndpointV1ProtocolSchema,
    actor: conversationObservationActorV1,
} as const;

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationObservationV1ProtocolSchema = defineProtocolObject({
    ...conversationAuthenticatedObservationEnvelopeFields,
    message: conversationFullTextMessageV1,
}, { policy: 'closed' });

/** Strict authenticated evidence supplied by a provider transport. */
export const ConversationObservationV1Schema = ConversationObservationV1ProtocolSchema;
export type ConversationObservationV1 = ReturnType<typeof ConversationObservationV1Schema.parse>;
export const ConversationObservationV1JsonSchema: PluginJsonSchema = ConversationObservationV1Schema.jsonSchema;

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationAuthenticatedObservationShellV1ProtocolSchema = defineProtocolObject({
    ...conversationAuthenticatedObservationEnvelopeFields,
    message: conversationAuthenticatedObservationShellMessageV1,
}, { policy: 'closed' });

/** Authenticated ingress envelope deliberately stripped of rejected message body text. */
export const ConversationAuthenticatedObservationShellV1Schema = ConversationAuthenticatedObservationShellV1ProtocolSchema;
export type ConversationAuthenticatedObservationShellV1 = ReturnType<
    typeof ConversationAuthenticatedObservationShellV1Schema.parse
>;
export const ConversationAuthenticatedObservationShellV1JsonSchema: PluginJsonSchema =
    ConversationAuthenticatedObservationShellV1Schema.jsonSchema;

const conversationUnsupportedEditShellV1 = defineProtocolObject({
    ...conversationAuthenticatedObservationEnvelopeFields,
    message: conversationUnsupportedEditShellMessageV1,
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationNormalizedIngressV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('fullText'),
        observation: ConversationObservationV1ProtocolSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('routableNonAdmission'),
        shell: ConversationAuthenticatedObservationShellV1ProtocolSchema,
        reason: defineProtocolUnion([
            defineProtocolLiteral('messageTooLarge'),
            defineProtocolLiteral('unsupportedContent'),
        ]),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('routableNonAdmission'),
        shell: conversationUnsupportedEditShellV1,
        reason: defineProtocolLiteral('unsupportedEdit'),
    }, { policy: 'closed' }),
]);

/** The sole provider-normalized ingress vocabulary accepted by the Channels core. */
export const ConversationNormalizedIngressV1Schema = ConversationNormalizedIngressV1ProtocolSchema;
export type ConversationNormalizedIngressV1 = ReturnType<
    typeof ConversationNormalizedIngressV1Schema.parse
>;
export const ConversationNormalizedIngressV1JsonSchema: PluginJsonSchema = ConversationNormalizedIngressV1Schema.jsonSchema;

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationProviderObservationIngestInputV1ProtocolSchema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    observation: ConversationNormalizedIngressV1ProtocolSchema,
}, { policy: 'closed' });

/** Provider-to-core ingest input; host caller authority and checkpoints stay outside this value. */
export const ConversationProviderObservationIngestInputV1Schema = ConversationProviderObservationIngestInputV1ProtocolSchema;
export type ConversationProviderObservationIngestInputV1 = ReturnType<
    typeof ConversationProviderObservationIngestInputV1Schema.parse
>;
export const ConversationProviderObservationIngestInputV1JsonSchema: PluginJsonSchema =
    ConversationProviderObservationIngestInputV1Schema.jsonSchema;
