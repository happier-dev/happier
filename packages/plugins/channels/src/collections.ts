import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import {
  defineAccountCollection,
  PluginMachineExecutionOriginV1JsonSchema,
} from '@happier-dev/plugin-sdk/collections';
import { QualifiedConnectedAccountRefJsonSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import {
  PluginContributionIdentityV1JsonSchema,
  PluginIdJsonSchema,
} from '@happier-dev/plugin-sdk/manifest';
import { PluginWebhookEndpointIdV1JsonSchema } from '@happier-dev/plugin-sdk/webhooks';
import { AutomationResultDeliverySourceV1JsonSchema } from '@happier-dev/plugin-sdk/automations';
import {
  CONVERSATION_BINDING_INPUT_MODES_V1,
  CONVERSATION_CONNECTION_HISTORY_GAP_REASONS_V1,
  CONVERSATION_PROVIDER_READINESS_ATTENTION_CODES_V1,
  CONVERSATION_PROVIDER_FAILURE_REASONS_V1,
  CONVERSATION_CORE_PROVIDER_ACTION_IDS_V1,
  CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1,
  CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1,
  CONVERSATION_DELIVERY_MENTION_POLICIES_V1,
  CONVERSATION_OUTBOUND_TEXT_UNITS_V1,
  ConversationBindingIdV1Schema,
  ConversationBindingIdV1JsonSchema,
  ConversationConnectionIdV1Schema,
  ConversationConnectionIdV1JsonSchema,
  ConversationProviderConnectionStopInputV1JsonSchema,
  ConversationResolvedEndpointV1JsonSchema,
  ConversationBindingTargetV1JsonSchema,
  ConversationAuthenticatedObservationShellV1JsonSchema,
  ConversationIngressAutomationEventCandidateV1JsonSchema,
  ConversationNormalizedIngressV1JsonSchema,
  MAX_CONVERSATION_APPROVAL_REQUEST_ID_UTF8_BYTES,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  MAX_CONVERSATION_DELIVERY_ATTEMPTS,
  MAX_CONVERSATION_DELIVERY_CHUNKS,
  MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES,
  MAX_CONVERSATION_ENDPOINT_STABLE_ID_UTF8_BYTES,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
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
import { MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS } from './connectionPollFailureBounds.js';

/** Canonical Data contribution identifiers; never publish camelCase aliases. */
export const CHANNEL_STATE_COLLECTION_ID = 'channel-state';
export const CHANNEL_DELIVERIES_COLLECTION_ID = 'channel-deliveries';

export const CHANNEL_STATE_FIELD = {
  id: 'id',
  recordKind: 'record-kind',
  version: 'v',
  connectionId: 'connection-id',
  bindingId: 'binding-id',
  terminal: 'terminal',
  attention: 'attention',
  dueAt: 'due-at',
  createdAt: 'created-at',
  updatedAt: 'updated-at',
} as const;

export const CHANNEL_STATE_INDEX_ID = {
  byKind: 'by-kind',
  byConnectionBindingV2: 'by-connection-binding-v2',
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
  byRetryDue: 'by-retry-due',
} as const;

export const CHANNEL_DELIVERIES_RECORD_KIND = {
  outwardDelivery: 'outward-delivery',
} as const;

export const CHANNEL_STATE_RECORD_KIND = {
  connection: 'connection',
  binding: 'binding',
  connectionIdentityKey: 'connection-identity-key',
  connectionReservation: 'connection-reservation',
  ingressObligation: 'ingress-obligation',
  ingressCensus: 'ingress-census',
  checkpoint: 'checkpoint',
  projectionFrontier: 'projection-frontier',
  sessionRotation: 'session-rotation',
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
export const MAX_CHANNEL_STATE_ROW_BYTES = 256 * 1024;
const MAX_CHANNEL_DELIVERY_ROW_BYTES = 512 * 1024;

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
 * selection narrows that plugin to its one admitted contribution generation.
 */
export type PersistedConversationProviderContributionSelection = Readonly<{
  contributionId: string;
  immutableGenerationId: string;
}>;

export const ConversationProviderContributionSelectionJsonSchema: PluginJsonSchema = {
  type: 'object',
  properties: {
    // Reuse the canonical contribution-local-id grammar instead of creating a
    // Channels-specific identifier dialect.
    contributionId: PluginContributionIdentityV1JsonSchema.properties!.localId!,
    immutableGenerationId: boundedString(MAX_PLUGIN_ID_LENGTH),
  },
  required: ['contributionId', 'immutableGenerationId'],
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

const CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    connectionRevision: POSITIVE_SAFE_INTEGER_SCHEMA,
    authorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    transportOrigin: PluginMachineExecutionOriginV1JsonSchema,
  },
  required: ['connectionRevision', 'authorityEpoch', 'transportOrigin'],
  additionalProperties: false,
};

function pendingOldTransportStopSchema(input: Readonly<{
  predecessorCheckpointedPollInvocation: PluginJsonSchema;
  stopRequest: PluginJsonSchema;
  acceptedPossibleLoss: PluginJsonSchema;
}>): PluginJsonSchema {
  return {
    type: 'object',
    properties: {
      predecessorCheckpointedPollInvocation: input.predecessorCheckpointedPollInvocation,
      transportOrigin: PluginMachineExecutionOriginV1JsonSchema,
      providerContributionSelection: ConversationProviderContributionSelectionJsonSchema,
      stopRequest: input.stopRequest,
      overlapSafety: {
        type: 'string',
        enum: ['safe', 'providerExclusive', 'destructive'],
      },
      acceptedPossibleLoss: input.acceptedPossibleLoss,
    },
    required: [
      'predecessorCheckpointedPollInvocation',
      'transportOrigin',
      'providerContributionSelection',
      'stopRequest',
      'overlapSafety',
      'acceptedPossibleLoss',
    ],
    additionalProperties: false,
  };
}

const PENDING_OLD_TRANSPORT_STOP_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_TRANSFER_OR_DELETE_SCHEMA,
  acceptedPossibleLoss: BOOLEAN_SCHEMA,
});

