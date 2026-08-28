import {
  PluginError,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { PluginMachineExecutionOriginV1 } from '@happier-dev/plugin-sdk/actions';
import {
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginAccountCollectionForDefinition,
} from '@happier-dev/plugin-sdk/collections';
import {
  CONVERSATION_BINDING_INPUT_MODES_V1,
  ConversationBindingV1Schema,
  ConversationConnectionIdV1Schema,
  ConversationProviderConnectionStopInputV1Schema,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  conversationBindingInputModesForEndpointV1,
  isConversationBindingInputModeDeliverableV1,
  type ConversationBindingInputModeV1,
  type ConversationBindingTargetV1,
  type ConversationBindingV1,
  type ConversationProviderConnectionStopInputV1,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
  isCanonicalChannelStateRecordIdentity,
  type PersistedConversationProviderContributionSelection,
} from './collections.js';
import {
  freezeConversationPendingOldTransportStop,
  transitionConversationConnection,
  type ConversationCheckpointedPollInvocationBasisV1,
  type ConversationConnectionEnabledResultV1,
  type ConversationConnectionLifecycleStateV1,
  type ConversationPendingOldTransportStopV1,
  type ConversationConnectionProviderReadinessV1,
} from './connectionLifecycle.js';
import {
  projectConversationConnectionPollFailureAttention,
  type ConversationConnectionPollFailureAttentionV1,
} from './connectionPollFailure.js';
import { readPersistedConversationConnectionPollFailure } from './connectionPollFailurePersistence.js';
import {
  revokeConversationBindingPrincipals,
  transitionConversationBinding,
  type ConversationBindingStateV1,
} from './bindingTransition.js';

const MANAGEMENT_SUMMARY_MAX_CODE_POINTS = 28;

export type ChannelStateJsonRecord = Readonly<Record<string, JsonValue>>;
export type ChannelStateRow = Readonly<{
  rowId: string;
  revision: number;
  value: ChannelStateJsonRecord;
}>;
export type ChannelStateBindingCollection = Pick<
  PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>,
  'get' | 'query' | 'batch'
>;

export type ConversationConnectionUpdateRow = Readonly<{
  payload: ChannelStateJsonRecord;
  lifecycle: ConversationConnectionLifecycleStateV1;
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  providerSetupInput: JsonValue;
  routingIdentityKey: string;
  transportOrigin: PluginMachineExecutionOriginV1;
}>;

export type ConversationConnectionLifecycleMutationResult = Readonly<{
  kind: 'updated' | 'unchanged';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
}>;

export type ConversationBindingUpdateState = ConversationBindingV1;

export type ConversationBindingUpdateRow = Readonly<{
  payload: ChannelStateJsonRecord;
  binding: ConversationBindingUpdateState;
}>;

export type ConversationBindingManagementRow = Readonly<{
  bindingId: string;
  revision: number;
  connectionId: string;
  endpoint: Readonly<{
    audience: 'direct' | 'shared';
    label?: string;
  }>;
  target: Readonly<{
    kind: 'session' | 'automation';
    summary: string;
  }>;
  inputMode: 'directMentionsOnly' | 'addressedMessages' | 'allAllowedMessages';
  deliveryMode: 'repliesOnly' | 'mirrorSession' | 'finalResult' | 'none';
  /**
   * The owner-configured chat-approval policy. `enabled` is the only control:
   * an enabled binding admits `/allow` and `/deny` from its admitted approver
   * set through the canonical Session permission mediation owner.
   */
  approval:
    | Readonly<{ kind: 'notApplicable' }>
    | Readonly<{ kind: 'off' }>
    | Readonly<{
      kind: 'enabled';
      maximumScope: 'request' | 'session';
    }>;
  enabled: boolean;
  deletionState: 'none' | 'finalizingDelete';
}>;

/**
 * The minimal retained relation between a host-stamped Session and existing
 * outward-delivery custody. It deliberately does not project endpoint,
 * principal, policy, or provider data.
 */
export type ConversationSessionBindingDeliveryTarget = Readonly<{
  bindingId: string;
  connectionId: string;
}>;

/**
 * The direct-Account counterpart of the safe connection Resource projection.
 * It deliberately contains no provider configuration, credential, endpoint,
 * routing, or raw delivery data.
 */
export type ConversationConnectionManagementRow = Readonly<{
  connectionId: string;
  revision: number;
  providerPluginId: string;
  selectedMachineId: string;
  selectedTransport: 'checkpointedPull' | 'socket' | 'durablePush';
  integrationPrincipalLabel?: string;
  /**
   * The input modes this connection's provider proved it can deliver on a
   * shared endpoint. Absent means the provider declared no restriction.
   */
  sharedEndpointInputModes?: readonly ConversationBindingInputModeV1[];
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  maximumObservationAgeMs: number;
  attention: Readonly<{
    historyGap: Readonly<{
      reportedAt: number;
      reason: 'providerHistoryUnavailable' | 'applicationAdmissionLost';
    }> | null;
    providerReadiness: ConversationConnectionProviderReadinessV1;
    ingressConflict: ConversationIngressConflictAttention;
    pollFailure: ConversationConnectionPollFailureAttentionV1 | null;
    bestEffortBeforeDurableAdmission: boolean;
    oldTransportStopUnconfirmed: boolean;
    acceptedPossibleLoss: boolean;
  }>;
}>;

/** Content-free occurrence-conflict fact safe for connection management UI. */
export type ConversationIngressConflictAttention = Readonly<{
  kind: 'occurrenceEvidenceMismatch';
}> | null;

export type ConversationIngressBlockedAttentionRow = Readonly<{
  kind: 'blocked';
  obligationId: string;
  revision: number;
  connectionId: string;
  bindingId: string;
  attemptCount: number;
  updatedAt: number;
}>;

export type ConversationIngressTerminalAttentionRow = Readonly<{
  kind: 'terminal';
  obligationId: string;
  revision: number;
  connectionId: string;
  bindingId: string;
  updatedAt: number;
}>;

export type ConversationIngressOccurrenceConflictAttentionRow = Readonly<{
  kind: 'occurrenceConflict';
  censusId: string;
  revision: number;
  connectionId: string;
}>;

export type ConversationIngressAttentionRow =
  | ConversationIngressBlockedAttentionRow
  | ConversationIngressTerminalAttentionRow
  | ConversationIngressOccurrenceConflictAttentionRow;

export type ConversationBindingEnablementResult = Readonly<{
  kind: 'updated' | 'unchanged';
  bindingId: string;
  revision: number;
  authorityEpoch: number;
}>;

function policyError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

export function isChannelStateJsonRecord(value: unknown): value is ChannelStateJsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Narrows one host-validated Channel-state Collection row without restating a
 * record-kind decoder. Individual row-family owners still validate identity
 * and payload semantics after this shared no-throw envelope boundary.
 */
export function asChannelStateRow(row: Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
}> | null | undefined): ChannelStateRow | undefined {
  return row !== null && row !== undefined && isChannelStateJsonRecord(row.value)
    ? { rowId: row.rowId, revision: row.revision, value: row.value }
    : undefined;
}

