import type { JsonValue } from '@happier-dev/plugin-sdk';
import { embedProtocolJsonSchema, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import { SessionPullRequestConfiguredFixCustodySchema } from './configuredFixResultV19.js';
import { shareRepeatedCollectionSchemas } from './collectionSchemaDefinitions.js';
export { SessionPullRequestConfiguredFixCustodySchema } from './configuredFixResultV19.js';
import { ConversationConnectionTransportOriginV1JsonSchema, ConversationPendingEndpointRetargetIntentV1JsonSchema } from './connectionLifecycle.js';
import {
  defineAccountCollection,
  PLUGIN_COLLECTION_REVISION_MAX,
} from '@happier-dev/plugin-sdk/collections';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  PluginContributionIdentityV1JsonSchema,
  PluginIdJsonSchema,
} from '@happier-dev/plugin-sdk/manifest';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';
import { AutomationConversationEventActorsV1Schema, AutomationResultDeliverySourceV1JsonSchema } from '@happier-dev/plugin-sdk/automations';
import {
  CONVERSATION_BINDING_INPUT_MODES_V1,
  CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1,
  CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1,
  CONVERSATION_PROVIDER_FAILURE_REASONS_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1,
  CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
  CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1,
  CONVERSATION_DELIVERY_RESOLVED_OUTCOMES_V1,

  CONVERSATION_TRANSPORT_KINDS_V1,
  ConversationBindingIdV1Schema,
  ConversationDeliveryContentV1JsonSchema,
  ConversationOutboundTextLimitV1JsonSchema,
  ConversationDeliveryNewThreadV1JsonSchema,
  ConversationStartSourceV1JsonSchema,
  ConversationAllowedPrincipalIdsV1JsonSchema,
  ConversationInboundDebounceMsV1JsonSchema,
  ConversationBindingIdV1JsonSchema,
  ConversationConnectionIdV1Schema,
  ConversationConnectionIdV1JsonSchema,
  ConversationProviderConnectionStopInputV1JsonSchema,
  ConversationResolvedEndpointV1JsonSchema,
  ConversationBindingTargetV1JsonSchema,
  ConversationScopedPullRequestTriggerV1Schema,
  SessionPullRequestUpdateV1Schema,
  SessionPullRequestUpdateContinuationV1Schema,
  ConversationAuthenticatedObservationShellV1JsonSchema,
  ConversationIngressAutomationEventCandidateV1JsonSchema,
  ConversationNormalizedIngressV1JsonSchema,
  MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES,
  MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES,
  MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES,
  MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
  MAX_CONVERSATION_PROVIDER_CONNECTION_KEY_UTF8_BYTES,
  MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES,
  MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES,
  MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES,
  MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
} from '@happier-dev/channels-protocol/v1';

import {
  CONVERSATION_DELIVERY_CONTENT_FREE_STATES,
  CONVERSATION_DELIVERY_CUSTODY_STATES,
} from './deliveryCustody.js';
import { createConversationNewSessionCreationKey } from './commands.js';
import { CONVERSATION_NON_ADMISSION_REASONS } from './commandPolicy.js';

import {
  CHANNEL_COLLECTION_MIGRATIONS,
  CHANNEL_DELIVERIES_COLLECTION_ID,
  CHANNEL_STATE_COLLECTION_ID,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_MIGRATIONS_ARTIFACT_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collectionMigrations.js';
export {
  CHANNEL_DELIVERIES_COLLECTION_ID,
  CHANNEL_STATE_COLLECTION_ID,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_MIGRATIONS_ARTIFACT_ID,
  CHANNEL_STATE_RECORD_KIND,
  migrateChannelStateV1ToV2,
  migrateChannelStateV2ToV3,
} from './collectionMigrations.js';

export const CHANNEL_STATE_INDEX_ID = {
  byKind: 'by-kind',
  byConnectionBindingV2: 'by-connection-binding-v2',
  byConnectionKindV1: 'by-connection-kind-v1',
  bySessionKindBindingUpdateV1: 'by-session-kind-binding-update-v1',
  byPullRequestSessionBindingV1: 'by-pr-session-binding-v1',
  byAttention: 'by-attention',
  byIngressDue: 'by-ingress-due',
} as const;

export const CHANNEL_DELIVERIES_FIELD = {
  id: 'id',
  recordKind: 'record-kind',
  version: 'v',
  connectionId: 'connection-id',
  bindingId: 'binding-id',
  terminal: 'terminal',
  attention: 'attention',
  retryNotBefore: 'retry-not-before',
  createdAt: 'created-at',
  updatedAt: 'updated-at',
} as const;

export const CHANNEL_DELIVERIES_INDEX_ID = {
  byOwnerAttention: 'by-owner-attention',
  byConnectionAttention: 'by-connection-attention',
  byRetryDue: 'by-retry-due',
  byTerminalUpdatedAt: 'by-terminal-updated-at',
} as const;

export const CHANNEL_DELIVERIES_RECORD_KIND = {
  outwardDelivery: 'outward-delivery',
} as const;


/** Fixed singleton row; opaque reservation rows never reuse this identity. */
export const CHANNEL_STATE_FIXED_ROW_ID = {
  connectionIdentityKey: 'connection-identity-key',
} as const;

const CHANNEL_STATE_RECORD_KINDS = Object.values(CHANNEL_STATE_RECORD_KIND);

const MAX_SAFE_INTEGER = 9_007_199_254_740_991;
const MAX_PLUGIN_ID_LENGTH = 256;
const MAX_DISPLAY_LABEL_LENGTH = 256;
const MAX_PRINCIPAL_ID_LENGTH = 256;

const JSON_VALUE_SCHEMA = {} satisfies PluginJsonSchema;
const NULL_SCHEMA = { type: 'null' } satisfies PluginJsonSchema;
const BOOLEAN_SCHEMA = { type: 'boolean' } satisfies PluginJsonSchema;
const POSITIVE_SAFE_INTEGER_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_SAFE_INTEGER,
} satisfies PluginJsonSchema;
const NON_NEGATIVE_SAFE_INTEGER_SCHEMA = {
  type: 'integer',
  minimum: 0,
  maximum: MAX_SAFE_INTEGER,
} satisfies PluginJsonSchema;
/**
 * A retained witness of one exact Account Collection row revision. Its ceiling
 * is the Collection owner's persisted `Int` column, so a durable fence can
 * never name a revision the host would refuse to reach. Channels-owned
 * authority epochs and payload counters keep the wider safe-integer bound.
 */
const COLLECTION_ROW_REVISION_SCHEMA = {
  type: 'integer',
  minimum: 1,
  maximum: PLUGIN_COLLECTION_REVISION_MAX,
} satisfies PluginJsonSchema;

function boundedString(maxLength: number): PluginJsonSchema {
  return { type: 'string', minLength: 1, maxLength };
}

function nullable(schema: PluginJsonSchema): PluginJsonSchema {
  return { anyOf: [schema, NULL_SCHEMA] };
}

const CONNECTION_ID_SCHEMA = ConversationConnectionIdV1JsonSchema;
const BINDING_ID_SCHEMA = ConversationBindingIdV1JsonSchema;
const CONNECTION_IDENTITY_KEY_ROW_ID_SCHEMA: PluginJsonSchema = {
  type: 'string',
  const: CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey,
};
const OPAQUE_ROUTING_ROW_ID_SCHEMA: PluginJsonSchema = {
  type: 'string',
  minLength: 43,
  maxLength: 43,
  pattern: '^[A-Za-z0-9_-]{43}$',
};
const NON_CONNECTION_IDENTITY_KEY_ROW_ID_SCHEMA: PluginJsonSchema = {
  type: 'string',
  minLength: 1,
  maxLength: 256,
  pattern: `^(?!${CHANNEL_STATE_FIXED_ROW_ID.connectionIdentityKey}$)`,
};
const DISPLAY_LABEL_SCHEMA = boundedString(MAX_DISPLAY_LABEL_LENGTH);
const PRINCIPAL_ID_SCHEMA = boundedString(MAX_PRINCIPAL_ID_LENGTH);
const OCCURRENCE_ID_SCHEMA = boundedString(MAX_CONVERSATION_OCCURRENCE_ID_UTF8_BYTES);

/**
 * The durable provider-operation identity. The plugin id remains a separate
 * connection fact because it also fences the stamped execution origin; this
 * selection narrows that plugin to its stable contribution identity. Runtime
 * execution re-admits that identity through the current Provider snapshot.
 */
export type PersistedConversationProviderContributionSelection = Readonly<{
  contributionId: string;
}>;

export const ConversationProviderContributionSelectionJsonSchema: PluginJsonSchema = {
  type: 'object',
  properties: {
    // Reuse the canonical contribution-local-id grammar instead of creating a
    // Channels-specific identifier dialect.
    contributionId: PluginContributionIdentityV1JsonSchema.properties!.localId!,
  },
  required: ['contributionId'],
  additionalProperties: false,
};

const CHECKPOINTED_PULL_TRANSPORT_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: { kind: { type: 'string', const: 'checkpointedPull' } },
  required: ['kind'],
  additionalProperties: false,
};

const SOCKET_TRANSPORT_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: { kind: { type: 'string', const: 'socket' } },
  required: ['kind'],
  additionalProperties: false,
};

const DURABLE_PUSH_TRANSPORT_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'durablePush' },
    webhookContributionRef: PluginContributionIdentityV1JsonSchema,
    webhookEndpointId: PluginWebhookEndpointIdV1JsonSchema,
    webhookSourceInstanceId: boundedString(MAX_PLUGIN_ID_LENGTH),
  },
  required: [
    'kind',
    'webhookContributionRef',
    'webhookEndpointId',
    'webhookSourceInstanceId',
  ],
  additionalProperties: false,
};

const CONNECTION_TRANSPORT_SCHEMA: PluginJsonSchema = {
  oneOf: [
    CHECKPOINTED_PULL_TRANSPORT_SCHEMA,
    SOCKET_TRANSPORT_SCHEMA,
    DURABLE_PUSH_TRANSPORT_SCHEMA,
  ],
};

