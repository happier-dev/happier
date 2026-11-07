/** Stable identity of the one target-owned Channels provider point. */
export const CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1 = 'providers';
export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';
export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1 = 1;

/** Canonical Channels plugin identity for its own qualified contribution refs. */
export const CONVERSATION_CORE_PLUGIN_ID_V1 = 'happier.channels';

/** Content-free reasons retained by ingress and exposed by terminal attention reads. */
export const CONVERSATION_NON_ADMISSION_REASONS_V1 = [
    // Read-only legacy reason; current dispatch publishes its policy result.
    'staleAuthority',
    'endpointMismatch',
    'actorUnattributable',
    'actorNotAllowed',
    'integrationSelf',
    'botSenderDisabled',
    'messageTooLarge',
    'unsupportedContent',
    'unsupportedEdit',
    'notAddressed',
    'malformedCommand',
    'commandNotAuthorized',
    'targetUnavailable',
    'routeNotMatched',
] as const;

/** Stable Channels core Action ids for provider callers. */
export const CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1 = Object.freeze({
    observationIngest: 'provider/observation-ingest-v1',
    connectionsList: 'provider/connections-list-v1',
    connectionRead: 'provider/connection-read-v1',
    transportFactReport: 'provider/transport-fact-report-v1',
    automationResultDeliver: 'automation/result-deliver-v1',
    permissionMediationSourceCurrentness: 'permission-mediation/source-currentness-v1',
});

/**
 * Channels' own Automation result-delivery target. The host accepts any
 * plugin's own declared Action contribution as the reply recipient, so this is
 * one plugin's binding, not a platform-wide pin: a third-party bridge freezes
 * its own qualified contribution here instead.
 */
export const CONVERSATION_AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1 = Object.freeze({
    pluginId: CONVERSATION_CORE_PLUGIN_ID_V1,
    localId: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver,
});

/** Stable present-user/core management Action ids. */
export const CONVERSATION_MANAGEMENT_ACTION_IDS_V1 = Object.freeze({
    connectionList: 'connection/list-v1',
    bindingList: 'binding/list-v1',
    ingressAttention: 'ingress/attention-v1',
    deliveryAttention: 'delivery/attention-v1',
    deliveryRead: 'delivery/read-v1',
    conversationStart: 'conversation/start-v1',
    connectionCreate: 'connection/create-v1',
    connectionTransfer: 'connection/transfer-v1',
    connectionUpdate: 'connection/update-v1',
    connectionDelete: 'connection/delete-v1',
    connectionPrepare: 'connection/prepare-v1',
    connectionSetupRemediate: 'connection/setup-remediate-v1',
    connectionRetest: 'connection/retest-v1',
    connectionPairingCreate: 'connection/pairing-create-v1',
    connectionPairingRead: 'connection/pairing-read-v1',
    connectionPairingFinalize: 'connection/pairing-finalize-v1',
    connectionPairingCancel: 'connection/pairing-cancel-v1',
    bindingRead: 'binding/read-v1',
    bindingResolve: 'binding/resolve-v1',
    bindingCreate: 'binding/create-v1',
    bindingUpdate: 'binding/update-v1',
    bindingSetEnabled: 'binding/set-enabled-v1',
    bindingDelete: 'binding/delete-v1',
    sessionProjectionNoticeDismiss: 'binding/session-projection-notice-dismiss-v1',
    streamNoticeDismiss: 'stream/notice-dismiss-v1',
    deliveryResolve: 'delivery/resolve-v1',
    ingressRetry: 'ingress/retry-v1',
    connectionPollRetry: 'connection/poll-retry-v1',
});

export const MAX_CONVERSATION_PROVIDER_CONNECTION_KEY_UTF8_BYTES = 512;
export const MAX_CONVERSATION_PROVIDER_CONFIG_UTF8_BYTES = 48 * 1024;
export const MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES = 96;
export const MAX_CONVERSATION_CONNECTION_ID_ASCII_BYTES = MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES;
export const MAX_CONVERSATION_BINDING_ID_ASCII_BYTES = MAX_CONVERSATION_CHANNEL_RELATION_ID_ASCII_BYTES;
export const MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES = 512;
export const MAX_CONVERSATION_ENDPOINT_RESOLUTION_INPUT_UTF8_BYTES = 2 * 1024;
export const MAX_CONVERSATION_ENDPOINT_DISPLAY_LABEL_CODE_POINTS = 256;
export const MAX_CONVERSATION_RESOLUTION_CANDIDATES = 50;
export const MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES = 1024;
export const MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES = 2 * 1024;
export const MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES = 128;
/**
 * An Event source instance is an opaque provider-owned fact. The ceiling
 * matches the existing provider Event setup surfaces, while keeping one
 * durable Channels ingress obligation safely inside its Account-row budget.
 */