export function ownChannelStateValue(
  record: ChannelStateJsonRecord,
  key: string,
): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function assertCurrent(input: Readonly<{
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>, operation: 'channels_binding_set_enabled' | 'channels_binding_update' | 'channels_connection_update' | 'channels_connection_set_enabled' = 'channels_binding_set_enabled'): void {
  input.assertCurrent?.();
  if (!input.signal?.aborted) return;
  throw policyError(
    `${operation}_cancelled`,
    operation === 'channels_binding_set_enabled' || operation === 'channels_binding_update'
      ? 'Binding policy update was cancelled before its Account mutation completed.'
      : 'Connection policy update was cancelled before its Account mutation completed.',
    true,
  );
}

function readPersistedTransportOrigin(value: JsonValue | undefined): PluginMachineExecutionOriginV1 {
  if (!isChannelStateJsonRecord(value)) {
    throw policyError('channels_connection_update_corrupt', 'Connection update target has an invalid persisted transport origin.');
  }
  const materializationRef = ownChannelStateValue(value, 'materializationRef');
  const serverIdentityId = ownChannelStateValue(value, 'serverIdentityId');
  const pluginId = isChannelStateJsonRecord(materializationRef)
    ? ownChannelStateValue(materializationRef, 'pluginId')
    : undefined;
  const machineId = isChannelStateJsonRecord(materializationRef)
    ? ownChannelStateValue(materializationRef, 'machineId')
    : undefined;
  const materializationId = isChannelStateJsonRecord(materializationRef)
    ? ownChannelStateValue(materializationRef, 'materializationId')
    : undefined;
  if (typeof serverIdentityId !== 'string'
    || !isChannelStateJsonRecord(materializationRef)
    || typeof pluginId !== 'string'
    || typeof machineId !== 'string'
    || typeof materializationId !== 'string') {
    throw policyError('channels_connection_update_corrupt', 'Connection update target has an invalid persisted transport origin.');
  }
  return {
    serverIdentityId,
    materializationRef: { pluginId, machineId, materializationId },
  };
}

/**
 * Collection admission owns the canonical identifier grammar. This reader
 * only rejects absent or structurally corrupt durable facts before a caller
 * could select a provider operation from them.
 */
function readPersistedProviderContributionSelection(
  value: JsonValue | undefined,
): PersistedConversationProviderContributionSelection {
  if (!isChannelStateJsonRecord(value)) {
    throw policyError(
      'channels_connection_update_corrupt',
      'Connection update target has an invalid persisted provider contribution selection.',
    );
  }
  const contributionId = ownChannelStateValue(value, 'contributionId');
  const immutableGenerationId = ownChannelStateValue(value, 'immutableGenerationId');
  if (typeof contributionId !== 'string'
    || contributionId.length === 0
    || typeof immutableGenerationId !== 'string'
    || immutableGenerationId.length === 0) {
    throw policyError(
      'channels_connection_update_corrupt',
      'Connection update target has an invalid persisted provider contribution selection.',
    );
  }
  return { contributionId, immutableGenerationId };
}

function readPersistedCheckpointedPollInvocationBasis(
  value: JsonValue | undefined,
): ConversationCheckpointedPollInvocationBasisV1 {
  if (!isChannelStateJsonRecord(value)) {
    throw policyError(
      'channels_connection_update_corrupt',
      'Connection update target has an invalid predecessor checkpointed-poll invocation.',
    );
  }
  const connectionRevision = ownChannelStateValue(value, 'connectionRevision');
  const authorityEpoch = ownChannelStateValue(value, 'authorityEpoch');
  if (typeof connectionRevision !== 'number'
    || !Number.isSafeInteger(connectionRevision)
    || connectionRevision < 1
    || typeof authorityEpoch !== 'number'
    || !Number.isSafeInteger(authorityEpoch)
    || authorityEpoch < 1) {
    throw policyError(
      'channels_connection_update_corrupt',
      'Connection update target has an invalid predecessor checkpointed-poll revision or authority epoch.',
    );
  }
  return {
    connectionRevision,
    authorityEpoch,
    transportOrigin: readPersistedTransportOrigin(ownChannelStateValue(value, 'transportOrigin')),
  };
}

function readPersistedPendingOldTransportStop(
  value: JsonValue | undefined,
): ConversationPendingOldTransportStopV1 | null {
  if (value === null) return null;
  if (!isChannelStateJsonRecord(value)) {
    throw policyError('channels_connection_update_corrupt', 'Connection update target has an invalid old-stop custody slot.');
  }
  const transportOrigin = readPersistedTransportOrigin(ownChannelStateValue(value, 'transportOrigin'));
  const providerContributionSelection = readPersistedProviderContributionSelection(
    ownChannelStateValue(value, 'providerContributionSelection'),
  );
  const stopRequest = ownChannelStateValue(value, 'stopRequest');
  const predecessorCheckpointedPollInvocation = readPersistedCheckpointedPollInvocationBasis(
    ownChannelStateValue(value, 'predecessorCheckpointedPollInvocation'),
  );
  const overlapSafety = ownChannelStateValue(value, 'overlapSafety');
  const acceptedPossibleLoss = ownChannelStateValue(value, 'acceptedPossibleLoss');
  if (stopRequest === undefined
    || (overlapSafety !== 'safe'
      && overlapSafety !== 'providerExclusive'
      && overlapSafety !== 'destructive')
    || typeof acceptedPossibleLoss !== 'boolean') {
    throw policyError('channels_connection_update_corrupt', 'Connection update target has an incomplete old-stop custody slot.');
  }
  let parsedStopRequest: ConversationProviderConnectionStopInputV1;
  try {
    parsedStopRequest = ConversationProviderConnectionStopInputV1Schema.parse(stopRequest);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_update_corrupt',
      message: 'Connection update target has an invalid frozen stop request.',
    }, { cause });
  }
  if (parsedStopRequest.reason === 'disable') {
    throw policyError('channels_connection_update_corrupt', 'Connection update target retained an ordinary-disable stop request.');
  }
  return freezeConversationPendingOldTransportStop({
    predecessorCheckpointedPollInvocation,
    transportOrigin,
    providerContributionSelection,
    stopRequest: parsedStopRequest,
    overlapSafety,
    acceptedPossibleLoss,
  });
}

/**
 * Account Collections validate the complete connection record before this
 * owner sees it. These checks only select the target row and narrow the six
 * lifecycle fields that the shared transition is allowed to change; provider,
 * transport, pairing, and reservation authority remain opaque and retained.
 */