const CONNECTION_TRANSPORT_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: { transport: CHECKPOINTED_PULL_TRANSPORT_SCHEMA },
      required: ['transport'],
    },
    {
      type: 'object',
      properties: { transport: SOCKET_TRANSPORT_SCHEMA },
      required: ['transport'],
    },
    {
      type: 'object',
      properties: {
        transport: DURABLE_PUSH_TRANSPORT_SCHEMA,
        overlapSafety: { type: 'string', const: 'safe' },
        replayContinuity: { type: 'string', const: 'none' },
      },
      required: ['transport', 'overlapSafety', 'replayContinuity'],
    },
  ],
};

const OLD_TRANSPORT_STOP_REQUEST_TRANSFER_OR_DELETE_SCHEMA: PluginJsonSchema = {
  allOf: [
    ConversationProviderConnectionStopInputV1JsonSchema,
    {
      type: 'object',
      properties: { reason: { type: 'string', enum: ['transfer', 'delete'] } },
      required: ['reason'],
    },
  ],
};

const OLD_TRANSPORT_STOP_REQUEST_TRANSFER_SCHEMA: PluginJsonSchema = {
  allOf: [
    ConversationProviderConnectionStopInputV1JsonSchema,
    {
      type: 'object',
      properties: { reason: { type: 'string', const: 'transfer' } },
      required: ['reason'],
    },
  ],
};

const OLD_TRANSPORT_STOP_REQUEST_DELETE_SCHEMA: PluginJsonSchema = {
  allOf: [
    ConversationProviderConnectionStopInputV1JsonSchema,
    {
      type: 'object',
      properties: { reason: { type: 'string', const: 'delete' } },
      required: ['reason'],
    },
  ],
};

// Connections follow the current admitted provider at one Home/Machine.
const CONNECTION_TRANSPORT_ORIGIN_SCHEMA = ConversationConnectionTransportOriginV1JsonSchema;

const CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    connectionRevision: COLLECTION_ROW_REVISION_SCHEMA,
    authorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    transportOrigin: CONNECTION_TRANSPORT_ORIGIN_SCHEMA,
  },
  required: ['connectionRevision', 'authorityEpoch', 'transportOrigin'],
  additionalProperties: false,
};

function pendingOldTransportStopSchema(input: Readonly<{
  predecessorCheckpointedPollInvocation: PluginJsonSchema;
  stopRequest: PluginJsonSchema;
  endpointRetarget: PluginJsonSchema;
  acceptedPossibleLoss: PluginJsonSchema;
}>): PluginJsonSchema {
  return {
    type: 'object',
    properties: {
      predecessorCheckpointedPollInvocation: input.predecessorCheckpointedPollInvocation,
      transportOrigin: CONNECTION_TRANSPORT_ORIGIN_SCHEMA,
      providerContributionSelection: ConversationProviderContributionSelectionJsonSchema,
      stopRequest: input.stopRequest,
      // The retired transport, frozen with the slot. The row's own transport
      // already names the replacement once a transfer commits, so this is the
      // only durable predecessor authority a settlement may read.
      predecessorTransportKind: {
        type: 'string',
        enum: [...CONVERSATION_TRANSPORT_KINDS_V1],
      },
      endpointRetarget: input.endpointRetarget,
      overlapSafety: {
        type: 'string',
        enum: ['safe', 'providerExclusive'],
      },
      acceptedPossibleLoss: input.acceptedPossibleLoss,
    },
    required: [
      'predecessorCheckpointedPollInvocation',
      'transportOrigin',
      'providerContributionSelection',
      'stopRequest',
      'predecessorTransportKind',
      'endpointRetarget',
      'overlapSafety',
      'acceptedPossibleLoss',
    ],
    additionalProperties: false,
  };
}

/**
 * Provider-stop custody never also carries an endpoint move. The separate
 * closed endpoint-intent arm owns those exact convergence facts.
 */
const PENDING_ENDPOINT_RETARGET_SCHEMA: PluginJsonSchema = {
  type: 'string',
  const: 'notRequired',
};

const PENDING_OLD_TRANSPORT_STOP_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_TRANSFER_OR_DELETE_SCHEMA,
  endpointRetarget: PENDING_ENDPOINT_RETARGET_SCHEMA,
  acceptedPossibleLoss: BOOLEAN_SCHEMA,
});

const PENDING_OLD_TRANSPORT_STOP_TRANSFER_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_TRANSFER_SCHEMA,
  endpointRetarget: PENDING_ENDPOINT_RETARGET_SCHEMA,
  acceptedPossibleLoss: BOOLEAN_SCHEMA,
});

const PENDING_OLD_TRANSPORT_STOP_DELETE_UNACCEPTED_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_DELETE_SCHEMA,
  endpointRetarget: { type: 'string', const: 'notRequired' },
  acceptedPossibleLoss: { type: 'boolean', const: false },
});

const PENDING_OLD_TRANSPORT_STOP_DELETE_ACCEPTED_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_DELETE_SCHEMA,
  endpointRetarget: { type: 'string', const: 'notRequired' },
  acceptedPossibleLoss: { type: 'boolean', const: true },
});

const NULLABLE_PENDING_OLD_TRANSPORT_STOP_SCHEMA = nullable({ anyOf: [PENDING_OLD_TRANSPORT_STOP_SCHEMA, ConversationPendingEndpointRetargetIntentV1JsonSchema] });

const CONNECTION_DELETION_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        deletionState: { type: 'string', const: 'none' },
        pendingOldTransportStop: {
          anyOf: [NULL_SCHEMA, PENDING_OLD_TRANSPORT_STOP_TRANSFER_SCHEMA, ConversationPendingEndpointRetargetIntentV1JsonSchema],
        },
      },
      required: ['deletionState', 'pendingOldTransportStop'],
    },
    {
      type: 'object',
      properties: {
        deletionState: { type: 'string', const: 'pendingStopReconciliation' },
        enabled: { type: 'boolean', const: false },
        providerReadiness: NULL_SCHEMA,
        pendingOldTransportStop: PENDING_OLD_TRANSPORT_STOP_DELETE_UNACCEPTED_SCHEMA,
      },
      required: ['deletionState', 'enabled', 'pendingOldTransportStop'],
    },
    {
      type: 'object',
      properties: {
        deletionState: { type: 'string', const: 'finalizingDelete' },
        enabled: { type: 'boolean', const: false },
        providerReadiness: NULL_SCHEMA,
        pendingOldTransportStop: {
          anyOf: [NULL_SCHEMA, PENDING_OLD_TRANSPORT_STOP_DELETE_ACCEPTED_SCHEMA],
        },
      },
      required: ['deletionState', 'enabled', 'pendingOldTransportStop'],
    },
  ],
};

const HISTORY_GAP_SCHEMA = nullable({
  oneOf: [
    {
      type: 'object',
      properties: {
        reportedAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
        reason: { type: 'string', const: CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1[0] },
        diagnostic: boundedString(MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES),
      },
      required: ['reportedAt', 'reason'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        reportedAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
        reason: { type: 'string', const: CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1[1] },
      },
      required: ['reportedAt', 'reason'],
      additionalProperties: false,
    },
  ],
});

const PROVIDER_READINESS_SCHEMA = nullable({
  type: 'object',
  properties: {
    code: { type: 'string', enum: [...CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1] },
    diagnostic: boundedString(MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES),
  },
  required: ['code'],
  additionalProperties: false,
});

const POLL_FAILURE_EVIDENCE_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'provider' },
        reason: { type: 'string', enum: [...CONVERSATION_PROVIDER_FAILURE_REASONS_V1] },
        diagnostic: boundedString(MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES),
      },
      required: ['kind', 'reason'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'action' },
        code: boundedString(MAX_PLUGIN_ID_LENGTH),
        message: boundedString(MAX_CONVERSATION_PROVIDER_DIAGNOSTIC_UTF8_BYTES),
      },
      required: ['kind', 'code', 'message'],
      additionalProperties: false,
    },
  ],
};

/**
 * The persisted connection poll-failure contract. Readers reuse this exact
 * Collection schema rather than maintaining a second validation dialect.
 */
export const ConversationConnectionPollFailureJsonSchema = nullable({
  oneOf: [
    {
      type: 'object',
      properties: {
        phase: { type: 'string', const: 'retryDue' },
        attemptCount: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        retryNotBeforeMs: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
        evidence: POLL_FAILURE_EVIDENCE_SCHEMA,
      },
      required: ['phase', 'attemptCount', 'retryNotBeforeMs', 'evidence'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        phase: { type: 'string', const: 'blocked' },
        attemptCount: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
        },
        retryNotBeforeMs: NULL_SCHEMA,
        evidence: POLL_FAILURE_EVIDENCE_SCHEMA,
      },
      required: ['phase', 'attemptCount', 'retryNotBeforeMs', 'evidence'],
      additionalProperties: false,
    },
  ],
});

