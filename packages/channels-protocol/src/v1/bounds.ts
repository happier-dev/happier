/** Stable identity of the one target-owned Channels provider point. */
export const CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1 = 'providers';
export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';
export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1 = 1;

/** Stable Channels core Action ids for provider callers. */
export const CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1 = Object.freeze({
    observationIngest: 'provider/observation-ingest-v1',
    connectionsList: 'provider/connections-list-v1',
    connectionRead: 'provider/connection-read-v1',
    transportFactReport: 'provider/transport-fact-report-v1',
    automationResultDeliver: 'automation/result-deliver-v1',
});

/** Stable present-user/core management Action ids. */
export const CONVERSATION_MANAGEMENT_ACTION_IDS_V1 = Object.freeze({
    connectionCreate: 'connection/create-v1',
    connectionTransfer: 'connection/transfer-v1',
    connectionUpdate: 'connection/update-v1',
    connectionSetEnabled: 'connection/set-enabled-v1',
    connectionDelete: 'connection/delete-v1',
    connectionAbandon: 'connection/abandon-v1',
    connectionPrepare: 'connection/prepare-v1',
    connectionPairingCreate: 'connection/pairing-create-v1',
    connectionPairingFinalize: 'connection/pairing-finalize-v1',
    connectionPairingCancel: 'connection/pairing-cancel-v1',
    bindingRead: 'binding/read-v1',
    bindingResolve: 'binding/resolve-v1',
    bindingCreate: 'binding/create-v1',
    bindingUpdate: 'binding/update-v1',
    bindingSetEnabled: 'binding/set-enabled-v1',
    bindingDelete: 'binding/delete-v1',
    bindingTargetRotate: 'binding/target-rotate-v1',
    streamBaselineAccept: 'stream/baseline-accept-v1',
    deliveryResolve: 'delivery/resolve-v1',
    ingressRetry: 'ingress/retry-v1',
    connectionPollRetry: 'connection/poll-retry-v1',
});

export const MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT = 32;
export const MAX_CONVERSATION_BINDINGS_PER_ACCOUNT = 256;
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
export const MAX_CONVERSATION_CHECKPOINT_UTF8_BYTES = 48 * 1024;
export const MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES = 128;
export const MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES = 256;
export const MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES = 512;
export const MAX_CONVERSATION_INGRESS_TEXT_UTF8_BYTES = 64 * 1024;
export const MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES = 192 * 1024;
export const MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES = 100;
export const MAX_CONVERSATION_RECEIVE_WAIT_MS = 60_000;
export const MAX_CONVERSATION_DELIVERY_CHUNKS = 32;
export const MAX_CONVERSATION_DELIVERY_ATTEMPTS = 5;
export const MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES = 256;
export const MAX_CONVERSATION_RETRY_AFTER_MS = 86_400_000;
export const MAX_CONVERSATION_INBOUND_DEBOUNCE_MS = 5_000;
export const MIN_CONVERSATION_OBSERVATION_AGE_MS = 60_000;
export const MAX_CONVERSATION_OBSERVATION_AGE_MS = 30 * 86_400_000;

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

/** Stable, provider-neutral connection readiness attention codes. */
export const CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1 = [
    'providerPermissionMissing',
    'providerConfigurationInvalid',
] as const;

export const CONVERSATION_MESSAGE_CONTENT_PROVENANCE_V1 = [
    'original',
    'forwarded',
    'viaBot',
] as const;

export const CONVERSATION_DELIVERY_MENTION_POLICIES_V1 = [
    'suppress',
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
export type ConversationDeliveryMentionPolicyV1 = (typeof CONVERSATION_DELIVERY_MENTION_POLICIES_V1)[number];
export type ConversationDeliveryLinkPreviewPolicyV1 = (typeof CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1)[number];
export type ConversationDeliveryRetryKindV1 = (typeof CONVERSATION_DELIVERY_RETRY_KINDS_V1)[number];
export type ConversationDeliveryArchiveRecoveryV1 = (typeof CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1)[number];
export type ConversationBindingInputModeV1 = (typeof CONVERSATION_BINDING_INPUT_MODES_V1)[number];
