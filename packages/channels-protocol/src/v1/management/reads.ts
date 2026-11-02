import {
    defineProtocolArray, defineProtocolLiteral, defineProtocolNumber,
    defineProtocolObject, defineProtocolString, defineProtocolUnion,
    ProtocolCollectionOpaqueCursorV1Schema,
    type PluginJsonSchema,
} from '@happier-dev/plugin-sdk/protocol';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import { ConversationBindingIdV1Schema, ConversationConnectionIdV1Schema, ConversationCollectionRowRevisionV1ProtocolSchema } from '../identity.js';
import { ConversationProviderDiagnosticV1Schema } from '../diagnostics.js';
import { CONVERSATION_NON_ADMISSION_REASONS_V1, CONVERSATION_PROVIDER_FAILURE_REASONS_V1, CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1 } from '../bounds.js';
import { ConversationSessionLastDeliveryOutcomeV1Schema } from './sessionConversations.js';
import { ConversationJsonValueV1ProtocolSchema } from '../json.js';

function values<const T extends readonly [string, string, ...string[]]>(entries: T) {
    const literal = (entry: T[number]) => defineProtocolLiteral(entry);
    return defineProtocolUnion([literal(entries[0]), literal(entries[1]), ...entries.slice(2).map(literal)]);
}
const closed = { policy: 'closed' } as const;
const text = defineProtocolString({ minLength: 1 });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const integer = defineProtocolNumber({ integer: true, minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const revision = ConversationCollectionRowRevisionV1ProtocolSchema;
const pageFields = {
    cursor: ProtocolCollectionOpaqueCursorV1Schema.optional(),
    // This is the existing Account Collection query envelope, not a Channels cap.
    limit: defineProtocolNumber({ integer: true, minimum: 1, maximum: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 }).optional(),
};
const nextCursor = ProtocolCollectionOpaqueCursorV1Schema.optional();
/** Read-time guidance only. The named Action still admits input and owns effects. */
export const ConversationRecommendedRecoveryV1Schema = defineProtocolObject({
    action: defineProtocolUnion([text, defineProtocolObject({ pluginId: text, localId: text }, closed)]),
    input: ConversationJsonValueV1ProtocolSchema,
    reason: text,
    // Missing operands are never defaulted into consent to an irreversible effect.
    unavailableReason: text.optional(),
}, closed);
export type ConversationRecommendedRecoveryV1 = ReturnType<typeof ConversationRecommendedRecoveryV1Schema.parse>;
export const ConversationRecommendedRecoveryV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationRecommendedRecoveryV1Schema.jsonSchema)();
const recommendedRecovery = ConversationRecommendedRecoveryV1Schema.nullable().optional();
export const ConversationConnectionListInputV1Schema = defineProtocolObject(pageFields, closed);
export const ConversationBindingListInputV1Schema = defineProtocolObject({ ...pageFields,
    connectionId: ConversationConnectionIdV1Schema.optional(), parentBindingId: ConversationBindingIdV1Schema.optional(),
    sessionId: text.optional(), automationId: text.optional(),
}, closed);
export const ConversationIngressAttentionInputV1Schema = defineProtocolObject(pageFields, closed);
export const ConversationDeliveryAttentionInputV1Schema = defineProtocolObject({ ...pageFields,
    connectionId: ConversationConnectionIdV1Schema,
}, closed);
const custodyId = defineProtocolString({ pattern: '^[A-Za-z0-9_-]{43}$' });
export const ConversationDeliveryReadInputV1Schema = defineProtocolObject({ custodyId }, closed);

const pollEvidence = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('provider'), reason: values(CONVERSATION_PROVIDER_FAILURE_REASONS_V1) }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('action'), code: text, message: text.optional() }, closed),
]);
const pollFailure = defineProtocolUnion([
    defineProtocolObject({ phase: defineProtocolLiteral('retryDue'), attemptCount: integer, retryNotBeforeMs: integer, evidence: pollEvidence }, closed),
    defineProtocolObject({ phase: defineProtocolLiteral('blocked'), attemptCount: integer, retryNotBeforeMs: defineProtocolLiteral(null), evidence: pollEvidence }, closed),
]).nullable();
const outwardDelivery = defineProtocolObject({ retryDue: boolean, notDelivered: boolean, partial: boolean,
    outcomeUnknown: boolean, archiveRecovery: boolean }, closed);