const CONNECTION_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    configurationRevision: COLLECTION_ROW_REVISION_SCHEMA,
    providerPluginId: PluginIdJsonSchema,
    providerContributionSelection: ConversationProviderContributionSelectionJsonSchema,
    // This opaque JSON belongs to the selected provider setup contract. Its
    // bytes are bounded by the one canonical Account Collection row limit.
    providerSetupInput: JSON_VALUE_SCHEMA,
    credentialRef: nullable(QualifiedConnectedAccountRefJsonSchema),
    transportOrigin: CONNECTION_TRANSPORT_ORIGIN_SCHEMA,
    transport: CONNECTION_TRANSPORT_SCHEMA,
    overlapSafety: { type: 'string', enum: ['safe', 'providerExclusive'] },
    replayContinuity: { type: 'string', enum: ['checkpointed', 'sessionBound', 'none'] },
    // Provider setup validates the exact unit and bounded template before this
    // private connection snapshot is written. These facts are re-read by the
    // single custody/pairing paths; list/read never project either one.
    outboundTextLimit: ConversationOutboundTextLimitV1JsonSchema,
    recommendedMaximumObservationAgeMs: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    // The provider-authenticated shared-endpoint delivery truth. Optional
    // because a provider that declares no restriction asserts every mode is
    // deliverable; the binding policy owner reads that absence the same way.
    sharedEndpointInputModes: {
      type: 'array',
      items: { type: 'string', enum: [...CONVERSATION_BINDING_INPUT_MODES_V1] },
      minItems: 1,
      maxItems: CONVERSATION_BINDING_INPUT_MODES_V1.length,
      uniqueItems: true,
    },
    pairingDeepLinkTemplate: {
      type: 'string',
      minLength: 9,
      maxLength: MAX_CONVERSATION_PAIRING_DEEP_LINK_TEMPLATE_UTF8_BYTES,
      pattern: '^(?!(?:[\\s\\S]*\\{\\{token\\}\\}){2})[\\s\\S]*\\{\\{token\\}\\}[\\s\\S]*$',
    },
    providerConnectionKey: boundedString(MAX_CONVERSATION_PROVIDER_CONNECTION_KEY_UTF8_BYTES),
    providerConfigVersion: { type: 'integer', const: 1 },
    // Provider setup owns this bounded opaque JSON contract. Core stores it
    // without treating it as a second provider configuration schema.
    providerConfig: JSON_VALUE_SCHEMA,
    routingIdentityKey: {
      type: 'string',
      minLength: 43,
      maxLength: 43,
      pattern: '^[A-Za-z0-9_-]{43}$',
    },
    integrationPrincipal: {
      type: 'object',
      properties: {
        id: PRINCIPAL_ID_SCHEMA,
        label: DISPLAY_LABEL_SCHEMA,
      },
      required: ['id'],
      additionalProperties: false,
    },
    authorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    enabled: BOOLEAN_SCHEMA,
    deletionState: {
      type: 'string',
      enum: ['none', 'pendingStopReconciliation', 'finalizingDelete'],
    },
    pendingOldTransportStop: NULLABLE_PENDING_OLD_TRANSPORT_STOP_SCHEMA,
    historyGap: HISTORY_GAP_SCHEMA,
    providerReadiness: PROVIDER_READINESS_SCHEMA,
    pollFailure: ConversationConnectionPollFailureJsonSchema,
    maximumObservationAgeMs: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    // Historical connection-age fields remain readable, but have no runtime consumer.
    observationAgeExpansionFloorOccurredAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  },
  required: [
    'configurationRevision',
    'providerPluginId',
    'providerContributionSelection',
    'providerSetupInput',
    'credentialRef',
    'transportOrigin',
    'transport',
    'overlapSafety',
    'replayContinuity',
    'providerConnectionKey',
    'providerConfigVersion',
    'providerConfig',
    'routingIdentityKey',
    'integrationPrincipal',
    'authorityEpoch',
    'enabled',
    'deletionState',
    'pendingOldTransportStop',
    'historyGap',
    'pollFailure',
  ],
  additionalProperties: false,
  allOf: [
    CONNECTION_TRANSPORT_CONSISTENCY_SCHEMA,
    CONNECTION_DELETION_CONSISTENCY_SCHEMA,
  ],
} satisfies PluginJsonSchema;

const RESOLVED_ENDPOINT_SCHEMA = {
  ...ConversationResolvedEndpointV1JsonSchema,
  properties: {
    ...ConversationResolvedEndpointV1JsonSchema.properties!,
    id: boundedString(MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES),
    parentId: boundedString(MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES),
    label: DISPLAY_LABEL_SCHEMA,
    parentLabel: DISPLAY_LABEL_SCHEMA,
  },
} satisfies PluginJsonSchema;

const BINDING_DELETION_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        deletionState: { type: 'string', const: 'none' },
      },
      required: ['deletionState'],
    },
    {
      type: 'object',
      properties: {
        deletionState: { type: 'string', const: 'finalizingDelete' },
        enabled: { type: 'boolean', const: false },
      },
      required: ['deletionState', 'enabled'],
    },
  ],
};

const BINDING_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    parentBindingId: ConversationBindingIdV1JsonSchema,
    inboundBirthMessageId: boundedString(MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES),
    endpoint: RESOLVED_ENDPOINT_SCHEMA,
    target: ConversationBindingTargetV1JsonSchema,
    allowedPrincipalIds: ConversationAllowedPrincipalIdsV1JsonSchema,
    allowBotSenders: BOOLEAN_SCHEMA,
    inputMode: { type: 'string', enum: [...CONVERSATION_BINDING_INPUT_MODES_V1] },
    inboundDebounceMs: ConversationInboundDebounceMsV1JsonSchema,
    linkPreviewPolicy: { type: 'string', enum: ['suppress', 'providerDefault'] },
    senderFeedback: { type: 'string', enum: ['off', 'eligibleRefusals'] },
    authorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    enabled: BOOLEAN_SCHEMA,
    deletionState: { type: 'string', enum: ['none', 'finalizingDelete'] },
  },
  required: [
    'endpoint',
    'target',
    'allowedPrincipalIds',
    'allowBotSenders',
    'inputMode',
    'inboundDebounceMs',
    'linkPreviewPolicy',
    'senderFeedback',
    'authorityEpoch',
    'enabled',
    'deletionState',
  ],
  additionalProperties: false,
  allOf: [BINDING_DELETION_CONSISTENCY_SCHEMA],
} satisfies PluginJsonSchema;

const CONNECTION_IDENTITY_KEY_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    connectionIdentityKey: {
      type: 'string',
      minLength: 43,
      maxLength: 43,
      pattern: '^[A-Za-z0-9_-]{43}$',
    },
  },
  required: ['connectionIdentityKey'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

const CONNECTION_RESERVATION_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    providerPluginId: PluginIdJsonSchema,
    providerConnectionKey: boundedString(MAX_CONVERSATION_PROVIDER_CONNECTION_KEY_UTF8_BYTES),
    integrationPrincipalId: PRINCIPAL_ID_SCHEMA,
  },
  required: ['providerPluginId', 'providerConnectionKey', 'integrationPrincipalId'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

const FROZEN_SESSION_INGRESS_TARGET_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'session' },
    sessionId: boundedString(MAX_PLUGIN_ID_LENGTH),
    idempotencyKey: boundedString(MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES),
    requestedPermissionCeiling: {
      type: 'string',
      enum: ['default', 'read-only', 'safe-yolo', 'yolo', 'plan'],
    },
    // The owner's chat-approval ceiling is frozen with the rest of the target
    // so a retry stamps the disclosure the admitted binding revision carried.
    remoteApprovalMaxScope: {
      type: 'string',
      enum: ['off', 'request', 'session'],
    },
    // Absence deliberately means no frozen approval command. An admitted
    // `/allow` or `/deny` freezes its exact request, decision, and requested
    // scope before any mediation call, so a later policy edit cannot redirect
    // or widen a replay.
    approval: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            // One owner for the admitted approval identifier: the command
            // classifier refuses anything past this many UTF-8 bytes, and a
            // string never has more code points than UTF-8 bytes, so every
            // identifier that classifier admits is persistable here.
            requestId: boundedString(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES),
            decision: { type: 'string', enum: ['allow', 'deny'] },
            scope: { type: 'string', enum: ['request', 'session'] },
          },
          required: ['requestId', 'decision', 'scope'],
          additionalProperties: false,
        },
      ],
    },
    // Retained `/answer` targets remain readable. Fresh associations keep
    // only userActionAnswerRequestId; the occurrence owns pending values.
    userActionAnswer: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            requestId: boundedString(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES),
            answers: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                properties: {
                  questionIndex: { type: 'integer' },
                  values: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string' },
                  },
                },
                required: ['questionIndex', 'values'],
                additionalProperties: false,
              },
            },
          },
          required: ['requestId', 'answers'],
          additionalProperties: false,
        },
      ],
    },
    // Old obligations predate `/new`; absence deliberately means no frozen
    // rotation request. New obligations retain the binding-owned recipe;
    // the original occurrence supplies its prompt without another policy
    // decision. Historical full targets remain readable.
    newSession: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            recipe: { type: 'object', additionalProperties: {} },
            initialPrompt: { type: 'string', minLength: 1 },
          },
          required: ['recipe'],
          additionalProperties: false,
        },
      ],
    },
    stop: { type: 'boolean', const: true },
  },
  required: [
    'kind',
    'sessionId',
    'idempotencyKey',
    'requestedPermissionCeiling',
    'remoteApprovalMaxScope',
  ],
  additionalProperties: false,
};

const FROZEN_AUTOMATION_INGRESS_TARGET_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'automation' },
    automationId: boundedString(MAX_PLUGIN_ID_LENGTH),
    occurrenceKey: boundedString(MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES),
    scopedTrigger: ConversationScopedPullRequestTriggerV1Schema.jsonSchema,
    // The generic Automation Action owns the actual reply-context bounds and
    // validation. This row freezes its exact JSON input before the first call;
    // it is not a Channels-created envelope or a second reply-context store.
    resultDelivery: {
      oneOf: [
        {
          type: 'object',
          properties: { kind: { type: 'string', const: 'none' } },
          required: ['kind'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            kind: { type: 'string', const: 'finalResult' },
            // This callback is minted by Channels after authenticated admission;
            // a provider or binding cannot redirect Automation result delivery.
            actionRef: {
              type: 'object',
              properties: {
                pluginId: { type: 'string', const: 'happier.channels' },
                localId: {
                  type: 'string',
                  const: CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1.automationResultDeliver,
                },
              },
              required: ['pluginId', 'localId'],
              additionalProperties: false,
            },
            opaqueContext: JSON_VALUE_SCHEMA,
          },
          required: ['kind', 'actionRef', 'opaqueContext'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['kind', 'automationId', 'occurrenceKey', 'resultDelivery'],
  additionalProperties: false,
};

/**
 * A provider Event is not a binding-owned Automation admission. The selected
 * provider contribution receives this immutable candidate through its own
 * Action, while Channels retains the one durable ingress lifecycle around it.
 */
const FROZEN_EVENT_INGRESS_TARGET_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'event' },
    candidate: ConversationIngressAutomationEventCandidateV1JsonSchema,
    providerPluginId: PluginIdJsonSchema,
    providerContributionSelection: ConversationProviderContributionSelectionJsonSchema,
    executionOrigin: CONNECTION_TRANSPORT_ORIGIN_SCHEMA,
  },
  required: [
    'kind',
    'candidate',
    'providerPluginId',
    'providerContributionSelection',
    'executionOrigin',
  ],
  additionalProperties: false,
};

