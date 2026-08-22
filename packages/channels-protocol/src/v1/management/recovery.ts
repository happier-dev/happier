import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolString,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

const opaqueCustodyIdV1 = defineProtocolString({ pattern: '^[A-Za-z0-9_-]{43}$' });
const positiveSafeInteger = defineProtocolNumber({
    integer: true,
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
});

/** @internal Relative-only exact ingress-obligation retry input. */
export const ConversationIngressRetryInputV1ProtocolSchema = defineProtocolObject({
    obligationId: opaqueCustodyIdV1,
    expectedRevision: positiveSafeInteger,
}, { policy: 'closed' });

/** Retries one exact blocked ingress obligation; it cannot supply new ingress. */
export const ConversationIngressRetryInputV1Schema = ConversationIngressRetryInputV1ProtocolSchema;
export type ConversationIngressRetryInputV1 = ReturnType<
    typeof ConversationIngressRetryInputV1Schema.parse
>;
export const ConversationIngressRetryInputV1JsonSchema: PluginJsonSchema =
    ConversationIngressRetryInputV1Schema.jsonSchema;

/** @internal Relative-only exact ingress-obligation retry outcome. */
export const ConversationIngressRetryResultV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('retryScheduled'),
    obligationId: opaqueCustodyIdV1,
    revision: positiveSafeInteger,
}, { policy: 'closed' });

export const ConversationIngressRetryResultV1Schema = ConversationIngressRetryResultV1ProtocolSchema;
export type ConversationIngressRetryResultV1 = ReturnType<
    typeof ConversationIngressRetryResultV1Schema.parse
>;
export const ConversationIngressRetryResultV1JsonSchema: PluginJsonSchema =
    ConversationIngressRetryResultV1Schema.jsonSchema;

/** @internal Relative-only explicit settlement of one ambiguous delivery custody row. */
export const ConversationDeliveryResolveInputV1ProtocolSchema = defineProtocolObject({
    custodyId: opaqueCustodyIdV1,
    expectedRevision: positiveSafeInteger,
    resolution: defineProtocolUnion([
        defineProtocolLiteral('accepted'),
        defineProtocolLiteral('discarded'),
        // The provider proved the archived destination received nothing, and
        // reported the owner-led recovery arm. Reopening that exact obligation
        // is not a blind resend: it is the only decision the custody owner
        // will accept for an authoritative no-effect refusal.
        defineProtocolLiteral('retryAfterUnarchive'),
    ]),
}, { policy: 'closed' });

/** A user may settle retained ambiguous custody, never resend a provider effect. */
export const ConversationDeliveryResolveInputV1Schema = ConversationDeliveryResolveInputV1ProtocolSchema;
export type ConversationDeliveryResolveInputV1 = ReturnType<
    typeof ConversationDeliveryResolveInputV1Schema.parse
>;
export const ConversationDeliveryResolveInputV1JsonSchema: PluginJsonSchema =
    ConversationDeliveryResolveInputV1Schema.jsonSchema;

/** @internal Relative-only delivery-custody settlement outcome. */
export const ConversationDeliveryResolveResultV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolLiteral('resolved'),
    custodyId: opaqueCustodyIdV1,
    revision: positiveSafeInteger,
    resolution: defineProtocolUnion([
        defineProtocolLiteral('accepted'),
        defineProtocolLiteral('discarded'),
        defineProtocolLiteral('retryAfterUnarchive'),
    ]),
}, { policy: 'closed' });

export const ConversationDeliveryResolveResultV1Schema = ConversationDeliveryResolveResultV1ProtocolSchema;
export type ConversationDeliveryResolveResultV1 = ReturnType<
    typeof ConversationDeliveryResolveResultV1Schema.parse
>;
export const ConversationDeliveryResolveResultV1JsonSchema: PluginJsonSchema =
    ConversationDeliveryResolveResultV1Schema.jsonSchema;
