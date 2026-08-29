import {
    conversationBindingPolicyForOmittedFieldsV1,
    ConversationBindingCreateInputV1Schema,
    ConversationBindingCreateResultV1Schema,
    ConversationBindingDeleteInputV1Schema,
    ConversationBindingDeleteResultV1Schema,
    ConversationBindingMutationResultV1Schema,
    ConversationBindingReadInputV1Schema,
    ConversationBindingReadResultV1Schema,
    ConversationBindingResolveInputV1Schema,
    ConversationBindingResolveResultV1Schema,
    ConversationBindingSetEnabledInputV1Schema,
    ConversationBindingUpdateInputV1Schema,
    ConversationBindingUpdateResultV1Schema,
} from './bindings.js';
import {
    ConversationConnectionCreateInputV1Schema,
    ConversationConnectionCreateResultV1Schema,
    ConversationConnectionDeleteInputV1Schema,
    ConversationConnectionDeleteResultV1Schema,
    ConversationConnectionTransferInputV1Schema,
    ConversationConnectionTransferResultV1Schema,
    ConversationConnectionUpdateInputV1Schema,
    ConversationConnectionUpdateResultV1Schema,
} from './connections.js';
import {
    ConversationPairingCancelInputV1Schema,
    ConversationPairingCancelResultV1Schema,
    ConversationPairingCreateInputV1Schema,
    ConversationPairingCreateResultV1Schema,
    ConversationPairingFinalizeInputV1Schema,
    ConversationPairingFinalizeResultV1Schema,
} from './pairing.js';
import {
    ConversationConnectionPollRetryManagementActionDeclarationV1,
} from './pollRetry.js';
import {
    ConversationSessionProjectionBaselineAcceptManagementActionDeclarationV1,
} from './projectionBaseline.js';
import {
    ConversationConnectionPrepareInputV1Schema,
    ConversationConnectionPrepareResultV1Schema,
} from './prepare.js';
import {
    ConversationConnectionRetestManagementActionDeclarationV1,
} from './retest.js';
import {
    ConversationDeliveryResolveInputV1Schema,
    ConversationDeliveryResolveResultV1Schema,
    ConversationIngressRetryInputV1Schema,
    ConversationIngressRetryResultV1Schema,
} from './recovery.js';
import type {
    ConversationActionDeclarationV1,
    ConversationManagementActionDeclarationsV1,
} from '../actionDeclarations.js';