/**
 * The frozen target is an existing collection-schema owner boundary: force
 * both closed discriminated branches through that shared schema type before
 * composing the obligation payload. This prevents TypeScript from preserving
 * their mutually exclusive property maps as an optional-undefined union.
 */
const FROZEN_INGRESS_TARGET_SCHEMA: PluginJsonSchema = {
  oneOf: [
    FROZEN_SESSION_INGRESS_TARGET_SCHEMA,
    FROZEN_AUTOMATION_INGRESS_TARGET_SCHEMA,
    FROZEN_EVENT_INGRESS_TARGET_SCHEMA,
    {
      type: 'object',
      properties: { kind: { type: 'string', const: 'discussion' },
        discussionId: boundedString(MAX_PLUGIN_ID_LENGTH), localId: boundedString(MAX_PLUGIN_ID_LENGTH),
        providerPluginId: PluginIdJsonSchema },
      required: ['kind', 'discussionId', 'localId', 'providerPluginId'], additionalProperties: false,
    },
  ],
};

const INGRESS_TERMINAL_DISPOSITION_SCHEMA = {
  type: 'string',
  enum: [
    'admitted',
    'rejected',
    'suppressed',
    'approvalConsumed',
    'userActionConsumed',
    'rotationBusy',
    'rotationSuperseded',
    'rotated',
    'connectionDeleted',
    'staleAuthority',
  ],
} satisfies PluginJsonSchema;

const INGRESS_NON_ADMISSION_SCHEMA = nullable({
  type: 'object',
  properties: {
    reason: { type: 'string', enum: [...CONVERSATION_NON_ADMISSION_REASONS] },
    senderFeedbackEligible: BOOLEAN_SCHEMA,
  },
  required: ['reason', 'senderFeedbackEligible'],
  additionalProperties: false,
});

const INGRESS_OBLIGATION_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    occurrenceIds: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_CONVERSATION_RECEIVE_BATCH_ENTRIES,
      items: OCCURRENCE_ID_SCHEMA,
    },
    normalizedIngress: nullable(ConversationNormalizedIngressV1JsonSchema),
    observationShell: ConversationAuthenticatedObservationShellV1JsonSchema,
    eventCandidate: nullable(ConversationIngressAutomationEventCandidateV1JsonSchema),
    prUpdate: SessionPullRequestUpdateV1Schema.jsonSchema,
    prSplitContinuation: SessionPullRequestUpdateContinuationV1Schema.jsonSchema,
    prBatchMemberIds: { type: 'array', items: OPAQUE_ROUTING_ROW_ID_SCHEMA, uniqueItems: true },
    prBatchLeaderId: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    prRoundPrepared: { const: true },
    prSequenceEndObserved: { const: true },
    prFixExhausted: { const: true },
    sessionInput: {
      type: 'object',
      properties: {
        sessionId: boundedString(MAX_PLUGIN_ID_LENGTH),
        localId: { type: 'string', minLength: 1 },
        projectedReplySeq: nullable(POSITIVE_SAFE_INTEGER_SCHEMA),
      },
      required: ['sessionId', 'localId', 'projectedReplySeq'],
      additionalProperties: false,
    },
    target: nullable(FROZEN_INGRESS_TARGET_SCHEMA),
    sourceAuthority: {
      type: 'object',
      properties: {
        connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
        // Provider Event obligations are connection-owned. Binding-owned
        // Session/Automation obligations retain their existing exact fence.
        bindingRevision: nullable(COLLECTION_ROW_REVISION_SCHEMA),
        bindingAuthorityEpoch: nullable(POSITIVE_SAFE_INTEGER_SCHEMA),
      },
      required: ['connectionAuthorityEpoch'],
      additionalProperties: false,
    },
    lifecycle: {
      oneOf: [
        ...(['batchCollecting', 'debounceDue', 'ready', 'attempting', 'retryDue', 'blocked', 'terminal'] as const)
          .map((phase) => ({
            type: 'object' as const,
            properties: {
              phase: { type: 'string' as const, const: phase },
              attemptCount: { type: 'integer' as const, minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
              dueAt: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
            },
            required: ['phase', 'attemptCount', 'dueAt'],
            additionalProperties: false,
          })),
      ],
    },
    // The host-stamped turn resolved for a frozen chat approval, written
    // before the irreversible mediation effect so replay re-answers the exact
    // idempotent owner tuple. Absence deliberately means unresolved; the rest
    // of that tuple is already immutable in the frozen target.
    approvalTurnId: nullable(boundedString(MAX_PLUGIN_ID_LENGTH)),
    // This is the host-stamped turn needed to retry the exact canonical
    // user-action Action. It is not an answer-result cache; absence means the
    // pending projection has not yet supplied the live turn.
    userActionAnswerTurnId: nullable(boundedString(MAX_PLUGIN_ID_LENGTH)),
    stopOutcome: { type: 'string', enum: ['cancelled', 'refused', 'unconfirmed'] },
    disposition: nullable(INGRESS_TERMINAL_DISPOSITION_SCHEMA),
    nonAdmission: INGRESS_NON_ADMISSION_SCHEMA,
  },
  required: [
    'occurrenceIds',
    'normalizedIngress',
    'observationShell',
    'target',
    'sourceAuthority',
    'lifecycle',
    'disposition',
    'nonAdmission',
  ],
  additionalProperties: false,
  allOf: [{
    oneOf: [
      {
        properties: {
          lifecycle: {
            type: 'object',
            properties: { phase: { type: 'string', enum: ['batchCollecting', 'debounceDue', 'ready', 'attempting', 'retryDue', 'blocked'] } },
            required: ['phase'],
          },
          disposition: NULL_SCHEMA,
          nonAdmission: NULL_SCHEMA,
        },
        required: ['lifecycle', 'disposition', 'nonAdmission'],
      },
      {
        properties: {
          lifecycle: {
            type: 'object',
            properties: { phase: { type: 'string', const: 'terminal' } },
            required: ['phase'],
          },
          disposition: INGRESS_TERMINAL_DISPOSITION_SCHEMA,
          nonAdmission: INGRESS_NON_ADMISSION_SCHEMA,
        },
        required: ['lifecycle', 'disposition', 'nonAdmission'],
      },
    ],
  }],
} satisfies PluginJsonSchema;

const {
  normalizedIngress: _normalizedIngress,
  observationShell: _observationShell,
  eventCandidate: _eventCandidate,
  ...historicalIngressObligationProperties
} = INGRESS_OBLIGATION_PAYLOAD_SCHEMA.properties;

// Inert pre-release development transition; remove at 0.3 migration consolidation (OWNER-RULINGS 2026-10-31).
const HISTORICAL_INGRESS_OBLIGATION_PAYLOAD_SCHEMA = {
  ...INGRESS_OBLIGATION_PAYLOAD_SCHEMA,
  properties: {
    ...historicalIngressObligationProperties,
    censusId: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    prEventActors: AutomationConversationEventActorsV1Schema.jsonSchema,
    userActionAnswerRequestId: boundedString(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES),
  },
  required: ['censusId', ...INGRESS_OBLIGATION_PAYLOAD_SCHEMA.required.filter(
    field => field !== 'normalizedIngress' && field !== 'observationShell',
  )],
} satisfies PluginJsonSchema;

/**
 * The ingress owner sorts this exact set by printable-ASCII binding ID before
 * its one immutable write. JSON Schema cannot express that ordering relation,
 * so the owner-local normalizer remains the correspondence authority.
 */