export function readConversationConnectionUpdateRow(input: Readonly<{
  row: ChannelStateRow;
  connectionId: string;
}>): ConversationConnectionUpdateRow {
  const { row, connectionId } = input;
  const value = row.value;
  const payload = ownChannelStateValue(value, 'payload');
  const rowConnectionId = ownChannelStateValue(value, CHANNEL_STATE_FIELD.connectionId);
  if (!isCanonicalChannelStateRecordIdentity({
    rowId: row.rowId,
    recordKind: CHANNEL_STATE_RECORD_KIND.connection,
    connectionId,
  })
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection
    || rowConnectionId !== connectionId
    || !isChannelStateJsonRecord(payload)) {
    throw policyError('channels_connection_update_corrupt', 'Connection update target is not a canonical retained connection row.');
  }

  const authorityEpoch = ownChannelStateValue(payload, 'authorityEpoch');
  const enabled = ownChannelStateValue(payload, 'enabled');
  const deletionState = ownChannelStateValue(payload, 'deletionState');
  const overlapSafety = ownChannelStateValue(payload, 'overlapSafety');
  const providerPluginId = ownChannelStateValue(payload, 'providerPluginId');
  const providerContributionSelection = readPersistedProviderContributionSelection(
    ownChannelStateValue(payload, 'providerContributionSelection'),
  );
  const providerSetupInput = ownChannelStateValue(payload, 'providerSetupInput');
  const routingIdentityKey = ownChannelStateValue(payload, 'routingIdentityKey');
  const pendingOldTransportStop = readPersistedPendingOldTransportStop(
    ownChannelStateValue(payload, 'pendingOldTransportStop'),
  );
  const historyGap = ownChannelStateValue(payload, 'historyGap');
  // Older retained V1 rows predate generic readiness attention. New writes
  // always materialize the canonical null/attention field, while readers
  // interpret the supported predecessor shape as no current attention.
  const providerReadiness = ownChannelStateValue(payload, 'providerReadiness') ?? null;
  const pollFailure = readPersistedConversationConnectionPollFailure(
    ownChannelStateValue(payload, 'pollFailure'),
  );
  const maximumObservationAgeMs = ownChannelStateValue(payload, 'maximumObservationAgeMs');
  const observationAgeExpansionFloorOccurredAt = ownChannelStateValue(
    payload,
    'observationAgeExpansionFloorOccurredAt',
  );
  if (typeof authorityEpoch !== 'number'
    || !Number.isSafeInteger(authorityEpoch)
    || authorityEpoch < 1
    || typeof enabled !== 'boolean'
    || (deletionState !== 'none'
      && deletionState !== 'pendingStopReconciliation'
      && deletionState !== 'finalizingDelete')
    || (overlapSafety !== 'safe'
      && overlapSafety !== 'providerExclusive'
      && overlapSafety !== 'destructive')
    || typeof providerPluginId !== 'string'
    || providerSetupInput === undefined
    || typeof routingIdentityKey !== 'string'
    || historyGap === undefined
    || (historyGap !== null && !isChannelStateJsonRecord(historyGap))
    || (providerReadiness !== null && !isChannelStateJsonRecord(providerReadiness))
    || pollFailure === undefined
    || typeof maximumObservationAgeMs !== 'number'
    || !Number.isSafeInteger(maximumObservationAgeMs)
    || maximumObservationAgeMs < MIN_CONVERSATION_OBSERVATION_AGE_MS
    || maximumObservationAgeMs > MAX_CONVERSATION_OBSERVATION_AGE_MS
    || (observationAgeExpansionFloorOccurredAt !== undefined
      && (typeof observationAgeExpansionFloorOccurredAt !== 'number'
        || !Number.isSafeInteger(observationAgeExpansionFloorOccurredAt)
        || observationAgeExpansionFloorOccurredAt < 0))) {
    throw policyError('channels_connection_update_corrupt', 'Connection update target has an invalid lifecycle payload.');
  }
  return {
    payload,
    providerPluginId,
    providerContributionSelection,
    providerSetupInput,
    routingIdentityKey,
    transportOrigin: readPersistedTransportOrigin(ownChannelStateValue(payload, 'transportOrigin')),
    lifecycle: {
      authorityEpoch,
      enabled,
      deletionState,
      overlapSafety,
      pendingOldTransportStop,
      // The Collection schema validates the exact history-gap variants. This
      // owner deliberately does not reparse provider evidence it cannot own.
      historyGap: historyGap as ConversationConnectionLifecycleStateV1['historyGap'],
      providerReadiness: providerReadiness as ConversationConnectionLifecycleStateV1['providerReadiness'],
      pollFailure,
      maximumObservationAgeMs,
      observationAgeExpansionFloorOccurredAt: observationAgeExpansionFloorOccurredAt ?? null,
    },
  };
}

/** Rebuilds the one retained connection row from the shared lifecycle state. */
export function withConversationConnectionLifecycle(input: Readonly<{
  row: ChannelStateRow;
  current: ConversationConnectionUpdateRow;
  lifecycle: ConversationConnectionLifecycleStateV1;
  updatedAt?: number;
}>): ChannelStateJsonRecord {
  return {
    ...input.row.value,
    [CHANNEL_STATE_FIELD.updatedAt]: input.updatedAt ?? Date.now(),
    payload: {
      ...input.current.payload,
      authorityEpoch: input.lifecycle.authorityEpoch,
      enabled: input.lifecycle.enabled,
      deletionState: input.lifecycle.deletionState,
      overlapSafety: input.lifecycle.overlapSafety,
      pendingOldTransportStop: input.lifecycle.pendingOldTransportStop,
      historyGap: input.lifecycle.historyGap,
      providerReadiness: input.lifecycle.providerReadiness,
      pollFailure: input.lifecycle.pollFailure,
      maximumObservationAgeMs: input.lifecycle.maximumObservationAgeMs,
      ...(input.lifecycle.observationAgeExpansionFloorOccurredAt === null
        ? {}
        : { observationAgeExpansionFloorOccurredAt: input.lifecycle.observationAgeExpansionFloorOccurredAt }),
    },
  } satisfies ChannelStateJsonRecord;
}

/**
 * The provider-authenticated shared-endpoint delivery truth, as persisted.
 * A row that carries none leaves the capability absent, which the binding
 * policy owner reads as "the provider declared no restriction".
 */
export function readConversationConnectionSharedEndpointInputModes(
  payload: ChannelStateJsonRecord,
): readonly ConversationBindingInputModeV1[] | undefined {
  const declared = ownChannelStateValue(payload, 'sharedEndpointInputModes');
  if (declared === undefined) return undefined;
  if (!Array.isArray(declared)) {
    throw policyError(
      'channels_connection_management_row_invalid',
      'The Channels connection index received an invalid shared-endpoint input-mode capability.',
    );
  }
  const modes = CONVERSATION_BINDING_INPUT_MODES_V1.filter((mode) => declared.includes(mode));
  if (modes.length !== declared.length) {
    throw policyError(
      'channels_connection_management_row_invalid',
      'The Channels connection index received an invalid shared-endpoint input-mode capability.',
    );
  }
  return modes;
}

/** One writer-side capability gate for every resulting enabled binding policy. */
export function assertConversationBindingInputModeIsDeliverable(input: Readonly<{
  audience: ConversationBindingV1['endpoint']['audience'];
  inputMode: ConversationBindingInputModeV1;
  sharedEndpointInputModes: readonly ConversationBindingInputModeV1[] | undefined;
  operation: 'channels_binding_create' | 'channels_binding_update' | 'channels_binding_set_enabled';
}>): void {
  if (isConversationBindingInputModeDeliverableV1({
    audience: input.audience,
    inputMode: input.inputMode,
    ...(input.sharedEndpointInputModes === undefined
      ? {}
      : { sharedEndpointInputModes: input.sharedEndpointInputModes }),
  })) return;
  throw new PluginError({
    code: `${input.operation}_input_mode_unsupported`,
    message: 'The selected integration cannot deliver this incoming message policy for a shared conversation.',
    details: {
      inputMode: input.inputMode,
      deliverableInputModes: [...conversationBindingInputModesForEndpointV1({
        audience: input.audience,
        ...(input.sharedEndpointInputModes === undefined
          ? {}
          : { sharedEndpointInputModes: input.sharedEndpointInputModes }),
      })],
    },
  });
}

/** The connection revision serializes only changes to enabled delivery demand. */
export function hasConversationBindingDeliveryDemandChanged(
  current: ConversationBindingStateV1,
  next: ConversationBindingStateV1,
): boolean {
  if (current.enabled !== next.enabled) return true;
  if (!next.enabled) return false;
  return current.endpoint.audience !== next.endpoint.audience
    || current.inputMode !== next.inputMode;
}

