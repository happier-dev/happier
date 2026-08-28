import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
    defineProtocolUniqueArray,
} from '@happier-dev/plugin-sdk/protocol';

import {
    CONVERSATION_BINDING_INPUT_MODES_V1,
    CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
    MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
    MAX_CONVERSATION_INBOUND_DEBOUNCE_MS,
} from '../bounds.js';
import type {
    ConversationBindingInputModeV1,
    ConversationDeliveryLinkPreviewPolicyV1,
    ConversationEndpointAudienceV1,
} from '../bounds.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';
import {
    ConversationBindingIdV1ProtocolSchema,
    ConversationConnectionIdV1ProtocolSchema,
} from '../identity.js';
import {
    ConversationEndpointIdentityV1ProtocolSchema,
    ConversationEndpointResolveKindsV1ProtocolSchema,
    ConversationResolutionQueryV1ProtocolSchema,
    ConversationResolvedEndpointCandidatesV1ProtocolSchema,
    ConversationResolvedPrincipalCandidatesV1ProtocolSchema,
} from '../provider/resolution.js';
import {
    ConversationBindingTargetV1ProtocolSchema,
    ConversationBindingV1ProtocolSchema,
    ConversationPrincipalIdV1ProtocolSchema,
} from './targets.js';
import type { ConversationSessionBindingTargetV1 } from './targets.js';

const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});
const protocolBoolean = defineProtocolUnion([
    defineProtocolLiteral(true),
    defineProtocolLiteral(false),
]);

const mutableBindingPolicyFieldsV1 = {
    target: ConversationBindingTargetV1ProtocolSchema,
    allowBotSenders: protocolBoolean,
    inputMode: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[0]),
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[1]),
        defineProtocolLiteral(CONVERSATION_BINDING_INPUT_MODES_V1[2]),
    ]),
    inboundDebounceMs: defineProtocolNumber({
        integer: true,
        minimum: 0,
        maximum: MAX_CONVERSATION_INBOUND_DEBOUNCE_MS,
    }),
    linkPreviewPolicy: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[0]),
        defineProtocolLiteral(CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1[1]),
    ]),
    senderFeedback: defineProtocolUnion([
        defineProtocolLiteral('off'),
        defineProtocolLiteral('eligibleRefusals'),
    ]),
    enabled: protocolBoolean,
} as const;

/**
 * What an omitted binding-policy field means at create time.
 *
 * The create writer, the pairing writer, and the surface that previews the
 * binding before it exists all need the same answer, so this is one owner
 * rather than three copies of the same literals: a surface that showed a
 * different default from the one the writer persists is a lie about the
 * binding the person is about to create.
 *
 * A shared endpoint defaults to mentions-only because everyone in it would
 * otherwise address the agent by speaking; a direct endpoint has no such
 * ambiguity.
 */
export function conversationBindingPolicyForOmittedFieldsV1(
    audience: ConversationEndpointAudienceV1,
): Readonly<{
    allowBotSenders: false;
    inputMode: ConversationBindingInputModeV1;
    inboundDebounceMs: number;
    linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
    senderFeedback: 'off';
    enabled: false;
}> {
    return {
        allowBotSenders: false,
        inputMode: audience === 'direct' ? 'allAllowedMessages' : 'directMentionsOnly',
        inboundDebounceMs: 750,
        linkPreviewPolicy: 'suppress',
        senderFeedback: 'off',
        enabled: false,
    };
}

/**
 * What an omitted Session-target delivery mode means at create time.
 *
 * `deliveryMode` is required by the persisted target contract, so no writer
 * can default it; the create surface and the binding editor both have to name
 * one before the person has expressed a preference. That answer is derived
 * from the same endpoint audience as the policy defaults above and belongs
 * with them: a direct conversation has exactly one person in it, so mirroring
 * the Session is what connecting it asked for, while the same choice in a
 * shared room is unsolicited traffic for everyone else present.
 */
export function conversationSessionBindingDeliveryModeForOmittedFieldV1(
    audience: ConversationEndpointAudienceV1,
): ConversationSessionBindingTargetV1['policy']['deliveryMode'] {
    return audience === 'direct' ? 'mirrorSession' : 'repliesOnly';
}