export const MAX_CONVERSATION_AUTOMATION_EVENT_SOURCE_INSTANCE_ID_UTF8_BYTES = 512;
export const MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES = 256;
/**
 * The chat-approval request identifier a `/allow`/`/deny` sender may name.
 * Ingress has no generic text ceiling, so the inbound command grammar must
 * apply this bound itself: the frozen ingress obligation persists the exact
 * identifier, and the canonical Permission mediation contract accepts at most
 * 256 UTF-8 bytes for one request id.
 */
export const MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES = 256;
export const MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES = 512;
export const MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES = 100;
export const MAX_CONVERSATION_RECEIVE_WAIT_MS = 60_000;
export const MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES = 256;
/** Millisecond quantities are safe integers, not workload or freshness policy ceilings. */
export const MAX_CONVERSATION_RETRY_AFTER_MS = Number.MAX_SAFE_INTEGER;



export const CONVERSATION_TRANSPORT_KINDS_V1 = [
    'checkpointedPull',
    'socket',
    'durablePush',
] as const;

export const CONVERSATION_ENDPOINT_KINDS_V1 = [
    'direct',
    'shared',
    'thread',
    'githubIssue',
    'githubPullRequest',
] as const;

export const CONVERSATION_ENDPOINT_AUDIENCES_V1 = [
    'direct',
    'shared',
] as const;

export const CONVERSATION_OUTBOUND_TEXT_UNITS_V1 = [
    'utf8Bytes',
    'utf16CodeUnits',
    'unicodeCodePoints',
] as const;

export const CONVERSATION_PROVIDER_FAILURE_REASONS_V1 = [
    'credentialInvalid',
    'permissionMissing',
    'network',
    'rateLimited',
    'providerConflict',
    'unsupported',
    'invalidConfiguration',
] as const;

export const CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1 = [
    'poll',
    'socket',
    'webhook',
] as const;

export const CONVERSATION_OBSERVATION_ACTOR_KINDS_V1 = [
    'human',
    'integration',
    'bot',
    'unknown',
] as const;

export const CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1 = [
    'none',
    'directIntegrationMention',
    'integrationRoleMention',
    'replyToIntegration',
] as const;

export const CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1 = [
    'providerHistoryUnavailable',
    'applicationAdmissionLost',
] as const;

/**
 * Stable, provider-neutral connection readiness attention codes. The three
 * name different repairs: a remote permission the integration must be granted,
 * a remote configuration the integration owner must correct, and a Connected
 * Account credential the user must replace or resynchronize. Collapsing the
 * credential case into configuration sends the user to a surface that cannot
 * clear the attention.
 */
export const CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1 = [
    'providerPermissionMissing',
    'providerConfigurationInvalid',
    'providerCredentialInvalid',
] as const;

export const CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1 = [
    'original',
    'forwarded',
    'viaBot',
] as const;



export const CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1 = [
    'suppress',
    'providerDefault',
] as const;

export const CONVERSATION_DELIVERY_RETRY_KINDS_V1 = [
    'safe',
    'after',
    'never',
] as const;

export const CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1 = [
    'unarchiveAndRetry',
    'ownerMustUnarchiveOrRebind',
] as const;

export const CONVERSATION_BINDING_INPUT_MODES_V1 = [
    'directMentionsOnly',
    'addressedMessages',
    'allAllowedMessages',
] as const;

export type ConversationTransportKindV1 = (typeof CONVERSATION_TRANSPORT_KINDS_V1)[number];
export type ConversationEndpointKindV1 = (typeof CONVERSATION_ENDPOINT_KINDS_V1)[number];
export type ConversationEndpointAudienceV1 = (typeof CONVERSATION_ENDPOINT_AUDIENCES_V1)[number];
export type ConversationOutboundTextUnitV1 = (typeof CONVERSATION_OUTBOUND_TEXT_UNITS_V1)[number];
export type ConversationProviderFailureReasonV1 = (typeof CONVERSATION_PROVIDER_FAILURE_REASONS_V1)[number];
export type ConversationObservationTransportKindV1 = (typeof CONVERSATION_OBSERVATION_TRANSPORT_KINDS_V1)[number];
export type ConversationObservationActorKindV1 = (typeof CONVERSATION_OBSERVATION_ACTOR_KINDS_V1)[number];
export type ConversationObservationAddressingEvidenceV1 = (typeof CONVERSATION_OBSERVATION_ADDRESSING_EVIDENCE_V1)[number];
export type ConversationConnectionHistoryGapReasonV1 = (typeof CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1)[number];
export type ConversationProviderReadinessAttentionCodeV1 = (typeof CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1)[number];
export type ConversationMessageContentProvenanceV1 = (typeof CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1)[number];

export type ConversationDeliveryLinkPreviewPolicyV1 = (typeof CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1)[number];
export type ConversationDeliveryRetryKindV1 = (typeof CONVERSATION_DELIVERY_RETRY_KINDS_V1)[number];
export type ConversationDeliveryArchiveRecoveryV1 = (typeof CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1)[number];
export type ConversationBindingInputModeV1 = (typeof CONVERSATION_BINDING_INPUT_MODES_V1)[number];
