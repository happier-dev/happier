import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
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
import { ConversationProviderFailureV1ProtocolSchema } from '../diagnostics.js';

const ConversationPluginContributionRefV1ProtocolSchema = PluginContributionIdentityV1Schema;
const conversationPluginContributionRefV1 = ConversationPluginContributionRefV1ProtocolSchema;

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
}, { policy: 'closed' });

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
    outboundTextLimit: ConversationOutboundTextLimitV1ProtocolSchema,
    sharedEndpointInputModes: ConversationSharedEndpointInputModesV1ProtocolSchema.optional(),
    pairingDeepLinkTemplate: pairingDeepLinkTemplateV1.optional(),
    webhookContributionRef: conversationPluginContributionRefV1.optional(),
}, { policy: 'closed' });

/** Provider-authenticated setup facts; no endpoint setup object is a Channels value. */
export const ConversationProviderSetupResultV1Schema = ConversationProviderSetupResultV1ProtocolSchema;
export type ConversationProviderSetupResultV1 = ReturnType<
    typeof ConversationProviderSetupResultV1Schema.parse
>;
export const ConversationProviderSetupResultV1JsonSchema: PluginJsonSchema =
    ConversationProviderSetupResultV1Schema.jsonSchema;

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
    ConversationProviderSetupRemediationV1Schema.jsonSchema;

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
    ConversationProviderSetupRemediationResultV1Schema.jsonSchema;

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
    ConversationProviderSetupOutcomeV1Schema.jsonSchema;