const PENDING_OLD_TRANSPORT_STOP_TRANSFER_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_TRANSFER_SCHEMA,
  acceptedPossibleLoss: BOOLEAN_SCHEMA,
});

const PENDING_OLD_TRANSPORT_STOP_DELETE_UNACCEPTED_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_DELETE_SCHEMA,
  acceptedPossibleLoss: { type: 'boolean', const: false },
});

const PENDING_OLD_TRANSPORT_STOP_DELETE_ACCEPTED_SCHEMA = pendingOldTransportStopSchema({
  predecessorCheckpointedPollInvocation: CHECKPOINTED_POLL_INVOCATION_BASIS_SCHEMA,
  stopRequest: OLD_TRANSPORT_STOP_REQUEST_DELETE_SCHEMA,
  acceptedPossibleLoss: { type: 'boolean', const: true },
});

const NULLABLE_PENDING_OLD_TRANSPORT_STOP_SCHEMA = nullable(PENDING_OLD_TRANSPORT_STOP_SCHEMA);

const CONNECTION_DELETION_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        deletionState: { type: 'string', const: 'none' },
        pendingOldTransportStop: {
          anyOf: [NULL_SCHEMA, PENDING_OLD_TRANSPORT_STOP_TRANSFER_SCHEMA],
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
          maximum: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS - 1,
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
          maximum: MAX_CONVERSATION_POLL_FAILURE_ATTEMPTS,
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
    providerPluginId: PluginIdJsonSchema,
    providerContributionSelection: ConversationProviderContributionSelectionJsonSchema,
    // This opaque JSON belongs to the selected provider setup contract. Its
    // bytes are bounded by the one canonical Account Collection row limit.
    providerSetupInput: JSON_VALUE_SCHEMA,
    credentialRef: nullable(QualifiedConnectedAccountRefJsonSchema),
    transportOrigin: PluginMachineExecutionOriginV1JsonSchema,
    transport: CONNECTION_TRANSPORT_SCHEMA,
    overlapSafety: { type: 'string', enum: ['safe', 'providerExclusive', 'destructive'] },
    replayContinuity: { type: 'string', enum: ['checkpointed', 'sessionBound', 'none'] },
    // Provider setup validates the exact unit and bounded template before this
    // private connection snapshot is written. These facts are re-read by the
    // single custody/pairing paths; list/read never project either one.
    outboundTextLimit: {
      type: 'object',
      properties: {
        maximum: POSITIVE_SAFE_INTEGER_SCHEMA,
        unit: { type: 'string', enum: [...CONVERSATION_OUTBOUND_TEXT_UNITS_V1] },
      },
      required: ['maximum', 'unit'],
      additionalProperties: false,
    },
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
    maximumObservationAgeMs: {
      type: 'integer',
      minimum: MIN_CONVERSATION_OBSERVATION_AGE_MS,
      maximum: MAX_CONVERSATION_OBSERVATION_AGE_MS,
    },
    // Optional for predecessor rows. A widened observation-age policy writes
    // this one connection-local replay floor; it never stores ingress bodies
    // or per-occurrence tombstones.
    observationAgeExpansionFloorOccurredAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
  },
  required: [
    'providerPluginId',
    'providerContributionSelection',
    'providerSetupInput',
    'credentialRef',
    'transportOrigin',
    'transport',
    'overlapSafety',
    'replayContinuity',
    'outboundTextLimit',
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
    'maximumObservationAgeMs',
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
    endpoint: RESOLVED_ENDPOINT_SCHEMA,
    target: ConversationBindingTargetV1JsonSchema,
    allowedPrincipalIds: {
      type: 'array',
      minItems: 1,
      maxItems: 256,
      items: PRINCIPAL_ID_SCHEMA,
    },
    allowBotSenders: BOOLEAN_SCHEMA,
    inputMode: { type: 'string', enum: [...CONVERSATION_BINDING_INPUT_MODES_V1] },
    inboundDebounceMs: { type: 'integer', minimum: 0, maximum: 5_000 },
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
    // `/answer` freezes only the admitted indexed transport tuple. The
    // canonical Session Action remains the owner of live-question membership,
    // choice labels, requiredness, and answer semantics.
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
    // rotation request. New obligations freeze the binding-owned recipe and
    // prompt before any Session effect so a later edit cannot redirect a
    // replay. The recipe remains Session-authoring-owned JSON.
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
    executionOrigin: PluginMachineExecutionOriginV1JsonSchema,
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
  ],
};