export {
    conversationBindingInputModesForEndpointV1,
    conversationBindingPolicyForOmittedFieldsV1,
    conversationSessionBindingDeliveryModeForOmittedFieldV1,
    isConversationBindingInputModeDeliverableV1,
    ConversationAutomationTargetNotVerifiedResultV1JsonSchema,
    ConversationAutomationTargetNotVerifiedResultV1Schema,
    ConversationBindingCreateInputV1JsonSchema,
    ConversationBindingCreateInputV1Schema,
    ConversationBindingCreateResultV1JsonSchema,
    ConversationBindingCreateResultV1Schema,
    ConversationBindingDeleteInputV1JsonSchema,
    ConversationBindingDeleteInputV1Schema,
    ConversationBindingDeleteResultV1JsonSchema,
    ConversationBindingDeleteResultV1Schema,
    ConversationBindingMutationResultV1JsonSchema,
    ConversationBindingMutationResultV1Schema,
    ConversationBindingReadInputV1JsonSchema,
    ConversationBindingReadInputV1Schema,
    ConversationBindingReadResultV1JsonSchema,
    ConversationBindingReadResultV1Schema,
    ConversationBindingResolveInputV1JsonSchema,
    ConversationBindingResolveInputV1Schema,
    ConversationBindingResolveResultV1JsonSchema,
    ConversationBindingResolveResultV1Schema,
    ConversationBindingResolutionUnavailableV1JsonSchema,
    ConversationBindingResolutionUnavailableV1Schema,
    ConversationBindingSetEnabledInputV1JsonSchema,
    ConversationBindingSetEnabledInputV1Schema,
    ConversationBindingUpdateInputV1JsonSchema,
    ConversationBindingUpdateInputV1Schema,
    ConversationBindingUpdateResultV1JsonSchema,
    ConversationBindingUpdateResultV1Schema,
} from './bindings.js';
export type {
    ConversationAutomationTargetNotVerifiedResultV1,
    ConversationBindingCreateInputV1,
    ConversationBindingCreateResultV1,
    ConversationBindingDeleteInputV1,
    ConversationBindingDeleteResultV1,
    ConversationBindingMutationResultV1,
    ConversationBindingReadInputV1,
    ConversationBindingReadResultV1,
    ConversationBindingResolveInputV1,
    ConversationBindingResolveResultV1,
    ConversationBindingResolutionUnavailableV1,
    ConversationBindingSetEnabledInputV1,
    ConversationBindingUpdateInputV1,
    ConversationBindingUpdateResultV1,
} from './bindings.js';
export {
    CONVERSATION_CONNECTION_CREATE_SELECTABLE_TRANSPORTS_V1,
    CONVERSATION_CONNECTION_SELECTABLE_TRANSPORTS_V1,
    CONVERSATION_CONNECTION_WEBHOOK_SOURCE_INSTANCE_ID_PREFIX_V1,
    ConversationConnectionCreateInputV1JsonSchema,
    ConversationConnectionCreateInputV1Schema,
    ConversationConnectionCreateResultV1JsonSchema,
    ConversationConnectionCreateResultV1Schema,
    ConversationConnectionDeleteInputV1JsonSchema,
    ConversationConnectionDeleteInputV1Schema,
    ConversationConnectionDeleteResultV1JsonSchema,
    ConversationConnectionDeleteResultV1Schema,
    ConversationConnectionTransferInputV1JsonSchema,
    ConversationConnectionTransferInputV1Schema,
    ConversationConnectionTransferResultV1JsonSchema,
    ConversationConnectionTransferResultV1Schema,
    ConversationConnectionUpdateInputV1JsonSchema,
    ConversationConnectionUpdateInputV1Schema,
    ConversationConnectionUpdateResultV1JsonSchema,
    ConversationConnectionUpdateResultV1Schema,
    conversationConnectionWebhookSourceInstanceIdV1,
    isConversationConnectionCreateSelectableTransportV1,
    isConversationConnectionSelectableTransportV1,
} from './connections.js';
export type {
    ConversationConnectionCreateInputV1,
    ConversationConnectionCreateResultV1,
    ConversationConnectionCreateSelectableTransportV1,
    ConversationConnectionDeleteInputV1,
    ConversationConnectionDeleteResultV1,
    ConversationConnectionEndpointRequiredResultV1,
    ConversationConnectionWebhookEndpointSetupRequiredResultV1,
    ConversationConnectionSelectableTransportV1,
    ConversationConnectionTransferInputV1,
    ConversationConnectionTransferResultV1,
    ConversationConnectionUpdateInputV1,
    ConversationConnectionUpdateResultV1,
} from './connections.js';
export {
    ConversationPairingCancelInputV1JsonSchema,
    ConversationPairingCancelInputV1Schema,
    ConversationPairingCancelResultV1JsonSchema,
    ConversationPairingCancelResultV1Schema,
    ConversationPairingCreateInputV1JsonSchema,
    ConversationPairingCreateInputV1Schema,
    ConversationPairingCreateResultV1JsonSchema,
    ConversationPairingCreateResultV1Schema,
    ConversationPairingFinalizeInputV1JsonSchema,
    ConversationPairingFinalizeInputV1Schema,
    ConversationPairingFinalizeResultV1JsonSchema,
    ConversationPairingFinalizeResultV1Schema,
    ConversationPairingResourceV1JsonSchema,
    ConversationPairingResourceV1Schema,
} from './pairing.js';
export type {
    ConversationPairingCancelInputV1,
    ConversationPairingCancelResultV1,
    ConversationPairingCreateInputV1,
    ConversationPairingCreateResultV1,
    ConversationPairingFinalizeInputV1,
    ConversationPairingFinalizeResultV1,
    ConversationPairingResourceV1,
} from './pairing.js';
export {
    ConversationConnectionPollRetryInputV1JsonSchema,
    ConversationConnectionPollRetryInputV1Schema,
    ConversationConnectionPollRetryManagementActionDeclarationV1,
    ConversationConnectionPollRetryResultV1JsonSchema,
    ConversationConnectionPollRetryResultV1Schema,
} from './pollRetry.js';
export {
    ConversationSessionProjectionBaselineAcceptInputV1JsonSchema,
    ConversationSessionProjectionBaselineAcceptInputV1Schema,
    ConversationSessionProjectionBaselineAcceptManagementActionDeclarationV1,
    ConversationSessionProjectionBaselineAcceptResultV1JsonSchema,
    ConversationSessionProjectionBaselineAcceptResultV1Schema,
} from './projectionBaseline.js';
export type {
    ConversationSessionProjectionBaselineAcceptInputV1,
    ConversationSessionProjectionBaselineAcceptResultV1,
} from './projectionBaseline.js';
export type {
    ConversationConnectionPollRetryInputV1,
    ConversationConnectionPollRetryResultV1,
} from './pollRetry.js';
export {
    ConversationConnectionPrepareInputV1JsonSchema,
    ConversationConnectionPrepareInputV1Schema,
    ConversationConnectionPrepareResultV1JsonSchema,
    ConversationConnectionPrepareResultV1Schema,
    ConversationProviderSetupRemediationV1JsonSchema,
    ConversationProviderSetupRemediationV1Schema,
} from './prepare.js';
export type {
    ConversationConnectionPrepareInputV1,
    ConversationConnectionPrepareResultV1,
    ConversationProviderSetupRemediationV1,
} from './prepare.js';
export {
    ConversationConnectionRetestInputV1JsonSchema,
    ConversationConnectionRetestInputV1Schema,
    ConversationConnectionRetestManagementActionDeclarationV1,
    ConversationConnectionRetestResultV1JsonSchema,
    ConversationConnectionRetestResultV1Schema,
} from './retest.js';
export type {
    ConversationConnectionRetestInputV1,
    ConversationConnectionRetestResultV1,
} from './retest.js';
export {
    ConversationDeliveryResolveInputV1JsonSchema,
    ConversationDeliveryResolveInputV1Schema,
    ConversationDeliveryResolveResultV1JsonSchema,
    ConversationDeliveryResolveResultV1Schema,
    ConversationIngressRetryInputV1JsonSchema,
    ConversationIngressRetryInputV1Schema,
    ConversationIngressRetryResultV1JsonSchema,
    ConversationIngressRetryResultV1Schema,
} from './recovery.js';
export type {
    ConversationDeliveryResolveInputV1,
    ConversationDeliveryResolveResultV1,
    ConversationIngressRetryInputV1,
    ConversationIngressRetryResultV1,
} from './recovery.js';
export {
    ConversationBindingTargetV1JsonSchema,
    ConversationBindingTargetV1Schema,
    ConversationBindingV1JsonSchema,
    ConversationBindingV1Schema,
} from './targets.js';
export type {
    ChannelSessionSpawnRecipeV1,
    ConversationBindingTargetV1,
    ConversationBindingV1,
    ConversationSessionBindingTargetV1,
} from './targets.js';