function projectConversationConnectionManagementRow(
  row: ChannelStateRow,
): ConversationConnectionManagementRow {
  let current: ConversationConnectionUpdateRow;
  try {
    current = readConversationConnectionUpdateRow({ row, connectionId: row.rowId });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_connection_management_row_invalid',
      message: 'The Channels connection index received an invalid connection row.',
    }, { cause });
  }
  const transport = ownChannelStateValue(current.payload, 'transport');
  const replayContinuity = ownChannelStateValue(current.payload, 'replayContinuity');
  const integrationPrincipal = ownChannelStateValue(current.payload, 'integrationPrincipal');
  const sharedEndpointInputModes = readConversationConnectionSharedEndpointInputModes(current.payload);
  const selectedTransport = isChannelStateJsonRecord(transport)
    ? ownChannelStateValue(transport, 'kind')
    : undefined;
  const integrationPrincipalLabel = isChannelStateJsonRecord(integrationPrincipal)
    ? ownChannelStateValue(integrationPrincipal, 'label')
    : undefined;
  if ((selectedTransport !== 'checkpointedPull'
      && selectedTransport !== 'socket'
      && selectedTransport !== 'durablePush')
    || (replayContinuity !== 'checkpointed'
      && replayContinuity !== 'sessionBound'
      && replayContinuity !== 'none')
    || (integrationPrincipalLabel !== undefined && typeof integrationPrincipalLabel !== 'string')) {
    throw policyError(
      'channels_connection_management_row_invalid',
      'The Channels connection index received an invalid management projection.',
    );
  }
  const historyGap = current.lifecycle.historyGap === null
    ? null
    : {
      reportedAt: current.lifecycle.historyGap.reportedAt,
      reason: current.lifecycle.historyGap.reason,
    };
  const pollFailure = projectConversationConnectionPollFailureAttention(current.lifecycle.pollFailure);
  const providerReadiness = current.lifecycle.providerReadiness === null
    ? null
    : {
      code: current.lifecycle.providerReadiness.code,
      ...(current.lifecycle.providerReadiness.diagnostic === undefined
        ? {}
        : { diagnostic: current.lifecycle.providerReadiness.diagnostic }),
    };
  return {
    connectionId: row.rowId,
    revision: row.revision,
    providerPluginId: current.providerPluginId,
    selectedMachineId: current.transportOrigin.materializationRef.machineId,
    selectedTransport,
    ...(integrationPrincipalLabel === undefined ? {} : { integrationPrincipalLabel }),
    ...(sharedEndpointInputModes === undefined ? {} : { sharedEndpointInputModes }),
    authorityEpoch: current.lifecycle.authorityEpoch,
    enabled: current.lifecycle.enabled,
    deletionState: current.lifecycle.deletionState,
    maximumObservationAgeMs: current.lifecycle.maximumObservationAgeMs,
    attention: {
      historyGap,
      providerReadiness,
      ingressConflict: null,
      pollFailure,
      bestEffortBeforeDurableAdmission: selectedTransport === 'socket'
        && replayContinuity === 'sessionBound',
      oldTransportStopUnconfirmed: current.lifecycle.pendingOldTransportStop !== null,
      acceptedPossibleLoss: current.lifecycle.pendingOldTransportStop?.acceptedPossibleLoss === true,
    },
  };
}

function projectConversationIngressConflictAttention(input: Readonly<{
  row: ChannelStateRow;
  connectionId: string;
}>): Exclude<ConversationIngressConflictAttention, null> {
  const value = input.row.value;
  const payload = ownChannelStateValue(value, 'payload');
  const id = ownChannelStateValue(value, CHANNEL_STATE_FIELD.id);
  const recordKind = ownChannelStateValue(value, CHANNEL_STATE_FIELD.recordKind);
  const connectionId = ownChannelStateValue(value, CHANNEL_STATE_FIELD.connectionId);
  const bindingId = ownChannelStateValue(value, CHANNEL_STATE_FIELD.bindingId);
  const attention = ownChannelStateValue(value, CHANNEL_STATE_FIELD.attention);
  const conflict = isChannelStateJsonRecord(payload)
    ? ownChannelStateValue(payload, 'conflict')
    : undefined;
  if (
    id !== input.row.rowId
    || recordKind !== CHANNEL_STATE_RECORD_KIND.ingressCensus
    || connectionId !== input.connectionId
    || (bindingId !== undefined && bindingId !== null)
    || attention !== true
    || !isChannelStateJsonRecord(conflict)
    || conflict.kind !== 'occurrenceEvidenceMismatch'
    || Object.keys(conflict).length !== 1
    || !Number.isSafeInteger(input.row.revision)
    || input.row.revision < 1
  ) {
    throw policyError(
      'channels_connection_management_ingress_conflict_invalid',
      'The Channels connection conflict index returned a non-canonical ingress census conflict.',
    );
  }
  return { kind: 'occurrenceEvidenceMismatch' };
}