const INGRESS_CENSUS_MATCHED_BINDING_SCHEMA = {
  type: 'object',
  properties: {
    bindingId: BINDING_ID_SCHEMA,
    bindingRevision: COLLECTION_ROW_REVISION_SCHEMA,
    bindingAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
  },
  required: ['bindingId'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

/**
 * Census equality retains the complete provider-normalized ingress exactly
 * once. Per-binding obligations reference this row and never duplicate body
 * bytes.
 */
const INGRESS_CENSUS_NORMALIZED_INGRESS_SCHEMA = ConversationNormalizedIngressV1JsonSchema;

/**
 * The body-free replay identity a settled census keeps: the authenticated
 * envelope the protocol already publishes without a body. Retired digest
 * fields remain readable without rewriting retained records.
 */
const INGRESS_CENSUS_COMPACTED_SCHEMA = {
  type: 'object',
  properties: {
    shell: ConversationAuthenticatedObservationShellV1JsonSchema,
    replayDigest: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    // Historical member bookkeeping remains readable, never newly produced.
    retainedAttentionObligationRowIds: {
      type: 'array',
      items: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    },
  },
  required: ['shell', 'retainedAttentionObligationRowIds'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

/** A monotonic, redacted occurrence-evidence mismatch fact. */
const INGRESS_CENSUS_CONFLICT_FACT_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', const: 'occurrenceEvidenceMismatch' },
  },
  required: ['kind'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

/**
 * This is a private, immutable routing fact only. It carries neither source
 * content/attribution nor a completion state; per-binding obligations retain
 * all dispatch and checkpoint authority.
 */
const RETAINED_INGRESS_CENSUS_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    // Exactly one of the two carries the occurrence. The full ingress is
    // retained while any destination still needs its body; native handoff
    // leaves only the body-free replay identity.
    normalizedIngress: nullable(INGRESS_CENSUS_NORMALIZED_INGRESS_SCHEMA),
    compacted: nullable(INGRESS_CENSUS_COMPACTED_SCHEMA),
    phase: { type: 'string', enum: ['preparing', 'prepared'] },
    connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    maximumObservationAgeMs: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    // Historical checkpoint coverage is readable but no longer produced.
    checkpointCoveredAt: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
    conflict: nullable(INGRESS_CENSUS_CONFLICT_FACT_SCHEMA),
    // Existing retained censuses predate Event candidates. Omission reads as
    // no candidate; current writers always persist the explicit nullable arm.
    eventCandidate: nullable(ConversationIngressAutomationEventCandidateV1JsonSchema),
    // Poll shaping context stays with the sole replay census after compaction.
    endpointWasRetainedAtPoll: BOOLEAN_SCHEMA,
    matchedBindings: {
      type: 'array',
      minItems: 0,
      items: INGRESS_CENSUS_MATCHED_BINDING_SCHEMA,
    },
  },
  required: [
    'normalizedIngress',
    'compacted',
    'phase',
    'connectionAuthorityEpoch',
    'maximumObservationAgeMs',
    'conflict',
    'matchedBindings',
  ],
  additionalProperties: false,
} satisfies PluginJsonSchema;

// Retained closed payloads remain readable without rewriting their rows. New
// pending content has no all-destination preparation state.
const { phase: _retainedPreparationPhase, ...INGRESS_OCCURRENCE_PROPERTIES } = RETAINED_INGRESS_CENSUS_PAYLOAD_SCHEMA.properties;
const INGRESS_CENSUS_PAYLOAD_SCHEMA = {
  oneOf: [RETAINED_INGRESS_CENSUS_PAYLOAD_SCHEMA, {
    ...RETAINED_INGRESS_CENSUS_PAYLOAD_SCHEMA,
    properties: {
      ...INGRESS_OCCURRENCE_PROPERTIES,
      compacted: nullable({ ...INGRESS_CENSUS_COMPACTED_SCHEMA, required: ['shell'] }),
    },
    required: ['normalizedIngress', 'compacted', 'conflict', 'matchedBindings'],
  }],
} satisfies PluginJsonSchema;

const CHECKPOINT_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    authorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    opaqueToken: JSON_VALUE_SCHEMA,
    lastOccurrenceId: nullable(OCCURRENCE_ID_SCHEMA),
    revision: POSITIVE_SAFE_INTEGER_SCHEMA,
    nextPollNotBeforeMs: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
  },
  // Retained counters remain accepted; current writers use the Collection CAS
  // revision and provider token rather than a second checkpoint counter.
  required: ['authorityEpoch', 'opaqueToken', 'nextPollNotBeforeMs'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

const SESSION_PROJECTION_FRONTIER_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    targetSessionId: boundedString(MAX_PLUGIN_ID_LENGTH),
    transcriptCursor: JSON_VALUE_SCHEMA,
    lastScannedSeq: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
    revision: POSITIVE_SAFE_INTEGER_SCHEMA,
  },
  required: ['targetSessionId', 'transcriptCursor', 'lastScannedSeq', 'revision'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

const PROJECTION_FRONTIER_PAYLOAD_SCHEMA: PluginJsonSchema = { oneOf: [
  SESSION_PROJECTION_FRONTIER_PAYLOAD_SCHEMA,
  { type: 'object', properties: {
    targetDiscussionId: boundedString(MAX_PLUGIN_ID_LENGTH),
    lastScannedSeq: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  }, required: ['targetDiscussionId', 'lastScannedSeq'], additionalProperties: false },
] };

const SESSION_ROTATION_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    commandOccurrenceId: OCCURRENCE_ID_SCHEMA,
    expectedOldSessionId: boundedString(MAX_PLUGIN_ID_LENGTH),
    creationKey: {
      type: 'string',
      minLength: 'channel-new:'.length + 1,
      maxLength: MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
      pattern: '^channel-new:',
    },
    initialPromptIdempotencyKey: nullable(
      boundedString(MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES),
    ),
    revision: POSITIVE_SAFE_INTEGER_SCHEMA,
  },
  required: [
    'commandOccurrenceId',
    'expectedOldSessionId',
    'creationKey',
    'initialPromptIdempotencyKey',
    'revision',
  ],
  additionalProperties: false,
} satisfies PluginJsonSchema;

const INGRESS_OBLIGATION_ROW_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: BOOLEAN_SCHEMA,
        [CHANNEL_STATE_FIELD.attention]: { const: false },
        payload: { type: 'object', properties: { kind: { const: 'configuredFix' } }, required: ['kind'] },
      },
      required: [CHANNEL_STATE_FIELD.terminal, CHANNEL_STATE_FIELD.attention, CHANNEL_STATE_FIELD.bindingId,
        CHANNEL_STATE_FIELD.sessionId, 'payload'],
    },
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: { type: 'boolean', const: false },
        [CHANNEL_STATE_FIELD.attention]: { type: 'boolean', const: false },
        [CHANNEL_STATE_FIELD.dueAt]: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
        payload: { type: 'object', properties: {
          lifecycle: { type: 'object', properties: { phase: { type: 'string', const: 'batchCollecting' } }, required: ['phase'] },
          disposition: NULL_SCHEMA, nonAdmission: NULL_SCHEMA,
        }, required: ['lifecycle', 'disposition', 'nonAdmission'] },
      },
      required: [CHANNEL_STATE_FIELD.terminal, CHANNEL_STATE_FIELD.attention, 'payload'],
    },
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: { type: 'boolean', const: false },
        [CHANNEL_STATE_FIELD.attention]: { type: 'boolean', const: false },
        [CHANNEL_STATE_FIELD.dueAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
        payload: {
          type: 'object',
          properties: {
            lifecycle: {
              type: 'object',
              properties: { phase: { type: 'string', enum: ['debounceDue', 'ready', 'attempting', 'retryDue'] } },
              required: ['phase'],
            },
            disposition: NULL_SCHEMA,
            nonAdmission: NULL_SCHEMA,
          },
          required: ['lifecycle', 'disposition', 'nonAdmission'],
        },
      },
      required: [CHANNEL_STATE_FIELD.terminal, CHANNEL_STATE_FIELD.attention, CHANNEL_STATE_FIELD.dueAt, 'payload'],
    },
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: { type: 'boolean', const: false },
        [CHANNEL_STATE_FIELD.attention]: { type: 'boolean', const: true },
        [CHANNEL_STATE_FIELD.dueAt]: NULL_SCHEMA,
        payload: {
          type: 'object',
          properties: {
            lifecycle: {
              type: 'object',
              properties: { phase: { type: 'string', const: 'blocked' } },
              required: ['phase'],
            },
            disposition: NULL_SCHEMA,
            nonAdmission: NULL_SCHEMA,
          },
          required: ['lifecycle', 'disposition', 'nonAdmission'],
        },
      },
      required: [CHANNEL_STATE_FIELD.terminal, CHANNEL_STATE_FIELD.attention, 'payload'],
    },
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: { type: 'boolean', const: true },
        [CHANNEL_STATE_FIELD.attention]: BOOLEAN_SCHEMA,
        [CHANNEL_STATE_FIELD.dueAt]: NULL_SCHEMA,
        payload: {
          type: 'object',
          properties: {
            lifecycle: {
              type: 'object',
              properties: { phase: { type: 'string', const: 'terminal' } },
              required: ['phase'],
            },
            disposition: INGRESS_TERMINAL_DISPOSITION_SCHEMA,
            nonAdmission: INGRESS_NON_ADMISSION_SCHEMA,
          },
          required: ['lifecycle', 'disposition', 'nonAdmission'],
        },
      },
      required: [CHANNEL_STATE_FIELD.terminal, CHANNEL_STATE_FIELD.attention, 'payload'],
    },
  ],
} satisfies PluginJsonSchema;

/**
 * Retained mismatch rows keep their historical strict projection. Current
 * occurrence writes use the ordinary false/null arm and carry no conflict proof.
 */
const INGRESS_CENSUS_ROW_CONSISTENCY_SCHEMA = {
  oneOf: [
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: NULL_SCHEMA,
        [CHANNEL_STATE_FIELD.bindingId]: NULL_SCHEMA,
        [CHANNEL_STATE_FIELD.attention]: { type: 'boolean', const: false },
        [CHANNEL_STATE_FIELD.dueAt]: NULL_SCHEMA,
        payload: {
          type: 'object',
          properties: { conflict: NULL_SCHEMA },
          required: ['conflict'],
        },
      },
      required: [CHANNEL_STATE_FIELD.attention, 'payload'],
    },
    {
      properties: {
        [CHANNEL_STATE_FIELD.terminal]: NULL_SCHEMA,
        [CHANNEL_STATE_FIELD.bindingId]: NULL_SCHEMA,
        [CHANNEL_STATE_FIELD.attention]: { type: 'boolean', const: true },
        [CHANNEL_STATE_FIELD.dueAt]: NULL_SCHEMA,
        payload: {
          type: 'object',
          properties: { conflict: INGRESS_CENSUS_CONFLICT_FACT_SCHEMA },
          required: ['conflict'],
        },
      },
      required: [CHANNEL_STATE_FIELD.attention, 'payload'],
    },
  ],
} satisfies PluginJsonSchema;

/** `attention` is an ingress-obligation diagnostic projection, never generic state. */
const NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA = {
  properties: {
    [CHANNEL_STATE_FIELD.attention]: NULL_SCHEMA,
    [CHANNEL_STATE_FIELD.dueAt]: NULL_SCHEMA,
  },
} satisfies PluginJsonSchema;

