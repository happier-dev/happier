import type {
    PluginJsonSchema,
    ProtocolComposableSchema,
} from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';

import {
    CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1,
    CONVERSATION_OBSERVATION_ACTOR_KINDS_V1,
    CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1,
    CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1,
    MAX_CONVERSATION_AUTOMATION_EVENT_SOURCE_INSTANCE_ID_UTF8_BYTES,
    MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES,
    MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES,
    MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
} from '../bounds.js';
import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';
import { ConversationJsonValueV1ProtocolSchema } from '../json.js';
import {
    ConversationEndpointDisplayLabelV1ProtocolSchema,
    ConversationResolvedEndpointV1ProtocolSchema,
} from '../provider/resolution.js';
import { ConversationMessageAttachmentV1Schema } from '../provider/attachments.js';

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
const conversationIngressTextV1 = defineProtocolString({ minLength: 1 });

/**
 * The Event owner identifies its own declaration through this qualified
 * contribution reference. Channels preserves it as provider evidence, then
 * verifies it against the selected connection provider before persistence.
 */
export type ConversationAutomationEventRefV1 = Readonly<{
    pluginId: string;
    localId: string;
}>;

const conversationAutomationEventRefV1: ProtocolComposableSchema<ConversationAutomationEventRefV1> =
    PluginContributionIdentityV1Schema;

const conversationAutomationEventSourceInstanceIdV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_AUTOMATION_EVENT_SOURCE_INSTANCE_ID_UTF8_BYTES,
    minLength: 1,
});

/** @internal Relative-only Event evidence supplied with one normalized ingress. */
export const ConversationIngressAutomationEventCandidateV1ProtocolSchema = defineProtocolObject({
    eventRef: conversationAutomationEventRefV1,
    sourceInstanceId: conversationAutomationEventSourceInstanceIdV1,
    sourceContractVersion: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    payload: ConversationJsonValueV1ProtocolSchema,
}, { policy: 'closed' });

/**
 * One provider-derived Event candidate. Channels owns its durable retry and
 * checkpoint lifecycle; the provider later uses this immutable evidence only
 * to select and admit its own Automation definitions.
 */
export const ConversationIngressAutomationEventCandidateV1Schema =
    ConversationIngressAutomationEventCandidateV1ProtocolSchema;
export type ConversationIngressAutomationEventCandidateV1 = ReturnType<
    typeof ConversationIngressAutomationEventCandidateV1Schema.parse
>;
export const ConversationIngressAutomationEventCandidateV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationIngressAutomationEventCandidateV1Schema.jsonSchema)();

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
    // Authenticated provider evidence for this observation's repository.
    // Only true establishes write access; null or omission means unknown.
    repositoryWriteAccess: defineProtocolUnion([
        defineProtocolLiteral(true),
        defineProtocolLiteral(false),
    ]).nullable().optional(),
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
        attachments: defineProtocolArray(ConversationMessageAttachmentV1Schema).optional(),
        replyToMessageId: conversationProviderMessageIdV1,
        addressingEvidence: defineProtocolLiteral(replyToIntegrationEvidence),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        text: conversationIngressTextV1,
        attachments: defineProtocolArray(ConversationMessageAttachmentV1Schema).optional(),
        replyToMessageId: conversationProviderMessageIdV1.optional(),
        addressingEvidence: nonReplyAddressingEvidenceV1,
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        text: defineProtocolLiteral(''),
        attachments: defineProtocolArray(ConversationMessageAttachmentV1Schema, { minItems: 1 }),
        replyToMessageId: conversationProviderMessageIdV1,
        addressingEvidence: defineProtocolLiteral(replyToIntegrationEvidence),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationMessageBaseFields,
        revision: conversationProviderMessageIdV1.optional(),
        text: defineProtocolLiteral(''),
        attachments: defineProtocolArray(ConversationMessageAttachmentV1Schema, { minItems: 1 }),
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
    scopedTriggerKind: defineProtocolUnion([defineProtocolLiteral('prComment'), defineProtocolLiteral('ciFailed')]).optional(),
} as const;

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationObservationV1ProtocolSchema = defineProtocolObject({
    ...conversationAuthenticatedObservationEnvelopeFields,
    message: conversationFullTextMessageV1,
}, { policy: 'closed' });

/** Strict authenticated evidence supplied by a provider transport. */
export const ConversationObservationV1Schema = ConversationObservationV1ProtocolSchema;
export type ConversationObservationV1 = ReturnType<typeof ConversationObservationV1Schema.parse>;
export const ConversationObservationV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationObservationV1Schema.jsonSchema)();

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
    /* @__PURE__ */ (() => ConversationAuthenticatedObservationShellV1Schema.jsonSchema)();

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
export const ConversationNormalizedIngressV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationNormalizedIngressV1Schema.jsonSchema)();

/** @internal Relative-only one-occurrence envelope shared by direct and poll ingress. */
export const ConversationIngressObservedEntryV1ProtocolSchema = defineProtocolObject({
    observation: ConversationNormalizedIngressV1ProtocolSchema,
    eventCandidate: ConversationIngressAutomationEventCandidateV1ProtocolSchema.nullable(),
}, { policy: 'closed' });

/**
 * The sole normalized provider ingress unit. Event candidate evidence travels
 * through the same durable Channels census as its Chat observation, never a
 * second provider-local replay path.
 */
export const ConversationIngressObservedEntryV1Schema = ConversationIngressObservedEntryV1ProtocolSchema;
export type ConversationIngressObservedEntryV1 = ReturnType<
    typeof ConversationIngressObservedEntryV1Schema.parse
>;
export const ConversationIngressObservedEntryV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationIngressObservedEntryV1Schema.jsonSchema)();

const conversationProviderObservationIngestInputV1Shape = {
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    authorityEpoch: defineProtocolNumber({ integer: true, minimum: 1, maximum: Number.MAX_SAFE_INTEGER }).optional(),
    entry: ConversationIngressObservedEntryV1ProtocolSchema,
} as const;

/** Preserve the concrete schema identity through nested public declarations. */
export interface ConversationProviderObservationIngestInputSchemaV1 extends ReturnType<
    typeof defineProtocolObject<typeof conversationProviderObservationIngestInputV1Shape, { policy: 'closed' }>
> {}

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationProviderObservationIngestInputV1ProtocolSchema: ConversationProviderObservationIngestInputSchemaV1 =
    defineProtocolObject(conversationProviderObservationIngestInputV1Shape, { policy: 'closed' });

/** Held socket workers carry their observed generation; request-scoped ingress may omit it. */
export const ConversationProviderObservationIngestInputV1Schema: ConversationProviderObservationIngestInputSchemaV1 =
    ConversationProviderObservationIngestInputV1ProtocolSchema;
export type ConversationProviderObservationIngestInputV1 = ReturnType<
    typeof ConversationProviderObservationIngestInputV1Schema.parse
>;
export const ConversationProviderObservationIngestInputV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationProviderObservationIngestInputV1Schema.jsonSchema)();