/**
 * The input modes a binding on this endpoint can actually promise.
 *
 * One owner for the surface that offers the choice and the writer that
 * persists it, so a person can never be shown — or saved with — an incoming
 * message policy the provider's platform will silently never deliver. A
 * connection whose provider declared no restriction keeps every mode.
 */
export function conversationBindingInputModesForEndpointV1(input: Readonly<{
    audience: ConversationEndpointAudienceV1;
    sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
}>): readonly ConversationBindingInputModeV1[] {
    if (input.audience === 'direct' || input.sharedEndpointInputModes === undefined) {
        return CONVERSATION_BINDING_INPUT_MODES_V1;
    }
    const declared = CONVERSATION_BINDING_INPUT_MODES_V1.filter(
        (mode) => input.sharedEndpointInputModes!.includes(mode),
    );
    // A provider that declares an empty or unrecognized set still leaves the
    // one mode every conversation platform can deliver: an explicit mention.
    return declared.length > 0 ? declared : [CONVERSATION_BINDING_INPUT_MODES_V1[0]];
}

/** Whether this endpoint's provider can actually honour the requested mode. */
export function isConversationBindingInputModeDeliverableV1(input: Readonly<{
    audience: ConversationEndpointAudienceV1;
    inputMode: ConversationBindingInputModeV1;
    sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
}>): boolean {
    return conversationBindingInputModesForEndpointV1(input).includes(input.inputMode);
}

/**
 * @internal Relative-only endpoint selection.
 *
 * Binding create, binding update, and pairing create all name their
 * destination this way instead of asserting an already-resolved endpoint, so
 * the caller's choice is re-proven against the exact current provider
 * candidates before that owner acts on it. Create and update resolve
 * immediately before their write; pairing resolves once when the challenge is
 * issued and persists that frozen destination at finalization.
 */
export const ConversationBindingEndpointSelectionV1ProtocolSchema = defineProtocolObject({
    query: ConversationResolutionQueryV1ProtocolSchema,
    kinds: ConversationEndpointResolveKindsV1ProtocolSchema.optional(),
    selected: ConversationEndpointIdentityV1ProtocolSchema,
}, { policy: 'closed' });

const conversationBindingPrincipalSelectionEntryV1 = defineProtocolObject({
    id: ConversationPrincipalIdV1ProtocolSchema,
    kind: defineProtocolUnion([
        defineProtocolLiteral('human'),
        defineProtocolLiteral('bot'),
    ]),
}, { policy: 'closed' });

const conversationBindingPrincipalSelectionV1 = defineProtocolObject({
    query: ConversationResolutionQueryV1ProtocolSchema,
    selected: defineProtocolUniqueArray(
        conversationBindingPrincipalSelectionEntryV1,
        { minItems: 1, maxItems: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT },
    ),
}, { policy: 'closed' });

const conversationBindingHumanPrincipalSelectionV1 = defineProtocolObject({
    query: ConversationResolutionQueryV1ProtocolSchema,
    selected: defineProtocolUniqueArray(
        defineProtocolObject({
            id: ConversationPrincipalIdV1ProtocolSchema,
            kind: defineProtocolLiteral('human'),
        }, { policy: 'closed' }),
        { minItems: 1, maxItems: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT },
    ),
}, { policy: 'closed' });

const conversationBindingAudienceSelectionV1 = defineProtocolObject({
    expectedConnectionRevision: positiveSafeInteger,
    endpointSelection: ConversationBindingEndpointSelectionV1ProtocolSchema,
    principalSelection: conversationBindingPrincipalSelectionV1,
}, { policy: 'closed' });

const conversationBindingHumanAudienceSelectionV1 = defineProtocolObject({
    expectedConnectionRevision: positiveSafeInteger,
    endpointSelection: ConversationBindingEndpointSelectionV1ProtocolSchema,
    principalSelection: conversationBindingHumanPrincipalSelectionV1,
}, { policy: 'closed' });