/** Finalizing configuration is immediately eligible through the existing due-work index. */
const DELETE_FINALIZATION_ROW_CONSISTENCY_SCHEMA = {
  properties: { [CHANNEL_STATE_FIELD.attention]: NULL_SCHEMA },
  oneOf: [
    {
      properties: {
        [CHANNEL_STATE_FIELD.dueAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
        payload: { properties: { deletionState: { const: 'finalizingDelete' } } },
      },
      required: [CHANNEL_STATE_FIELD.dueAt],
    },
    {
      properties: {
        [CHANNEL_STATE_FIELD.dueAt]: NULL_SCHEMA,
        payload: { properties: { deletionState: { enum: ['none', 'pendingStopReconciliation'] } } },
      },
    },
  ],
} satisfies PluginJsonSchema;

type StateRecordDefinition = Readonly<{
  kind: (typeof CHANNEL_STATE_RECORD_KINDS)[number];
  payload: PluginJsonSchema;
  rowIdSchema: PluginJsonSchema;
  requiredProjectionFields: readonly string[];
  rowConsistency?: PluginJsonSchema;
}>;

/**
 * Generic Data validates declared row schemas and CAS only. Before issuing a
 * generic Data mutation, the Channels core transition/writer must call this
 * owner-local correspondence check for relations JSON Schema cannot compare
 * across fields.
 */
export function isCanonicalChannelStateRecordIdentity(input: Readonly<{
  rowId: string;
  recordKind: (typeof CHANNEL_STATE_RECORD_KINDS)[number];
  connectionId?: string;
  bindingId?: string;
  commandOccurrenceId?: string;
  creationKey?: string;
  ingressTargetKind?: 'session' | 'automation' | 'event' | 'discussion';
  sessionIdempotencyKey?: string;
}>): boolean {
  if (input.recordKind === CHANNEL_STATE_RECORD_KIND.connection) {
    return input.connectionId !== undefined
      && input.rowId === input.connectionId
      && ConversationConnectionIdV1Schema.safeParse(input.rowId).success;
  }
  if (input.recordKind === CHANNEL_STATE_RECORD_KIND.binding) {
    return input.bindingId !== undefined
      && input.rowId === input.bindingId
      && ConversationBindingIdV1Schema.safeParse(input.rowId).success;
  }
  if (input.recordKind === CHANNEL_STATE_RECORD_KIND.sessionRotation) {
    return input.bindingId !== undefined
      && ConversationBindingIdV1Schema.safeParse(input.bindingId).success
      && input.commandOccurrenceId !== undefined
      && input.creationKey === createConversationNewSessionCreationKey({
        bindingId: input.bindingId,
        commandOccurrenceId: input.commandOccurrenceId,
      });
  }
  if (input.recordKind === CHANNEL_STATE_RECORD_KIND.ingressObligation) {
    if (input.ingressTargetKind === 'session') {
      return input.sessionIdempotencyKey === `channels:input:v1:${input.rowId}`;
    }
    return input.ingressTargetKind === 'automation' || input.ingressTargetKind === 'event' || input.ingressTargetKind === 'discussion';
  }
  return true;
}

const STATE_RECORDS: readonly StateRecordDefinition[] = [
  {
    kind: CHANNEL_STATE_RECORD_KIND.connection,
    payload: CONNECTION_PAYLOAD_SCHEMA,
    rowIdSchema: CONNECTION_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.connectionId],
    rowConsistency: DELETE_FINALIZATION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.binding,
    payload: BINDING_PAYLOAD_SCHEMA,
    rowIdSchema: BINDING_ID_SCHEMA,
    requiredProjectionFields: [
      CHANNEL_STATE_FIELD.connectionId,
      CHANNEL_STATE_FIELD.bindingId,
    ],
    rowConsistency: DELETE_FINALIZATION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.connectionIdentityKey,
    payload: CONNECTION_IDENTITY_KEY_PAYLOAD_SCHEMA,
    rowIdSchema: CONNECTION_IDENTITY_KEY_ROW_ID_SCHEMA,
    requiredProjectionFields: [],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.connectionReservation,
    payload: CONNECTION_RESERVATION_PAYLOAD_SCHEMA,
    rowIdSchema: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.connectionId],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    payload: INGRESS_OBLIGATION_PAYLOAD_SCHEMA,
    rowIdSchema: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    requiredProjectionFields: [
      CHANNEL_STATE_FIELD.connectionId,
      CHANNEL_STATE_FIELD.terminal,
      CHANNEL_STATE_FIELD.attention,
    ],
    rowConsistency: INGRESS_OBLIGATION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.ingressCensus,
    payload: INGRESS_CENSUS_PAYLOAD_SCHEMA,
    rowIdSchema: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.connectionId],
    rowConsistency: INGRESS_CENSUS_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.checkpoint,
    payload: CHECKPOINT_PAYLOAD_SCHEMA,
    rowIdSchema: NON_CONNECTION_IDENTITY_KEY_ROW_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.connectionId],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.projectionFrontier,
    payload: PROJECTION_FRONTIER_PAYLOAD_SCHEMA,
    rowIdSchema: NON_CONNECTION_IDENTITY_KEY_ROW_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.bindingId],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.sessionRotation,
    payload: SESSION_ROTATION_PAYLOAD_SCHEMA,
    rowIdSchema: NON_CONNECTION_IDENTITY_KEY_ROW_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.bindingId],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
  },
];


/**
 * One strict Account Collection contract for all Channels configuration,
 * ingress, checkpoint, projection-frontier, and rotation state. Every row
 * family remains explicit; no later core phase gets an opaque escape hatch.
 */
export const CHANNEL_STATE_COLLECTION = defineAccountCollection({
  id: CHANNEL_STATE_COLLECTION_ID,
  schemaVersion: 23,
  readableSchemaVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  // V21 publishes the V20 document with its reused subschemas under `$defs`
  // (same validation, a fraction of the size every reader compiles).
  // V22 admits due unclassified PR captures so interrupted batching can resume.
  // V23 adopts changed embedded Action result schemas through Data migration.
  schema: shareRepeatedCollectionSchemas({
    type: 'object',
    properties: {
      [CHANNEL_STATE_FIELD.id]: boundedString(256),
      [CHANNEL_STATE_FIELD.recordKind]: {
        type: 'string',
        enum: [...CHANNEL_STATE_RECORD_KINDS],
      },
      [CHANNEL_STATE_FIELD.version]: { type: 'integer', const: 1 },
      // Data projects optional fields as null but validates their non-null
      // scalar value through this schema. They must stay out of `required` so
      // a null projection is omitted from the reconstructed logical row.
      [CHANNEL_STATE_FIELD.connectionId]: CONNECTION_ID_SCHEMA,
      [CHANNEL_STATE_FIELD.bindingId]: BINDING_ID_SCHEMA,
      [CHANNEL_STATE_FIELD.sessionId]: boundedString(MAX_PLUGIN_ID_LENGTH),
      [CHANNEL_STATE_FIELD.prBinding]: BOOLEAN_SCHEMA,
      [CHANNEL_STATE_FIELD.prUpdateAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      [CHANNEL_STATE_FIELD.terminal]: BOOLEAN_SCHEMA,
      [CHANNEL_STATE_FIELD.attention]: BOOLEAN_SCHEMA,
      [CHANNEL_STATE_FIELD.dueAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      [CHANNEL_STATE_FIELD.createdAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      [CHANNEL_STATE_FIELD.updatedAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      // The record-kind branch below owns the exact payload schema. Repeating
      // every branch here only duplicates the same strict validation in the
      // bundled manifest and can exhaust its bounded JSON entry budget.
      payload: {},
    },
    required: [
      CHANNEL_STATE_FIELD.id,
      CHANNEL_STATE_FIELD.recordKind,
      CHANNEL_STATE_FIELD.version,
      CHANNEL_STATE_FIELD.createdAt,
      CHANNEL_STATE_FIELD.updatedAt,
      'payload',
    ],
    additionalProperties: false,
    allOf: [{
      oneOf: STATE_RECORDS.map(({
        kind,
        payload,
        rowIdSchema,
        requiredProjectionFields,
        rowConsistency,
      }, index) => ({
        properties: {
          [CHANNEL_STATE_FIELD.id]: rowIdSchema,
          [CHANNEL_STATE_FIELD.recordKind]: { type: 'string', const: kind },
          payload: kind === CHANNEL_STATE_RECORD_KIND.ingressObligation ? { oneOf: [payload,
            embedProtocolJsonSchema(SessionPullRequestConfiguredFixCustodySchema.jsonSchema,
              ['allOf', 0, 'oneOf', index, 'properties', 'payload', 'oneOf', 1]),
            // Keep both retained strict arms byte-identical. Presence of the
            // actual native input evidence distinguishes this additive arm.
            { ...INGRESS_OBLIGATION_PAYLOAD_SCHEMA,
              properties: { ...INGRESS_OBLIGATION_PAYLOAD_SCHEMA.properties,
                prEventActors: AutomationConversationEventActorsV1Schema.jsonSchema },
              required: [...INGRESS_OBLIGATION_PAYLOAD_SCHEMA.required, 'prEventActors'],
            },
            // Native request identity, not another answer-content owner. The
            // retained closed payloads cannot accept this required property.
            { ...INGRESS_OBLIGATION_PAYLOAD_SCHEMA,
              properties: { ...INGRESS_OBLIGATION_PAYLOAD_SCHEMA.properties,
                userActionAnswerRequestId: boundedString(MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES) },
              required: [...INGRESS_OBLIGATION_PAYLOAD_SCHEMA.required, 'userActionAnswerRequestId'],
            }, HISTORICAL_INGRESS_OBLIGATION_PAYLOAD_SCHEMA] } : payload,
        },
        required: [
          CHANNEL_STATE_FIELD.id,
          CHANNEL_STATE_FIELD.recordKind,
          'payload',
          ...requiredProjectionFields,
        ],
        ...(rowConsistency === undefined ? {} : { allOf: [rowConsistency] }),
      })),
    }],
  }),
  rowIdField: CHANNEL_STATE_FIELD.id,
  identityFields: [],
  serverReadable: [
    CHANNEL_STATE_FIELD.recordKind,
    CHANNEL_STATE_FIELD.version,
    CHANNEL_STATE_FIELD.connectionId,
    CHANNEL_STATE_FIELD.bindingId,
    CHANNEL_STATE_FIELD.sessionId,
    CHANNEL_STATE_FIELD.prBinding,
    CHANNEL_STATE_FIELD.prUpdateAt,
    CHANNEL_STATE_FIELD.terminal,
    CHANNEL_STATE_FIELD.attention,
    CHANNEL_STATE_FIELD.dueAt,
    CHANNEL_STATE_FIELD.createdAt,
    CHANNEL_STATE_FIELD.updatedAt,
  ],
  indexes: [
    {
      id: CHANNEL_STATE_INDEX_ID.byKind,
      fields: [
        { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
      ],
    },
    {
      // V1 index semantics are immutable after first Account use, so the
      // refined tuple ships as a new index ID rather than an in-place rewrite.
      // The retired `by-connection-binding` V1 index is absent from this V2
      // target: it has no reader left, and declaring it would leave the feature
      // paying for a seventh index Data could never contract.
      // Data appends the row-ID tiebreaker, so this declaration names only the
      // V2 tuple.
      id: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
      fields: [
        { field: CHANNEL_STATE_FIELD.connectionId, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.attention, direction: 'asc' },
      ],
    },
    {
      // Polling and exact provider reads select configuration without opening
      // this connection's retained census/obligation history.
      id: CHANNEL_STATE_INDEX_ID.byConnectionKindV1,
      fields: [
        { field: CHANNEL_STATE_FIELD.connectionId, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
      ],
    },
    {
      // Omitted selector scalars project to null; Data appends its canonical row-ID tie break.
      id: CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1,
      fields: [
        { field: CHANNEL_STATE_FIELD.sessionId, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.prUpdateAt, direction: 'desc' },
      ],
    },
    {
      id: CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1,
      fields: [
        { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.prBinding, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.sessionId, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.bindingId, direction: 'asc' },
      ],
    },
    {
      id: CHANNEL_STATE_INDEX_ID.byAttention,
      fields: [
        { field: CHANNEL_STATE_FIELD.attention, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.updatedAt, direction: 'desc' },
        { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
      ],
    },
    {
      id: CHANNEL_STATE_INDEX_ID.byIngressDue,
      fields: [
        { field: CHANNEL_STATE_FIELD.recordKind, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.dueAt, direction: 'asc' },
        { field: CHANNEL_STATE_FIELD.id, direction: 'asc' },
      ],
    },
  ],
  uiQueries: [],
  relations: [],
  migrations: CHANNEL_COLLECTION_MIGRATIONS[CHANNEL_STATE_COLLECTION_ID],
  migrationArtifact: {
    artifactId: CHANNEL_STATE_MIGRATIONS_ARTIFACT_ID,
    exportName: 'collectionMigrations',
  },
});

const DELIVERY_SOURCE_SCHEMA: PluginJsonSchema = {
  oneOf: [
    ConversationStartSourceV1JsonSchema,
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'sessionProjection' },
        sessionId: boundedString(MAX_PLUGIN_ID_LENGTH),
        semanticItemId: boundedString(MAX_PLUGIN_ID_LENGTH),
      },
      required: ['kind', 'sessionId', 'semanticItemId'],
      additionalProperties: false,
    },
    AutomationResultDeliverySourceV1JsonSchema,
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'permissionWait' },
        sessionId: boundedString(MAX_PLUGIN_ID_LENGTH),
        turnId: boundedString(MAX_PLUGIN_ID_LENGTH),
        requestId: boundedString(MAX_PLUGIN_ID_LENGTH),
      },
      required: ['kind', 'sessionId', 'turnId', 'requestId'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'controlResponse' },
        controlId: boundedString(MAX_PLUGIN_ID_LENGTH),
        controlKind: {
          type: 'string',
          enum: ['pairing', 'newSession', 'approval', 'userAction', 'stop', 'refusal', 'recovery'],
        },
      },
      required: ['kind', 'controlId', 'controlKind'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        kind: { type: 'string', const: 'discussionProjection' },
        discussionId: boundedString(MAX_PLUGIN_ID_LENGTH),
        semanticItemId: boundedString(MAX_PLUGIN_ID_LENGTH),
      },
      required: ['kind', 'discussionId', 'semanticItemId'],
      additionalProperties: false,
    },
  ],
};