const INGRESS_TERMINAL_DISPOSITION_SCHEMA = {
  type: 'string',
  enum: [
    'admitted',
    'rejected',
    'suppressed',
    'pairingConsumed',
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
    censusId: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    target: nullable(FROZEN_INGRESS_TARGET_SCHEMA),
    sourceAuthority: {
      type: 'object',
      properties: {
        connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
        // Provider Event obligations are connection-owned. Binding-owned
        // Session/Automation obligations retain their existing exact fence.
        bindingRevision: nullable(POSITIVE_SAFE_INTEGER_SCHEMA),
        bindingAuthorityEpoch: nullable(POSITIVE_SAFE_INTEGER_SCHEMA),
      },
      required: ['connectionAuthorityEpoch', 'bindingRevision', 'bindingAuthorityEpoch'],
      additionalProperties: false,
    },
    lifecycle: {
      oneOf: [
        ...(['debounceDue', 'ready', 'attempting', 'retryDue', 'blocked', 'terminal'] as const)
          .map((phase) => ({
            type: 'object' as const,
            properties: {
              phase: { type: 'string' as const, const: phase },
              attemptCount: { type: 'integer' as const, minimum: 0, maximum: MAX_CONVERSATION_DELIVERY_ATTEMPTS },
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
    disposition: nullable(INGRESS_TERMINAL_DISPOSITION_SCHEMA),
    nonAdmission: INGRESS_NON_ADMISSION_SCHEMA,
  },
  required: [
    'occurrenceIds',
    'censusId',
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
            properties: { phase: { type: 'string', enum: ['debounceDue', 'ready', 'attempting', 'retryDue', 'blocked'] } },
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

/**
 * The ingress owner sorts this exact set by printable-ASCII binding ID before
 * its one immutable write. JSON Schema cannot express that ordering relation,
 * so the owner-local normalizer remains the correspondence authority.
 */
const INGRESS_CENSUS_MATCHED_BINDING_SCHEMA = {
  type: 'object',
  properties: {
    bindingId: BINDING_ID_SCHEMA,
    bindingRevision: POSITIVE_SAFE_INTEGER_SCHEMA,
    bindingAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
  },
  required: ['bindingId', 'bindingRevision', 'bindingAuthorityEpoch'],
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
 * envelope the protocol already publishes without a body, plus one full
 * base64url HMAC-SHA256 digest of the admitted text.
 */
const INGRESS_CENSUS_COMPACTED_SCHEMA = {
  type: 'object',
  properties: {
    shell: ConversationAuthenticatedObservationShellV1JsonSchema,
    textDigest: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
    // A settled attention row remains independently visible until this
    // census's frozen horizon. Persist its exact identity here so retention
    // never needs an Account-wide reverse scan after discarding fan-out.
    retainedAttentionObligationRowIds: {
      type: 'array',
      items: OPAQUE_ROUTING_ROW_ID_SCHEMA,
    },
  },
  required: ['shell', 'textDigest', 'retainedAttentionObligationRowIds'],
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
const INGRESS_CENSUS_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    // Exactly one of the two carries the occurrence. The full ingress is
    // retained while any obligation can still consume its body; a settled unit
    // keeps only the body-free replay identity for the rest of its window.
    normalizedIngress: nullable(INGRESS_CENSUS_NORMALIZED_INGRESS_SCHEMA),
    compacted: nullable(INGRESS_CENSUS_COMPACTED_SCHEMA),
    phase: { type: 'string', enum: ['preparing', 'prepared'] },
    connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    maximumObservationAgeMs: {
      type: 'integer',
      minimum: MIN_CONVERSATION_OBSERVATION_AGE_MS,
      maximum: MAX_CONVERSATION_OBSERVATION_AGE_MS,
    },
    // Existing retained censuses predate checkpoint coverage. Omission remains
    // readable as uncovered; new census rows write an explicit null.
    checkpointCoveredAt: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
    conflict: nullable(INGRESS_CENSUS_CONFLICT_FACT_SCHEMA),
    // Existing retained censuses predate Event candidates. Omission reads as
    // no candidate; current writers always persist the explicit nullable arm.
    eventCandidate: nullable(ConversationIngressAutomationEventCandidateV1JsonSchema),
    matchedBindings: {
      type: 'array',
      minItems: 0,
      maxItems: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
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

const CHECKPOINT_PAYLOAD_SCHEMA = {
  type: 'object',
  properties: {
    authorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
    opaqueToken: JSON_VALUE_SCHEMA,
    lastOccurrenceId: nullable(OCCURRENCE_ID_SCHEMA),
    revision: POSITIVE_SAFE_INTEGER_SCHEMA,
    nextPollNotBeforeMs: nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA),
  },
  required: ['authorityEpoch', 'opaqueToken', 'lastOccurrenceId', 'revision', 'nextPollNotBeforeMs'],
  additionalProperties: false,
} satisfies PluginJsonSchema;

const PROJECTION_FRONTIER_PAYLOAD_SCHEMA = {
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

const INGRESS_OBLIGATION_ROW_CONSISTENCY_SCHEMA = {
  oneOf: [
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
 * A census is its own conflict authority. The strict pair means ordinary
 * census rows are false/null and the one monotonic mismatch fact is true/fact;
 * neither preparing nor prepared state can carry an ambiguous projection.
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
  ingressTargetKind?: 'session' | 'automation' | 'event';
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
    return input.ingressTargetKind === 'automation' || input.ingressTargetKind === 'event';
  }
  return true;
}

const STATE_RECORDS: readonly StateRecordDefinition[] = [
  {
    kind: CHANNEL_STATE_RECORD_KIND.connection,
    payload: CONNECTION_PAYLOAD_SCHEMA,
    rowIdSchema: CONNECTION_ID_SCHEMA,
    requiredProjectionFields: [CHANNEL_STATE_FIELD.connectionId],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
  },
  {
    kind: CHANNEL_STATE_RECORD_KIND.binding,
    payload: BINDING_PAYLOAD_SCHEMA,
    rowIdSchema: BINDING_ID_SCHEMA,
    requiredProjectionFields: [
      CHANNEL_STATE_FIELD.connectionId,
      CHANNEL_STATE_FIELD.bindingId,
    ],
    rowConsistency: NON_INGRESS_ATTENTION_ROW_CONSISTENCY_SCHEMA,
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

function isChannelStateJsonRecord(value: JsonValue | undefined): value is Readonly<Record<string, JsonValue>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Pure target-artifact migration for DATA-EU7. Generic Data owns all source
 * reads, target staging, index readiness, and the authoritative cutover; this
 * callback transforms only the logical census shape it owns.
 */
export function migrateChannelStateV1ToV2(
  value: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  if (value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.ingressCensus) {
    return value;
  }
  const payload = value.payload;
  if (!isChannelStateJsonRecord(payload)) {
    throw new Error('A V1 ingress census must contain an object payload.');
  }
  return {
    ...value,
    [CHANNEL_STATE_FIELD.attention]: false,
    payload: { ...payload, conflict: null, compacted: null },
  };
}

/**
 * One strict V2 Account Collection contract for all Channels configuration,
 * ingress, checkpoint, projection-frontier, and rotation state. Every row
 * family remains explicit; no later core phase gets an opaque escape hatch.
 */
export const CHANNEL_STATE_COLLECTION = defineAccountCollection({
  id: CHANNEL_STATE_COLLECTION_ID,
  schemaVersion: 2,
  readableSchemaVersions: [1],
  schema: {
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
      }) => ({
        properties: {
          [CHANNEL_STATE_FIELD.id]: rowIdSchema,
          [CHANNEL_STATE_FIELD.recordKind]: { type: 'string', const: kind },
          payload,
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
  },
  rowIdField: CHANNEL_STATE_FIELD.id,
  identityFields: [],
  serverReadable: [
    CHANNEL_STATE_FIELD.recordKind,
    CHANNEL_STATE_FIELD.version,
    CHANNEL_STATE_FIELD.connectionId,
    CHANNEL_STATE_FIELD.bindingId,
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
  migrations: [{
    id: 'channel-state-v1-to-v2',
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    migrate: migrateChannelStateV1ToV2,
  }],
  quota: {
    maxRowEncodedBytes: MAX_CHANNEL_STATE_ROW_BYTES,
    maxRowsByIndexPrefix: [
      {
        indexId: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.connection],
        maxRows: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
      },
      {
        indexId: CHANNEL_STATE_INDEX_ID.byKind,
        prefix: [CHANNEL_STATE_RECORD_KIND.binding],
        maxRows: MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
      },
    ],
  },
});

const DELIVERY_SOURCE_SCHEMA: PluginJsonSchema = {
  oneOf: [
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
          enum: ['pairing', 'newSession', 'approval', 'userAction', 'refusal', 'recovery'],
        },
      },
      required: ['kind', 'controlId', 'controlKind'],
      additionalProperties: false,
    },
  ],
};

/**
 * The one strict persisted route-authority union. The owning runtime correlates
 * its exact arm with the existing optional `binding-id`: connection-only rows
 * carry only their connection epoch; binding rows add binding revision/epoch.
 */
const DELIVERY_ROUTE_AUTHORITY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      type: 'object',
      properties: {
        connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
      },
      required: ['connectionAuthorityEpoch'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        connectionAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
        bindingRevision: POSITIVE_SAFE_INTEGER_SCHEMA,
        bindingAuthorityEpoch: POSITIVE_SAFE_INTEGER_SCHEMA,
      },
      required: [
        'connectionAuthorityEpoch',
        'bindingRevision',
        'bindingAuthorityEpoch',
      ],
      additionalProperties: false,
    },
  ],
};

const DELIVERY_ATTEMPT_ID_SCHEMA = nullable(boundedString(MAX_PLUGIN_ID_LENGTH));
const DELIVERY_STARTED_AT_SCHEMA = nullable(NON_NEGATIVE_SAFE_INTEGER_SCHEMA);
const DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA: PluginJsonSchema = {
  type: 'array',
  maxItems: MAX_CONVERSATION_DELIVERY_CHUNKS,
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
  maximum: MAX_CONVERSATION_DELIVERY_CHUNKS,
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
  startedAt: PluginJsonSchema;
  providerMessageIds: PluginJsonSchema;
  failedChunk: PluginJsonSchema;
  archiveRecovery: PluginJsonSchema;
}>): PluginJsonSchema {
  return {
    type: 'object',
    properties: {
      state: deliveryCustodyStateSchema(input.state),
      attemptId: input.attemptId,
      startedAt: input.startedAt,
      providerMessageIds: input.providerMessageIds,
      failedChunk: input.failedChunk,
      archiveRecovery: input.archiveRecovery,
    },
    required: [
      'state',
      'attemptId',
      'startedAt',
      'providerMessageIds',
      'failedChunk',
      'archiveRecovery',
    ],
  };
}

const DELIVERY_PAYLOAD_STATE_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    deliveryPayloadStateSchema({
      state: 'ready',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'retryDue',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'attempting',
      attemptId: boundedString(MAX_PLUGIN_ID_LENGTH),
      startedAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'delivered',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'notDelivered',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: DELIVERY_ARCHIVE_RECOVERY_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      // A currentness/policy suppression is a known no-effect terminal result,
      // so it neither invents provider evidence nor creates owner attention.
      state: 'suppressed',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'partial',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_CHUNK_INDEX_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'outcomeUnknown',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: ['resolvedAccepted', 'resolvedDiscarded'],
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_FAILED_CHUNK_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryPayloadStateSchema({
      state: 'connectionDeleted',
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
  ],
};

/**
 * Full delivery bytes may disappear only where the canonical
 * {@link isConversationDeliveryContentFree} predicate says the body is no
 * longer required: a content-free state that no owner-led archive retry can
 * still consume. The opaque HMAC proof lets a later source replay rejoin the
 * same structural custody row without restoring or exposing message content.
 * The body-free arm's `archiveRecovery` constraint is the schema-image of that
 * predicate's archive-retry exception, so schema admission and runtime
 * compaction share one body-required/body-free decision.
 */
const DELIVERY_PAYLOAD_CONTENT_RETENTION_SCHEMA: PluginJsonSchema = {
  oneOf: [
    {
      properties: {
        content: { type: 'string', minLength: 1, maxLength: MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES },
        contentFingerprint: nullable(OPAQUE_ROUTING_ROW_ID_SCHEMA),
      },
      required: ['content'],
    },
    {
      properties: {
        content: NULL_SCHEMA,
        contentFingerprint: OPAQUE_ROUTING_ROW_ID_SCHEMA,
        state: { type: 'string', enum: [...CONVERSATION_DELIVERY_CONTENT_FREE_STATES] },
        // Everything except the one recovery arm an owner can still unarchive
        // and resend; non-`notDelivered` states always carry null here. The
        // literal is tied to the protocol vocabulary rather than a positional
        // index, so reordering that const cannot silently flip this
        // schema-image of the canonical content-free predicate.
        archiveRecovery: nullable({
          type: 'string',
          const: 'ownerMustUnarchiveOrRebind' satisfies (typeof CONVERSATION_DELIVERY_ARCHIVE_RECOVERY_KINDS_V1)[number],
        }),
      },
      required: ['content', 'contentFingerprint', 'state', 'archiveRecovery'],
    },
  ],
};

const DELIVERY_PAYLOAD_SCHEMA: PluginJsonSchema = {
  type: 'object',
  properties: {
    source: DELIVERY_SOURCE_SCHEMA,
    routeAuthority: DELIVERY_ROUTE_AUTHORITY_SCHEMA,
    endpoint: RESOLVED_ENDPOINT_SCHEMA,
    content: nullable({ type: 'string', minLength: 1, maxLength: MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES }),
    contentFingerprint: nullable(OPAQUE_ROUTING_ROW_ID_SCHEMA),
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
    mentionPolicy: { type: 'string', enum: [...CONVERSATION_DELIVERY_MENTION_POLICIES_V1] },
    linkPreviewPolicy: { type: 'string', enum: [...CONVERSATION_DELIVERY_LINK_PREVIEW_POLICIES_V1] },
    state: {
      type: 'string',
      enum: [...CONVERSATION_DELIVERY_CUSTODY_STATES],
    },
    attemptCount: {
      type: 'integer',
      minimum: 0,
      maximum: MAX_CONVERSATION_DELIVERY_ATTEMPTS,
    },
    attemptId: DELIVERY_ATTEMPT_ID_SCHEMA,
    startedAt: DELIVERY_STARTED_AT_SCHEMA,
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
    'mentionPolicy',
    'linkPreviewPolicy',
    'state',
    'attemptCount',
    'attemptId',
    'startedAt',
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
  attention: boolean;
  attemptId: PluginJsonSchema;
  startedAt: PluginJsonSchema;
  providerMessageIds: PluginJsonSchema;
  failedChunk: PluginJsonSchema;
  archiveRecovery: PluginJsonSchema;
  hasRetryNotBefore?: boolean;
}>): PluginJsonSchema {
  return {
    type: 'object',
    properties: {
      ...DELIVERY_ROW_COMMON_PROPERTIES,
      ...(input.hasRetryNotBefore === true
        ? { [CHANNEL_DELIVERIES_FIELD.retryNotBefore]: NON_NEGATIVE_SAFE_INTEGER_SCHEMA }
        : {}),
      [CHANNEL_DELIVERIES_FIELD.terminal]: { type: 'boolean', const: input.terminal },
      [CHANNEL_DELIVERIES_FIELD.attention]: { type: 'boolean', const: input.attention },
      payload: deliveryPayloadStateSchema(input),
    },
    required: [
      ...DELIVERY_ROW_REQUIRED,
      ...(input.hasRetryNotBefore === true ? [CHANNEL_DELIVERIES_FIELD.retryNotBefore] : []),
    ],
    additionalProperties: false,
  };
}

const DELIVERY_ROW_STATE_CONSISTENCY_SCHEMA: PluginJsonSchema = {
  oneOf: [
    deliveryRowStateSchema({
      state: 'ready',
      terminal: false,
      attention: false,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'retryDue',
      terminal: false,
      attention: false,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
      hasRetryNotBefore: true,
    }),
    deliveryRowStateSchema({
      state: 'attempting',
      terminal: false,
      attention: false,
      attemptId: boundedString(MAX_PLUGIN_ID_LENGTH),
      startedAt: NON_NEGATIVE_SAFE_INTEGER_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'delivered',
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'notDelivered',
      terminal: true,
      attention: true,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: DELIVERY_ARCHIVE_RECOVERY_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'suppressed',
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'partial',
      terminal: true,
      attention: true,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_CHUNK_INDEX_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'outcomeUnknown',
      terminal: true,
      attention: true,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: ['resolvedAccepted', 'resolvedDiscarded'],
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: DELIVERY_FAILED_CHUNK_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
    }),
    deliveryRowStateSchema({
      state: 'connectionDeleted',
      terminal: true,
      attention: false,
      attemptId: NULL_SCHEMA,
      startedAt: NULL_SCHEMA,
      providerMessageIds: EMPTY_DELIVERY_PROVIDER_MESSAGE_IDS_SCHEMA,
      failedChunk: NULL_SCHEMA,
      archiveRecovery: NULL_SCHEMA,
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
  schemaVersion: 1,
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
      id: CHANNEL_DELIVERIES_INDEX_ID.byRetryDue,
      fields: [
        { field: CHANNEL_DELIVERIES_FIELD.terminal, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.retryNotBefore, direction: 'asc' },
        { field: CHANNEL_DELIVERIES_FIELD.id, direction: 'asc' },
      ],
    },
  ],
  uiQueries: [],
  relations: [],
  // No readable schema version below the current one, so there is no
  // ordered migration edge to declare and none to implement in the
  // executable half.
  migrations: [],
  quota: { maxRowEncodedBytes: MAX_CHANNEL_DELIVERY_ROW_BYTES },
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