/** The exact manifest-facing declaration for transport-free provider setup observation. */
export const ConversationConnectionPrepareManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionPrepareInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionPrepareResultV1Schema.jsonSchema,
});

/**
 * The exact manifest-facing declaration for connection creation. Durable push
 * is part of this one contract through its strict endpoint-ensure continuation
 * arm; the core owns the preallocated identity, ensure facts, and the
 * correspondence proof, so no caller-owned endpoint authority exists.
 */
export const ConversationConnectionCreateManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionCreateInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionCreateResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for guarded non-durable transfer. */
export const ConversationConnectionTransferManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionTransferInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionTransferResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for the guarded connection update. */
export const ConversationConnectionUpdateManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionUpdateInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionUpdateResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for guarded connection deletion. */
export const ConversationConnectionDeleteManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionDeleteInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionDeleteResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for explicit connection abandonment. */
export const ConversationConnectionAbandonManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionDeleteInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionDeleteResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for accepting a stream baseline. */
export const ConversationStreamBaselineAcceptManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationConnectionDeleteInputV1Schema.jsonSchema,
    resultSchema: ConversationConnectionUpdateResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for pairing creation. */
export const ConversationPairingCreateManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationPairingCreateInputV1Schema.jsonSchema,
    resultSchema: ConversationPairingCreateResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for pairing finalization. */
export const ConversationPairingFinalizeManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationPairingFinalizeInputV1Schema.jsonSchema,
    resultSchema: ConversationPairingFinalizeResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for pairing cancellation. */
export const ConversationPairingCancelManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationPairingCancelInputV1Schema.jsonSchema,
    resultSchema: ConversationPairingCancelResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for binding creation. */
export const ConversationBindingCreateManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationBindingCreateInputV1Schema.jsonSchema,
    resultSchema: ConversationBindingCreateResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for read-only binding endpoint/principal resolution. */
export const ConversationBindingResolveManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationBindingResolveInputV1Schema.jsonSchema,
    resultSchema: ConversationBindingResolveResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for one private binding row read. */
export const ConversationBindingReadManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationBindingReadInputV1Schema.jsonSchema,
    resultSchema: ConversationBindingReadResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for guarded binding updates. */
export const ConversationBindingUpdateManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationBindingUpdateInputV1Schema.jsonSchema,
    resultSchema: ConversationBindingMutationResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for guarded binding enablement. */
export const ConversationBindingSetEnabledManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationBindingSetEnabledInputV1Schema.jsonSchema,
    resultSchema: ConversationBindingUpdateResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for idempotent binding deletion. */
export const ConversationBindingDeleteManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationBindingDeleteInputV1Schema.jsonSchema,
    resultSchema: ConversationBindingDeleteResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for one ingress-obligation retry. */
export const ConversationIngressRetryManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationIngressRetryInputV1Schema.jsonSchema,
    resultSchema: ConversationIngressRetryResultV1Schema.jsonSchema,
});

/** The exact manifest-facing declaration for ambiguous delivery-custody resolution. */
export const ConversationDeliveryResolveManagementActionDeclarationV1: ConversationActionDeclarationV1 = Object.freeze({
    inputSchema: ConversationDeliveryResolveInputV1Schema.jsonSchema,
    resultSchema: ConversationDeliveryResolveResultV1Schema.jsonSchema,
});

/**
 * Present-user declarations whose schemas are fully executable today. Create
 * admits the non-durable transports directly and durable push only through
 * its strict continuation arm.
 */
export const CONVERSATION_MANAGEMENT_ACTION_DECLARATIONS_V1: ConversationManagementActionDeclarationsV1 = Object.freeze({
    connectionCreate: ConversationConnectionCreateManagementActionDeclarationV1,
    connectionTransfer: ConversationConnectionTransferManagementActionDeclarationV1,
    connectionPrepare: ConversationConnectionPrepareManagementActionDeclarationV1,
    connectionRetest: ConversationConnectionRetestManagementActionDeclarationV1,
    connectionUpdate: ConversationConnectionUpdateManagementActionDeclarationV1,
    connectionDelete: ConversationConnectionDeleteManagementActionDeclarationV1,
    connectionAbandon: ConversationConnectionAbandonManagementActionDeclarationV1,
    streamBaselineAccept: ConversationStreamBaselineAcceptManagementActionDeclarationV1,
    connectionPairingCreate: ConversationPairingCreateManagementActionDeclarationV1,
    connectionPairingFinalize: ConversationPairingFinalizeManagementActionDeclarationV1,
    connectionPairingCancel: ConversationPairingCancelManagementActionDeclarationV1,
    bindingRead: ConversationBindingReadManagementActionDeclarationV1,
    bindingResolve: ConversationBindingResolveManagementActionDeclarationV1,
    bindingCreate: ConversationBindingCreateManagementActionDeclarationV1,
    bindingUpdate: ConversationBindingUpdateManagementActionDeclarationV1,
    bindingSetEnabled: ConversationBindingSetEnabledManagementActionDeclarationV1,
    bindingDelete: ConversationBindingDeleteManagementActionDeclarationV1,
    sessionProjectionBaselineAccept: ConversationSessionProjectionBaselineAcceptManagementActionDeclarationV1,
    ingressRetry: ConversationIngressRetryManagementActionDeclarationV1,
    deliveryResolve: ConversationDeliveryResolveManagementActionDeclarationV1,
    connectionPollRetry: ConversationConnectionPollRetryManagementActionDeclarationV1,
});