/**
 * Retained stamps stay readable without a data rewrite. Current Session
 * projection rows keep the binding epoch for redrive eligibility; other
 * dispatch policy is decided from current owner records, not these fields.
 */
const DELIVERY_ROUTE_AUTHORITY_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    bindingRevision: COLLECTION_ROW_REVISION_SCHEMA,
    bindingAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
  },
  additionalProperties: false,
};

const DELIVERY_ATTEMPT_ID_SCHEMA = nullable(boundedString(MAX_PLUGIN_ID_LENGTH));
const DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA: PluginJsonSchema = {
  type: 'array',
  items: boundedString(MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES),
};
const EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA: PluginJsonSchema = {
  type: 'array',
  maxItems: 0,
  items: boundedString(MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES),
};
const DELIVERY_CHUNK_INDEX_SCHEMA = {
  type: 'integer',
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
} satisfies PluginJsonSchema;
const DELIVERY_FAILED_CHUNK_SCHEMA = nullable(DELIVERY_CHUNK_INDEX_SCHEMA);
const DELIVERY_ARCHIVE_RECOVERY_SCHEMA = nullable({
  type: 'string',
  enum: [...CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1],
});

type ConversationDeliveryCustodyState =
  (typeof CONVERSATION_DELIVERY_CUSTODY_STATES)[number];
type ConversationDeliveryCustodyStateSelection =
  | ConversationDeliveryCustodyState
  | readonly [ConversationDeliveryCustodyState, ...ConversationDeliveryCustodyState[]];

function deliveryCustodyStateSchema(
  state: ConversationDeliveryCustodyStateSelection,
): PluginJsonSchema {
  return typeof state === 'string'
    ? { type: 'string', const: state }
    : { type: 'string', enum: [...state] };
}

function deliveryPayloadStateSchema(input: Readonly<{
  state: ConversationDeliveryCustodyStateSelection;
  attemptId: PluginJsonSchema;

  providerMessageIds: PluginJsonSchema;
  failedChunk: PluginJsonSchema;
  archiveRecovery: PluginJsonSchema;
  reason?: PluginJsonSchema;
  outcome?: PluginJsonSchema;
}>): PluginJsonSchema {
  return {
    type: 'object',
    properties: {
      state: deliveryCustodyStateSchema(input.state),
      attemptId: input.attemptId,

      providerMessageIds: input.providerMessageIds,
      failedChunk: input.failedChunk,
      archiveRecovery: input.archiveRecovery,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    },
    required: [
      'state',
      'attemptId',

      'providerMessageIds',
      'failedChunk',
      'archiveRecovery',
      ...(input.reason === undefined ? [] : ['reason']),
      ...(input.outcome === undefined ? [] : ['outcome']),
    ],
  };
}

/** One strict stored-state table supplies payload and row schema projections. */
const DELIVERY_CUSTODY_STATE_SCHEMAS = [
    { state: 'notSent', terminal: true, attention: true, attemptId: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA, failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA, reason: { type: 'string', enum: ['providerRefused', 'ownerMustUnarchiveOrRebind'] } },
    { state: 'notSent', terminal: true, attention: false, attemptId: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA, failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA, reason: { type: 'string', enum: ['policySuppressed', 'connectionDeleted'] } },
    { state: 'resolved', terminal: true, attention: false, attemptId: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA, failedChunk: DELIVERY_FAILED_CHUNK_SCHEMA,
      archiveRecovery: NULL_SCHEMA, outcome: { type: 'string', enum: [...CONVERSATION_DELIVERY_RESOLVED_OUTCOMES_V1] } },
    {
      state: 'ready',
      terminal: false,
      attention: false,
      attemptId: NULL_SCHEMA,

      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: 'retryDue',
      terminal: false,
      // Retained rows may carry either value; current retries need no owner attention.
      attemptId: NULL_SCHEMA,

      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
      hasRetryNotBefore: true,
    },
    {
      state: 'attempting',
      terminal: false,
      attention: false,
      attemptId: boundedString(MAX_PLUGIN_ID_LENGTH),

      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: 'delivered',
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,

      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: 'notDelivered',
      terminal: true,
      attention: true,
      attemptId: NULL_SCHEMA,

      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: DELIVERY_ARCHIVE_RECOVERY_SCHEMA,
    },
    {
      state: 'suppressed',
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,

      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: 'partial',
      terminal: true,
      attention: true,
      attemptId: NULL_SCHEMA,

      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_CHUNK_INDEX_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: 'outcomeUnknown',
      terminal: true,
      attention: true,
      attemptId: DELIVERY_ATTEMPT_ID_SCHEMA,

      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: ['resolvedAccepted', 'resolvedDiscarded'],
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,

      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_FAILED_CHUNK_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
    {
      state: 'connectionDeleted',
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,

      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    },
] as const satisfies readonly Parameters<typeof deliveryRowStateSchema>[0][];

const DELIVERY_PAYLOAD_STATE_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  // Attention splits the row's notSent cases, not the retained payload grammar.
  oneOf: DELIVERY_CUSTODY_STATE_SCHEMAS
    .filter((entry, index) => entry.state !== 'notSent' || index === 0)
    .map(entry => deliveryPayloadStateSchema(entry.state === 'notSent'
      ? { ...entry, reason: { type: 'string', enum: [...CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1] } }
      : entry)),
};

/**
 * Terminal states retain source identity and effect evidence without content.
 * Historical fingerprints and archive fields stay readable, but do not
 * authorize another provider submission or restore a delivery body.
 */
const DELIVERY_PAYLOAD_CONTENT_RETENTION_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      properties: {
        content: ConversationDeliveryContentV1JsonSchema,
        contentFingerprint: nullable(OPAQUE_ROUTING_ROW_ID_SCHEMA),
      },
      required: ['content'],
    },
    {
      properties: {
        content: NULL_SCHEMA,
        contentFingerprint: nullable(OPAQUE_ROUTING_ROW_ID_SCHEMA),
        state: { type: 'string', enum: [...CONVERSATION_DELIVERY_CONTENT_FREE_STATES] },
        archiveRecovery: DELIVERY_ARCHIVE_RECOVERY_SCHEMA,
      },
      required: ['content', 'state', 'archiveRecovery'],
    },
  ],
};