async function readConversationConnectionIngressConflictAttention(input: Readonly<{
  collection: Pick<ChannelStateBindingCollection, 'query'>;
  connectionId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<ConversationIngressConflictAttention> {
  assertCurrent(input, 'channels_connection_update');
  const page = await input.collection.query({
    index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
    prefix: [
      input.connectionId,
      null,
      CHANNEL_STATE_RECORD_KIND.ingressCensus,
      true,
    ],
    order: 'asc',
    limit: 1,
  }, input.signal === undefined ? undefined : { signal: input.signal });
  assertCurrent(input, 'channels_connection_update');
  if (page.rows.length === 0) return null;
  return projectConversationIngressConflictAttention({
    row: page.rows[0],
    connectionId: input.connectionId,
  });
}

/**
 * The sole direct-Account connection-index reader. Its bounded projection is
 * shared by offline policy UI; it does not replace the live Resource owner.
 */
export async function readConversationConnectionManagementRows(input: Readonly<{
  collection: Pick<ChannelStateBindingCollection, 'query'>;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<Readonly<{ connections: readonly ConversationConnectionManagementRow[] }>> {
  assertCurrent(input, 'channels_connection_update');
  const page = await input.collection.query({
    index: CHANNEL_STATE_INDEX_ID.byKind,
    prefix: [CHANNEL_STATE_RECORD_KIND.connection],
    order: 'asc',
    limit: MAX_CONVERSATION_CONNECTIONS_PER_ACCOUNT,
  }, input.signal === undefined ? undefined : { signal: input.signal });
  assertCurrent(input, 'channels_connection_update');
  if (page.nextCursor !== undefined) {
    throw policyError(
      'channels_connection_management_page_invalid',
      'The Channels connection index exceeded the canonical connection bound.',
    );
  }
  const connections = await Promise.all(page.rows.map(async (row) => {
    const connection = projectConversationConnectionManagementRow(row);
    const ingressConflict = await readConversationConnectionIngressConflictAttention({
      collection: input.collection,
      connectionId: connection.connectionId,
      signal: input.signal,
      assertCurrent: input.assertCurrent,
    });
    return {
      ...connection,
      attention: {
        ...connection.attention,
        ingressConflict,
      },
    };
  }));
  assertCurrent(input, 'channels_connection_update');
  return { connections };
}

/**
 * Collections admit only a complete strict binding record. This selects its
 * canonical relation fields and delegates every persisted binding field to the
 * public Channels executable schema before the pure transition can reuse it.
 */
export function readConversationBindingUpdateRow(input: Readonly<{
  row: ChannelStateRow;
  bindingId: string;
}>): ConversationBindingUpdateRow {
  const { row, bindingId } = input;
  const value = row.value;
  const payload = ownChannelStateValue(value, 'payload');
  const rowBindingId = ownChannelStateValue(value, CHANNEL_STATE_FIELD.bindingId);
  const connectionId = ownChannelStateValue(value, CHANNEL_STATE_FIELD.connectionId);
  if (!isCanonicalChannelStateRecordIdentity({
    rowId: row.rowId,
    recordKind: CHANNEL_STATE_RECORD_KIND.binding,
    bindingId,
  })
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.binding
    || rowBindingId !== bindingId
    || typeof connectionId !== 'string'
    || !ConversationConnectionIdV1Schema.safeParse(connectionId).success
    || !isChannelStateJsonRecord(payload)) {
    throw policyError('channels_binding_set_enabled_corrupt', 'Binding enablement target is not a canonical retained binding row.');
  }
  try {
    return {
      payload,
      binding: ConversationBindingV1Schema.parse({
        v: ownChannelStateValue(value, CHANNEL_STATE_FIELD.version),
        id: rowBindingId,
        connectionId,
        endpoint: ownChannelStateValue(payload, 'endpoint'),
        target: ownChannelStateValue(payload, 'target'),
        allowedPrincipalIds: ownChannelStateValue(payload, 'allowedPrincipalIds'),
        allowBotSenders: ownChannelStateValue(payload, 'allowBotSenders'),
        inputMode: ownChannelStateValue(payload, 'inputMode'),
        inboundDebounceMs: ownChannelStateValue(payload, 'inboundDebounceMs'),
        linkPreviewPolicy: ownChannelStateValue(payload, 'linkPreviewPolicy'),
        senderFeedback: ownChannelStateValue(payload, 'senderFeedback'),
        authorityEpoch: ownChannelStateValue(payload, 'authorityEpoch'),
        enabled: ownChannelStateValue(payload, 'enabled'),
        deletionState: ownChannelStateValue(payload, 'deletionState'),
        createdAt: ownChannelStateValue(value, CHANNEL_STATE_FIELD.createdAt),
        updatedAt: ownChannelStateValue(value, CHANNEL_STATE_FIELD.updatedAt),
      }),
    };
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_set_enabled_corrupt',
      message: 'Binding enablement target is not a complete valid persisted binding.',
    }, { cause });
  }
}

export type ConversationBindingPolicyReadResult =
  | Readonly<{
    kind: 'ready';
    bindingId: string;
    revision: number;
    binding: ConversationBindingUpdateState;
  }>
  | Readonly<{ kind: 'notFound' }>;

/**
 * The Account-local counterpart of the exact binding read the online editor
 * performs through its management Action. It reuses the one canonical retained
 * row parser so an offline editor drafts from the same authoritative binding
 * the transition and CAS owner will compare against, never from the summary
 * projection the binding index renders.
 */
export async function readConversationBindingPolicyFromAccountCollection(input: Readonly<{
  collection: ChannelStateBindingCollection;
  bindingId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<ConversationBindingPolicyReadResult> {
  assertCurrent(input, 'channels_binding_update');
  const row = await input.collection.get(
    input.bindingId,
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  assertCurrent(input, 'channels_binding_update');
  if (row === null) return { kind: 'notFound' };
  return {
    kind: 'ready',
    bindingId: input.bindingId,
    revision: row.revision,
    binding: readConversationBindingUpdateRow({ row, bindingId: input.bindingId }).binding,
  };
}

/** Rebuilds the one retained row from a shared parsed policy state. */
export function withConversationBindingPolicy(input: Readonly<{
  row: ChannelStateRow;
  current: ConversationBindingUpdateRow;
  binding: ConversationBindingStateV1;
  updatedAt: number;
}>): ChannelStateJsonRecord {
  return {
    ...input.row.value,
    [CHANNEL_STATE_FIELD.updatedAt]: input.updatedAt,
    payload: {
      ...input.current.payload,
      endpoint: input.binding.endpoint,
      target: input.binding.target,
      allowedPrincipalIds: input.binding.allowedPrincipalIds,
      allowBotSenders: input.binding.allowBotSenders,
      inputMode: input.binding.inputMode,
      inboundDebounceMs: input.binding.inboundDebounceMs,
      linkPreviewPolicy: input.binding.linkPreviewPolicy,
      senderFeedback: input.binding.senderFeedback,
      authorityEpoch: input.binding.authorityEpoch,
      enabled: input.binding.enabled,
      deletionState: input.current.binding.deletionState,
    },
  } satisfies ChannelStateJsonRecord;
}

function boundedSummary(value: string): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= MANAGEMENT_SUMMARY_MAX_CODE_POINTS) return value;
  return `${codePoints.slice(0, MANAGEMENT_SUMMARY_MAX_CODE_POINTS - 1).join('')}…`;
}

function readConversationBindingManagementCurrentRow(
  row: ChannelStateRow,
): ConversationBindingUpdateRow {
  try {
    return readConversationBindingUpdateRow({ row, bindingId: row.rowId });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_binding_management_row_invalid',
      message: 'The Channels binding index received an invalid binding row.',
    }, { cause });
  }
}

function projectConversationBindingManagementRow(
  row: ChannelStateRow,
  currentRow?: ConversationBindingUpdateRow,
): ConversationBindingManagementRow {
  const current: ConversationBindingUpdateRow = currentRow
    ?? readConversationBindingManagementCurrentRow(row);
  const endpointLabel = current.binding.endpoint.label ?? current.binding.endpoint.parentLabel;
  const targetSummary = current.binding.target.kind === 'session'
    ? boundedSummary(current.binding.target.sessionId)
    : boundedSummary(current.binding.target.automationId);
  const deliveryMode = current.binding.target.kind === 'session'
    ? current.binding.target.policy.deliveryMode
    : current.binding.target.policy.resultDelivery;
  const approval: ConversationBindingManagementRow['approval'] = current.binding.target.kind !== 'session'
    ? { kind: 'notApplicable' }
    : current.binding.target.policy.approvals.kind === 'off'
      ? { kind: 'off' }
      : {
        kind: 'enabled',
        maximumScope: current.binding.target.policy.approvals.maximumScope,
      };
  return {
    bindingId: row.rowId,
    revision: row.revision,
    connectionId: current.binding.connectionId,
    endpoint: {
      audience: current.binding.endpoint.audience,
      ...(endpointLabel === undefined ? {} : { label: boundedSummary(endpointLabel) }),
    },
    target: {
      kind: current.binding.target.kind,
      summary: targetSummary,
    },
    inputMode: current.binding.inputMode,
    deliveryMode,
    approval,
    enabled: current.binding.enabled,
    deletionState: current.binding.deletionState,
  };
}

/**
 * The sole bounded binding-index reader for Resource and direct Account Data
 * consumers. It pages through the generic Data owner rather than treating the
 * Channels 256-row quota as a single protocol query page.
 */
export async function readConversationBindingManagementRows(input: Readonly<{
  collection: ChannelStateBindingCollection;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  /**
   * Restricts the projection to the bindings whose canonical target is exactly
   * this Session. The comparison is against the persisted `target.sessionId`,
   * never `target.summary`: the summary is a 28-code-point display projection,
   * so matching on it would both miss a longer Session identity and collide
   * two Sessions that share a prefix.
   */
  sessionId?: string;
}>): Promise<Readonly<{ bindings: readonly ConversationBindingManagementRow[] }>> {
  const bindings: ConversationBindingManagementRow[] = [];
  // Scanned rows, not admitted rows: a Session filter must still bound the
  // Account-wide index it pages through.
  let scannedCount = 0;
  let cursor: string | undefined;
  do {
    assertCurrent(input);
    const page = await input.collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
      limit: Math.min(MAX_CONVERSATION_BINDINGS_PER_ACCOUNT - scannedCount, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1),
      ...(cursor === undefined ? {} : { cursor }),
    }, input.signal === undefined ? undefined : { signal: input.signal });
    assertCurrent(input);
    for (const row of page.rows) {
      scannedCount += 1;
      if (scannedCount > MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
        throw policyError(
          'channels_binding_management_page_invalid',
          'The Channels binding index exceeded the canonical binding bound.',
        );
      }
      const current = readConversationBindingManagementCurrentRow(row);
      if (input.sessionId !== undefined
        && (current.binding.target.kind !== 'session'
          || current.binding.target.sessionId !== input.sessionId)) {
        continue;
      }
      bindings.push(projectConversationBindingManagementRow(row, current));
    }
    if (page.nextCursor === undefined) return { bindings };
    if (scannedCount >= MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
      throw policyError(
        'channels_binding_management_page_invalid',
        'The Channels binding index exceeded the canonical binding bound.',
      );
    }
    cursor = page.nextCursor;
  } while (true);
}

