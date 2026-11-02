import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolArray,
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
    defineProtocolUtf8String,
    defineProtocolUniqueArray,
} from '@happier-dev/plugin-sdk/protocol';
import { PluginContributionIdentityV1Schema } from '@happier-dev/plugin-sdk/manifest';

import {
    CONVERSATION_OUTBOUND_TEXT_UNITS_V1,
    CONVERSATION_TRANSPORT_KINDS_V1,
    MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
} from '../bounds.js';
import {
    ConversationProviderConfigV1ProtocolSchema,
} from '../json.js';
import {
    ConversationProviderConnectionKeyV1ProtocolSchema,
    ConversationQualifiedConnectedAccountRefV1ProtocolSchema,
    ConversationSharedEndpointInputModesV1ProtocolSchema,
} from './connection.js';
import {
    ConversationIntegrationPrincipalV1ProtocolSchema,
} from './lifecycle.js';
import { ConversationEndpointDisplayLabelV1ProtocolSchema } from './resolution.js';
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';

const ConversationPluginContributionRefV1ProtocolSchema = PluginContributionIdentityV1Schema;
const conversationPluginContributionRefV1 = ConversationPluginContributionRefV1ProtocolSchema;

/** @internal One configurable freshness range, also used by connection writes. */
export const ConversationMaximumObservationAgeV1ProtocolSchema = defineProtocolNumber({
    integer: true,
    minimum: 0,
    maximum: Number.MAX_SAFE_INTEGER,
});

const conversationTransportKindV1 = defineProtocolUnion([
    defineProtocolLiteral(CONVERSATION_TRANSPORT_KINDS_V1[0]),
    defineProtocolLiteral(CONVERSATION_TRANSPORT_KINDS_V1[1]),
    defineProtocolLiteral(CONVERSATION_TRANSPORT_KINDS_V1[2]),
]);

/** @internal One set-valued transport inventory shared with preparation. */
export const ConversationSupportedTransportsV1ProtocolSchema = defineProtocolUniqueArray(
    conversationTransportKindV1,
    { minItems: 1, maxItems: CONVERSATION_TRANSPORT_KINDS_V1.length },
);

const pairingDeepLinkTemplateV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
    minLength: 1,
    pattern: '^(?:(?!\\{\\{token\\}\\})[\\s\\S])*\\{\\{token\\}\\}(?:(?!\\{\\{token\\}\\})[\\s\\S])*$',
});

const conversationSetupExternalUrlV1 = defineProtocolUtf8String({
    maxUtf8Bytes: MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
    minLength: 1,
    pattern: '^https://[^\\s]+$',
});

/** @internal Provider-authored presentation; copyable values must never contain credentials. */
export const ConversationProviderSetupGuidanceV1ProtocolSchema = defineProtocolObject({
    externalUrl: conversationSetupExternalUrlV1,
    requiredPermissionsLabel: ConversationEndpointDisplayLabelV1ProtocolSchema,
    steps: defineProtocolArray(defineProtocolObject({
        title: ConversationEndpointDisplayLabelV1ProtocolSchema,
        externalUrl: conversationSetupExternalUrlV1.optional(),
        copyableValues: defineProtocolArray(defineProtocolObject({
            label: ConversationEndpointDisplayLabelV1ProtocolSchema,
            value: defineProtocolString({ minLength: 1 }),
        }, { policy: 'closed' }), { minItems: 1 }).optional(),
    }, { policy: 'closed' }), { minItems: 1 }).optional(),
}, { policy: 'closed' });

/**
 * @internal The three provider-declared connection facts that transport-free
 * preparation re-projects verbatim. Preparation reads them from this one owner
 * so a new safety level, continuity mode, or text unit cannot reach the setup
 * result while the prepare projection keeps rejecting it.
 */
export const ConversationConnectionOverlapSafetyV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral('safe'),
    defineProtocolLiteral('providerExclusive'),
    defineProtocolLiteral('destructive'),
]);

/** @internal Replay guarantee the provider's transport can offer after a gap. */
export const ConversationConnectionReplayContinuityV1ProtocolSchema = defineProtocolUnion([
    defineProtocolLiteral('checkpointed'),
    defineProtocolLiteral('sessionBound'),
    defineProtocolLiteral('none'),
]);

/** @internal One outbound text ceiling in the provider's own counting unit. */
export const ConversationOutboundTextLimitV1ProtocolSchema = defineProtocolObject({
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
    // Rendering/escaping/mention suppression must preserve this unit's count.
    // Thus the core's pre-send measure is also the post-format native measure.
    // Omission retains the existing requirement; it never permits expansion.
    formatting: defineProtocolLiteral('preservesNativeUnits').optional(),
}, { policy: 'closed' });

/** A declared provider-native ceiling; omission in setup means no text ceiling. */
export const ConversationOutboundTextLimitV1Schema = ConversationOutboundTextLimitV1ProtocolSchema;
export type ConversationOutboundTextLimitV1 = ReturnType<typeof ConversationOutboundTextLimitV1Schema.parse>;
export const ConversationOutboundTextLimitV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationOutboundTextLimitV1Schema.jsonSchema)();