export const ConversationConnectionManagementRowV1Schema = defineProtocolObject({
    connectionId: ConversationConnectionIdV1Schema, revision, providerPluginId: text, selectedMachineId: text,
    selectedTransport: values(['checkpointedPull', 'socket', 'durablePush']), integrationPrincipalLabel: defineProtocolString().optional(),
    sharedEndpointInputModes: defineProtocolArray(values(['directMentionsOnly', 'addressedMessages', 'allAllowedMessages'])).optional(),
    authorityEpoch: integer, enabled: boolean, deletionState: values(['none', 'pendingStopReconciliation', 'finalizingDelete']),
    maximumObservationAgeMs: integer,
    recommendedRecovery,
    attention: defineProtocolObject({
        historyGap: defineProtocolObject({ reportedAt: integer, reason: values(['providerHistoryUnavailable', 'applicationAdmissionLost']) }, closed).nullable(),
        providerReadiness: defineProtocolObject({ code: values(CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1),
            diagnostic: ConversationProviderDiagnosticV1Schema.optional() }, closed).nullable(),
        ingressConflict: defineProtocolObject({ kind: defineProtocolLiteral('occurrenceEvidenceMismatch') }, closed).nullable(),
        pollFailure, bestEffortBeforeDurableAdmission: boolean, oldTransportStopUnconfirmed: boolean,
        endpointRetargetOwed: boolean, acceptedPossibleLoss: boolean, outwardDelivery,
    }, closed),
}, closed);
export const ConversationConnectionListResultV1Schema = defineProtocolObject({
    connections: defineProtocolArray(ConversationConnectionManagementRowV1Schema), nextCursor,
}, closed);
export const ConversationBindingManagementRowV1Schema = defineProtocolObject({
    bindingId: ConversationBindingIdV1Schema, parentBindingId: ConversationBindingIdV1Schema.optional(), revision,
    connectionId: ConversationConnectionIdV1Schema,
    endpoint: defineProtocolObject({ audience: values(['direct', 'shared']), label: defineProtocolString().optional() }, closed),
    target: defineProtocolObject({ kind: values(['session', 'automation', 'threadRouter']), summary: text, sessionId: text.optional() }, closed),
    inputMode: values(['directMentionsOnly', 'addressedMessages', 'allAllowedMessages']),
    deliveryMode: values(['repliesOnly', 'mirrorSession', 'finalResult', 'none']),
    approval: defineProtocolUnion([
        defineProtocolObject({ kind: defineProtocolLiteral('notApplicable') }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('off') }, closed),
        defineProtocolObject({ kind: defineProtocolLiteral('enabled'), maximumScope: values(['request', 'session']) }, closed),
    ]), enabled: boolean, deletionState: values(['none', 'finalizingDelete']), recommendedRecovery,
}, closed);
export const ConversationBindingListResultV1Schema = defineProtocolObject({ bindings: defineProtocolArray(ConversationBindingManagementRowV1Schema), nextCursor }, closed);
const ingressIdentity = { obligationId: custodyId, revision, connectionId: ConversationConnectionIdV1Schema,
    bindingId: ConversationBindingIdV1Schema.optional(), updatedAt: integer, recommendedRecovery };
export const ConversationIngressAttentionResultV1Schema = defineProtocolObject({ obligations: defineProtocolArray(defineProtocolUnion([
    defineProtocolObject({ ...ingressIdentity, kind: defineProtocolLiteral('blocked'), attemptCount: integer }, closed),
    defineProtocolObject({ ...ingressIdentity, kind: defineProtocolLiteral('terminal'), category: values(['informational', 'recoverable']),
        reason: values(CONVERSATION_NON_ADMISSION_REASONS_V1).optional() }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('occurrenceConflict'), censusId: custodyId, revision, connectionId: ConversationConnectionIdV1Schema, recommendedRecovery }, closed),
])), nextCursor }, closed);
const createdThreadEndpointRequired = defineProtocolObject({ parentId: text }, closed).optional();
export const ConversationDeliveryAttentionResultV1Schema = defineProtocolObject({ rows: defineProtocolArray(defineProtocolObject({
    custodyId, bindingId: ConversationBindingIdV1Schema.optional(), revision, createdAt: integer, state: values(['partial', 'outcomeUnknown', 'archiveRecoverable']),
    acceptedPartCount: integer, failedChunk: integer.optional(), createdThreadEndpointRequired, recommendedRecovery,
}, closed)), nextCursor }, closed);
export const CONVERSATION_DELIVERY_CUSTODY_STATES_V1 = [
    'ready', 'retryDue', 'attempting', 'delivered', 'notDelivered', 'suppressed', 'partial', 'outcomeUnknown',
    'resolvedAccepted', 'resolvedDiscarded', 'connectionDeleted',
] as const;
export const ConversationDeliveryReadResultV1Schema = defineProtocolUnion([
    defineProtocolObject({ kind: defineProtocolLiteral('notFound') }, closed),
    defineProtocolObject({ kind: defineProtocolLiteral('ready'), delivery: defineProtocolObject({
        custodyId, revision, connectionId: ConversationConnectionIdV1Schema, bindingId: ConversationBindingIdV1Schema.optional(),
        state: values(CONVERSATION_DELIVERY_CUSTODY_STATES_V1),
        projection: defineProtocolObject({ terminal: boolean, attention: boolean, retryNotBefore: integer.optional() }, closed),
        lastOutcome: ConversationSessionLastDeliveryOutcomeV1Schema, createdThreadEndpointRequired, recommendedRecovery,
    }, closed) }, closed),
]);

export const ConversationConnectionListInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationConnectionListInputV1Schema.jsonSchema)();
export const ConversationConnectionListResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationConnectionListResultV1Schema.jsonSchema)();
export const ConversationConnectionManagementRowV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationConnectionManagementRowV1Schema.jsonSchema)();
export const ConversationBindingListInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationBindingListInputV1Schema.jsonSchema)();
export const ConversationBindingListResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationBindingListResultV1Schema.jsonSchema)();
export const ConversationBindingManagementRowV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationBindingManagementRowV1Schema.jsonSchema)();
export const ConversationIngressAttentionInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationIngressAttentionInputV1Schema.jsonSchema)();
export const ConversationIngressAttentionResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationIngressAttentionResultV1Schema.jsonSchema)();
export const ConversationDeliveryAttentionInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryAttentionInputV1Schema.jsonSchema)();
export const ConversationDeliveryAttentionResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryAttentionResultV1Schema.jsonSchema)();
export const ConversationDeliveryReadInputV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryReadInputV1Schema.jsonSchema)();
export const ConversationDeliveryReadResultV1JsonSchema: PluginJsonSchema = /* @__PURE__ */ (() => ConversationDeliveryReadResultV1Schema.jsonSchema)();