/**
 * Resolves the canonical binding rows for one host-stamped Session before a
 * read-only delivery projection consumes their existing custody. This is a
 * relation reader only: binding policy, delivery lifecycle, and Resource
 * currentness remain with their established owners.
 */
export async function readConversationSessionBindingDeliveryTargets(input: Readonly<{
  collection: ChannelStateBindingCollection;
  sessionId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<readonly ConversationSessionBindingDeliveryTarget[]> {
  if (input.sessionId.trim().length === 0) {
    throw policyError(
      'channels_binding_session_target_input_invalid',
      'A Session delivery target requires a host-stamped Session identity.',
    );
  }
  const targets: ConversationSessionBindingDeliveryTarget[] = [];
  let bindingCount = 0;
  let cursor: string | undefined;
  do {
    assertCurrent(input);
    const page = await input.collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
      limit: Math.min(
        MAX_CONVERSATION_BINDINGS_PER_ACCOUNT - bindingCount,
        PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ),
      ...(cursor === undefined ? {} : { cursor }),
    }, input.signal === undefined ? undefined : { signal: input.signal });
    assertCurrent(input);
    for (const row of page.rows) {
      bindingCount += 1;
      if (bindingCount > MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
        throw policyError(
          'channels_binding_session_target_page_invalid',
          'The Channels binding index exceeded the canonical binding bound.',
        );
      }
      let current: ConversationBindingUpdateRow;
      try {
        current = readConversationBindingUpdateRow({ row, bindingId: row.rowId });
      } catch (cause) {
        throw new PluginError({
          code: 'channels_binding_session_target_row_invalid',
          message: 'The Channels Session delivery target received an invalid binding row.',
        }, { cause });
      }
      if (current.binding.target.kind !== 'session'
        || current.binding.target.sessionId !== input.sessionId) {
        continue;
      }
      targets.push(Object.freeze({
        // The canonical row reader already proved the persisted binding id
        // equals this Account Collection row identity.
        bindingId: row.rowId,
        connectionId: current.binding.connectionId,
      }));
    }
    if (page.nextCursor === undefined) return Object.freeze(targets);
    if (bindingCount >= MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
      throw policyError(
        'channels_binding_session_target_page_invalid',
        'The Channels binding index exceeded the canonical binding bound.',
      );
    }
    cursor = page.nextCursor;
  } while (true);
}

/**
 * The shared direct-Data reader for blocked ingress custody. It deliberately
 * returns one bounded page, including the exact row revision required by the
 * retry Action's CAS, rather than introducing an attention Resource or a
 * second server-side list owner.
 */