/** @internal Relative-only input for the contributed setup result. */
export const ConversationProviderSetupResultV1ProtocolSchema = defineProtocolObject({
    v: defineProtocolLiteral(1),
    credentialRef: ConversationQualifiedConnectedAccountRefV1ProtocolSchema.nullable(),
    providerConnectionKey: ConversationProviderConnectionKeyV1ProtocolSchema,
    providerConfigVersion: defineProtocolLiteral(1),
    providerConfig: ConversationProviderConfigV1ProtocolSchema,
    integrationPrincipal: ConversationIntegrationPrincipalV1ProtocolSchema,
    supportedTransports: ConversationSupportedTransportsV1ProtocolSchema,
    recommendedTransport: conversationTransportKindV1,
    overlapSafety: ConversationConnectionOverlapSafetyV1ProtocolSchema,
    replayContinuity: ConversationConnectionReplayContinuityV1ProtocolSchema,
    outboundTextLimit: ConversationOutboundTextLimitV1ProtocolSchema.optional(),
    recommendedMaximumObservationAgeMs: ConversationMaximumObservationAgeV1ProtocolSchema.optional(),
    sharedEndpointInputModes: ConversationSharedEndpointInputModesV1ProtocolSchema.optional(),
    setupGuidance: ConversationProviderSetupGuidanceV1ProtocolSchema.optional(),
    pairingDeepLinkTemplate: pairingDeepLinkTemplateV1.optional(),
    webhookContributionRef: conversationPluginContributionRefV1.optional(),
}, { policy: 'closed' });

/** Provider-authenticated setup facts; no endpoint setup object is a Channels value. */
export const ConversationProviderSetupResultV1Schema = ConversationProviderSetupResultV1ProtocolSchema;
export type ConversationProviderSetupResultV1 = ReturnType<
    typeof ConversationProviderSetupResultV1Schema.parse
>;
export const ConversationProviderSetupResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationProviderSetupResultV1Schema.jsonSchema)();

/**
 * A provider's safe setup observation that asks the present user to resolve a
 * provider-owned conflict through the optional `setupRemediation` role.
 *
 * The Action declaration is the one presentation owner for that operation:
 * title, description, input hints, and host-rendered confirmation are not
 * duplicated in this data result. This keeps provider-local remediation
 * vocabulary out of Channels while still making the setup state explicit.
 */
export const ConversationProviderSetupRemediationV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('requiresRemediation'),
}, { policy: 'closed' });

export const ConversationProviderSetupRemediationV1Schema = ConversationProviderSetupRemediationV1ProtocolSchema;
export type ConversationProviderSetupRemediationV1 = ReturnType<
    typeof ConversationProviderSetupRemediationV1Schema.parse
>;
export const ConversationProviderSetupRemediationV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationProviderSetupRemediationV1Schema.jsonSchema)();

const conversationProviderSetupRemediatedV1 = defineProtocolObject({
    kind: defineProtocolLiteral('remediated'),
}, { policy: 'closed' });

const conversationProviderSetupRemediationOutcomeUnknownV1 = defineProtocolObject({
    kind: defineProtocolLiteral('outcomeUnknown'),
}, { policy: 'closed' });

/** @internal Relative-only result for the optional provider setup-remediation role. */
export const ConversationProviderSetupRemediationResultV1ProtocolSchema = defineProtocolUnion([
    conversationProviderSetupRemediatedV1,
    conversationProviderSetupRemediationOutcomeUnknownV1,
    ConversationProviderFailureV1ProtocolSchema,
]);

/**
 * Provider remediation effect evidence. `outcomeUnknown` is distinct from a
 * definite provider failure because the remote conflict may already have been
 * changed; Channels must re-run safe setup observation instead of retrying the
 * mutation blindly.
 */
export const ConversationProviderSetupRemediationResultV1Schema =
    ConversationProviderSetupRemediationResultV1ProtocolSchema;
export type ConversationProviderSetupRemediationResultV1 = ReturnType<
    typeof ConversationProviderSetupRemediationResultV1Schema.parse
>;
export const ConversationProviderSetupRemediationResultV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationProviderSetupRemediationResultV1Schema.jsonSchema)();

/** @internal Relative-only input for every valid setup role outcome. */
export const ConversationProviderSetupOutcomeV1ProtocolSchema = defineProtocolUnion([
    ConversationProviderSetupResultV1ProtocolSchema,
    ConversationProviderSetupRemediationV1ProtocolSchema,
]);

export const ConversationProviderSetupOutcomeV1Schema = ConversationProviderSetupOutcomeV1ProtocolSchema;
export type ConversationProviderSetupOutcomeV1 = ReturnType<
    typeof ConversationProviderSetupOutcomeV1Schema.parse
>;
export const ConversationProviderSetupOutcomeV1JsonSchema: PluginJsonSchema =
    /* @__PURE__ */ (() => ConversationProviderSetupOutcomeV1Schema.jsonSchema)();