/** @internal Relative-only strict binding-resolution request union. */
export const ConversationBindingResolveInputV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('endpoint'),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
        expectedConnectionRevision: positiveSafeInteger,
        query: ConversationResolutionQueryV1ProtocolSchema,
        kinds: ConversationEndpointResolveKindsV1ProtocolSchema.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('principal'),
        connectionId: ConversationConnectionIdV1ProtocolSchema,
        expectedConnectionRevision: positiveSafeInteger,
        endpointSelection: ConversationBindingEndpointSelectionV1ProtocolSchema,
        query: ConversationResolutionQueryV1ProtocolSchema,
    }, { policy: 'closed' }),
]);

/** Resolves one current provider endpoint or principal candidate page for binding setup. */
export const ConversationBindingResolveInputV1Schema = ConversationBindingResolveInputV1ProtocolSchema;
export type ConversationBindingResolveInputV1 = ReturnType<
    typeof ConversationBindingResolveInputV1Schema.parse
>;
export const ConversationBindingResolveInputV1JsonSchema: PluginJsonSchema =
    ConversationBindingResolveInputV1Schema.jsonSchema;

/** @internal Relative-only bounded reason for a resolution path that cannot run. */
export const ConversationBindingResolutionUnavailableV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('unavailable'),
    reason: defineProtocolUnion([
        defineProtocolLiteral('connectionNotFound'),
        defineProtocolLiteral('connectionDeleting'),
        defineProtocolLiteral('providerUnavailable'),
        defineProtocolLiteral('endpointResolveUnsupported'),
        defineProtocolLiteral('principalResolveUnsupported'),
    ]),
}, { policy: 'closed' });

export const ConversationBindingResolutionUnavailableV1Schema = ConversationBindingResolutionUnavailableV1ProtocolSchema;
export type ConversationBindingResolutionUnavailableV1 = ReturnType<
    typeof ConversationBindingResolutionUnavailableV1Schema.parse
>;
export const ConversationBindingResolutionUnavailableV1JsonSchema: PluginJsonSchema =
    ConversationBindingResolutionUnavailableV1Schema.jsonSchema;

const conversationBindingStaleResultV1 = defineProtocolObject({
    kind: defineProtocolLiteral('stale'),
}, { policy: 'closed' });

const conversationBindingResolveResultV1 = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('endpointCandidates'),
        candidates: ConversationResolvedEndpointCandidatesV1ProtocolSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('principalCandidates'),
        candidates: ConversationResolvedPrincipalCandidatesV1ProtocolSchema,
    }, { policy: 'closed' }),
    conversationBindingStaleResultV1,
    ConversationBindingResolutionUnavailableV1ProtocolSchema,
    ConversationProviderFailureV1ProtocolSchema,
]);

/** Closed read-only resolution outcome with no private connection facts. */
export const ConversationBindingResolveResultV1Schema = conversationBindingResolveResultV1;
export type ConversationBindingResolveResultV1 = ReturnType<
    typeof ConversationBindingResolveResultV1Schema.parse
>;
export const ConversationBindingResolveResultV1JsonSchema: PluginJsonSchema =
    ConversationBindingResolveResultV1Schema.jsonSchema;

const conversationBindingCreateFieldsV1 = {
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    expectedConnectionRevision: positiveSafeInteger,
    endpointSelection: ConversationBindingEndpointSelectionV1ProtocolSchema,
    target: mutableBindingPolicyFieldsV1.target,
    inputMode: mutableBindingPolicyFieldsV1.inputMode.optional(),
    inboundDebounceMs: mutableBindingPolicyFieldsV1.inboundDebounceMs.optional(),
    linkPreviewPolicy: mutableBindingPolicyFieldsV1.linkPreviewPolicy.optional(),
    senderFeedback: mutableBindingPolicyFieldsV1.senderFeedback.optional(),
    enabled: mutableBindingPolicyFieldsV1.enabled.optional(),
} as const;

/** @internal Relative-only input for creating a binding through the canonical writer. */
export const ConversationBindingCreateInputV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({
        ...conversationBindingCreateFieldsV1,
        principalSelection: conversationBindingHumanPrincipalSelectionV1,
        allowBotSenders: mutableBindingPolicyFieldsV1.allowBotSenders.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationBindingCreateFieldsV1,
        principalSelection: conversationBindingPrincipalSelectionV1,
        allowBotSenders: defineProtocolLiteral(true),
    }, { policy: 'closed' }),
]);

