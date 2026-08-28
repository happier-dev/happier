/** Stable identity of the one target-owned Channels provider point. */
export const CONVERSATION_PROVIDERS_CONTRIBUTION_POINT_ID_V1 = 'providers';
export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_ID_V1 = 'happier.channels/providers';
export const CONVERSATION_PROVIDERS_CONTRIBUTION_PROTOCOL_VERSION_V1 = 1;

/** Canonical Channels plugin identity for its own qualified contribution refs. */
export const CONVERSATION_CORE_PLUGIN_ID_V1 = 'happier.channels';

/** Stable Channels core Action ids for provider callers. */
export const CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1 = Object.freeze({
    observationIngest: 'provider/observation-ingest-v1',
    connectionsList: 'provider/connections-list-v1',
    connectionRead: 'provider/connection-read-v1',
    transportFactReport: 'provider/transport-fact-report-v1',
    automationResultDeliver: 'automation/result-deliver-v1',
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
    connectionCreate: 'connection/create-v1',
    connectionTransfer: 'connection/transfer-v1',
    connectionUpdate: 'connection/update-v1',
    connectionDelete: 'connection/delete-v1',
    connectionAbandon: 'connection/abandon-v1',
    connectionPrepare: 'connection/prepare-v1',
    connectionRetest: 'connection/retest-v1',
    connectionPairingCreate: 'connection/pairing-create-v1',
    connectionPairingFinalize: 'connection/pairing-finalize-v1',
    connectionPairingCancel: 'connection/pairing-cancel-v1',
    bindingRead: 'binding/read-v1',
    bindingResolve: 'binding/resolve-v1',
    bindingCreate: 'binding/create-v1',
    bindingUpdate: 'binding/update-v1',
    bindingSetEnabled: 'binding/set-enabled-v1',
    bindingDelete: 'binding/delete-v1',
    sessionProjectionBaselineAccept: 'binding/session-projection-baseline-accept-v1',
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
/**
 * An Event source instance is an opaque provider-owned fact. The ceiling
 * matches the existing provider Event setup surfaces, while keeping one
 * durable Channels ingress obligation safely inside its Account-row budget.
 */
export const MAX_CONVERSATION_AUTOMATION_EVENT_SOURCE_INSTANCE_ID_UTF8_BYTES = 512;
export const MAX_CONVERSATION_ACTOR_PRINCIPAL_ID_UTF8_BYTES = 256;
/**
 * The chat-approval request identifier a `/allow`/`/deny` sender may name.
 * Ingress text is bounded far above this, so the inbound command grammar must
 * apply this bound itself: the frozen ingress obligation persists the exact
 * identifier, and the canonical Permission mediation contract accepts at most
 * 256 UTF-8 bytes for one request id.
 */
export const MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES = 256;
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

/**
 * The freshness window a connection is created with for an omitted choice.
 *
 * Setup has to send `maximumObservationAgeMs` — the create contract requires
 * it — so this is the one place that answers for every surface, instead of a
 * surface reaching for the smallest configurable value and calling it a
 * default. A bound is not a default: seeding
 * `MIN_CONVERSATION_OBSERVATION_AGE_MS` means a message that arrived while the
 * machine was away for two minutes is discarded on return, which is exactly
 * the mail a checkpointed pull exists to replay.
 *
 * The 24 hours are the flagship V1 provider's own documented retention
 * ceiling, and that is where this number comes from. Telegram Bot API,
 * "Getting updates" (https://core.telegram.org/bots/api#getting-updates):
 * "Incoming updates are stored on the server until the bot receives them
 * either way, but they will not be kept longer than 24 hours." A longer
 * default therefore recovers nothing Telegram still holds, and a shorter one
 * discards mail Telegram would have replayed. Being one number rather than a
 * per-provider recommendation is deliberate: it is exact for Telegram, inert
 * for Discord (a socket observer that persists no cursor replays nothing for
 * an age filter to reject), and knowingly lossy for GitHub after an outage
 * longer than a day, where the owner can raise it as far as
 * `MAX_CONVERSATION_OBSERVATION_AGE_MS`.
 *
 * It must also clear `MAX_CONVERSATION_RETRY_AFTER_MS`, which coincides at the
 * same number today: a provider can hold this host's poller off for that long
 * through its retry hint, and dropping everything the host was told to wait
 * through would make the host discard mail because it obeyed the provider.
 * That is a separate floor, not this value's derivation — writing the default
 * as the retry ceiling would silently move the Telegram anchoring whenever the
 * retry ceiling moved. `bounds.test.ts` pins the anchoring and the floor
 * independently, so raising the retry ceiling past a day fails loudly instead.
 */
export const CONVERSATION_OBSERVATION_AGE_MS_FOR_OMITTED_FIELD_V1 = 86_400_000;

/**
 * `occurredAt` is minted by the provider's clock and compared against this
 * host's clock, so a provider timestamp may legitimately lead local time. This
 * is the same cross-host boundary the Account freshness proofs already allow
 * 60s for, and it is exactly `MIN_CONVERSATION_OBSERVATION_AGE_MS`, so the
 * forward allowance can never exceed the tightest window an operator can
 * configure. Beyond it a timestamp is not skew, and admitting it would pin the
 * occurrence's retained message body past every retention horizon.
 */
export const MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS = 60_000;

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