export async function readConversationIngressAttentionPage(input: Readonly<{
  collection: Pick<ChannelStateBindingCollection, 'query'>;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<Readonly<{
  obligations: readonly ConversationIngressAttentionRow[];
  nextCursor?: string;
}>> {
  const limit = Math.min(input.limit ?? PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw policyError(
      'channels_ingress_attention_page_invalid',
      'The Channels ingress attention page bound is invalid.',
    );
  }
  assertCurrent(input);
  const page = await input.collection.query({
    index: CHANNEL_STATE_INDEX_ID.byAttention,
    prefix: [true],
    order: 'asc',
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    limit,
  }, input.signal === undefined ? undefined : { signal: input.signal });
  assertCurrent(input);
  const obligations = page.rows.map((row): ConversationIngressAttentionRow => {
    const value = row.value;
    const payload = isChannelStateJsonRecord(value) ? ownChannelStateValue(value, 'payload') : undefined;
    const lifecycle = isChannelStateJsonRecord(payload) ? ownChannelStateValue(payload, 'lifecycle') : undefined;
    const id = isChannelStateJsonRecord(value) ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.id) : undefined;
    const recordKind = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.recordKind)
      : undefined;
    const connectionId = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.connectionId)
      : undefined;
    const bindingId = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.bindingId)
      : undefined;
    const attention = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.attention)
      : undefined;
    const terminal = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.terminal)
      : undefined;
    const dueAt = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.dueAt)
      : undefined;
    const updatedAt = isChannelStateJsonRecord(value)
      ? ownChannelStateValue(value, CHANNEL_STATE_FIELD.updatedAt)
      : undefined;
    const phase = isChannelStateJsonRecord(lifecycle) ? ownChannelStateValue(lifecycle, 'phase') : undefined;
    const attemptCount = isChannelStateJsonRecord(lifecycle)
      ? ownChannelStateValue(lifecycle, 'attemptCount')
      : undefined;
    const conflict = isChannelStateJsonRecord(payload) ? ownChannelStateValue(payload, 'conflict') : undefined;
    const isOccurrenceConflict = recordKind === CHANNEL_STATE_RECORD_KIND.ingressCensus
      && attention === true
      && (bindingId === undefined || bindingId === null)
      && isChannelStateJsonRecord(conflict)
      && conflict.kind === 'occurrenceEvidenceMismatch'
      && Object.keys(conflict).length === 1;
    if (recordKind === CHANNEL_STATE_RECORD_KIND.ingressCensus) {
      if (
        typeof id !== 'string'
        || id !== row.rowId
        || typeof connectionId !== 'string'
        || !isOccurrenceConflict
        || !Number.isSafeInteger(row.revision)
        || row.revision < 1
      ) {
        throw policyError(
          'channels_ingress_attention_row_invalid',
          'The Channels ingress attention index returned a non-canonical occurrence conflict.',
        );
      }
      return {
        kind: 'occurrenceConflict',
        censusId: id,
        revision: row.revision,
        connectionId,
      };
    }
    const isBlocked = terminal === false
      && dueAt === undefined
      && phase === 'blocked'
      && Number.isSafeInteger(attemptCount)
      && typeof attemptCount === 'number'
      && attemptCount >= 0;
    const isTerminal = terminal === true
      && dueAt === undefined
      && phase === 'terminal';
    if (typeof id !== 'string'
      || id !== row.rowId
      || recordKind !== CHANNEL_STATE_RECORD_KIND.ingressObligation
      || typeof connectionId !== 'string'
      || typeof bindingId !== 'string'
      || attention !== true
      || (!isBlocked && !isTerminal)
      || !Number.isSafeInteger(updatedAt)
      || typeof updatedAt !== 'number'
      || updatedAt < 0) {
      throw policyError(
        'channels_ingress_attention_row_invalid',
        'The Channels ingress attention index returned a non-canonical attention obligation.',
      );
    }
    if (isTerminal) {
      return {
        kind: 'terminal',
        obligationId: id,
        revision: row.revision,
        connectionId,
        bindingId,
        updatedAt,
      };
    }
    return {
      kind: 'blocked',
      obligationId: id,
      revision: row.revision,
      connectionId,
      bindingId,
      attemptCount: attemptCount as number,
      updatedAt,
    };
  });
  return {
    obligations,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

/**
 * The one retained-row mutation owner for Account-local connection lifecycle
 * edits. Online Actions and the admitted direct Account UI share this exact
 * parser, pure transition, revision CAS, and complete-row reconstruction.
 */
export async function mutateConversationConnectionLifecycleInAccountCollection(input: Readonly<{
  collection: ChannelStateBindingCollection;
  connectionId: string;
  expectedRevision: number;
  operation: 'channels_connection_update' | 'channels_connection_set_enabled';
  transition: (
    current: ConversationConnectionLifecycleStateV1,
    now: number,
  ) => ConversationConnectionEnabledResultV1;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  now?: () => number;
}>): Promise<ConversationConnectionLifecycleMutationResult> {
  const now = input.now ?? Date.now;
  assertCurrent(input, input.operation);
  const row = await input.collection.get(
    input.connectionId,
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  assertCurrent(input, input.operation);
  if (row === null) {
    throw policyError(`${input.operation}_not_found`, 'Connection lifecycle target does not exist.');
  }
  if (row.revision !== input.expectedRevision) {
    throw policyError(
      `${input.operation}_conflict`,
      'Connection lifecycle mutation requires the current retained row revision.',
      true,
    );
  }

  const current = readConversationConnectionUpdateRow({ row, connectionId: input.connectionId });
  const updatedAt = now();
  const transition = input.transition(current.lifecycle, updatedAt);
  if (transition.kind === 'rejected') {
    if (transition.code === 'deleteInProgress') {
      throw policyError(`${input.operation}_delete_in_progress`, 'Connection lifecycle cannot change while deletion is in progress.');
    }
    if (transition.code === 'oldTransportStopPending') {
      throw policyError(
        `${input.operation}_old_transport_stop_pending`,
        'Connection lifecycle cannot change while its frozen old-stop custody is unresolved.',
        true,
      );
    }
    if (transition.code === 'authorityEpochExhausted') {
      throw policyError(`${input.operation}_authority_epoch_exhausted`, 'Connection authority cannot advance further.');
    }
    throw policyError(
      `${input.operation}_maximum_observation_age_invalid`,
      'Connection observation age is outside the supported range.',
    );
  }
  if (transition.kind === 'unchanged') {
    return {
      kind: 'unchanged',
      connectionId: input.connectionId,
      revision: row.revision,
      authorityEpoch: transition.connection.authorityEpoch,
    };
  }

  const result = await input.collection.batch([
    {
      kind: 'put',
      value: withConversationConnectionLifecycle({
        row,
        current,
        lifecycle: transition.connection,
        updatedAt,
      }),
      expectedRevision: row.revision,
    },
  ], input.signal === undefined ? undefined : { signal: input.signal });
  assertCurrent(input, input.operation);
  if (result.status === 'conflict') {
    throw policyError(
      `${input.operation}_conflict`,
      'Connection lifecycle mutation lost its retained-row compare-and-swap.',
      true,
    );
  }
  const persisted = result.results.find((entry) => (
    entry.rowId === input.connectionId && entry.deleted === false
  ));
  if (persisted === undefined) {
    throw policyError(
      `${input.operation}_result_invalid`,
      'Connection lifecycle batch did not return its retained row result.',
      true,
    );
  }
  return {
    kind: 'updated',
    connectionId: input.connectionId,
    revision: persisted.revision,
    authorityEpoch: transition.connection.authorityEpoch,
  };
}

/** The direct Account counterpart of the online complete connection-policy Action. */
export async function updateConversationConnectionInAccountCollection(input: Readonly<{
  collection: ChannelStateBindingCollection;
  connectionId: string;
  expectedRevision: number;
  enabled: boolean;
  maximumObservationAgeMs: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  now?: () => number;
}>): Promise<ConversationConnectionLifecycleMutationResult> {
  return await mutateConversationConnectionLifecycleInAccountCollection({
    ...input,
    operation: 'channels_connection_update',
    transition: (current, now) => transitionConversationConnection({
      current,
      requested: {
        enabled: input.enabled,
        maximumObservationAgeMs: input.maximumObservationAgeMs,
      },
      now,
    }),
  });
}

export type ConversationBindingPolicyUpdateInput = Readonly<{
  collection: ChannelStateBindingCollection;
  bindingId: string;
  expectedRevision: number;
  /**
   * A Session target is decided entirely from the Account: `management.ts`'s
   * own persistence resolver returns it unchanged after the approval gate and
   * reaches no provider or Automation owner. An Automation target is the one
   * arm that needs the Automation owner's live template verification, so it is
   * refused here rather than persisted unverified.
   */
  target?: ConversationBindingTargetV1;
  /**
   * Senders to withdraw from the retained audience. Revocation is decidable
   * from the retained binding alone, so it stays available while the selected
   * machine is unreachable; admitting a sender is not, because only the
   * provider resolver can prove one exists on the endpoint.
   */
  revokedPrincipalIds?: readonly string[];
  allowBotSenders?: boolean;
  inputMode?: ConversationBindingInputModeV1;
  inboundDebounceMs?: number;
  linkPreviewPolicy?: ConversationBindingV1['linkPreviewPolicy'];
  senderFeedback?: ConversationBindingV1['senderFeedback'];
  enabled?: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  now?: () => number;
}>;

/**
 * Narrows a requested target to the arm an unreachable machine can decide.
 *
 * `management.ts`'s persistence resolver is the reference: it returns a Session
 * target unchanged after the shared approval gate, and calls the Automation
 * owner only for an Automation target. Offline editing therefore admits the
 * Session arm in full and refuses the Automation arm with a typed reason,
 * rather than silently dropping a target the caller asked for.
 */
function readAccountResolvableConversationBindingTarget(input: Readonly<{
  requested: ConversationBindingTargetV1 | undefined;
  current: ConversationBindingTargetV1;
  operation: 'channels_binding_set_enabled' | 'channels_binding_update';
}>): ConversationBindingTargetV1 {
  const { requested } = input;
  if (requested === undefined) return input.current;
  if (requested.kind !== 'session') {
    throw policyError(
      `${input.operation}_target_not_account_resolvable`,
      'An Automation binding target can only be changed while its Automation owner is reachable.',
    );
  }
  return requested;
}

/**
 * Applies a present-user revocation through the shared allow-list owner.
 *
 * The projection itself lives with `transitionConversationBinding` because it
 * upholds that owner's cross-field invariant; this only turns its two typed
 * refusals into the operation's own error vocabulary.
 */
function readAccountResolvableConversationBindingAudience(input: Readonly<{
  allowedPrincipalIds: readonly string[];
  target: ConversationBindingTargetV1;
  revokedPrincipalIds: readonly string[] | undefined;
  operation: 'channels_binding_set_enabled' | 'channels_binding_update';
}>): Readonly<{ allowedPrincipalIds: readonly string[]; target: ConversationBindingTargetV1 }> {
  const { revokedPrincipalIds } = input;
  if (revokedPrincipalIds === undefined || revokedPrincipalIds.length === 0) {
    return { allowedPrincipalIds: input.allowedPrincipalIds, target: input.target };
  }
  const revocation = revokeConversationBindingPrincipals({
    allowedPrincipalIds: input.allowedPrincipalIds,
    target: input.target,
    revokedPrincipalIds,
  });
  if (revocation.kind === 'rejected') {
    throw revocation.code === 'audienceWouldBeEmpty'
      ? policyError(
        `${input.operation}_audience_would_be_empty`,
        'A conversation binding must keep at least one allowed sender; disable or delete it instead.',
      )
      : policyError(
        `${input.operation}_principal_not_allowed`,
        'Only a sender this binding already allows can be revoked.',
      );
  }
  return { allowedPrincipalIds: revocation.allowedPrincipalIds, target: revocation.target };
}

/**
 * The one Account-local binding-policy writer. It accepts exactly the fields an
 * unreachable machine can decide from the retained binding itself, including a
 * Session target change; resolver-backed audience changes and Automation target
 * verification remain online-only at management.ts.
 */
async function mutateConversationBindingPolicyInAccountCollection(input: ConversationBindingPolicyUpdateInput & Readonly<{
  operation: 'channels_binding_set_enabled' | 'channels_binding_update';
}>): Promise<ConversationBindingEnablementResult> {
  const now = input.now ?? Date.now;
  assertCurrent(input, input.operation);
  const row = await input.collection.get(input.bindingId, input.signal === undefined ? undefined : { signal: input.signal });
  assertCurrent(input, input.operation);
  if (row === null) {
    throw policyError(`${input.operation}_not_found`, 'Binding mutation target does not exist.');
  }
  if (row.revision !== input.expectedRevision) {
    throw policyError(
      `${input.operation}_conflict`,
      'Binding mutation requires the current retained row revision.',
      true,
    );
  }

  const current = readConversationBindingUpdateRow({ row, bindingId: input.bindingId });
  if (current.binding.deletionState !== 'none') {
    throw policyError(
      `${input.operation}_delete_in_progress`,
      'Binding enablement cannot change while binding deletion cleanup is in progress.',
    );
  }
  if (
    input.enabled === true
    && !current.binding.enabled
    && current.binding.target.kind === 'automation'
  ) {
    throw policyError(
      `${input.operation}_target_verification_required`,
      'An Automation binding can be enabled only while its target owner is reachable for current verification.',
    );
  }
  const connectionRow = await input.collection.get(
    current.binding.connectionId,
    input.signal === undefined ? undefined : { signal: input.signal },
  );
  assertCurrent(input, input.operation);
  if (connectionRow === null) {
    throw policyError(`${input.operation}_connection_not_found`, 'Binding mutation owner connection does not exist.');
  }
  const connection = readConversationConnectionUpdateRow({
    row: connectionRow,
    connectionId: current.binding.connectionId,
  });
  if (connection.lifecycle.deletionState !== 'none') {
    throw policyError(
      `${input.operation}_connection_delete_in_progress`,
      'Binding mutation cannot change while its connection deletion is in progress.',
    );
  }

  const requestedTarget = readAccountResolvableConversationBindingTarget({
    requested: input.target,
    current: current.binding.target,
    operation: input.operation,
  });
  const audience = readAccountResolvableConversationBindingAudience({
    allowedPrincipalIds: current.binding.allowedPrincipalIds,
    target: requestedTarget,
    revokedPrincipalIds: input.revokedPrincipalIds,
    operation: input.operation,
  });
  const transition = transitionConversationBinding({
    current: current.binding,
    requested: {
      ...current.binding,
      target: audience.target,
      allowedPrincipalIds: audience.allowedPrincipalIds,
      allowBotSenders: input.allowBotSenders ?? current.binding.allowBotSenders,
      inputMode: input.inputMode ?? current.binding.inputMode,
      inboundDebounceMs: input.inboundDebounceMs ?? current.binding.inboundDebounceMs,
      linkPreviewPolicy: input.linkPreviewPolicy ?? current.binding.linkPreviewPolicy,
      senderFeedback: input.senderFeedback ?? current.binding.senderFeedback,
      enabled: input.enabled ?? current.binding.enabled,
    },
  });
  if (transition.kind === 'rejected') {
    if (transition.code === 'authorityEpochExhausted') {
      throw policyError(`${input.operation}_authority_epoch_exhausted`, 'Binding authority cannot advance further.');
    }
    throw policyError(`${input.operation}_corrupt`, 'Binding mutation could not preserve the canonical binding relation.');
  }
  if (transition.binding.enabled) {
    assertConversationBindingInputModeIsDeliverable({
      audience: transition.binding.endpoint.audience,
      inputMode: transition.binding.inputMode,
      sharedEndpointInputModes: readConversationConnectionSharedEndpointInputModes(connection.payload),
      operation: input.operation,
    });
  }
  if (transition.kind === 'unchanged') {
    return {
      kind: 'unchanged',
      bindingId: input.bindingId,
      revision: row.revision,
      authorityEpoch: transition.binding.authorityEpoch,
    };
  }

  const demandChanged = hasConversationBindingDeliveryDemandChanged(
    current.binding,
    transition.binding,
  );
  const result = await input.collection.batch([
    demandChanged
      ? {
        kind: 'put' as const,
        value: connectionRow.value,
        expectedRevision: connectionRow.revision,
      }
      : {
        kind: 'assert' as const,
        rowId: current.binding.connectionId,
        expectedRevision: connectionRow.revision,
      },
    {
      kind: 'put',
      value: withConversationBindingPolicy({
        row,
        current,
        binding: transition.binding,
        updatedAt: now(),
      }),
      expectedRevision: row.revision,
    },
  ], input.signal === undefined ? undefined : { signal: input.signal });
  assertCurrent(input, input.operation);
  if (result.status === 'conflict') {
    throw policyError(
      `${input.operation}_conflict`,
      'Binding mutation lost its retained-row compare-and-swap.',
      true,
    );
  }
  const persisted = result.results.find((entry) => (
    entry.rowId === input.bindingId && entry.deleted === false
  ));
  if (persisted === undefined) {
    throw policyError(
      `${input.operation}_result_invalid`,
      'Binding mutation batch did not return its retained row result.',
      true,
    );
  }
  return {
    kind: 'updated',
    bindingId: input.bindingId,
    revision: persisted.revision,
    authorityEpoch: transition.binding.authorityEpoch,
  };
}

/**
 * The direct Account counterpart of the online policy-only update path. It
 * does not accept endpoint, principal, or target edits because those require
 * current provider or Automation authority.
 */
export async function updateConversationBindingPolicyInAccountCollection(
  input: ConversationBindingPolicyUpdateInput,
): Promise<ConversationBindingEnablementResult> {
  return await mutateConversationBindingPolicyInAccountCollection({
    ...input,
    operation: 'channels_binding_update',
  });
}

/** The narrow legacy enablement entry point delegates to the one policy writer. */
export async function setConversationBindingEnabledInAccountCollection(input: Readonly<{
  collection: ChannelStateBindingCollection;
  bindingId: string;
  expectedRevision: number;
  enabled: boolean;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  now?: () => number;
}>): Promise<ConversationBindingEnablementResult> {
  return await mutateConversationBindingPolicyInAccountCollection({
    ...input,
    operation: 'channels_binding_set_enabled',
  });
}