export const ConversationBindingCreateInputV1Schema = ConversationBindingCreateInputV1ProtocolSchema;
export type ConversationBindingCreateInputV1 = ReturnType<
    typeof ConversationBindingCreateInputV1Schema.parse
>;
export const ConversationBindingCreateInputV1JsonSchema: PluginJsonSchema = ConversationBindingCreateInputV1Schema.jsonSchema;

/** Exact binding-scoped read input; list projections remain intentionally summary-only. */
export const ConversationBindingReadInputV1Schema = defineProtocolObject({
    bindingId: ConversationBindingIdV1ProtocolSchema,
}, { policy: 'closed' });
export type ConversationBindingReadInputV1 = ReturnType<typeof ConversationBindingReadInputV1Schema.parse>;
export const ConversationBindingReadInputV1JsonSchema: PluginJsonSchema =
    ConversationBindingReadInputV1Schema.jsonSchema;

/** Exact binding row projection with its current collection revision. */
export const ConversationBindingReadResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('ready'),
        revision: positiveSafeInteger,
        binding: ConversationBindingV1ProtocolSchema,
    }, { policy: 'closed' }),
    defineProtocolObject({
        kind: defineProtocolLiteral('notFound'),
    }, { policy: 'closed' }),
]);
export type ConversationBindingReadResultV1 = ReturnType<typeof ConversationBindingReadResultV1Schema.parse>;
export const ConversationBindingReadResultV1JsonSchema: PluginJsonSchema =
    ConversationBindingReadResultV1Schema.jsonSchema;

const conversationBindingUpdateFieldsV1 = {
    bindingId: ConversationBindingIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    target: mutableBindingPolicyFieldsV1.target.optional(),
    inputMode: mutableBindingPolicyFieldsV1.inputMode.optional(),
    inboundDebounceMs: mutableBindingPolicyFieldsV1.inboundDebounceMs.optional(),
    linkPreviewPolicy: mutableBindingPolicyFieldsV1.linkPreviewPolicy.optional(),
    senderFeedback: mutableBindingPolicyFieldsV1.senderFeedback.optional(),
    enabled: mutableBindingPolicyFieldsV1.enabled.optional(),
} as const;

/** @internal Relative-only omission-preserving guarded binding update input. */
export const ConversationBindingUpdateInputV1ProtocolSchema = defineProtocolUnion([
    defineProtocolObject({
        ...conversationBindingUpdateFieldsV1,
        audienceSelection: conversationBindingHumanAudienceSelectionV1.optional(),
        allowBotSenders: mutableBindingPolicyFieldsV1.allowBotSenders.optional(),
    }, { policy: 'closed' }),
    defineProtocolObject({
        ...conversationBindingUpdateFieldsV1,
        audienceSelection: conversationBindingAudienceSelectionV1,
        allowBotSenders: defineProtocolLiteral(true),
    }, { policy: 'closed' }),
]);

export const ConversationBindingUpdateInputV1Schema = ConversationBindingUpdateInputV1ProtocolSchema;
export type ConversationBindingUpdateInputV1 = ReturnType<
    typeof ConversationBindingUpdateInputV1Schema.parse
>;
export const ConversationBindingUpdateInputV1JsonSchema: PluginJsonSchema = ConversationBindingUpdateInputV1Schema.jsonSchema;

const conversationBindingUpdateResultV1 = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('updated'),
        defineProtocolLiteral('unchanged'),
    ]),
    bindingId: ConversationBindingIdV1ProtocolSchema,
    revision: positiveSafeInteger,
    authorityEpoch: positiveSafeInteger,
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels management schemas. */
export const ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('notVerified'),
    reason: defineProtocolUnion([
        defineProtocolLiteral('notFound'),
        defineProtocolLiteral('resultDeliveryUnsupported'),
    ]),
}, { policy: 'closed' });

