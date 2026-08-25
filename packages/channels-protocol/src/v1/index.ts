// V1 is the only public Channels business-protocol epoch.
export * from './bounds.js';
export type {
    ConversationJsonObjectV1,
    ConversationJsonValueV1,
} from './json.js';
export {
    CONVERSATION_CHANNEL_RELATION_ID_PRINTABLE_ASCII_PATTERN_V1,
    ConversationBindingIdV1JsonSchema,
    ConversationBindingIdV1Schema,
    ConversationChannelRelationIdV1JsonSchema,
    ConversationChannelRelationIdV1Schema,
    ConversationConnectionIdV1JsonSchema,
    ConversationConnectionIdV1Schema,
} from './identity.js';
export type {
    ConversationBindingIdV1,
    ConversationChannelRelationIdV1,
    ConversationConnectionIdV1,
} from './identity.js';
export {
    ConversationConnectionHistoryGapFactV1JsonSchema,
    ConversationConnectionHistoryGapFactV1Schema,
    ConversationProviderDiagnosticV1JsonSchema,
    ConversationProviderDiagnosticV1Schema,
    ConversationProviderFailureV1JsonSchema,
    ConversationProviderFailureV1Schema,
} from './diagnostics.js';
export type {
    ConversationConnectionHistoryGapFactV1,
    ConversationProviderDiagnosticV1,
    ConversationProviderFailureV1,
} from './diagnostics.js';
export * from './text.js';
export {
    ConversationAuthenticatedObservationShellV1JsonSchema,
    ConversationAuthenticatedObservationShellV1Schema,
    ConversationIngressAutomationEventCandidateV1JsonSchema,
    ConversationIngressAutomationEventCandidateV1Schema,
    ConversationIngressObservedEntryV1JsonSchema,
    ConversationIngressObservedEntryV1Schema,
    ConversationNormalizedIngressV1JsonSchema,
    ConversationNormalizedIngressV1Schema,
    ConversationObservationV1JsonSchema,
    ConversationObservationV1Schema,
    ConversationProviderObservationIngestInputV1JsonSchema,
    ConversationProviderObservationIngestInputV1Schema,
} from './core/ingress.js';
export type {
    ConversationAutomationEventRefV1,
    ConversationAuthenticatedObservationShellV1,
    ConversationIngressAutomationEventCandidateV1,
    ConversationIngressObservedEntryV1,
    ConversationNormalizedIngressV1,
    ConversationObservationV1,
    ConversationProviderObservationIngestInputV1,
} from './core/ingress.js';
export {
    ConversationTransportFactReportInputV1JsonSchema,
    ConversationTransportFactReportInputV1Schema,
    ConversationTransportFactReportResultV1JsonSchema,
    ConversationTransportFactReportResultV1Schema,
} from './core/transportFacts.js';
export type {
    ConversationTransportFactReportInputV1,
    ConversationTransportFactReportResultV1,
} from './core/transportFacts.js';
export {
    CONVERSATION_CORE_PROVIDER_ACTION_DECLARATIONS_V1,
} from './core/declarations.js';
export * from './management/index.js';
export * from './provider/index.js';
