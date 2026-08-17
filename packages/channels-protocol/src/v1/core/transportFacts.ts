import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';

import {
    defineProtocolLiteral,
    defineProtocolNumber,
    defineProtocolObject,
    defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

import {
    ConversationApplicationAdmissionLostV1Fields,
    ConversationProviderDiagnosticV1ProtocolSchema,
    ConversationProviderHistoryUnavailableV1Fields,
} from '../diagnostics.js';
import { CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1 } from '../bounds.js';
import { ConversationConnectionIdV1ProtocolSchema } from '../identity.js';

const conversationProviderHistoryGapTransportFactV1 = defineProtocolObject({
    ...ConversationProviderHistoryUnavailableV1Fields,
    kind: defineProtocolLiteral('historyGap'),
}, { policy: 'closed' });

const conversationApplicationAdmissionLostTransportFactV1 = defineProtocolObject({
    ...ConversationApplicationAdmissionLostV1Fields,
    kind: defineProtocolLiteral('historyGap'),
}, { policy: 'closed' });

const conversationStopConfirmedTransportFactV1 = defineProtocolObject({
    kind: defineProtocolLiteral('stopConfirmed'),
    reason: defineProtocolUnion([
        defineProtocolLiteral('explicitStop'),
        defineProtocolLiteral('notRunningOnReconcile'),
    ]),
}, { policy: 'closed' });

const conversationProviderReadinessAttentionTransportFactV1 = defineProtocolObject({
    kind: defineProtocolLiteral('providerReadiness'),
    status: defineProtocolLiteral('attention'),
    code: defineProtocolUnion([
        defineProtocolLiteral(CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1[0]),
        defineProtocolLiteral(CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1[1]),
    ]),
    diagnostic: ConversationProviderDiagnosticV1ProtocolSchema.optional(),
}, { policy: 'closed' });

const conversationProviderReadinessReadyTransportFactV1 = defineProtocolObject({
    kind: defineProtocolLiteral('providerReadiness'),
    status: defineProtocolLiteral('ready'),
}, { policy: 'closed' });

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationTransportFactReportInputV1ProtocolSchema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1ProtocolSchema,
    authorityEpoch: defineProtocolNumber({
        integer: true,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
    }),
    fact: defineProtocolUnion([
        conversationProviderHistoryGapTransportFactV1,
        conversationApplicationAdmissionLostTransportFactV1,
        conversationStopConfirmedTransportFactV1,
        conversationProviderReadinessAttentionTransportFactV1,
        conversationProviderReadinessReadyTransportFactV1,
    ]),
}, { policy: 'closed' });

/**
 * The only connection facts a background or socket provider may report. The
 * host derives caller identity and reconciliation eligibility separately.
 */
export const ConversationTransportFactReportInputV1Schema = ConversationTransportFactReportInputV1ProtocolSchema;
export type ConversationTransportFactReportInputV1 = ReturnType<
    typeof ConversationTransportFactReportInputV1Schema.parse
>;
export const ConversationTransportFactReportInputV1JsonSchema: PluginJsonSchema =
    ConversationTransportFactReportInputV1Schema.jsonSchema;

/** @internal Relative-only input for composed Channels protocol schemas. */
export const ConversationTransportFactReportResultV1ProtocolSchema = defineProtocolObject({
    kind: defineProtocolUnion([
        defineProtocolLiteral('recorded'),
        defineProtocolLiteral('rejoined'),
        defineProtocolLiteral('deleteFinalizing'),
        defineProtocolLiteral('staleAuthority'),
    ]),
}, { policy: 'closed' });

/** Closed core acknowledgement for a recorded or currentness-rejected transport fact. */
export const ConversationTransportFactReportResultV1Schema = ConversationTransportFactReportResultV1ProtocolSchema;
export type ConversationTransportFactReportResultV1 = ReturnType<
    typeof ConversationTransportFactReportResultV1Schema.parse
>;
export const ConversationTransportFactReportResultV1JsonSchema: PluginJsonSchema =
    ConversationTransportFactReportResultV1Schema.jsonSchema;