export const ConversationBindingSetEnabledInputV1Schema = defineProtocolObject({
    bindingId: ConversationBindingIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
    enabled: protocolBoolean,
}, { policy: 'closed' });
export type ConversationBindingSetEnabledInputV1 = ReturnType<
    typeof ConversationBindingSetEnabledInputV1Schema.parse
>;
export const ConversationBindingSetEnabledInputV1JsonSchema: PluginJsonSchema =
    ConversationBindingSetEnabledInputV1Schema.jsonSchema;

/** @internal Relative-only idempotent binding deletion request. */
export const ConversationBindingDeleteInputV1ProtocolSchema = defineProtocolObject({
    bindingId: ConversationBindingIdV1ProtocolSchema,
    expectedRevision: positiveSafeInteger,
}, { policy: 'closed' });

export const ConversationBindingDeleteInputV1Schema = ConversationBindingDeleteInputV1ProtocolSchema;
export type ConversationBindingDeleteInputV1 = ReturnType<
    typeof ConversationBindingDeleteInputV1Schema.parse
>;
export const ConversationBindingDeleteInputV1JsonSchema: PluginJsonSchema =
    ConversationBindingDeleteInputV1Schema.jsonSchema;

export const ConversationBindingUpdateResultV1Schema = conversationBindingUpdateResultV1;
export type ConversationBindingUpdateResultV1 = ReturnType<
    typeof ConversationBindingUpdateResultV1Schema.parse
>;
export const ConversationBindingUpdateResultV1JsonSchema: PluginJsonSchema =
    ConversationBindingUpdateResultV1Schema.jsonSchema;

/** The only public deletion outcomes; cleanup state remains a retained binding concern. */
export const ConversationBindingDeleteResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('deleted') }, { policy: 'closed' }),
    defineProtocolObject({ kind: defineProtocolLiteral('deletionPending') }, { policy: 'closed' }),
]);
export type ConversationBindingDeleteResultV1 = ReturnType<
    typeof ConversationBindingDeleteResultV1Schema.parse
>;
export const ConversationBindingDeleteResultV1JsonSchema: PluginJsonSchema =
    ConversationBindingDeleteResultV1Schema.jsonSchema;

export const ConversationAutomationTargetNotVerifiedResultV1Schema = ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema;
export type ConversationAutomationTargetNotVerifiedResultV1 = ReturnType<
    typeof ConversationAutomationTargetNotVerifiedResultV1Schema.parse
>;
export const ConversationAutomationTargetNotVerifiedResultV1JsonSchema: PluginJsonSchema =
    ConversationAutomationTargetNotVerifiedResultV1Schema.jsonSchema;

/** Guarded binding update outcomes, including current resolver and verifier feedback. */
export const ConversationBindingMutationResultV1Schema = defineProtocolUnion([
    conversationBindingUpdateResultV1,
    ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema,
    ConversationBindingResolutionUnavailableV1ProtocolSchema,
    conversationBindingStaleResultV1,
    ConversationProviderFailureV1ProtocolSchema,
]);
export type ConversationBindingMutationResultV1 = ReturnType<
    typeof ConversationBindingMutationResultV1Schema.parse
>;
export const ConversationBindingMutationResultV1JsonSchema: PluginJsonSchema =
    ConversationBindingMutationResultV1Schema.jsonSchema;

export const ConversationBindingCreateResultV1Schema = defineProtocolUnion([
    defineProtocolObject({
        kind: defineProtocolLiteral('created'),
        binding: ConversationBindingV1ProtocolSchema,
    }, { policy: 'closed' }),
    ConversationAutomationTargetNotVerifiedResultV1ProtocolSchema,
    ConversationBindingResolutionUnavailableV1ProtocolSchema,
    defineProtocolObject({
        kind: defineProtocolLiteral('stale'),
    }, { policy: 'closed' }),
    ConversationProviderFailureV1ProtocolSchema,
]);
export type ConversationBindingCreateResultV1 = ReturnType<
    typeof ConversationBindingCreateResultV1Schema.parse
>;
export const ConversationBindingCreateResultV1JsonSchema: PluginJsonSchema =
    ConversationBindingCreateResultV1Schema.jsonSchema;