const DELIVERY_PAYLOAD_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    source: DELIVERY_SOURCE_SCHEMA,
    routeAuthority: DELIVERY_ROUTE_AUTHORITY_SCHEMA,
    endpoint: RESOLVED_ENDPOINT_SCHEMA,
    content: nullable(ConversationDeliveryContentV1JsonSchema),
    newThread: ConversationDeliveryNewThreadV1JsonSchema,
    deliveryEndpoint: RESOLVED_ENDPOINT_SCHEMA,
    threadBindingPending: BOOLEAN_SCHEMA,
    contentFingerprint: nullable(OPAQUE_ROUTING_ROW_ID_SCHEMA),
    // Retained pre-simplification records stay readable without a data rewrite.
    mentionPolicy: { type: 'string', const: 'suppress' },
    startedAt: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
    reason: { type: 'string', enum: [...CONVERSATION_DELIVERY_NOT_SENT_REASONS_V1] },
    outcome: { type: 'string', enum: [...CONVERSATION_DELIVERY_RESOLVED_OUTCOMES_V1] },
    deliveryKey: boundedString(MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES),
    replyContext: nullable({
      type: 'object',
      properties: {
        replyToMessageId: boundedString(MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES),
        threadId: boundedString(MAX_CONVERSATION_PROVIDER_MESSAGE_ID_UTF8_BYTES),
      },
      additionalProperties: false,
      anyOf: [
        { required: ['replyToMessageId'] },
        { required: ['threadId'] },
      ],
    }),

    linkPreviewPolicy: { type: 'string', enum: [...CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1] },
    state: {
      type: 'string',
      enum: [...CONVERSATION_DELIVERY_CUSTODY_STATES],
    },
    attemptCount: {
      type: 'integer',
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    attemptId: DELIVERY_ATTEMPT_ID_SCHEMA,

    providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
    failedChunk: DELIVERY_FAILED_CHUNK_SCHEMA,
    archiveRecovery: DELIVERY_ARCHIVE_RECOVERY_SCHEMA,
  },
  required: [
    'source',
    'routeAuthority',
    'endpoint',
    'content',
    'deliveryKey',
    'replyContext',

    'linkPreviewPolicy',
    'state',
    'attemptCount',
    'attemptId',

    'providerMessageIds',
    'failedChunk',
    'archiveRecovery',
  ],
  additionalProperties: false,
  allOf: [DELIVERY_PAYLOAD_STATE_CONSISTENCY_SCHEMA, DELIVERY_PAYLOAD_CONTENT_RETENTION_SCHEMA],
};

const DELIVERY_ROW_COMMON_PROPERTIES = {
  [CHANNEL_DELIVERIES_FIELD.id]: OPAQUE_ROUTING_ROW_ID_SCHEMA,
  [CHANNEL_DELIVERIES_FIELD.recordKind]: {
    type: 'string',
    const: CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery,
  },
  [CHANNEL_DELIVERIES_FIELD.version]: { type: 'integer', const: 1 },
  [CHANNEL_DELIVERIES_FIELD.connectionId]: CONNECTION_ID_SCHEMA,
  [CHANNEL_DELIVERIES_FIELD.bindingId]: BINDING_ID_SCHEMA,
  [CHANNEL_DELIVERIES_FIELD.terminal]: BOOLEAN_SCHEMA,
  [CHANNEL_DELIVERIES_FIELD.attention]: BOOLEAN_SCHEMA,
  [CHANNEL_DELIVERIES_FIELD.createdAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  [CHANNEL_DELIVERIES_FIELD.updatedAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
} satisfies Record<string, PluginJsonSchema>;

const DELIVERY_ROW_REQUIRED = [
  CHANNEL_DELIVERIES_FIELD.id,
  CHANNEL_DELIVERIES_FIELD.recordKind,
  CHANNEL_DELIVERIES_FIELD.version,
  CHANNEL_DELIVERIES_FIELD.connectionId,
  CHANNEL_DELIVERIES_FIELD.terminal,
  CHANNEL_DELIVERIES_FIELD.attention,
  CHANNEL_DELIVERIES_FIELD.createdAt,
  CHANNEL_DELIVERIES_FIELD.updatedAt,
  'payload',
] as const;

function deliveryRowStateSchema(input: Readonly<{
  state: ConversationDeliveryCustodyStateSelection;
  terminal: boolean;
  attention?: boolean;
  attemptId: PluginJsonSchema;

  providerMessageIds: PluginJsonSchema;
  failedChunk: PluginJsonSchema;
  archiveRecovery: PluginJsonSchema;
  reason?: PluginJsonSchema;
  outcome?: PluginJsonSchema;
  hasRetryNotBefore?: boolean;
}>): PluginJsonSchema {
  return {
    type: 'object',
    properties: {
      ...DELIVERY_ROW_COMMON_PROPERTIES,
      ...(input.hasRetryNotBefore === true
        ? { [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA }
        : {}),
      [CHANNEL_DELIVERIES_FIELD.terminal]: input.terminal && (input.state === 'delivered' || input.state === 'resolvedAccepted' || input.state === 'resolved')
        ? BOOLEAN_SCHEMA : { type: 'boolean', const: input.terminal },
      [CHANNEL_DELIVERIES_FIELD.attention]: input.attention === undefined
        ? BOOLEAN_SCHEMA
        : { type: 'boolean', const: input.attention },
      payload: deliveryPayloadStateSchema(input),
    },
    ...(input.state === 'delivered' || input.state === 'resolvedAccepted' || input.state === 'resolved' ? {
      oneOf: [
        { properties: { terminal: { const: false }, payload: {
          properties: { threadBindingPending: { const: true } }, required: ['threadBindingPending'],
        } } },
        { properties: { terminal: { const: true }, payload: {
          properties: { threadBindingPending: { const: false } },
        } } },
      ],
    } : {}),
    required: [
      ...DELIVERY_ROW_REQUIRED,
      ...(input.hasRetryNotBefore === true ? [CHANNEL_DELIVERIES_FIELD.retryNotBefore] : []),
    ],
    additionalProperties: false,
  };
}

const DELIVERY_ROW_STATE_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    ...DELIVERY_CUSTODY_STATE_SCHEMAS.map(deliveryRowStateSchema),
    // Before the resolved outcome union, accepted starts could still owe their
    // child binding. Keep that disjoint retained shape, never a discarded one.
    deliveryRowStateSchema({
      state: 'resolvedAccepted', terminal: false, attention: false,
      attemptId: NULL_SCHEMA, providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_FAILED_CHUNK_SCHEMA, archiveRecovery: NULL_SCHEMA,
    }),
  ],
};

/**
 * The sole Channel outward-effect custody collection. Its projection contains
 * only owner, coarse lifecycle, and due-work facts; endpoint/content/provider
 * evidence remains inside the account-mode envelope.
 */
export const CHANNEL_DELIVERIES_COLLECTION = defineAccountCollection({
  id: CHANNEL_DELIVERIES_COLLECTION_ID,
  schemaVersion: 6,
  readableSchemaVersions: [1, 2, 3, 4, 5],
  schema: {
    type: 'object',
    properties: {
      [CHANNEL_DELIVERIES_FIELD.id]: OPAQUE_ROUTING_ROW_ID_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.recordKind]: {
        type: 'string',
        const: CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery,
      },
      [CHANNEL_DELIVERIES_FIELD.version]: { type: 'integer', const: 1 },
      [CHANNEL_DELIVERIES_FIELD.connectionId]: CONNECTION_ID_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.bindingId]: BINDING_ID_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.terminal]: BOOLEAN_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.attention]: BOOLEAN_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.createdAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      [CHANNEL_DELIVERIES_FIELD.updatedAt]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      payload: DELIVERY_PAYLOAD_SCHEMA,
    },
    required: [
      CHANNEL_DELIVERIES_FIELD.id,
      CHANNEL_DELIVERIES_FIELD.recordKind,
      CHANNEL_DELIVERIES_FIELD.version,
      CHANNEL_DELIVERIES_FIELD.connectionId,
      CHANNEL_DELIVERIES_FIELD.terminal,
      CHANNEL_DELIVERIES_FIELD.attention,
      CHANNEL_DELIVERIES_FIELD.createdAt,
      CHANNEL_DELIVERIES_FIELD.updatedAt,
      'payload',
    ],
    additionalProperties: false,
    allOf: [DELIVERY_ROW_STATE_CONSISTENCY_SCHEMA],
  },
  rowIdField: CHANNEL_DELIVERIES_FIELD.id,
  identityFields: [],
  serverReadable: [
    CHANNEL_DELIVERIES_FIELD.recordKind,
    CHANNEL_DELIVERIES_FIELD.version,
    CHANNEL_DELIVERIES_FIELD.connectionId,
    CHANNEL_DELIVERIES_FIELD.bindingId,
    CHANNEL_DELIVERIES_FIELD.terminal,
    CHANNEL_DELIVERIES_FIELD.attention,
    CHANNEL_DELIVERIES_FIELD.retryNotBefore,
    CHANNEL_DELIVERIES_FIELD.createdAt,
    CHANNEL_DELIVERIES_FIELD.updatedAt,
  ],
  indexes: [
    {
      id: CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
      fields: [
        { field: CHANNEL_DELIVERIES_FIELD.connectionId, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.bindingId, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.attention, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
      ],
    },
    {
      id: CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention,
      fields: [
        { field: CHANNEL_DELIVERIES_FIELD.connectionId, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.attention, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.bindingId, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
      ],
    },
    {
      id: CHANNEL_DELIVERIES_INDEX_ID.byRetryDue,
      fields: [
        { field: CHANNEL_DELIVERIES_FIELD.terminal, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.retryNotBefore, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
      ],
    },
    {
      id: CHANNEL_DELIVERIES_INDEX_ID.byTerminalUpdatedAt,
      fields: [
        { field: CHANNEL_DELIVERIES_FIELD.terminal, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.updatedAt, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
      ],
    },
  ],
  uiQueries: [],
  relations: [],
  // Canonical adjacent migrations preserve custody; the shared candidate
  // executor validates every target row before adopting the new contract.
  migrations: CHANNEL_COLLECTION_MIGRATIONS[CHANNEL_DELIVERIES_COLLECTION_ID],
  migrationArtifact: {
    artifactId: CHANNEL_STATE_MIGRATIONS_ARTIFACT_ID,
    exportName: 'collectionMigrations',
  },
});

/**
 * The two declared Account Collections, in one place, for the checks that
 * reason about the set rather than about one Collection.
 *
 * The manifest does not compose this array and no second function projects it
 * into a manifest declaration: `definePlugin` names each definition under its
 * own local id and derives both the static declaration — migration identities
 * without their callbacks — and the candidate-local migration projection from
 * it, so the two halves have one owner.
 */
export const CHANNEL_ACCOUNT_COLLECTIONS = [
  CHANNEL_STATE_COLLECTION,
  CHANNEL_DELIVERIES_COLLECTION,
] as const;
