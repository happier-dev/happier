import {
  isPluginError,
  PluginError,
  arePluginMachineExecutionOriginsEqual,
  type JsonValue,
  type PluginInvocationCaller,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type {
  PluginCollectionBatchMeasurement,
  PluginCollectionLimits,
  PluginCollectionRow,
} from '@happier-dev/plugin-sdk/collections';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type {
  PluginActionResultById,
  PluginMachineExecutionOriginV1,
} from '@happier-dev/plugin-sdk/actions';
import {
  AutomationConversationResultDeliveryV1Schema,
  type AutomationConversationAdmitInputV1,
  type AutomationConversationAdmitResultV1,
  type AutomationConversationResultDeliveryV1,
} from '@happier-dev/plugin-sdk/automations';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/plugin-sdk/sessions';
import {
  areConversationEndpointIdentitiesEqual,
  CONVERSATION_AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1,
  type ChannelSessionSpawnRecipeV1,
  type ConversationBindingInputModeV1,
  ConversationAuthenticatedObservationShellV1Schema,
  ConversationBindingIdV1Schema,
  ConversationConnectionIdV1Schema,
  type ConversationAuthenticatedObservationShellV1,
  type ConversationBindingTargetV1,
  ConversationNormalizedIngressV1Schema,
  ConversationPollInputV1Schema,
  ConversationPollResultV1Schema,
  MAX_CONVERSATION_OBSERVATION_AGE_MS,
  type ConversationResolvedEndpointV1,
  type ConversationNormalizedIngressV1,
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
  MAX_CONVERSATION_DELIVERY_ATTEMPTS,
  MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS,
  MAX_CONVERSATION_RECEIVE_WAIT_MS,
  MIN_CONVERSATION_OBSERVATION_AGE_MS,
  type ConversationObservationV1,
  type ConversationProviderObservationIngestInputV1,
  ConversationProviderObservationIngestInputV1Schema,
} from '@happier-dev/channels-protocol/v1';

import {
  classifyConversationCommand,
  createConversationNewSessionCreationKey,
} from './commands.js';
import {
  transitionConversationBinding,
  type ConversationBindingStateV1,
} from './bindingTransition.js';
import {
  hasUnsettledDestructiveOldTransportStop,
  isSelfStampedPluginCaller,
  type ConversationConnectionPollFailureEvidenceV1,
  type ConversationConnectionPollFailureV1,
  type ConversationConnectionLifecycleStateV1,
  type ConversationCheckpointedPollInvocationBasisV1,
  type ConversationPendingOldTransportStopV1,
} from './connectionLifecycle.js';
import { readPersistedConversationConnectionPollFailure } from './connectionPollFailurePersistence.js';
import { hasCurrentConversationTransportCaller } from './reconciliation.js';
import {
  CONVERSATION_NON_ADMISSION_REASONS,
  decideConversationCommandPolicy,
  isConversationSenderFeedbackEligible,
  settleCompetingNewSessionCommand,
  type ConversationNonAdmissionReason,
} from './commandPolicy.js';
import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
  isCanonicalChannelStateRecordIdentity,
  type PersistedConversationProviderContributionSelection,
} from './collections.js';
import {
  MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE,
  requireChannelsAccountStorage,
} from './requiredAccountStorage.js';
import { conversationRetryDelayMs } from './retryBackoff.js';
import {
  acceptConversationOutwardDeliveryReady,
  createConversationOutwardDeliveryCollectionStore,
  prepareConversationOutwardDeliveryReady,
  type ConversationControlResponseObligation,
} from './outwardDelivery.js';
import {
  readConversationBindingUpdateRow,
  readConversationConnectionUpdateRow,
  type ConversationConnectionUpdateRow,
} from './accountLocalBindingPolicy.js';
import {
  importHmacSha256Key,
  signLengthPrefixedUtf8HmacSha256Base64Url,
  tryDecodeBase64Url,
} from './privateRowIdentity.js';
import {
  confirmConversationCheckpointedPollStopForInvocation,
  recordConversationCheckpointedPollHistoryGapForInvocation,
  settleConversationProviderExclusiveCheckpointedPollReplacementForInvocation,
  type ConversationPairingManager,
} from './management.js';
import { readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import {
  createConversationSessionProjectionFrontierRow,
  createConversationSessionProjectionFrontierRowId,
  readConversationSessionProjectionNoHistoryBaseline,
} from './sessionProjection.js';

type PluginCaller = Extract<PluginInvocationCaller, Readonly<{ kind: 'plugin' }>>;
type JsonRecord = Readonly<Record<string, JsonValue>>;
type IngressExecutionSource =
  | Readonly<{
    kind: 'providerObservation';
    caller: PluginCaller | undefined;
    directAction: boolean;
  }>
  | Readonly<{
    kind: 'checkpointedPoll';
    executionOrigin: PluginMachineExecutionOriginV1;
    authorityEpoch: number;
  }>;
type StateRow = Readonly<{
  rowId: string;
  revision: number;
  value: JsonRecord;
}>;

/**
 * Both baseline and steady checkpointed polling admit provider results through
 * this one owner before any ingress or checkpoint effect can be scheduled.
 */
function readConversationPollResultForAdmission(
  value: unknown,
): ReturnType<typeof ConversationPollResultV1Schema.parse> {
  const result = ConversationPollResultV1Schema.parse(value);
  if (result.kind !== 'batch') return result;

  if (result.observations.length > MAX_CHECKPOINTED_POLL_COVERAGE_OBSERVATIONS) {
    throw new Error('A checkpointed poll batch exceeds the atomic census-coverage bound.');
  }

  const occurrenceIds = new Set<string>();
  for (const observation of result.observations) {
    const occurrenceId = observation.kind === 'fullText'
      ? observation.observation.occurrenceId
      : observation.shell.occurrenceId;
    if (occurrenceIds.has(occurrenceId)) {
      throw new Error('A poll batch must classify each occurrence at most once.');
    }
    occurrenceIds.add(occurrenceId);
  }
  return result;
}

type ChannelConnectionProviderTransport = Readonly<{
  transport: Readonly<{ kind: 'checkpointedPull' | 'socket' | 'durablePush' }>;
  providerConnectionKey: string;
  providerConfigVersion: number;
  providerConfig: JsonValue;
  credentialRef: JsonValue;
  replayContinuity: 'checkpointed' | 'sessionBound' | 'none';
}>;

type ChannelConnectionPayload = Readonly<{
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  transportOrigin: PluginMachineExecutionOriginV1;
  transport: Readonly<{ kind: 'checkpointedPull' | 'socket' | 'durablePush' }>;
  overlapSafety: ConversationConnectionLifecycleStateV1['overlapSafety'];
  routingIdentityKey: string;
  providerConnectionKey: string;
  providerConfigVersion: number;
  providerConfig: JsonValue;
  credentialRef: JsonValue;
  replayContinuity: 'checkpointed' | 'sessionBound' | 'none';
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  pendingOldTransportStop: ConversationPendingOldTransportStopV1 | null;
  historyGap: JsonValue | null;
  pollFailure: ConversationConnectionPollFailureV1 | null;
  maximumObservationAgeMs: number;
  observationAgeExpansionFloorOccurredAt: number | null;
}>;

type ChannelConnectionRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.connection;
  'connection-id': string;
  payload: ChannelConnectionPayload;
}>;

type ChannelBindingPayload = Readonly<{
  endpoint: ConversationResolvedEndpointV1;
  target: ConversationBindingTargetV1;
  allowedPrincipalIds: readonly string[];
  allowBotSenders: boolean;
  inputMode: ConversationBindingInputModeV1;
  inboundDebounceMs: number;
  linkPreviewPolicy: 'suppress' | 'providerDefault';
  senderFeedback: 'off' | 'eligibleRefusals';
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'finalizingDelete';
}>;

type ChannelBindingRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.binding;
  'connection-id': string;
  'binding-id': string;
  payload: ChannelBindingPayload;
}>;

type FrozenSessionTarget = Readonly<{
  kind: 'session';
  sessionId: string;
  idempotencyKey: string;
  requestedPermissionCeiling: Extract<ConversationBindingTargetV1, Readonly<{ kind: 'session' }>>['policy']['permissionCeiling'];
  /**
   * The owner-configured remote-approval ceiling, frozen with the rest of the
   * target so a retry after the first attempt stamps the same disclosure the
   * admitted revision carried instead of re-reading mutable binding policy.
   */
  remoteApprovalMaxScope: 'off' | 'request' | 'session';
  newSession: Readonly<{
    recipe: ChannelSessionSpawnRecipeV1;
    initialPrompt?: string;
  }> | null;
  /** The one frozen chat-approval command this obligation may mediate. */
  approval: Readonly<{
    requestId: string;
    decision: 'allow' | 'deny';
    scope: 'request' | 'session';
  }> | null;
}>;

type FrozenAutomationTarget = Readonly<{
  kind: 'automation';
  automationId: string;
  templateVersion: number;
  occurrenceKey: string;
  resultDelivery: AutomationConversationResultDeliveryV1;
}>;

type FrozenIngressTarget = FrozenSessionTarget | FrozenAutomationTarget;

type IngressCheckpointOutcome = 'checkpointSafe' | 'unsettled';
type IngressObservationOutcome = 'checkpointSafe' | 'checkpointSafeNoCensus' | 'unsettled';

type IngressDisposition =
  | 'admitted'
  | 'rejected'
  | 'suppressed'
  | 'pairingConsumed'
  | 'approvalConsumed'
  | 'rotationBusy'
  | 'rotationSuperseded'
  | 'rotated'
  | 'connectionDeleted'
  | 'staleAuthority';

type IngressNonAdmission = Readonly<{
  reason: ConversationNonAdmissionReason;
  senderFeedbackEligible: boolean;
}>;

type IngressObligationPayload = Readonly<{
  occurrenceIds: readonly string[];
  censusId: string;
  target: FrozenIngressTarget | null;
  sourceAuthority: Readonly<{
    connectionAuthorityEpoch: number;
    bindingRevision: number;
    bindingAuthorityEpoch: number;
  }>;
  lifecycle: Readonly<{
    phase: 'debounceDue' | 'ready' | 'attempting' | 'retryDue' | 'blocked' | 'terminal';
    attemptCount: number;
    dueAt: number | null;
  }>;
  disposition: IngressDisposition | null;
  nonAdmission: IngressNonAdmission | null;
}>;

type IngressObligationRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.ingressObligation;
  v: 1;
  'connection-id': string;
  'binding-id': string;
  terminal: boolean;
  attention: boolean;
  'due-at': number | null;
  'created-at': number;
  'updated-at': number;
  payload: IngressObligationPayload;
}>;

type IngressCensusMatchedBinding = Readonly<{
  bindingId: string;
  bindingRevision: number;
  bindingAuthorityEpoch: number;
}>;

type IngressCensusPayload = Readonly<{
  normalizedIngress: ConversationNormalizedIngressV1;
  phase: 'preparing' | 'prepared';
  connectionAuthorityEpoch: number;
  maximumObservationAgeMs: number;
  /** Set only in the checkpoint CAS that proves every member was terminal and non-attention. */
  checkpointCoveredAt: number | null;
  /** Strict terminal fact for contradictory immutable occurrence evidence. */
  conflict: Readonly<{ kind: 'occurrenceEvidenceMismatch' }> | null;
  matchedBindings: readonly IngressCensusMatchedBinding[];
}>;

type IngressCensusRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.ingressCensus;
  v: 1;
  'connection-id': string;
  attention: boolean;
  'created-at': number;
  'updated-at': number;
  payload: IngressCensusPayload;
}>;

type CheckpointRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.checkpoint;
  'connection-id': string;
  'created-at': number;
  'updated-at': number;
  payload: Readonly<{
    authorityEpoch: number;
    opaqueToken: JsonValue;
    lastOccurrenceId: string | null;
    revision: number;
    nextPollNotBeforeMs: number | null;
  }>;
}>;

type IngressAuthorityFence = Readonly<{
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  bindings: readonly Readonly<{ row: StateRow; value: ChannelBindingRecord }>[];
}>;

/**
 * The protocol ceiling on logical mutations per atomic Account Collection
 * batch. This is a provider-facing contract bound — how many observations one
 * poll may claim coverage for — so it stays fixed rather than following a
 * deployment's lowered `maxBatchRows`; writers that size a real batch read the
 * in-force limit from the collection handle instead.
 *
 * One connection fence plus one checkpoint leave the remaining slots for census
 * coverage.
 */
const MAX_CHECKPOINTED_POLL_COVERAGE_OBSERVATIONS = 100 - 2;
const INGRESS_RECOVERY_DELAY_MS = 0;
const NEW_SESSION_CONTROL_RESPONSE_TEXT = {
  started: 'Started a new Session.',
  busy: 'Another /new command is already in progress.',
} as const;

function pluginError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw pluginError(
      'channels_ingress_cancelled',
      'Conversation provider observation admission was cancelled before settlement.',
      true,
    );
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function own(record: JsonRecord, key: string): JsonValue | undefined {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isValidMaximumObservationAge(value: unknown): value is number {
  return isPositiveSafeInteger(value)
    && value >= MIN_CONVERSATION_OBSERVATION_AGE_MS
    && value <= MAX_CONVERSATION_OBSERVATION_AGE_MS;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function stringMember<const T extends readonly string[]>(
  value: JsonValue | undefined,
  members: T,
): T[number] | undefined {
  if (typeof value !== 'string') return undefined;
  return members.find((member) => member === value);
}

/**
 * Adapts an absent Collection row to this module's `undefined`. The row itself
 * is already the host's: Account Data validates every row against the admitted
 * `CHANNEL_STATE_COLLECTION` schema on write and again on read, so re-deriving
 * `rowId`/`revision`/`value` here would only restate a contract the typed
 * handle already carries. The record-kind decoders below still narrow it.
 */
function readStateRow(row: PluginCollectionRow<JsonRecord> | null | undefined): StateRow | undefined {
  return row ?? undefined;
}

/**
 * Reads the provider-transport slice of a retained connection payload.
 *
 * `readConversationConnectionUpdateRow` is the canonical retained-connection
 * decoder: it owns record kind, row identity, and every lifecycle field. These
 * six fields are the only ones it does not project, so this reads exactly them
 * and re-validates nothing the canonical decoder has already checked.
 */
function readConnectionProviderTransport(
  payload: JsonValue | undefined,
): ChannelConnectionProviderTransport | undefined {
  if (!isJsonRecord(payload)) return undefined;
  const transport = own(payload, 'transport');
  const providerConnectionKey = own(payload, 'providerConnectionKey');
  const providerConfigVersion = own(payload, 'providerConfigVersion');
  const providerConfig = own(payload, 'providerConfig');
  const credentialRef = own(payload, 'credentialRef');
  const replayContinuity = stringMember(
    own(payload, 'replayContinuity'),
    ['checkpointed', 'sessionBound', 'none'] as const,
  );
  if (
    !isJsonRecord(transport)
    || typeof providerConnectionKey !== 'string'
    || !isPositiveSafeInteger(providerConfigVersion)
    || providerConfig === undefined
    || credentialRef === undefined
    || replayContinuity === undefined
  ) return undefined;
  const transportKind = stringMember(
    own(transport, 'kind'),
    ['checkpointedPull', 'socket', 'durablePush'] as const,
  );
  if (transportKind === undefined) return undefined;
  return {
    transport: { kind: transportKind },
    providerConnectionKey,
    providerConfigVersion,
    providerConfig,
    credentialRef,
    replayContinuity,
  };
}

function stampedPluginCaller(context: PluginInvocationContext): PluginCaller | undefined {
  return context.surface === 'plugin' && isSelfStampedPluginCaller(context.caller)
    ? context.caller
    : undefined;
}

function expectedObservationTransport(
  kind: ChannelConnectionPayload['transport']['kind'],
): ConversationObservationV1['transport']['kind'] {
  switch (kind) {
    case 'checkpointedPull':
      return 'poll';
    case 'socket':
      return 'socket';
    case 'durablePush':
      return 'webhook';
  }
}

function asConnection(row: StateRow | null):
  | Readonly<{ row: StateRow; value: ChannelConnectionRecord }>
  | undefined {
  if (row === null) return undefined;
  // Ingress treats a corrupt retained row as "no current connection", so the
  // canonical decoder's throw is degraded to `undefined` here — once, instead
  // of re-parsing the same payload behind it.
  let connection: ConversationConnectionUpdateRow;
  try {
    connection = readConversationConnectionUpdateRow({ row, connectionId: row.rowId });
  } catch {
    return undefined;
  }
  if (own(row.value, CHANNEL_STATE_FIELD.id) !== row.rowId) return undefined;
  const providerTransport = readConnectionProviderTransport(connection.payload);
  if (providerTransport === undefined) return undefined;
  const { lifecycle } = connection;
  return {
    row,
    value: {
      id: row.rowId,
      'record-kind': CHANNEL_STATE_RECORD_KIND.connection,
      'connection-id': row.rowId,
      payload: {
        providerPluginId: connection.providerPluginId,
        providerContributionSelection: connection.providerContributionSelection,
        transportOrigin: connection.transportOrigin,
        routingIdentityKey: connection.routingIdentityKey,
        ...providerTransport,
        overlapSafety: lifecycle.overlapSafety,
        authorityEpoch: lifecycle.authorityEpoch,
        enabled: lifecycle.enabled,
        deletionState: lifecycle.deletionState,
        pendingOldTransportStop: lifecycle.pendingOldTransportStop,
        historyGap: lifecycle.historyGap,
        pollFailure: lifecycle.pollFailure,
        maximumObservationAgeMs: lifecycle.maximumObservationAgeMs,
        observationAgeExpansionFloorOccurredAt: lifecycle.observationAgeExpansionFloorOccurredAt,
      },
    },
  };
}

function asBinding(row: StateRow | undefined): Readonly<{ row: StateRow; value: ChannelBindingRecord }> | undefined {
  if (row === undefined) return undefined;
  if (own(row.value, CHANNEL_STATE_FIELD.recordKind) !== CHANNEL_STATE_RECORD_KIND.binding) return undefined;
  const { binding } = readConversationBindingUpdateRow({
    row,
    bindingId: row.rowId,
  });
  return {
    row,
    value: {
      id: row.rowId,
      'record-kind': CHANNEL_STATE_RECORD_KIND.binding,
      'connection-id': binding.connectionId,
      'binding-id': row.rowId,
      payload: binding,
    },
  };
}

function readFrozenIngressTarget(value: JsonValue | undefined): FrozenIngressTarget | undefined {
  if (!isJsonRecord(value)) return undefined;
  const kind = own(value, 'kind');
  if (kind === 'session') {
    const sessionId = own(value, 'sessionId');
    const idempotencyKey = own(value, 'idempotencyKey');
    const requestedPermissionCeiling = stringMember(
      own(value, 'requestedPermissionCeiling'),
      ['default', 'read-only', 'safe-yolo', 'yolo', 'plan'] as const,
    );
    if (
      typeof sessionId !== 'string'
      || typeof idempotencyKey !== 'string'
      || requestedPermissionCeiling === undefined
    ) return undefined;
    const remoteApprovalMaxScope = stringMember(
      own(value, 'remoteApprovalMaxScope'),
      ['off', 'request', 'session'] as const,
    );
    if (remoteApprovalMaxScope === undefined) return undefined;
    const frozenNewSession = own(value, 'newSession');
    let newSession: FrozenSessionTarget['newSession'];
    if (frozenNewSession === undefined || frozenNewSession === null) {
      newSession = null;
    } else if (isJsonRecord(frozenNewSession)) {
      const recipe = own(frozenNewSession, 'recipe');
      const initialPrompt = own(frozenNewSession, 'initialPrompt');
      if (!isJsonRecord(recipe) || (initialPrompt !== undefined && typeof initialPrompt !== 'string')) {
        return undefined;
      }
      newSession = {
        recipe,
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
      };
    } else {
      return undefined;
    }
    const frozenApproval = own(value, 'approval');
    let approval: FrozenSessionTarget['approval'];
    if (frozenApproval === undefined || frozenApproval === null) {
      approval = null;
    } else if (isJsonRecord(frozenApproval)) {
      const requestId = own(frozenApproval, 'requestId');
      const decision = stringMember(own(frozenApproval, 'decision'), ['allow', 'deny'] as const);
      const scope = stringMember(own(frozenApproval, 'scope'), ['request', 'session'] as const);
      if (typeof requestId !== 'string' || decision === undefined || scope === undefined) {
        return undefined;
      }
      approval = { requestId, decision, scope };
    } else {
      return undefined;
    }
    return {
      kind,
      sessionId,
      idempotencyKey,
      requestedPermissionCeiling,
      remoteApprovalMaxScope,
      newSession,
      approval,
    };
  }
  if (kind !== 'automation') return undefined;
  const automationId = own(value, 'automationId');
  const templateVersion = own(value, 'templateVersion');
  const occurrenceKey = own(value, 'occurrenceKey');
  const resultDelivery = AutomationConversationResultDeliveryV1Schema.safeParse(own(value, 'resultDelivery'));
  if (
    typeof automationId !== 'string'
    || !isNonNegativeSafeInteger(templateVersion)
    || typeof occurrenceKey !== 'string'
    || !resultDelivery.success
  ) return undefined;
  return {
    kind,
    automationId,
    templateVersion,
    occurrenceKey,
    resultDelivery: resultDelivery.data,
  };
}

const INGRESS_DISPOSITIONS = [
  'admitted',
  'rejected',
  'suppressed',
  'pairingConsumed',
  'approvalConsumed',
  'rotationBusy',
  'rotationSuperseded',
  'rotated',
  'connectionDeleted',
  'staleAuthority',
] as const;

function readIngressNonAdmission(value: JsonValue | undefined): IngressNonAdmission | null | undefined {
  if (value === null) return null;
  if (!isJsonRecord(value)) return undefined;
  const reason = stringMember(own(value, 'reason'), CONVERSATION_NON_ADMISSION_REASONS);
  const senderFeedbackEligible = own(value, 'senderFeedbackEligible');
  if (reason === undefined || typeof senderFeedbackEligible !== 'boolean') return undefined;
  return { reason, senderFeedbackEligible };
}

function asIngressObligation(row: StateRow | null):
  | Readonly<{ row: StateRow; value: IngressObligationRecord }>
  | undefined {
  if (row === null || own(row.value, CHANNEL_STATE_FIELD.recordKind) !== CHANNEL_STATE_RECORD_KIND.ingressObligation) {
    return undefined;
  }
  const id = own(row.value, CHANNEL_STATE_FIELD.id);
  const version = own(row.value, CHANNEL_STATE_FIELD.version);
  const connectionId = own(row.value, CHANNEL_STATE_FIELD.connectionId);
  const bindingId = own(row.value, CHANNEL_STATE_FIELD.bindingId);
  const terminal = own(row.value, CHANNEL_STATE_FIELD.terminal);
  const attention = own(row.value, CHANNEL_STATE_FIELD.attention);
  const dueAtProjectionValue = own(row.value, CHANNEL_STATE_FIELD.dueAt);
  const dueAtProjection = dueAtProjectionValue === undefined ? null : dueAtProjectionValue;
  const createdAt = own(row.value, CHANNEL_STATE_FIELD.createdAt);
  const updatedAt = own(row.value, CHANNEL_STATE_FIELD.updatedAt);
  const payload = own(row.value, 'payload');
  if (
    id !== row.rowId
    || version !== 1
    || typeof connectionId !== 'string'
    || typeof bindingId !== 'string'
    || typeof terminal !== 'boolean'
    || typeof attention !== 'boolean'
    || (dueAtProjection !== null && !isNonNegativeSafeInteger(dueAtProjection))
    || !isNonNegativeSafeInteger(createdAt)
    || !isNonNegativeSafeInteger(updatedAt)
    || !isJsonRecord(payload)
  ) return undefined;
  const occurrenceIds = own(payload, 'occurrenceIds');
  const targetValue = own(payload, 'target');
  const target = targetValue === null ? null : readFrozenIngressTarget(targetValue);
  const censusId = own(payload, 'censusId');
  const sourceAuthority = own(payload, 'sourceAuthority');
  const lifecycle = own(payload, 'lifecycle');
  const disposition = own(payload, 'disposition') === null
    ? null
    : stringMember(own(payload, 'disposition'), INGRESS_DISPOSITIONS);
  const nonAdmission = readIngressNonAdmission(own(payload, 'nonAdmission'));
  if (
    !Array.isArray(occurrenceIds)
    || occurrenceIds.length === 0
    || !occurrenceIds.every((occurrenceId) => typeof occurrenceId === 'string')
    || target === undefined
    || typeof censusId !== 'string'
    || !isJsonRecord(sourceAuthority)
    || !isJsonRecord(lifecycle)
    || disposition === undefined
    || nonAdmission === undefined
  ) return undefined;
  const phase = stringMember(
    own(lifecycle, 'phase'),
    ['debounceDue', 'ready', 'attempting', 'retryDue', 'blocked', 'terminal'] as const,
  );
  const attemptCount = own(lifecycle, 'attemptCount');
  const dueAt = own(lifecycle, 'dueAt');
  if (
    phase === undefined
    || !isNonNegativeSafeInteger(attemptCount)
    || (dueAt !== null && !isNonNegativeSafeInteger(dueAt))
    || dueAt !== dueAtProjection
  ) return undefined;
  const connectionAuthorityEpoch = own(sourceAuthority, 'connectionAuthorityEpoch');
  const bindingRevision = own(sourceAuthority, 'bindingRevision');
  const bindingAuthorityEpoch = own(sourceAuthority, 'bindingAuthorityEpoch');
  if (
    !isPositiveSafeInteger(connectionAuthorityEpoch)
    || !isPositiveSafeInteger(bindingRevision)
    || !isPositiveSafeInteger(bindingAuthorityEpoch)
  ) return undefined;
  return {
    row,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.ingressObligation,
      v: 1,
      'connection-id': connectionId,
      'binding-id': bindingId,
      terminal,
      attention,
      'due-at': dueAtProjection,
      'created-at': createdAt,
      'updated-at': updatedAt,
      payload: {
        occurrenceIds,
        censusId,
        target,
        sourceAuthority: { connectionAuthorityEpoch, bindingRevision, bindingAuthorityEpoch },
        lifecycle: { phase, attemptCount, dueAt },
        disposition,
        nonAdmission,
      },
    },
  };
}

function asIngressCensus(row: StateRow | null):
  | Readonly<{ row: StateRow; value: IngressCensusRecord }>
  | undefined {
  if (row === null || own(row.value, CHANNEL_STATE_FIELD.recordKind) !== CHANNEL_STATE_RECORD_KIND.ingressCensus) {
    return undefined;
  }
  const id = own(row.value, CHANNEL_STATE_FIELD.id);
  const version = own(row.value, CHANNEL_STATE_FIELD.version);
  const connectionId = own(row.value, CHANNEL_STATE_FIELD.connectionId);
  const attention = own(row.value, CHANNEL_STATE_FIELD.attention);
  const createdAt = own(row.value, CHANNEL_STATE_FIELD.createdAt);
  const updatedAt = own(row.value, CHANNEL_STATE_FIELD.updatedAt);
  const payload = own(row.value, 'payload');
  if (
    id !== row.rowId
    || version !== 1
    || typeof connectionId !== 'string'
    || !isNonNegativeSafeInteger(createdAt)
    || !isNonNegativeSafeInteger(updatedAt)
    || !isJsonRecord(payload)
  ) return undefined;
  const normalizedIngress = ConversationNormalizedIngressV1Schema.safeParse(own(payload, 'normalizedIngress'));
  const phase = stringMember(own(payload, 'phase'), ['preparing', 'prepared'] as const);
  const connectionAuthorityEpoch = own(payload, 'connectionAuthorityEpoch');
  const maximumObservationAgeMs = own(payload, 'maximumObservationAgeMs');
  const checkpointCoveredAtValue = own(payload, 'checkpointCoveredAt');
  const checkpointCoveredAt = checkpointCoveredAtValue === undefined || checkpointCoveredAtValue === null
    ? null
    : checkpointCoveredAtValue;
  const conflictValue = own(payload, 'conflict');
  const conflict = conflictValue === null
    ? null
    : isJsonRecord(conflictValue) && conflictValue.kind === 'occurrenceEvidenceMismatch'
      && Object.keys(conflictValue).length === 1
      ? { kind: 'occurrenceEvidenceMismatch' } as const
      : undefined;
  const matchedBindings = own(payload, 'matchedBindings');
  if (
    !normalizedIngress.success
    || phase === undefined
    || !isPositiveSafeInteger(connectionAuthorityEpoch)
    || !isValidMaximumObservationAge(maximumObservationAgeMs)
    || (checkpointCoveredAt !== null && !isNonNegativeSafeInteger(checkpointCoveredAt))
    || typeof attention !== 'boolean'
    || conflict === undefined
    || (attention !== (conflict !== null))
    || !Array.isArray(matchedBindings)
  ) return undefined;
  const parsedBindings: IngressCensusMatchedBinding[] = [];
  for (const binding of matchedBindings) {
    if (!isJsonRecord(binding)) return undefined;
    const bindingId = own(binding, 'bindingId');
    const bindingRevision = own(binding, 'bindingRevision');
    const bindingAuthorityEpoch = own(binding, 'bindingAuthorityEpoch');
    if (
      typeof bindingId !== 'string'
      || !isPositiveSafeInteger(bindingRevision)
      || !isPositiveSafeInteger(bindingAuthorityEpoch)
    ) return undefined;
    parsedBindings.push({ bindingId, bindingRevision, bindingAuthorityEpoch });
  }
  let normalizedBindings: readonly IngressCensusMatchedBinding[];
  try {
    normalizedBindings = normalizeIngressCensusMatchedBindings(parsedBindings);
  } catch {
    return undefined;
  }
  return {
    row,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.ingressCensus,
      v: 1,
      'connection-id': connectionId,
      attention,
      'created-at': createdAt,
      'updated-at': updatedAt,
      payload: {
        normalizedIngress: normalizedIngress.data,
        phase,
        connectionAuthorityEpoch,
        maximumObservationAgeMs,
        checkpointCoveredAt,
        conflict,
        matchedBindings: normalizedBindings,
      },
    },
  };
}

async function readPreparedIngressForObligation(input: Readonly<{
  context: PluginInvocationContext;
  obligation: IngressObligationRecord;
}>): Promise<ConversationNormalizedIngressV1> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const census = asIngressCensus(readStateRow(await collection.get(
    input.obligation.payload.censusId,
    { signal: input.context.signal },
  )) ?? null);
  if (
    census === undefined
    || census.value.payload.phase !== 'prepared'
    || census.value['connection-id'] !== input.obligation['connection-id']
    || !census.value.payload.matchedBindings.some((member) => (
      member.bindingId === input.obligation['binding-id']
      && member.bindingRevision === input.obligation.payload.sourceAuthority.bindingRevision
      && member.bindingAuthorityEpoch === input.obligation.payload.sourceAuthority.bindingAuthorityEpoch
    ))
  ) {
    throw pluginError(
      'channels_ingress_census_unprepared',
      'The ingress obligation does not reference its exact prepared census.',
      true,
    );
  }
  return census.value.payload.normalizedIngress;
}

function asCheckpoint(row: StateRow | null): Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined {
  if (row === null || own(row.value, CHANNEL_STATE_FIELD.recordKind) !== CHANNEL_STATE_RECORD_KIND.checkpoint) {
    return undefined;
  }
  const id = own(row.value, CHANNEL_STATE_FIELD.id);
  const connectionId = own(row.value, CHANNEL_STATE_FIELD.connectionId);
  const createdAt = own(row.value, CHANNEL_STATE_FIELD.createdAt);
  const updatedAt = own(row.value, CHANNEL_STATE_FIELD.updatedAt);
  const payload = own(row.value, 'payload');
  if (
    id !== row.rowId
    || typeof connectionId !== 'string'
    || !isNonNegativeSafeInteger(createdAt)
    || !isNonNegativeSafeInteger(updatedAt)
    || !isJsonRecord(payload)
  ) return undefined;
  const authorityEpoch = own(payload, 'authorityEpoch');
  const opaqueToken = own(payload, 'opaqueToken');
  const lastOccurrenceId = own(payload, 'lastOccurrenceId');
  const revision = own(payload, 'revision');
  const nextPollNotBeforeMs = own(payload, 'nextPollNotBeforeMs');
  if (
    !isPositiveSafeInteger(authorityEpoch)
    || opaqueToken === undefined
    || (lastOccurrenceId !== null && typeof lastOccurrenceId !== 'string')
    || !isPositiveSafeInteger(revision)
    || (nextPollNotBeforeMs !== null && !isNonNegativeSafeInteger(nextPollNotBeforeMs))
  ) return undefined;
  return {
    row,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.checkpoint,
      'connection-id': connectionId,
      'created-at': createdAt,
      'updated-at': updatedAt,
      payload: { authorityEpoch, opaqueToken, lastOccurrenceId, revision, nextPollNotBeforeMs },
    },
  };
}

function assertCurrentConnection(input: Readonly<{
  connection: ChannelConnectionRecord;
  source: IngressExecutionSource;
  observation?: ConversationAuthenticatedObservationShellV1;
}>): void {
  const { connection, source, observation } = input;
  const payload = connection.payload;
  if (source.kind === 'providerObservation') {
    if (!hasCurrentConversationTransportCaller({
      caller: source.caller,
      providerPluginId: payload.providerPluginId,
      transportOrigin: payload.transportOrigin,
    })) {
      throw pluginError(
        'channels_ingress_stale_authority',
        'The provider observation caller is no longer the current transport authority for the connection.',
      );
    }
    if (source.directAction && payload.transport.kind === 'checkpointedPull') {
      throw pluginError(
        'channels_ingress_checkpointed_pull_direct_unavailable',
        'Checkpointed-pull observations are admitted only by the checkpointed poll owner.',
      );
    }
  } else if (
    payload.providerPluginId !== source.executionOrigin.materializationRef.pluginId
    || !arePluginMachineExecutionOriginsEqual(payload.transportOrigin, source.executionOrigin)
    || payload.authorityEpoch !== source.authorityEpoch
  ) {
    throw pluginError(
      'channels_ingress_stale_authority',
      'The checkpointed poll no longer holds the current connection authority.',
      true,
    );
  }
  if (
    !payload.enabled
    || payload.deletionState !== 'none'
    || hasUnsettledDestructiveOldTransportStop(payload)
    || (source.kind === 'providerObservation' && payload.historyGap !== null)
  ) {
    throw pluginError(
      'channels_ingress_connection_unavailable',
      'The connection is disabled, deleting, or has a durable history gap.',
      true,
    );
  }
  if (
    input.observation !== undefined
    && input.observation.transport.kind !== expectedObservationTransport(payload.transport.kind)
  ) {
    throw pluginError(
      'channels_ingress_transport_mismatch',
      'The provider observation transport does not match the selected connection transport.',
    );
  }
}

function ingressShell(input: ConversationNormalizedIngressV1): ConversationAuthenticatedObservationShellV1 {
  if (input.kind === 'routableNonAdmission') return input.shell;
  const observation = input.observation;
  const message = observation.message;
  const shellMessage = message.addressingEvidence === 'replyToIntegration'
    ? {
      id: message.id,
      ...(message.revision === undefined ? {} : { revision: message.revision }),
      replyToMessageId: message.replyToMessageId,
      addressingEvidence: message.addressingEvidence,
      contentProvenance: message.contentProvenance,
      providerTimestamp: message.providerTimestamp,
    }
    : {
      id: message.id,
      ...(message.revision === undefined ? {} : { revision: message.revision }),
      ...(message.replyToMessageId === undefined
        ? {}
        : { replyToMessageId: message.replyToMessageId }),
      addressingEvidence: message.addressingEvidence,
      contentProvenance: message.contentProvenance,
      providerTimestamp: message.providerTimestamp,
    };
  return {
    v: observation.v,
    occurrenceId: observation.occurrenceId,
    occurredAt: observation.occurredAt,
    transport: observation.transport,
    endpoint: observation.endpoint,
    actor: observation.actor,
    message: shellMessage,
  };
}

function fullTextObservation(input: ConversationNormalizedIngressV1): ConversationObservationV1 | undefined {
  return input.kind === 'fullText' ? input.observation : undefined;
}

function normalizedIngressDiscriminant(
  input: ConversationNormalizedIngressV1,
): ConversationNormalizedIngressV1 {
  return ConversationNormalizedIngressV1Schema.parse(input);
}

function immutableIngressMatches(
  census: IngressCensusPayload,
  input: ConversationNormalizedIngressV1,
): boolean {
  const normalized = normalizedIngressDiscriminant(input);
  if (pluginJsonValuesEqual(census.normalizedIngress, normalized)) return true;
  if (
    census.normalizedIngress.kind !== 'fullText'
    || normalized.kind !== 'routableNonAdmission'
    || normalized.reason !== 'unsupportedEdit'
  ) return false;
  const admittedShell = ingressShell(census.normalizedIngress);
  const incomingShell = normalized.shell;
  if (admittedShell.message.revision === incomingShell.message.revision) return false;
  const { revision: _admittedRevision, providerTimestamp: _admittedTimestamp, ...admittedMessage } = admittedShell.message;
  const { revision: _incomingRevision, providerTimestamp: _incomingTimestamp, ...incomingMessage } = incomingShell.message;
  return pluginJsonValuesEqual(
    { ...admittedShell, message: admittedMessage },
    { ...incomingShell, message: incomingMessage },
  );
}

function combineIngressCheckpointOutcomes(
  current: IngressCheckpointOutcome,
  next: IngressCheckpointOutcome,
): IngressCheckpointOutcome {
  if (current === 'unsettled' || next === 'unsettled') return 'unsettled';
  return 'checkpointSafe';
}

/**
 * `occurredAt` is minted by the provider's clock, so an observation that is in
 * fact brand new can carry a timestamp ahead of this host's clock. Treating
 * that lead as staleness dropped the message *and* let the poll checkpoint
 * advance past it, so the bounded forward allowance is what keeps a one-second
 * clock difference from silently losing inbound mail. The allowance stays
 * bounded because `occurredAt` also pins the census retention horizon.
 */
function isObservationFresh(
  maximumObservationAgeMs: number,
  observation: ConversationAuthenticatedObservationShellV1,
): boolean {
  const observedAgeMs = Date.now() - observation.occurredAt;
  return observedAgeMs >= -MAX_CONVERSATION_OBSERVATION_CLOCK_SKEW_MS
    && observedAgeMs <= maximumObservationAgeMs;
}

function isAddressedForBinding(
  binding: ChannelBindingRecord,
  observation: ConversationAuthenticatedObservationShellV1,
): boolean {
  if (binding.payload.inputMode === 'allAllowedMessages') return true;
  const direct = observation.endpoint.audience === 'direct';
  if (binding.payload.inputMode === 'directMentionsOnly') {
    return direct || observation.message.addressingEvidence === 'directIntegrationMention';
  }
  return direct || observation.message.addressingEvidence !== 'none';
}

function sessionDisplayNameSnapshot(label: string | undefined): string | undefined {
  if (label === undefined || label !== label.normalize('NFC') || Array.from(label).length > 128) {
    return undefined;
  }
  return label;
}

type IngressAdmissionDecision = Readonly<{
  terminalOutcome: Readonly<{ disposition: IngressDisposition; nonAdmission: IngressNonAdmission }> | undefined;
  newSession: FrozenSessionTarget['newSession'];
  approval: FrozenSessionTarget['approval'];
}>;

/**
 * Classifies one observed command exactly once, then freezes the only C3
 * control request that can change the binding target.  The later dispatcher
 * consumes this durable result rather than consulting mutable binding policy.
 */
function ingressAdmissionDecision(input: Readonly<{
  binding: ChannelBindingRecord;
  bindingRevision: number;
  ingress: ConversationNormalizedIngressV1;
}>): IngressAdmissionDecision {
  const { binding, ingress } = input;
  const shell = ingressShell(ingress);
  const fullText = fullTextObservation(ingress);
  const actorAllowed = shell.actor.principalId !== null
    && binding.payload.allowedPrincipalIds.includes(shell.actor.principalId);
  const newSessionPolicy = binding.payload.target.kind === 'session'
    ? binding.payload.target.policy.newSession
    : { kind: 'off' as const };
  const newSessionEnabled = newSessionPolicy.kind === 'enabled'
    && shell.actor.principalId !== null
    && (newSessionPolicy.principalIds === undefined
      || newSessionPolicy.principalIds.includes(shell.actor.principalId));
  // An Automation target has no Session permission surface, so it reads as the
  // same persisted `off` the Session arm uses.
  const approvalPolicy = binding.payload.target.kind === 'session'
    ? binding.payload.target.policy.approvals
    : { kind: 'off' as const };
  const approvalCommandsEnabled = approvalPolicy.kind === 'enabled'
    && shell.actor.principalId !== null
    && (approvalPolicy.principalIds === undefined
      || approvalPolicy.principalIds.includes(shell.actor.principalId));
  const command = classifyConversationCommand(fullText?.message.text ?? '');
  const policy = decideConversationCommandPolicy({
    command,
    actor: shell.actor,
    contentProvenance: shell.message.contentProvenance,
    actorAllowed,
    allowBotSenders: binding.payload.allowBotSenders,
    targetKind: binding.payload.target.kind,
    approvalCommandsEnabled,
    newSessionEnabled,
    senderFeedback: binding.payload.senderFeedback,
  });
  if (policy.kind === 'terminal') {
    return {
      terminalOutcome: {
        disposition: policy.disposition,
        nonAdmission: {
          reason: policy.reason,
          senderFeedbackEligible: policy.senderFeedbackEligible,
        },
      },
      newSession: null,
      approval: null,
    };
  }
  if (policy.kind === 'approve') {
    return {
      terminalOutcome: undefined,
      newSession: null,
      approval: {
        requestId: policy.requestId,
        decision: policy.decision,
        scope: policy.scope,
      },
    };
  }
  if (policy.kind === 'newSession') {
    if (newSessionPolicy.kind !== 'enabled') {
      throw pluginError(
        'channels_ingress_new_session_policy_invalid',
        'The admitted /new command has no enabled frozen Session policy.',
      );
    }
    return {
      terminalOutcome: undefined,
      newSession: {
        recipe: newSessionPolicy.recipe,
        ...(policy.initialPrompt === undefined ? {} : { initialPrompt: policy.initialPrompt }),
      },
      approval: null,
    };
  }
  if (ingress.kind === 'routableNonAdmission') {
    return {
      terminalOutcome: {
        disposition: 'rejected',
        nonAdmission: {
          reason: ingress.reason,
          senderFeedbackEligible: ingress.reason !== 'unsupportedEdit'
            && isConversationSenderFeedbackEligible({
              senderFeedback: binding.payload.senderFeedback,
              actorPrincipalId: shell.actor.principalId,
              actorAllowed,
              reason: ingress.reason,
            }),
        },
      },
      newSession: null,
      approval: null,
    };
  }
  if (!isAddressedForBinding(binding, shell)) {
    return {
      terminalOutcome: {
        disposition: 'rejected',
        nonAdmission: {
          reason: 'notAddressed',
          senderFeedbackEligible: isConversationSenderFeedbackEligible({
            senderFeedback: binding.payload.senderFeedback,
            actorPrincipalId: shell.actor.principalId,
            actorAllowed,
            reason: 'notAddressed',
          }),
        },
      },
      newSession: null,
      approval: null,
    };
  }
  return { terminalOutcome: undefined, newSession: null, approval: null };
}

function decodeBase64Url(value: string): Uint8Array {
  const decoded = tryDecodeBase64Url(value);
  if (decoded === null) {
    throw pluginError(
      'channels_ingress_routing_key_invalid',
      'The connection routing identity key is not a valid base64url HMAC key.',
    );
  }
  return decoded;
}

async function opaqueHmacRowId(input: Readonly<{
  routingIdentityKey: string;
  domain: 'ingress-obligation' | 'ingress-census' | 'checkpoint' | 'session-rotation';
  parts: readonly string[];
}>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw pluginError(
      'channels_ingress_crypto_unavailable',
      'The runtime cannot derive a durable Channel routing identity.',
      true,
    );
  }
  const key = await importHmacSha256Key(subtle, decodeBase64Url(input.routingIdentityKey));
  return await signLengthPrefixedUtf8HmacSha256Base64Url({
    subtle,
    key,
    parts: ['channels:ingress:v1', input.domain, ...input.parts],
  });
}

/** The one private checkpoint identity remains connection-keyed across lifecycle fences. */
export async function deriveConversationCheckpointRowId(input: Readonly<{
  routingIdentityKey: string;
  connectionId: string;
}>): Promise<string> {
  return await opaqueHmacRowId({
    routingIdentityKey: input.routingIdentityKey,
    domain: 'checkpoint',
    parts: [input.connectionId],
  });
}

/** The one private session-rotation identity is binding-scoped beneath its connection key. */
export async function deriveConversationSessionRotationRowId(input: Readonly<{
  routingIdentityKey: string;
  connectionId: string;
  bindingId: string;
}>): Promise<string> {
  return await opaqueHmacRowId({
    routingIdentityKey: input.routingIdentityKey,
    domain: 'session-rotation',
    parts: [input.connectionId, input.bindingId],
  });
}

/** The ingress census remains in the established private connection-keyed HMAC namespace. */
export async function deriveIngressCensusRowId(input: Readonly<{
  routingIdentityKey: string;
  connectionId: string;
  occurrenceId: string;
}>): Promise<string> {
  return opaqueHmacRowId({
    routingIdentityKey: input.routingIdentityKey,
    domain: 'ingress-census',
    parts: [input.connectionId, input.occurrenceId],
  });
}

function compareCanonicalBindingId(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Canonicalizes the one bounded routing fact before its immutable census write. */
export function normalizeIngressCensusMatchedBindings(
  bindings: readonly IngressCensusMatchedBinding[],
): readonly IngressCensusMatchedBinding[] {
  if (bindings.length > MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) {
    throw pluginError(
      'channels_ingress_census_binding_limit_exceeded',
      'The ingress census exceeds the bounded Channel binding set.',
    );
  }
  const normalized = bindings.map((binding) => {
    if (
      !ConversationBindingIdV1Schema.safeParse(binding.bindingId).success
      || !isPositiveSafeInteger(binding.bindingRevision)
      || !isPositiveSafeInteger(binding.bindingAuthorityEpoch)
    ) {
      throw pluginError(
        'channels_ingress_census_binding_invalid',
        'The ingress census contains an invalid frozen binding fact.',
      );
    }
    return {
      bindingId: binding.bindingId,
      bindingRevision: binding.bindingRevision,
      bindingAuthorityEpoch: binding.bindingAuthorityEpoch,
    };
  });
  normalized.sort((left, right) => compareCanonicalBindingId(left.bindingId, right.bindingId));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.bindingId === normalized[index]!.bindingId) {
      throw pluginError(
        'channels_ingress_census_binding_duplicate',
        'The ingress census contains the same binding more than once.',
      );
    }
  }
  return normalized;
}

/** Prepared immutable value for the sole ingress census writer. */
export function createIngressCensusValue(input: Readonly<{
  censusId: string;
  connectionId: string;
  ingress: ConversationNormalizedIngressV1;
  connectionAuthorityEpoch: number;
  maximumObservationAgeMs: number;
  matchedBindings: readonly IngressCensusMatchedBinding[];
  now: number;
}>): JsonRecord {
  if (!isPositiveSafeInteger(input.connectionAuthorityEpoch)) {
    throw pluginError(
      'channels_ingress_census_authority_invalid',
      'The ingress census has no valid frozen connection authority epoch.',
    );
  }
  if (!isValidMaximumObservationAge(input.maximumObservationAgeMs)) {
    throw pluginError(
      'channels_ingress_census_observation_age_invalid',
      'The ingress census has no valid frozen maximum observation age.',
    );
  }
  return {
    id: input.censusId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressCensus,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connectionId,
    [CHANNEL_STATE_FIELD.attention]: false,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      normalizedIngress: normalizedIngressDiscriminant(input.ingress),
      phase: 'preparing',
      connectionAuthorityEpoch: input.connectionAuthorityEpoch,
      maximumObservationAgeMs: input.maximumObservationAgeMs,
      checkpointCoveredAt: null,
      conflict: null,
      matchedBindings: normalizeIngressCensusMatchedBindings(input.matchedBindings),
    },
  };
}

async function readBindingsForConnection(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
}>): Promise<readonly Readonly<{ row: StateRow; value: ChannelBindingRecord }>[]> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const bindings: Array<Readonly<{ row: StateRow; value: ChannelBindingRecord }>> = [];
  let cursor: string | undefined;
  do {
    const remaining = MAX_CONVERSATION_BINDINGS_PER_ACCOUNT - bindings.length;
    if (remaining <= 0) {
      throw pluginError(
        'channels_ingress_binding_limit_exceeded',
        'The Account has more Channel bindings than ingress is permitted to inspect.',
      );
    }
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
      limit: Math.min(remaining, MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE),
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: input.context.signal });
    for (const candidate of page.rows) {
      const row = readStateRow(candidate);
      if (row === undefined) continue;
      const binding = asBinding(row);
      if (binding !== undefined && binding.value['connection-id'] === input.connectionId) {
        bindings.push(binding);
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return bindings;
}

function frozenTargetForBinding(input: Readonly<{
  obligationId: string;
  connection: ChannelConnectionRecord;
  binding: ChannelBindingRecord;
  bindingRevision: number;
  ingress: ConversationNormalizedIngressV1;
  newSession: FrozenSessionTarget['newSession'];
  approval: FrozenSessionTarget['approval'];
}>): FrozenIngressTarget {
  const { binding } = input;
  if (binding.payload.target.kind === 'session') {
    const approvals = binding.payload.target.policy.approvals;
    const target: FrozenSessionTarget = {
      kind: 'session',
      sessionId: binding.payload.target.sessionId,
      idempotencyKey: `channels:input:v1:${input.obligationId}`,
      requestedPermissionCeiling: binding.payload.target.policy.permissionCeiling,
      remoteApprovalMaxScope: approvals.kind === 'enabled' ? approvals.maximumScope : 'off',
      newSession: input.newSession,
      approval: input.approval,
    };
    if (!isCanonicalChannelStateRecordIdentity({
      rowId: input.obligationId,
      recordKind: CHANNEL_STATE_RECORD_KIND.ingressObligation,
      ingressTargetKind: target.kind,
      sessionIdempotencyKey: target.idempotencyKey,
    })) {
      throw pluginError(
        'channels_ingress_identity_invalid',
        'The derived Session ingress obligation identity is not canonical.',
      );
    }
    return target;
  }
  const target: FrozenAutomationTarget = {
    kind: 'automation',
    automationId: binding.payload.target.automationId,
    templateVersion: binding.payload.target.templateVersion,
    occurrenceKey: ingressShell(input.ingress).occurrenceId,
    resultDelivery: binding.payload.target.policy.resultDelivery === 'none'
      ? { kind: 'none' }
      : {
        kind: 'finalResult',
        actionRef: CONVERSATION_AUTOMATION_RESULT_DELIVERY_ACTION_REF_V1,
        opaqueContext: {
          v: 1,
          kind: 'conversationAutomationResultDelivery',
          connectionId: input.connection.id,
          bindingId: binding.id,
          bindingRevision: input.bindingRevision,
          connectionAuthorityEpoch: input.connection.payload.authorityEpoch,
          bindingAuthorityEpoch: binding.payload.authorityEpoch,
          linkPreviewPolicy: binding.payload.linkPreviewPolicy,
          endpoint: {
            kind: ingressShell(input.ingress).endpoint.kind,
            audience: ingressShell(input.ingress).endpoint.audience,
            id: ingressShell(input.ingress).endpoint.id,
            ...(ingressShell(input.ingress).endpoint.parentId === undefined
              ? {}
              : { parentId: ingressShell(input.ingress).endpoint.parentId }),
          },
          reply: {
            providerMessageId: ingressShell(input.ingress).message.id,
            ...(ingressShell(input.ingress).message.replyToMessageId === undefined
              ? {}
              : { providerReplyToMessageId: ingressShell(input.ingress).message.replyToMessageId }),
          },
        },
      },
  };
  if (!isCanonicalChannelStateRecordIdentity({
    rowId: input.obligationId,
    recordKind: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    ingressTargetKind: target.kind,
  })) {
    throw pluginError(
      'channels_ingress_identity_invalid',
      'The derived Automation ingress obligation identity is not canonical.',
    );
  }
  return target;
}

/**
 * Once a census exists, current connection state still fences its caller, but
 * it must not reclassify or restamp an obligation that belongs to that census.
 */
function frozenConnectionForIngressCensus(input: Readonly<{
  connection: ChannelConnectionRecord;
  census: IngressCensusPayload;
}>): ChannelConnectionRecord {
  return {
    ...input.connection,
    payload: {
      ...input.connection.payload,
      authorityEpoch: input.census.connectionAuthorityEpoch,
      maximumObservationAgeMs: input.census.maximumObservationAgeMs,
    },
  };
}

function createIngressObligationValue(input: Readonly<{
  censusId: string;
  obligationId: string;
  connection: ChannelConnectionRecord;
  binding: ChannelBindingRecord;
  bindingRevision: number;
  ingress: ConversationNormalizedIngressV1;
  target: FrozenIngressTarget;
  terminalOutcome: Readonly<{ disposition: IngressDisposition; nonAdmission: IngressNonAdmission }> | undefined;
  now: number;
}>): JsonRecord {
  const terminal = input.terminalOutcome !== undefined;
  const shell = ingressShell(input.ingress);
  const dueAt = terminal ? null : input.now + input.binding.payload.inboundDebounceMs;
  return {
    id: input.obligationId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connection.id,
    [CHANNEL_STATE_FIELD.bindingId]: input.binding.id,
    [CHANNEL_STATE_FIELD.terminal]: terminal,
    [CHANNEL_STATE_FIELD.attention]: input.terminalOutcome !== undefined,
    ...(dueAt === null ? {} : { [CHANNEL_STATE_FIELD.dueAt]: dueAt }),
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      occurrenceIds: [shell.occurrenceId],
      censusId: input.censusId,
      target: input.target,
      sourceAuthority: {
        connectionAuthorityEpoch: input.connection.payload.authorityEpoch,
        bindingRevision: input.bindingRevision,
        bindingAuthorityEpoch: input.binding.payload.authorityEpoch,
      },
      lifecycle: {
        phase: terminal
          ? 'terminal'
          : input.binding.payload.inboundDebounceMs > 0 ? 'debounceDue' : 'ready',
        attemptCount: 0,
        dueAt,
      },
      disposition: input.terminalOutcome?.disposition ?? null,
      nonAdmission: input.terminalOutcome?.nonAdmission ?? null,
    },
  };
}

function createStaleIngressObligationValue(input: Readonly<{
  obligationId: string;
  censusId: string;
  connectionId: string;
  connectionAuthorityEpoch: number;
  member: IngressCensusMatchedBinding;
  occurrenceId: string;
  now: number;
}>): JsonRecord {
  return {
    id: input.obligationId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connectionId,
    [CHANNEL_STATE_FIELD.bindingId]: input.member.bindingId,
    [CHANNEL_STATE_FIELD.terminal]: true,
    [CHANNEL_STATE_FIELD.attention]: true,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      occurrenceIds: [input.occurrenceId],
      censusId: input.censusId,
      target: null,
      sourceAuthority: {
        connectionAuthorityEpoch: input.connectionAuthorityEpoch,
        bindingRevision: input.member.bindingRevision,
        bindingAuthorityEpoch: input.member.bindingAuthorityEpoch,
      },
      lifecycle: { phase: 'terminal', attemptCount: 0, dueAt: null },
      disposition: 'staleAuthority',
      nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
    },
  };
}

function preparedIngressCensusValue(input: Readonly<{
  census: IngressCensusRecord;
  now: number;
}>): JsonRecord {
  return {
    ...input.census,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: { ...input.census.payload, phase: 'prepared' },
  };
}

/**
 * Checkpoint coverage is a content-free fact. It is written in the same
 * Account Collection batch as the checkpoint that makes replay of this
 * prepared, fully terminal census unnecessary.
 */
function checkpointCoveredIngressCensusValue(input: Readonly<{
  census: IngressCensusRecord;
  now: number;
}>): JsonRecord {
  if (input.census.attention || input.census.payload.conflict !== null) {
    throw pluginError(
      'channels_ingress_occurrence_conflict',
      'A conflicting ingress census can never receive checkpoint coverage.',
    );
  }
  return {
    ...input.census,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: { ...input.census.payload, checkpointCoveredAt: input.now },
  };
}

function occurrenceConflictIngressCensusValue(input: Readonly<{
  census: IngressCensusRecord;
  now: number;
}>): JsonRecord {
  if (input.census.attention || input.census.payload.conflict !== null) {
    throw pluginError(
      'channels_ingress_census_invalid',
      'The ingress census conflict transition requires its exact null/false predecessor.',
    );
  }
  return {
    ...input.census,
    [CHANNEL_STATE_FIELD.attention]: true,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.census.payload,
      conflict: { kind: 'occurrenceEvidenceMismatch' },
    },
  };
}

/**
 * Contradictory occurrence evidence is terminal on the census itself. The
 * byte-identical connection put is an intentional revision fence against an
 * in-flight checkpoint commit; it copies no conflict state onto the
 * connection.
 */
async function markIngressCensusOccurrenceConflict(input: Readonly<{
  context: PluginInvocationContext;
  source: IngressExecutionSource;
  observation: ConversationNormalizedIngressV1;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
}>): Promise<void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const shell = ingressShell(input.observation);
  let connection = input.connection;
  let census = input.census;
  while (true) {
    assertCurrentConnection({ connection: connection.value, source: input.source, observation: shell });
    if (census.value.attention && census.value.payload.conflict?.kind === 'occurrenceEvidenceMismatch') {
      return;
    }
    if (census.value.attention || census.value.payload.conflict !== null) {
      throw pluginError(
        'channels_ingress_census_invalid',
        'The ingress census has an invalid conflict/attention pair.',
      );
    }
    const result = await collection.batch([
      {
        kind: 'put',
        value: connection.row.value,
        expectedRevision: connection.row.revision,
      },
      {
        kind: 'put',
        value: occurrenceConflictIngressCensusValue({ census: census.value, now: Date.now() }),
        expectedRevision: census.row.revision,
      },
    ], { signal: input.context.signal });
    if (result.status !== 'conflict') return;

    const rereadConnection = asConnection(readStateRow(await collection.get(
      connection.row.rowId,
      { signal: input.context.signal },
    )) ?? null);
    const rereadCensus = asIngressCensus(readStateRow(await collection.get(
      census.row.rowId,
      { signal: input.context.signal },
    )) ?? null);
    if (rereadConnection === undefined || rereadCensus === undefined) {
      throw pluginError(
        'channels_ingress_stale_authority',
        'The connection or immutable census changed before its conflict fact could commit.',
        true,
      );
    }
    assertCurrentConnection({ connection: rereadConnection.value, source: input.source, observation: shell });
    if (rereadCensus.value.attention && rereadCensus.value.payload.conflict?.kind === 'occurrenceEvidenceMismatch') {
      return;
    }
    if (matchesIngressCensus({ census: rereadCensus.value.payload, ingress: input.observation })) {
      throw pluginError(
        'channels_ingress_stale_authority',
        'The immutable ingress evidence changed before its conflict fact could commit.',
        true,
      );
    }
    connection = rereadConnection;
    census = rereadCensus;
  }
}

/**
 * Ingress preparation settles every obligation it writes against one immutable
 * census fence, so each batch carries that fence plus as many puts as the
 * deployment admits.
 *
 * What may travel together is the Account Data owner's fact, not this plugin's:
 * `limits` is what the deployment enforces and `measurement` is what the sealed
 * request actually costs, both read from the collection handle. Channels only
 * decides what must settle atomically, then packs greedily against those
 * measured bytes.
 *
 * `measurement` must describe `[fence, ...values as puts]`, in that order.
 */
export function partitionIngressPreparationValues(input: Readonly<{
  values: readonly JsonRecord[];
  limits: PluginCollectionLimits;
  measurement: PluginCollectionBatchMeasurement;
}>): readonly (readonly JsonRecord[])[] {
  const { values, limits, measurement } = input;
  if (values.length === 0) return [];
  const fenceEncodedBytes = measurement.operationEncodedBytes[0];
  if (
    fenceEncodedBytes === undefined
    || measurement.operationEncodedBytes.length !== values.length + 1
  ) {
    throw pluginError(
      'channels_ingress_preparation_unmeasured',
      'Ingress preparation batching requires a measurement of its fence and every prepared value.',
    );
  }
  const budgetEncodedBytes = limits.maxBatchBytes
    - measurement.overheadEncodedBytes
    - fenceEncodedBytes;
  const maximumPutsPerBatch = limits.maxBatchRows - 1;
  const batches: JsonRecord[][] = [];
  let current: JsonRecord[] = [];
  let currentEncodedBytes = 0;
  for (const [index, value] of values.entries()) {
    const putEncodedBytes = measurement.operationEncodedBytes[index + 1]!;
    if (putEncodedBytes > budgetEncodedBytes || maximumPutsPerBatch < 1) {
      throw pluginError(
        'channels_ingress_preparation_oversized',
        'A prepared ingress obligation exceeds what one Account Collection batch can carry.',
      );
    }
    if (
      current.length > 0
      && (
        current.length >= maximumPutsPerBatch
        || currentEncodedBytes + putEncodedBytes > budgetEncodedBytes
      )
    ) {
      batches.push(current);
      current = [];
      currentEncodedBytes = 0;
    }
    current.push(value);
    currentEncodedBytes += putEncodedBytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function terminalIngressObligationValue(input: Readonly<{
  obligation: IngressObligationRecord;
  disposition: IngressDisposition;
  nonAdmission?: IngressNonAdmission;
  now: number;
}>): JsonRecord {
  const { [CHANNEL_STATE_FIELD.dueAt]: _dueAt, ...obligationWithoutDueAt } = input.obligation;
  return {
    ...obligationWithoutDueAt,
    [CHANNEL_STATE_FIELD.terminal]: true,
    [CHANNEL_STATE_FIELD.attention]: input.nonAdmission !== undefined,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.obligation.payload,
      lifecycle: {
        phase: 'terminal',
        attemptCount: input.obligation.payload.lifecycle.attemptCount,
        dueAt: null,
      },
      disposition: input.disposition,
      nonAdmission: input.nonAdmission ?? null,
    },
  };
}

/**
 * The ingress owner decides whether a retained obligation can be terminalized
 * for connection deletion. Management consumes this narrow result instead of
 * reparsing ingress custody or inventing a second terminal-state predicate.
 */
export type ConversationIngressConnectionDeletionSettlement =
  | Readonly<{
    kind: 'readyToSettle';
    connectionId: string;
    bindingId: string;
    value: JsonRecord;
  }>
  | Readonly<{
    kind: 'terminal';
    connectionId: string;
    bindingId: string;
  }>
  | Readonly<{
    kind: 'blocked';
    connectionId: string;
    bindingId: string;
  }>
  | Readonly<{ kind: 'invalid' }>;

/** Binding deletion shares ingress custody; only the terminal disposition differs. */
export type ConversationIngressBindingDeletionSettlement = ConversationIngressConnectionDeletionSettlement;

function prepareConversationIngressObligationForDeletion(input: Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
  now: number;
  disposition: 'connectionDeleted' | 'staleAuthority';
  nonAdmission?: IngressNonAdmission;
}>): ConversationIngressConnectionDeletionSettlement {
  if (!isJsonRecord(input.value)) return { kind: 'invalid' };
  const obligation = asIngressObligation({
    rowId: input.rowId,
    revision: input.revision,
    value: input.value,
  });
  if (obligation === undefined) return { kind: 'invalid' };
  const connectionId = obligation.value['connection-id'];
  const bindingId = obligation.value['binding-id'];
  if (obligation.value.payload.lifecycle.phase === 'terminal') {
    return { kind: 'terminal', connectionId, bindingId };
  }
  if (!['ready', 'debounceDue', 'retryDue'].includes(obligation.value.payload.lifecycle.phase)) {
    return { kind: 'blocked', connectionId, bindingId };
  }
  return {
    kind: 'readyToSettle',
    connectionId,
    bindingId,
    value: terminalIngressObligationValue({
      obligation: obligation.value,
      disposition: input.disposition,
      ...(input.nonAdmission === undefined ? {} : { nonAdmission: input.nonAdmission }),
      now: input.now,
    }),
  };
}

export function prepareConversationIngressObligationForConnectionDeletion(input: Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
  now: number;
}>): ConversationIngressConnectionDeletionSettlement {
  return prepareConversationIngressObligationForDeletion({
    ...input,
    disposition: 'connectionDeleted',
  });
}

/**
 * A finalizing binding has already revoked its authority. Work that has not
 * begun externally becomes the ordinary stale-authority terminal outcome;
 * attempting and blocked custody remains with its incumbent recovery owner.
 */
export function prepareConversationIngressObligationForBindingDeletion(input: Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
  now: number;
}>): ConversationIngressBindingDeletionSettlement {
  return prepareConversationIngressObligationForDeletion({
    ...input,
    disposition: 'staleAuthority',
    nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
  });
}

function attemptingIngressObligationValue(input: Readonly<{
  obligation: IngressObligationRecord;
  now: number;
}>): JsonRecord {
  const { [CHANNEL_STATE_FIELD.dueAt]: _dueAt, ...obligationWithoutDueAt } = input.obligation;
  return {
    ...obligationWithoutDueAt,
    [CHANNEL_STATE_FIELD.terminal]: false,
    [CHANNEL_STATE_FIELD.attention]: false,
    [CHANNEL_STATE_FIELD.dueAt]: input.now + INGRESS_RECOVERY_DELAY_MS,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.obligation.payload,
      lifecycle: {
        phase: 'attempting',
        attemptCount: input.obligation.payload.lifecycle.attemptCount + 1,
        dueAt: input.now + INGRESS_RECOVERY_DELAY_MS,
      },
      disposition: null,
    },
  };
}

function retryDueIngressObligationValue(input: Readonly<{
  obligation: IngressObligationRecord;
  now: number;
}>): JsonRecord {
  const attemptCount = input.obligation.payload.lifecycle.attemptCount;
  const dueAt = input.now + conversationRetryDelayMs(attemptCount);
  return {
    ...input.obligation,
    [CHANNEL_STATE_FIELD.terminal]: false,
    [CHANNEL_STATE_FIELD.attention]: false,
    [CHANNEL_STATE_FIELD.dueAt]: dueAt,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.obligation.payload,
      lifecycle: { phase: 'retryDue', attemptCount, dueAt },
      disposition: null,
      nonAdmission: null,
    },
  };
}

function blockedIngressObligationValue(input: Readonly<{
  obligation: IngressObligationRecord;
  now: number;
}>): JsonRecord {
  const { [CHANNEL_STATE_FIELD.dueAt]: _dueAt, ...obligationWithoutDueAt } = input.obligation;
  return {
    ...obligationWithoutDueAt,
    [CHANNEL_STATE_FIELD.terminal]: false,
    [CHANNEL_STATE_FIELD.attention]: true,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.obligation.payload,
      lifecycle: {
        phase: 'blocked',
        attemptCount: input.obligation.payload.lifecycle.attemptCount,
        dueAt: null,
      },
      disposition: null,
      nonAdmission: null,
    },
  };
}

async function putIngressObligationLifecycle(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  value: JsonRecord;
  /** A returned boundary result proved no admission occurred, so aborted caller work may still repair its counter. */
  knownNoEffectCleanup?: boolean;
}>): Promise<Readonly<{ row: StateRow; value: IngressObligationRecord }>> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const result = await collection.batch([
    { kind: 'put', value: input.value, expectedRevision: input.obligation.row.revision },
  ], input.knownNoEffectCleanup === true ? undefined : { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError('channels_ingress_lifecycle_conflict', 'The ingress lifecycle changed before its transition committed.', true);
  }
  const resultRow = result.results.find((entry) => entry.rowId === input.obligation.row.rowId && !entry.deleted);
  const parsed = resultRow === undefined ? undefined : asIngressObligation({
    rowId: resultRow.rowId,
    revision: resultRow.revision,
    value: input.value,
  });
  if (parsed === undefined) throw pluginError('channels_ingress_lifecycle_invalid', 'The persisted ingress lifecycle is invalid.');
  return parsed;
}

/**
 * A retired or replaced contribution is the provider half of stale authority.
 * Its own reader raises exactly these codes; every other failure stays a live
 * boundary error the caller still owns.
 */
function isRetiredProviderContribution(error: unknown): boolean {
  return isPluginError(error)
    && (error.code === 'channels_provider_contribution_unavailable'
      || error.code === 'channels_provider_contribution_ambiguous');
}

/**
 * Row currentness is only half of the authority a dispatch runs under. A
 * debounced, retried, or rotated obligation can become due long after its
 * connection was admitted, so both last-moment fences reread the retained
 * selection against the canonical contribution owner instead of trusting the
 * frozen census. Neither keeps a provider cache or a census-local copy.
 */
async function hasCurrentProviderContributionSelection(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
}>): Promise<boolean> {
  try {
    await readCurrentProviderContributionForPersistedSelection({
      context: {
        targetedContributions: input.context.services.targetedContributions,
        signal: input.context.signal,
      },
      providerPluginId: input.connection.value.payload.providerPluginId,
      providerContributionSelection: input.connection.value.payload.providerContributionSelection,
    });
    return true;
  } catch (error) {
    assertNotAborted(input.context.signal);
    if (!isRetiredProviderContribution(error)) throw error;
    return false;
  }
}

async function revalidateFirstDispatchAuthority(input: Readonly<{
  context: PluginInvocationContext;
  source: IngressExecutionSource;
  connectionId: string;
  bindingId: string;
  obligation: IngressObligationRecord;
  ingress: ConversationNormalizedIngressV1;
}>): Promise<IngressAuthorityFence | undefined> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connection = asConnection(readStateRow(await collection.get(
    input.connectionId,
    { signal: input.context.signal },
  )) ?? null);
  if (connection === undefined) return undefined;
  try {
    assertCurrentConnection({
      connection: connection.value,
      source: input.source,
      observation: ingressShell(input.ingress),
    });
  } catch {
    return undefined;
  }
  if (connection.value.payload.authorityEpoch !== input.obligation.payload.sourceAuthority.connectionAuthorityEpoch) {
    return undefined;
  }
  if (!await hasCurrentProviderContributionSelection({ context: input.context, connection })) {
    return undefined;
  }
  const binding = asBinding(readStateRow(await collection.get(
    input.bindingId,
    { signal: input.context.signal },
  )));
  if (binding !== undefined
    && binding.value['connection-id'] === input.connectionId
    && binding.value.payload.enabled
    && binding.value.payload.deletionState === 'none'
    && binding.row.revision === input.obligation.payload.sourceAuthority.bindingRevision
    && binding.value.payload.authorityEpoch === input.obligation.payload.sourceAuthority.bindingAuthorityEpoch
    && areConversationEndpointIdentitiesEqual(binding.value.payload.endpoint, ingressShell(input.ingress).endpoint)
  ) {
    return { connection, bindings: [binding] };
  }
  return undefined;
}

function ingressAuthorityAssertions(authority: IngressAuthorityFence) {
  return [
    {
      kind: 'assert' as const,
      rowId: authority.connection.row.rowId,
      expectedRevision: authority.connection.row.revision,
    },
    ...authority.bindings.map((binding) => ({
      kind: 'assert' as const,
      rowId: binding.row.rowId,
      expectedRevision: binding.row.revision,
    })),
  ];
}

/**
 * The existing Account collection is the only currentness/CAS owner.  Every
 * durable ingress transition that can precede Session or checkpoint effects
 * therefore carries the exact connection/binding live-row assertions in the
 * same mutation, rather than treating an earlier read as an authority lease.
 */
async function batchPutWithIngressAuthorityFence(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence;
  value: JsonRecord;
  expectedRevision: number | 'absent';
}>): Promise<StateRow> {
  assertNotAborted(input.context.signal);
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const result = await collection.batch([
    ...ingressAuthorityAssertions(input.authority),
    { kind: 'put', value: input.value, expectedRevision: input.expectedRevision },
  ], { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_ingress_stale_authority',
      'Channel authority changed before the guarded ingress transition could commit.',
      true,
    );
  }
  const rowId = input.value[CHANNEL_STATE_FIELD.id];
  if (typeof rowId !== 'string') {
    throw pluginError(
      'channels_ingress_batch_result_invalid',
      'The guarded ingress transition has no canonical string row identity.',
    );
  }
  const resultRow = result.results.find((entry) => entry.rowId === rowId && !entry.deleted);
  if (resultRow === undefined) {
    throw pluginError(
      'channels_ingress_batch_result_invalid',
      'The guarded ingress transition did not return its persisted row.',
      true,
    );
  }
  return { rowId, revision: resultRow.revision, value: input.value };
}

async function settleIngressTerminal(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  disposition: IngressDisposition;
  nonAdmission?: IngressNonAdmission;
}>): Promise<Readonly<{ row: StateRow; value: IngressObligationRecord }>> {
  const row = await batchPutWithIngressAuthorityFence({
    context: input.context,
    authority: input.authority,
    value: terminalIngressObligationValue({
      obligation: input.obligation.value,
      disposition: input.disposition,
      ...(input.nonAdmission === undefined ? {} : { nonAdmission: input.nonAdmission }),
      now: Date.now(),
    }),
    expectedRevision: input.obligation.row.revision,
  });
  const settled = asIngressObligation(row);
  if (settled === undefined) {
    throw pluginError('channels_ingress_settlement_invalid', 'The persisted ingress terminal settlement is invalid.');
  }
  return settled;
}

/**
 * A ready obligation cannot enter an external effect without its live
 * connection/binding fence. Once that guarded transition persisted
 * `attempting`, however, an accepted Session or Automation effect may already
 * exist behind the frozen request. Recovery may settle only that exact
 * attempting obligation; it cannot dispatch, relabel ready work, or bypass a
 * later checkpoint commit.
 */
async function settleAttemptedIngressTerminal(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  disposition: IngressDisposition;
  nonAdmission?: IngressNonAdmission;
}>): Promise<Readonly<{ row: StateRow; value: IngressObligationRecord }>> {
  if (input.obligation.value.payload.lifecycle.phase !== 'attempting') {
    throw pluginError(
      'channels_ingress_attempt_recovery_invalid',
      'Only a durably attempted ingress obligation can recover its terminal settlement.',
    );
  }
  assertNotAborted(input.context.signal);
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const value = terminalIngressObligationValue({
    obligation: input.obligation.value,
    disposition: input.disposition,
    ...(input.nonAdmission === undefined ? {} : { nonAdmission: input.nonAdmission }),
    now: Date.now(),
  });
  const result = await collection.batch([
    { kind: 'put', value, expectedRevision: input.obligation.row.revision },
  ], { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_ingress_attempt_settlement_conflict',
      'The frozen attempted ingress obligation changed before terminal recovery could commit.',
      true,
    );
  }
  const row = result.results.find((entry) => entry.rowId === input.obligation.row.rowId && !entry.deleted);
  if (row === undefined) {
    throw pluginError(
      'channels_ingress_attempt_settlement_invalid',
      'The recovered ingress terminal settlement did not return its retained row.',
      true,
    );
  }
  const settled = asIngressObligation({ rowId: row.rowId, revision: row.revision, value });
  if (settled === undefined) {
    throw pluginError('channels_ingress_attempt_settlement_invalid', 'The recovered ingress terminal settlement is invalid.');
  }
  return settled;
}

async function settleIngressEffectTerminal(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence | undefined;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  disposition: IngressDisposition;
  nonAdmission?: IngressNonAdmission;
}>): Promise<Readonly<{ row: StateRow; value: IngressObligationRecord }>> {
  if (input.authority === undefined) {
    return await settleAttemptedIngressTerminal(input);
  }
  return await settleIngressTerminal({
    ...input,
    authority: input.authority,
  });
}

type SessionRotationPayload = Readonly<{
  commandOccurrenceId: string;
  expectedOldSessionId: string;
  creationKey: string;
  initialPromptIdempotencyKey: string | null;
  revision: number;
}>;

type SessionRotationRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.sessionRotation;
  'binding-id': string;
  'created-at': number;
  'updated-at': number;
  payload: SessionRotationPayload;
}>;

type SessionProjectionFrontierRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.projectionFrontier;
  'binding-id': string;
  'created-at': number;
  'updated-at': number;
  payload: Readonly<{
    targetSessionId: string;
    transcriptCursor: JsonValue;
    lastScannedSeq: number;
    revision: number;
  }>;
}>;

function asSessionRotation(row: StateRow | null): Readonly<{ row: StateRow; value: SessionRotationRecord }> | undefined {
  if (row === null || own(row.value, CHANNEL_STATE_FIELD.recordKind) !== CHANNEL_STATE_RECORD_KIND.sessionRotation) {
    return undefined;
  }
  const id = own(row.value, CHANNEL_STATE_FIELD.id);
  const bindingId = own(row.value, CHANNEL_STATE_FIELD.bindingId);
  const createdAt = own(row.value, CHANNEL_STATE_FIELD.createdAt);
  const updatedAt = own(row.value, CHANNEL_STATE_FIELD.updatedAt);
  const payload = own(row.value, 'payload');
  if (
    id !== row.rowId
    || typeof bindingId !== 'string'
    || !isNonNegativeSafeInteger(createdAt)
    || !isNonNegativeSafeInteger(updatedAt)
    || !isJsonRecord(payload)
  ) return undefined;
  const commandOccurrenceId = own(payload, 'commandOccurrenceId');
  const expectedOldSessionId = own(payload, 'expectedOldSessionId');
  const creationKey = own(payload, 'creationKey');
  const initialPromptIdempotencyKey = own(payload, 'initialPromptIdempotencyKey');
  const revision = own(payload, 'revision');
  if (
    typeof commandOccurrenceId !== 'string'
    || typeof expectedOldSessionId !== 'string'
    || typeof creationKey !== 'string'
    || (initialPromptIdempotencyKey !== null && typeof initialPromptIdempotencyKey !== 'string')
    || !isPositiveSafeInteger(revision)
  ) return undefined;
  return {
    row,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.sessionRotation,
      'binding-id': bindingId,
      'created-at': createdAt,
      'updated-at': updatedAt,
      payload: {
        commandOccurrenceId,
        expectedOldSessionId,
        creationKey,
        initialPromptIdempotencyKey,
        revision,
      },
    },
  };
}

function asSessionProjectionFrontier(
  row: StateRow | null,
  bindingId: string,
): Readonly<{ row: StateRow; value: SessionProjectionFrontierRecord }> | undefined {
  if (row === null || own(row.value, CHANNEL_STATE_FIELD.recordKind) !== CHANNEL_STATE_RECORD_KIND.projectionFrontier) {
    return undefined;
  }
  const id = own(row.value, CHANNEL_STATE_FIELD.id);
  const rowBindingId = own(row.value, CHANNEL_STATE_FIELD.bindingId);
  const createdAt = own(row.value, CHANNEL_STATE_FIELD.createdAt);
  const updatedAt = own(row.value, CHANNEL_STATE_FIELD.updatedAt);
  const payload = own(row.value, 'payload');
  if (
    id !== createConversationSessionProjectionFrontierRowId(bindingId)
    || rowBindingId !== bindingId
    || !isNonNegativeSafeInteger(createdAt)
    || !isNonNegativeSafeInteger(updatedAt)
    || !isJsonRecord(payload)
  ) return undefined;
  const targetSessionId = own(payload, 'targetSessionId');
  const transcriptCursor = own(payload, 'transcriptCursor');
  const lastScannedSeq = own(payload, 'lastScannedSeq');
  const revision = own(payload, 'revision');
  if (
    typeof targetSessionId !== 'string'
    || transcriptCursor === undefined
    || !isNonNegativeSafeInteger(lastScannedSeq)
    || !isPositiveSafeInteger(revision)
  ) return undefined;
  return {
    row,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.projectionFrontier,
      'binding-id': bindingId,
      'created-at': createdAt,
      'updated-at': updatedAt,
      payload: { targetSessionId, transcriptCursor, lastScannedSeq, revision },
    },
  };
}

function bindingState(binding: ChannelBindingRecord): ConversationBindingStateV1 {
  return {
    connectionId: binding['connection-id'],
    endpoint: binding.payload.endpoint,
    target: binding.payload.target,
    allowedPrincipalIds: binding.payload.allowedPrincipalIds,
    allowBotSenders: binding.payload.allowBotSenders,
    inputMode: binding.payload.inputMode,
    inboundDebounceMs: binding.payload.inboundDebounceMs,
    linkPreviewPolicy: binding.payload.linkPreviewPolicy,
    senderFeedback: binding.payload.senderFeedback,
    authorityEpoch: binding.payload.authorityEpoch,
    enabled: binding.payload.enabled,
  };
}

function bindingValueForTransition(input: Readonly<{
  binding: Readonly<{ row: StateRow; value: ChannelBindingRecord }>;
  next: ConversationBindingStateV1;
  now: number;
}>): JsonRecord {
  const createdAt = own(input.binding.row.value, CHANNEL_STATE_FIELD.createdAt);
  if (!isNonNegativeSafeInteger(createdAt)) {
    throw pluginError(
      'channels_ingress_binding_corrupt',
      'The current Channel binding has no valid creation timestamp for target rotation.',
    );
  }
  return {
    id: input.binding.value.id,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.binding,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.next.connectionId,
    [CHANNEL_STATE_FIELD.bindingId]: input.binding.value.id,
    [CHANNEL_STATE_FIELD.createdAt]: createdAt,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      endpoint: input.next.endpoint,
      target: input.next.target,
      allowedPrincipalIds: input.next.allowedPrincipalIds,
      allowBotSenders: input.next.allowBotSenders,
      inputMode: input.next.inputMode,
      inboundDebounceMs: input.next.inboundDebounceMs,
      linkPreviewPolicy: input.next.linkPreviewPolicy,
      senderFeedback: input.next.senderFeedback,
      authorityEpoch: input.next.authorityEpoch,
      enabled: input.next.enabled,
      deletionState: input.binding.value.payload.deletionState,
    },
  };
}

async function readCurrentRotationAuthority(input: Readonly<{
  context: PluginInvocationContext;
  source: IngressExecutionSource;
  connectionId: string;
  bindingId: string;
  obligation: IngressObligationRecord;
}>): Promise<IngressAuthorityFence | undefined> {
  const ingress = await readPreparedIngressForObligation({ context: input.context, obligation: input.obligation });
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connection = asConnection(readStateRow(await collection.get(
    input.connectionId,
    { signal: input.context.signal },
  )) ?? null);
  if (connection === undefined) return undefined;
  try {
    assertCurrentConnection({
      connection: connection.value,
      source: input.source,
      observation: ingressShell(ingress),
    });
  } catch {
    return undefined;
  }
  if (connection.value.payload.authorityEpoch !== input.obligation.payload.sourceAuthority.connectionAuthorityEpoch) {
    return undefined;
  }
  if (!await hasCurrentProviderContributionSelection({ context: input.context, connection })) {
    return undefined;
  }
  const binding = asBinding(readStateRow(await collection.get(
    input.bindingId,
    { signal: input.context.signal },
  )));
  if (
    binding === undefined
    || binding.value['connection-id'] !== input.connectionId
    || !binding.value.payload.enabled
    || binding.value.payload.deletionState !== 'none'
    || !areConversationEndpointIdentitiesEqual(binding.value.payload.endpoint, ingressShell(ingress).endpoint)
  ) return undefined;
  return { connection, bindings: [binding] };
}

function initialPromptIdempotencyKey(input: Readonly<{
  obligationId: string;
  target: FrozenSessionTarget;
}>): string | null {
  return input.target.newSession?.initialPrompt === undefined
    ? null
    : `channels:new:v1:${input.obligationId}`;
}

function sessionRotationClaimMatches(input: Readonly<{
  claim: SessionRotationRecord;
  target: FrozenSessionTarget;
  commandOccurrenceId: string;
  promptIdempotencyKey: string | null;
}>): boolean {
  return input.claim.payload.commandOccurrenceId === input.commandOccurrenceId
    && input.claim.payload.expectedOldSessionId === input.target.sessionId
    && input.claim.payload.creationKey === createConversationNewSessionCreationKey({
      bindingId: input.claim['binding-id'],
      commandOccurrenceId: input.commandOccurrenceId,
    })
    && input.claim.payload.initialPromptIdempotencyKey === input.promptIdempotencyKey;
}

function createSessionRotationClaimValue(input: Readonly<{
  rotationId: string;
  bindingId: string;
  target: FrozenSessionTarget;
  commandOccurrenceId: string;
  promptIdempotencyKey: string | null;
  now: number;
}>): JsonRecord {
  const creationKey = createConversationNewSessionCreationKey({
    bindingId: input.bindingId,
    commandOccurrenceId: input.commandOccurrenceId,
  });
  if (!isCanonicalChannelStateRecordIdentity({
    rowId: input.rotationId,
    recordKind: CHANNEL_STATE_RECORD_KIND.sessionRotation,
    bindingId: input.bindingId,
    commandOccurrenceId: input.commandOccurrenceId,
    creationKey,
  })) {
    throw pluginError(
      'channels_ingress_rotation_identity_invalid',
      'The Session rotation claim did not preserve its canonical creation identity.',
    );
  }
  return {
    id: input.rotationId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.sessionRotation,
    v: 1,
    [CHANNEL_STATE_FIELD.bindingId]: input.bindingId,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      commandOccurrenceId: input.commandOccurrenceId,
      expectedOldSessionId: input.target.sessionId,
      creationKey,
      initialPromptIdempotencyKey: input.promptIdempotencyKey,
      revision: 1,
    },
  };
}

async function writeNewSessionControlResponseCustody(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  content: (typeof NEW_SESSION_CONTROL_RESPONSE_TEXT)[keyof typeof NEW_SESSION_CONTROL_RESPONSE_TEXT];
}>): Promise<IngressCheckpointOutcome> {
  const binding = input.authority.bindings[0];
  if (binding === undefined) return 'unsettled';
  const shell = ingressShell(await readPreparedIngressForObligation({
    context: input.context,
    obligation: input.obligation.value,
  }));
  const outward: ConversationControlResponseObligation = {
    connectionId: input.obligation.value['connection-id'],
    bindingId: input.obligation.value['binding-id'],
    routeAuthority: {
      connectionAuthorityEpoch: input.authority.connection.value.payload.authorityEpoch,
      bindingRevision: binding.row.revision,
      bindingAuthorityEpoch: binding.value.payload.authorityEpoch,
    },
    source: {
      kind: 'controlResponse',
      controlId: input.obligation.value.id,
      controlKind: 'newSession',
    },
    endpoint: shell.endpoint,
    content: input.content,
    deliveryKey: `ingress-new:${input.obligation.value.id}`,
    replyContext: { replyToMessageId: shell.message.id },
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
  return await acceptIngressControlResponseCustody({
    context: input.context,
    outward,
    invalidCode: 'channels_ingress_new_session_custody_invalid',
    invalidMessage: 'The /new control-response custody obligation is invalid.',
  });
}

async function settleRotationTerminal(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence;
  claim: Readonly<{ row: StateRow; value: SessionRotationRecord }>;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  disposition: Extract<IngressDisposition, 'rejected' | 'rotationSuperseded' | 'rotated'>;
}>): Promise<boolean> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const result = await collection.batch([
    ...ingressAuthorityAssertions(input.authority),
    {
      kind: 'put',
      value: terminalIngressObligationValue({
        obligation: input.obligation.value,
        disposition: input.disposition,
        now: Date.now(),
      }),
      expectedRevision: input.obligation.row.revision,
    },
    { kind: 'delete', rowId: input.claim.row.rowId, expectedRevision: input.claim.row.revision },
  ], { signal: input.context.signal });
  return result.status === 'updated';
}

async function admitNewSessionInitialPrompt(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence;
  target: FrozenSessionTarget;
  claim: SessionRotationRecord;
  obligation: IngressObligationRecord;
}>): Promise<boolean> {
  const initialPrompt = input.target.newSession?.initialPrompt;
  if (initialPrompt === undefined) return true;
  const promptIdempotencyKey = input.claim.payload.initialPromptIdempotencyKey;
  if (promptIdempotencyKey === null) return false;
  const binding = input.authority.bindings[0];
  if (binding === undefined || binding.value.payload.target.kind !== 'session') return false;
  const fullText = fullTextObservation(await readPreparedIngressForObligation({
    context: input.context,
    obligation: input.obligation,
  }));
  if (fullText === undefined) return false;
  const displayNameSnapshot = sessionDisplayNameSnapshot(fullText.actor.label);
  const externalActor = fullText.actor.kind === 'human' || fullText.actor.kind === 'bot'
    ? {
        kind: fullText.actor.kind,
        ...(displayNameSnapshot === undefined ? {} : { displayNameSnapshot }),
      }
    : undefined;
  const session = await input.context.services.sessions.get(
    binding.value.payload.target.sessionId,
    { signal: input.context.signal },
  );
  if (session === null) return false;
  const result = await session.send({
    kind: 'userText',
    text: initialPrompt,
    idempotencyKey: promptIdempotencyKey,
    source: {
      sourceRef: `channels:binding:${binding.value.id}`,
      sourceRevisionOrEpoch: `${input.obligation.payload.sourceAuthority.connectionAuthorityEpoch}:${input.obligation.payload.sourceAuthority.bindingAuthorityEpoch}`,
      remoteApprovalMaxScope: input.target.remoteApprovalMaxScope,
      requestedPermissionCeiling: input.target.requestedPermissionCeiling,
      ...(externalActor === undefined ? {} : { externalActor }),
      contentProvenance: fullText.message.contentProvenance,
    },
  }, { signal: input.context.signal });
  return result.status === 'accepted' || result.status === 'alreadyAccepted' || result.status === 'rejected';
}

async function dispatchNewSessionRotation(input: Readonly<{
  context: PluginInvocationContext;
  source: IngressExecutionSource;
  connectionId: string;
  bindingId: string;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  firstAuthority: IngressAuthorityFence | undefined;
}>): Promise<IngressCheckpointOutcome> {
  const target = input.obligation.value.payload.target;
  if (target === null || target.kind !== 'session' || target.newSession === null) return 'unsettled';
  const ingress = await readPreparedIngressForObligation({ context: input.context, obligation: input.obligation.value });
  const commandOccurrenceId = ingressShell(ingress).occurrenceId;
  const promptIdempotencyKey = initialPromptIdempotencyKey({
    obligationId: input.obligation.value.id,
    target,
  });
  let firstAuthority = input.firstAuthority ?? await revalidateFirstDispatchAuthority({
    context: input.context,
    source: input.source,
    connectionId: input.connectionId,
    bindingId: input.bindingId,
    obligation: input.obligation.value,
    ingress,
  });
  const connection = firstAuthority?.connection ?? (await readCurrentRotationAuthority({
    context: input.context,
    source: input.source,
    connectionId: input.connectionId,
    bindingId: input.bindingId,
    obligation: input.obligation.value,
  }))?.connection;
  if (connection === undefined) return 'unsettled';
  const rotationId = await deriveConversationSessionRotationRowId({
    routingIdentityKey: connection.value.payload.routingIdentityKey,
    connectionId: input.connectionId,
    bindingId: input.bindingId,
  });
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  let claim = asSessionRotation(readStateRow(await collection.get(
    rotationId,
    { signal: input.context.signal },
  )) ?? null);
  if (claim === undefined) {
    if (firstAuthority === undefined) return 'unsettled';
    const value = createSessionRotationClaimValue({
      rotationId,
      bindingId: input.bindingId,
      target,
      commandOccurrenceId,
      promptIdempotencyKey,
      now: Date.now(),
    });
    const result = await collection.batch([
      ...ingressAuthorityAssertions(firstAuthority),
      { kind: 'put', value, expectedRevision: 'absent' },
    ], { signal: input.context.signal });
    if (result.status === 'updated') {
      const revision = result.results.find((entry) => entry.rowId === rotationId && !entry.deleted)?.revision;
      claim = revision === undefined
        ? undefined
        : asSessionRotation({ rowId: rotationId, revision, value });
    } else {
      claim = asSessionRotation(readStateRow(await collection.get(
        rotationId,
        { signal: input.context.signal },
      )) ?? null);
    }
  }
  if (claim === undefined) return 'unsettled';
  if (!sessionRotationClaimMatches({
    claim: claim.value,
    target,
    commandOccurrenceId,
    promptIdempotencyKey,
  })) {
    if (firstAuthority === undefined) return 'unsettled';
    const busy = settleCompetingNewSessionCommand({
      ingressObligationId: input.obligation.value.id,
      initialPrompt: target.newSession.initialPrompt,
      createBusyResponse: true,
    });
    if (busy.controlResponse === undefined) {
      throw pluginError(
        'channels_ingress_new_session_busy_response_missing',
        'A competing /new command did not retain its required control-response identity.',
      );
    }
    const custody = await writeNewSessionControlResponseCustody({
      context: input.context,
      authority: firstAuthority,
      obligation: input.obligation,
      content: NEW_SESSION_CONTROL_RESPONSE_TEXT.busy,
    });
    if (custody !== 'checkpointSafe') return custody;
    await settleIngressTerminal({
      context: input.context,
      authority: firstAuthority,
      obligation: input.obligation,
      disposition: busy.ingress.disposition,
    });
    return 'checkpointSafe';
  }

  const spawnInput = SessionSpawnNewInputV2Schema.safeParse({
    ...target.newSession.recipe,
    creationKey: claim.value.payload.creationKey,
  });
  if (!spawnInput.success) {
    if (firstAuthority === undefined) return 'unsettled';
    return await settleRotationTerminal({
      context: input.context,
      authority: firstAuthority,
      claim,
      obligation: input.obligation,
      disposition: 'rejected',
    }) ? 'checkpointSafe' : 'unsettled';
  }
  const authorityBeforeSpawn = await readCurrentRotationAuthority({
    context: input.context,
    source: input.source,
    connectionId: input.connectionId,
    bindingId: input.bindingId,
    obligation: input.obligation.value,
  });
  if (authorityBeforeSpawn === undefined) return 'unsettled';
  firstAuthority ??= authorityBeforeSpawn;
  const spawned = await input.context.services.actions.execute(
    'session.spawn_new',
    spawnInput.data,
    { signal: input.context.signal },
  );
  assertNotAborted(input.context.signal);
  if (spawned.type === 'pending') return 'unsettled';
  if (spawned.type === 'error') {
    if (spawned.retryable || firstAuthority === undefined) return 'unsettled';
    return await settleRotationTerminal({
      context: input.context,
      authority: firstAuthority,
      claim,
      obligation: input.obligation,
      disposition: 'rejected',
    }) ? 'checkpointSafe' : 'unsettled';
  }

  const baseline = await readConversationSessionProjectionNoHistoryBaseline({
    actions: input.context.services.actions,
    sessionId: spawned.sessionId,
    signal: input.context.signal,
  });
  assertNotAborted(input.context.signal);
  if (baseline.kind !== 'ready') return 'unsettled';

  let current = await readCurrentRotationAuthority({
    context: input.context,
    source: input.source,
    connectionId: input.connectionId,
    bindingId: input.bindingId,
    obligation: input.obligation.value,
  });
  if (current === undefined) return 'unsettled';
  let currentBinding = current.bindings[0];
  if (currentBinding === undefined) return 'unsettled';
  const frontierRowId = createConversationSessionProjectionFrontierRowId(input.bindingId);
  let frontier = asSessionProjectionFrontier(readStateRow(await collection.get(
    frontierRowId,
    { signal: input.context.signal },
  )) ?? null, input.bindingId);

  if (currentBinding.value.payload.target.kind === 'session'
    && currentBinding.value.payload.target.sessionId === spawned.sessionId) {
    // Transcript cursors are opaque. `lastScannedSeq` is the projection
    // owner's monotonic evidence that this persisted frontier is at least the
    // no-history baseline observed for the spawned Session.
    if (frontier === undefined
      || frontier.value.payload.targetSessionId !== spawned.sessionId
      || frontier.value.payload.lastScannedSeq < baseline.lastScannedSeq) {
      return 'unsettled';
    }
  } else if (currentBinding.value.payload.target.kind === 'session'
    && currentBinding.value.payload.target.sessionId === target.sessionId) {
    if (
      currentBinding.row.revision !== input.obligation.value.payload.sourceAuthority.bindingRevision
      || currentBinding.value.payload.authorityEpoch !== input.obligation.value.payload.sourceAuthority.bindingAuthorityEpoch
      || (frontier !== undefined && frontier.value.payload.targetSessionId !== target.sessionId)
    ) return 'unsettled';
    const transition = transitionConversationBinding({
      current: bindingState(currentBinding.value),
      requested: {
        ...bindingState(currentBinding.value),
        target: {
          ...currentBinding.value.payload.target,
          sessionId: spawned.sessionId,
        },
      },
    });
    if (transition.kind !== 'updated') return 'unsettled';
    const now = Date.now();
    const bindingValue = bindingValueForTransition({
      binding: currentBinding,
      next: transition.binding,
      now,
    });
    const frontierValue = createConversationSessionProjectionFrontierRow({
      bindingId: input.bindingId,
      targetSessionId: spawned.sessionId,
      transcriptCursor: baseline.transcriptCursor,
      lastScannedSeq: baseline.lastScannedSeq,
      revision: (frontier?.value.payload.revision ?? 0) + 1,
      ...(frontier === undefined ? {} : { createdAt: frontier.value['created-at'] }),
      now,
    });
    const retargeted = await collection.batch([
      {
        kind: 'assert',
        rowId: current.connection.row.rowId,
        expectedRevision: current.connection.row.revision,
      },
      { kind: 'assert', rowId: claim.row.rowId, expectedRevision: claim.row.revision },
      { kind: 'put', value: bindingValue, expectedRevision: currentBinding.row.revision },
      {
        kind: 'put',
        value: frontierValue,
        expectedRevision: frontier === undefined ? 'absent' : frontier.row.revision,
      },
    ], { signal: input.context.signal });
    if (retargeted.status !== 'updated') return 'unsettled';
    const bindingRevision = retargeted.results.find((entry) => entry.rowId === input.bindingId && !entry.deleted)?.revision;
    const retargetedBinding = bindingRevision === undefined
      ? undefined
      : asBinding({ rowId: input.bindingId, revision: bindingRevision, value: bindingValue });
    if (retargetedBinding === undefined) return 'unsettled';
    current = { connection: current.connection, bindings: [retargetedBinding] };
    currentBinding = retargetedBinding;
  } else {
    return await settleRotationTerminal({
      context: input.context,
      authority: current,
      claim,
      obligation: input.obligation,
      disposition: 'rotationSuperseded',
    }) ? 'checkpointSafe' : 'unsettled';
  }

  const promptAdmitted = await admitNewSessionInitialPrompt({
    context: input.context,
    authority: current,
    target,
    claim: claim.value,
    obligation: input.obligation.value,
  });
  if (!promptAdmitted) return 'unsettled';
  const custody = await writeNewSessionControlResponseCustody({
    context: input.context,
    authority: current,
    obligation: input.obligation,
    content: NEW_SESSION_CONTROL_RESPONSE_TEXT.started,
  });
  if (custody !== 'checkpointSafe') return custody;
  return await settleRotationTerminal({
    context: input.context,
    authority: current,
    claim,
    obligation: input.obligation,
    disposition: 'rotated',
  }) ? 'checkpointSafe' : 'unsettled';
}

async function acceptIngressControlResponseCustody(input: Readonly<{
  context: PluginInvocationContext;
  outward: ConversationControlResponseObligation;
  invalidCode: string;
  invalidMessage: string;
}>): Promise<IngressCheckpointOutcome> {
  const stateCollection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const prepared = await prepareConversationOutwardDeliveryReady({
    stateCollection,
    signal: input.context.signal,
    obligation: input.outward,
  });
  const accepted = await acceptConversationOutwardDeliveryReady({
    store: createConversationOutwardDeliveryCollectionStore({
      stateCollection,
      deliveriesCollection: requireChannelsAccountStorage(input.context).collection(CHANNEL_DELIVERIES_COLLECTION),
      signal: input.context.signal,
    }),
    prepared,
    signal: input.context.signal,
  });
  switch (accepted.kind) {
    case 'accepted':
    case 'retired':
    case 'suppressed':
      return 'checkpointSafe';
    case 'unavailable':
      return 'unsettled';
    case 'invalid':
      throw pluginError(input.invalidCode, input.invalidMessage);
  }
}

/**
 * The one sender-visible acknowledgement vocabulary for a mediated chat
 * approval. It states only whether the decision was recorded; PERM-14 keeps
 * the rule, prompt, tool, and grant detail inside owner-encrypted Session
 * content, so no part of the permission body is echoed to the channel.
 */
const APPROVAL_CONTROL_RESPONSE_TEXT = {
  allowed: 'Approved the pending permission request.',
  denied: 'Denied the pending permission request.',
  notPending: 'That permission request is no longer pending.',
  refused: 'That permission decision was not accepted.',
} as const;

type ApprovalControlResponseText =
  (typeof APPROVAL_CONTROL_RESPONSE_TEXT)[keyof typeof APPROVAL_CONTROL_RESPONSE_TEXT];

async function writeApprovalControlResponseCustody(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  content: ApprovalControlResponseText;
}>): Promise<IngressCheckpointOutcome> {
  const shell = ingressShell(await readPreparedIngressForObligation({
    context: input.context,
    obligation: input.obligation.value,
  }));
  const outward: ConversationControlResponseObligation = {
    connectionId: input.obligation.value['connection-id'],
    bindingId: input.obligation.value['binding-id'],
    routeAuthority: {
      connectionAuthorityEpoch: input.obligation.value.payload.sourceAuthority.connectionAuthorityEpoch,
      bindingRevision: input.obligation.value.payload.sourceAuthority.bindingRevision,
      bindingAuthorityEpoch: input.obligation.value.payload.sourceAuthority.bindingAuthorityEpoch,
    },
    source: {
      kind: 'controlResponse',
      controlId: input.obligation.value.id,
      controlKind: 'approval',
    },
    endpoint: shell.endpoint,
    content: input.content,
    deliveryKey: `ingress-approval:${input.obligation.value.id}`,
    replyContext: { replyToMessageId: shell.message.id },
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
  return await acceptIngressControlResponseCustody({
    context: input.context,
    outward,
    invalidCode: 'channels_ingress_approval_custody_invalid',
    invalidMessage: 'The chat-approval control-response custody obligation is invalid.',
  });
}

/**
 * A canonical-owner outcome that cannot be settled now. The obligation keeps
 * the incumbent bounded attempt/backoff ladder instead of a mediation-local
 * timer, queue, or retry ledger.
 */
async function retryApprovalMediation(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
}>): Promise<IngressCheckpointOutcome> {
  const exhausted = input.obligation.value.payload.lifecycle.attemptCount
    >= MAX_CONVERSATION_DELIVERY_ATTEMPTS;
  await putIngressObligationLifecycle({
    context: input.context,
    obligation: input.obligation,
    value: exhausted
      ? blockedIngressObligationValue({ obligation: input.obligation.value, now: Date.now() })
      : retryDueIngressObligationValue({ obligation: input.obligation.value, now: Date.now() }),
    knownNoEffectCleanup: true,
  });
  return exhausted ? 'checkpointSafe' : 'unsettled';
}

async function settleApprovalMediationTerminal(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence | undefined;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  disposition: Extract<IngressDisposition, 'approvalConsumed' | 'rejected'>;
  content: ApprovalControlResponseText;
}>): Promise<IngressCheckpointOutcome> {
  const custody = await writeApprovalControlResponseCustody({
    context: input.context,
    obligation: input.obligation,
    content: input.content,
  });
  if (custody !== 'checkpointSafe') return custody;
  await settleIngressEffectTerminal({
    context: input.context,
    authority: input.authority,
    obligation: input.obligation,
    disposition: input.disposition,
    ...(input.disposition === 'rejected'
      ? {
        nonAdmission: {
          reason: 'targetUnavailable' as const,
          senderFeedbackEligible: false,
        },
      }
      : {}),
  });
  return 'checkpointSafe';
}

/**
 * Settles one frozen `/allow`/`/deny` through the canonical Session permission
 * owner. Channels contributes only the attributed external principal and the
 * exact binding source authority: the request tuple comes from the generic
 * pending projection, the scope is passed through unnarrowed so the one
 * mediation owner applies or refuses it, and no local grant, queue, decision
 * store, or inferred turn exists here.
 */
async function dispatchApprovalMediation(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  bindingId: string;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  authority: IngressAuthorityFence | undefined;
  target: FrozenSessionTarget;
  approval: NonNullable<FrozenSessionTarget['approval']>;
  actorPrincipalId: string | null;
}>): Promise<IngressCheckpointOutcome> {
  const { approval, target } = input;
  if (input.actorPrincipalId === null) {
    // The admission owner only freezes an approval for an attributable actor,
    // so a frozen command beside an unattributable census is corrupt state
    // rather than a product outcome.
    throw pluginError(
      'channels_ingress_approval_actor_invalid',
      'The frozen chat-approval command has no attributable external principal.',
    );
  }
  const connection = input.authority?.connection ?? asConnection(readStateRow(
    await requireChannelsAccountStorage(input.context)
      .collection(CHANNEL_STATE_COLLECTION)
      .get(input.connectionId, { signal: input.context.signal }),
  ) ?? null);
  if (connection === undefined) {
    return await retryApprovalMediation({ context: input.context, obligation: input.obligation });
  }
  const sourceAuthority = input.obligation.value.payload.sourceAuthority;
  const source = {
    sessionId: target.sessionId,
    sourceRef: `channels:binding:${input.bindingId}`,
    sourceRevisionOrEpoch: `${sourceAuthority.connectionAuthorityEpoch}:${sourceAuthority.bindingAuthorityEpoch}`,
  } as const;

  let pending: PluginActionResultById['session.permission.remote.pending.list'];
  try {
    pending = await input.context.services.actions.execute(
      'session.permission.remote.pending.list',
      source,
      { signal: input.context.signal },
    );
  } catch (error) {
    assertNotAborted(input.context.signal);
    // A definite refusal from the canonical owner cannot become a permanent
    // ingest throw: that would re-observe the same message forever and hold
    // the connection checkpoint. Settle it truthfully instead.
    if (isPluginError(error) && error.retryable === false) {
      return await settleApprovalMediationTerminal({
        context: input.context,
        authority: input.authority,
        obligation: input.obligation,
        disposition: 'rejected',
        content: APPROVAL_CONTROL_RESPONSE_TEXT.refused,
      });
    }
    return await retryApprovalMediation({ context: input.context, obligation: input.obligation });
  }
  const match = pending.requests.find((request) => request.requestId === approval.requestId);
  if (match === undefined) {
    // A truncated projection cannot prove absence, so the obligation stays on
    // its bounded retry ladder rather than settling a request that may still
    // be pending behind the host's bound.
    if (pending.truncated) {
      return await retryApprovalMediation({ context: input.context, obligation: input.obligation });
    }
    return await settleApprovalMediationTerminal({
      context: input.context,
      authority: input.authority,
      obligation: input.obligation,
      disposition: 'rejected',
      content: APPROVAL_CONTROL_RESPONSE_TEXT.notPending,
    });
  }

  let responded: PluginActionResultById['session.permission.remote.respond'];
  try {
    responded = await input.context.services.actions.execute(
      'session.permission.remote.respond',
      {
        ...source,
        turnId: match.turnId,
        requestId: approval.requestId,
        idempotencyKey: `channels:approval:v1:${input.obligation.value.id}`,
        actor: {
          namespace: connection.value.payload.providerPluginId,
          principalId: input.actorPrincipalId,
        },
        decision: approval.decision,
        scope: approval.scope,
      },
      { signal: input.context.signal },
    );
  } catch (error) {
    assertNotAborted(input.context.signal);
    if (isPluginError(error) && error.retryable === false) {
      return await settleApprovalMediationTerminal({
        context: input.context,
        authority: input.authority,
        obligation: input.obligation,
        disposition: 'rejected',
        content: APPROVAL_CONTROL_RESPONSE_TEXT.refused,
      });
    }
    return await retryApprovalMediation({ context: input.context, obligation: input.obligation });
  }

  if (responded.status === 'rejected') {
    if (
      responded.code === 'mediationStateUnavailable'
      || responded.code === 'sessionUnavailable'
      || responded.code === 'ownerMachineUnavailable'
      || responded.code === 'canceled'
    ) {
      return await retryApprovalMediation({ context: input.context, obligation: input.obligation });
    }
    return await settleApprovalMediationTerminal({
      context: input.context,
      authority: input.authority,
      obligation: input.obligation,
      disposition: 'rejected',
      content: responded.code === 'requestNotFound' || responded.code === 'requestNotPending'
        ? APPROVAL_CONTROL_RESPONSE_TEXT.notPending
        : APPROVAL_CONTROL_RESPONSE_TEXT.refused,
    });
  }
  return await settleApprovalMediationTerminal({
    context: input.context,
    authority: input.authority,
    obligation: input.obligation,
    disposition: 'approvalConsumed',
    content: responded.decision === 'allow'
      ? APPROVAL_CONTROL_RESPONSE_TEXT.allowed
      : APPROVAL_CONTROL_RESPONSE_TEXT.denied,
  });
}

async function settleTerminalRefusalCustody(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
}>): Promise<IngressCheckpointOutcome> {
  const { obligation } = input;
  const nonAdmission = obligation.value.payload.nonAdmission;
  if (nonAdmission === null || !nonAdmission.senderFeedbackEligible) return 'checkpointSafe';

  const shell = ingressShell(await readPreparedIngressForObligation({
    context: input.context,
    obligation: obligation.value,
  }));
  const outward: ConversationControlResponseObligation = {
    connectionId: obligation.value['connection-id'],
    bindingId: obligation.value['binding-id'],
    routeAuthority: {
      connectionAuthorityEpoch: obligation.value.payload.sourceAuthority.connectionAuthorityEpoch,
      bindingRevision: obligation.value.payload.sourceAuthority.bindingRevision,
      bindingAuthorityEpoch: obligation.value.payload.sourceAuthority.bindingAuthorityEpoch,
    },
    source: {
      kind: 'controlResponse',
      controlId: obligation.value.id,
      controlKind: 'refusal',
    },
    endpoint: shell.endpoint,
    content: 'This message could not be admitted.',
    deliveryKey: 'ingress-refusal:' + obligation.value.id,
    replyContext: { replyToMessageId: shell.message.id },
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
  return await acceptIngressControlResponseCustody({
    context: input.context,
    outward,
    invalidCode: 'channels_ingress_refusal_custody_invalid',
    invalidMessage: 'The prepared sender-refusal custody obligation is invalid.',
  });
}

/**
 * This is deliberately a second, obligation-only CAS. A failed first-attempt
 * authority fence must never turn a concurrently claimed attempting row
 * back into a terminal state.
 */
async function terminalizeReadyAsStaleAuthority(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
}>): Promise<IngressCheckpointOutcome> {
  if (!['ready', 'debounceDue', 'retryDue'].includes(input.obligation.value.payload.lifecycle.phase)) {
    return input.obligation.value.payload.lifecycle.phase === 'terminal'
      ? 'checkpointSafe'
      : 'unsettled';
  }
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const value = terminalIngressObligationValue({
    obligation: input.obligation.value,
    disposition: 'staleAuthority',
    nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
    now: Date.now(),
  });
  const result = await collection.batch([
    { kind: 'put', value, expectedRevision: input.obligation.row.revision },
  ], { signal: input.context.signal });
  if (result.status !== 'conflict') return 'checkpointSafe';
  const current = asIngressObligation(readStateRow(await collection.get(
    input.obligation.row.rowId,
    { signal: input.context.signal },
  )) ?? null);
  if (current === undefined) return 'unsettled';
  return current.value.payload.lifecycle.phase === 'terminal'
    ? 'checkpointSafe'
    : 'unsettled';
}

async function dispatchIngressObligation(input: Readonly<{
  context: PluginInvocationContext;
  source: IngressExecutionSource;
  connectionId: string;
  bindingId: string;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  ingress: ConversationNormalizedIngressV1;
}>): Promise<IngressCheckpointOutcome> {
  let obligation = input.obligation;
  let authority: IngressAuthorityFence | undefined;
  if (obligation.value.payload.lifecycle.phase === 'terminal') {
    return settleTerminalRefusalCustody({ context: input.context, obligation });
  }
  if (obligation.value.payload.lifecycle.phase === 'blocked') return 'checkpointSafe';
  if (
    obligation.value.payload.lifecycle.dueAt !== null
    && obligation.value.payload.lifecycle.dueAt > Date.now()
  ) return 'unsettled';
  if (obligation.value.payload.lifecycle.phase === 'attempting') {
    if (obligation.value.payload.lifecycle.attemptCount >= MAX_CONVERSATION_DELIVERY_ATTEMPTS) {
      await putIngressObligationLifecycle({
        context: input.context,
        obligation,
        value: blockedIngressObligationValue({ obligation: obligation.value, now: Date.now() }),
      });
      return 'checkpointSafe';
    }
    obligation = await putIngressObligationLifecycle({
      context: input.context,
      obligation,
      value: attemptingIngressObligationValue({ obligation: obligation.value, now: Date.now() }),
    });
  }
  if (['ready', 'debounceDue', 'retryDue'].includes(obligation.value.payload.lifecycle.phase)) {
    authority = await revalidateFirstDispatchAuthority({
      context: input.context,
      source: input.source,
      connectionId: input.connectionId,
      bindingId: input.bindingId,
      obligation: obligation.value,
      ingress: input.ingress,
    });
    if (authority === undefined) {
      return terminalizeReadyAsStaleAuthority({ context: input.context, obligation });
    }
    let row: StateRow;
    try {
      row = await batchPutWithIngressAuthorityFence({
        context: input.context,
        authority,
        value: attemptingIngressObligationValue({ obligation: obligation.value, now: Date.now() }),
        expectedRevision: obligation.row.revision,
      });
    } catch (error) {
      if (isPluginError(error) && error.code === 'channels_ingress_stale_authority') {
        return terminalizeReadyAsStaleAuthority({ context: input.context, obligation });
      }
      throw error;
    }
    const attempting = asIngressObligation(row);
    if (attempting === undefined) {
      throw pluginError('channels_ingress_attempt_invalid', 'The persisted ingress dispatch attempt is invalid.');
    }
    obligation = attempting;
  }
  assertNotAborted(input.context.signal);
  const fullText = fullTextObservation(input.ingress);
  if (fullText === undefined) {
    throw pluginError(
      'channels_ingress_input_invalid',
      'A bodyless non-admission cannot enter Session or Automation admission.',
    );
  }
  if (obligation.value.payload.target === null) {
    throw pluginError('channels_ingress_target_missing', 'An active ingress obligation has no frozen target.');
  }
  if (obligation.value.payload.target.kind === 'session') {
    const target = obligation.value.payload.target;
    if (target.newSession !== null) {
      return await dispatchNewSessionRotation({
        context: input.context,
        source: input.source,
        connectionId: input.connectionId,
        bindingId: input.bindingId,
        obligation,
        firstAuthority: authority,
      });
    }
    if (target.approval !== null) {
      return await dispatchApprovalMediation({
        context: input.context,
        connectionId: input.connectionId,
        bindingId: input.bindingId,
        obligation,
        authority,
        target,
        approval: target.approval,
        actorPrincipalId: fullText.actor.principalId,
      });
    }
    const displayNameSnapshot = sessionDisplayNameSnapshot(fullText.actor.label);
    const actorKind = fullText.actor.kind;
    const externalActor = actorKind === 'human' || actorKind === 'bot'
      ? {
          kind: actorKind,
          ...(displayNameSnapshot === undefined
            ? {}
            : { displayNameSnapshot }),
        }
      : undefined;
    const session = await input.context.services.sessions.get(target.sessionId, { signal: input.context.signal });
    if (session === null) {
      throw pluginError(
        'channels_ingress_session_unavailable',
        'The Session target is unavailable for the frozen ingress obligation.',
        true,
      );
    }
    const result = await session.send({
      kind: 'userText',
      text: fullText.message.text,
      idempotencyKey: target.idempotencyKey,
      source: {
        sourceRef: `channels:binding:${input.bindingId}`,
        sourceRevisionOrEpoch: `${obligation.value.payload.sourceAuthority.connectionAuthorityEpoch}:${obligation.value.payload.sourceAuthority.bindingAuthorityEpoch}`,
        remoteApprovalMaxScope: target.remoteApprovalMaxScope,
        requestedPermissionCeiling: target.requestedPermissionCeiling,
        ...(externalActor === undefined ? {} : { externalActor }),
        contentProvenance: fullText.message.contentProvenance,
      },
    }, { signal: input.context.signal });
    if (result.status === 'accepted' || result.status === 'alreadyAccepted') {
      await settleIngressEffectTerminal({
        context: input.context,
        authority,
        obligation,
        disposition: 'admitted',
      });
      return 'checkpointSafe';
    }
    if (result.status === 'rejected' && result.code === 'session_input_cancelled') {
      const exhausted = obligation.value.payload.lifecycle.attemptCount >= MAX_CONVERSATION_DELIVERY_ATTEMPTS;
      await putIngressObligationLifecycle({
        context: input.context,
        obligation,
        value: exhausted
          ? blockedIngressObligationValue({ obligation: obligation.value, now: Date.now() })
          : retryDueIngressObligationValue({ obligation: obligation.value, now: Date.now() }),
        knownNoEffectCleanup: true,
      });
      return exhausted ? 'checkpointSafe' : 'unsettled';
    }
    if (result.status === 'rejected') {
      await settleIngressEffectTerminal({
        context: input.context,
        authority,
        obligation,
        disposition: 'rejected',
      });
      return 'checkpointSafe';
    }
    const exhausted = obligation.value.payload.lifecycle.attemptCount >= MAX_CONVERSATION_DELIVERY_ATTEMPTS;
    await putIngressObligationLifecycle({
      context: input.context,
      obligation,
      value: exhausted
        ? blockedIngressObligationValue({ obligation: obligation.value, now: Date.now() })
        : retryDueIngressObligationValue({ obligation: obligation.value, now: Date.now() }),
    });
    return exhausted ? 'checkpointSafe' : 'unsettled';
  }

  const target = obligation.value.payload.target;
  const admissionInput: AutomationConversationAdmitInputV1 = {
    automationId: target.automationId,
    bindingId: input.bindingId,
    templateVersion: target.templateVersion,
    occurrenceId: target.occurrenceKey,
    occurredAt: fullText.occurredAt,
    sender: {
      principalId: fullText.actor.principalId,
      kind: fullText.actor.kind,
      isIntegrationSelf: fullText.actor.isIntegrationSelf,
      ...(fullText.actor.label === undefined ? {} : { label: fullText.actor.label }),
      contentProvenance: fullText.message.contentProvenance,
    },
    text: fullText.message.text,
    resultDelivery: target.resultDelivery,
  };
  const admission: AutomationConversationAdmitResultV1 = await input.context.services.actions.execute(
    'automation.conversation.admit',
    admissionInput,
    { signal: input.context.signal },
  );
  if (admission.kind === 'blocked') {
    const exhausted = obligation.value.payload.lifecycle.attemptCount >= MAX_CONVERSATION_DELIVERY_ATTEMPTS;
    await putIngressObligationLifecycle({
      context: input.context,
      obligation,
      value: exhausted
        ? blockedIngressObligationValue({ obligation: obligation.value, now: Date.now() })
        : retryDueIngressObligationValue({ obligation: obligation.value, now: Date.now() }),
      knownNoEffectCleanup: true,
    });
    return exhausted ? 'checkpointSafe' : 'unsettled';
  }
  assertNotAborted(input.context.signal);
  if (!admission.checkpointSafe) {
    throw pluginError(
      'channels_ingress_automation_admission_invalid',
      'Automation returned a non-terminal admission result outside its closed contract.',
      true,
    );
  }
  await settleIngressEffectTerminal({
    context: input.context,
    authority,
    obligation,
    disposition: 'admitted',
  });
  return 'checkpointSafe';
}

function matchesIngressCensus(input: Readonly<{
  census: IngressCensusPayload;
  ingress: ConversationNormalizedIngressV1;
}>): boolean {
  // The frozen census names the authority that admitted its first effect, but
  // authority epoch is a currentness fence rather than occurrence identity.
  // A compatible E→E+1 transfer must rejoin the same immutable occurrence
  // without allowing an old poller to settle a new effect.
  return immutableIngressMatches(input.census, input.ingress);
}

/**
 * The sole core ingress owner for provider observations. It writes the
 * immutable census first, prepares its per-binding units in bounded batches,
 * and admits only after the census is durably marked prepared. Those units—
 * not a scan cursor—then own dispatch safety.
 */
async function ingestConversationObservationForInvocation(
  unparsedInput: ConversationProviderObservationIngestInputV1,
  context: PluginInvocationContext,
  source: IngressExecutionSource,
  pairing?: ConversationPairingManager,
): Promise<IngressObservationOutcome> {
  assertNotAborted(context.signal);
  const input = ConversationProviderObservationIngestInputV1Schema.parse(unparsedInput);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const connectionState = asConnection(readStateRow(await collection.get(
    input.connectionId,
    { signal: context.signal },
  )) ?? null);
  if (connectionState === undefined) {
    throw pluginError('channels_ingress_connection_unavailable', 'The requested Channel connection is unavailable.', true);
  }
  const shell = ingressShell(input.observation);
  assertCurrentConnection({
    connection: connectionState.value,
    source,
    observation: shell,
  });

  const censusId = await deriveIngressCensusRowId({
    routingIdentityKey: connectionState.value.payload.routingIdentityKey,
    connectionId: connectionState.value.id,
    occurrenceId: shell.occurrenceId,
  });
  let census = asIngressCensus(readStateRow(await collection.get(
    censusId,
    { signal: context.signal },
  )) ?? null);
  // A census is finite replay evidence, not an indefinite anti-resurrection
  // tombstone. Its frozen window governs an existing occurrence; after that
  // window, do not match, pair, prepare, or admit it. When no census remains,
  // a connection-local expansion floor also keeps a later wider setting from
  // reauthorizing an occurrence that had already aged out. The poll remains
  // safe to checkpoint without recording census coverage.
  //
  // The one exception is a census still in `preparing`: that is admitted work
  // this Account accepted and never finished writing, and it holds the only
  // copy of the captured inbound message. Wall-clock age cannot decide that
  // unit, because nothing else can ever finish it — preparation is reachable
  // only from this path. A replay therefore rejoins it however late, which
  // completes work already accepted rather than resurrecting an aged-out
  // occurrence. An already-`prepared` unit needs nothing from a late replay and
  // stays behind the window, so retention races cannot change what a late
  // replay does.
  if (census?.value.payload.phase !== 'preparing' && (
    !isObservationFresh(
      census?.value.payload.maximumObservationAgeMs
        ?? connectionState.value.payload.maximumObservationAgeMs,
      shell,
    ) || (
      census === undefined
      && connectionState.value.payload.observationAgeExpansionFloorOccurredAt !== null
      && shell.occurredAt < connectionState.value.payload.observationAgeExpansionFloorOccurredAt
    )
  )) return 'checkpointSafeNoCensus';

  let pairingReservation:
    | Readonly<{
      pairing: ConversationPairingManager;
      reservation: Extract<ReturnType<ConversationPairingManager['preparePreBindingMessage']>, Readonly<{ kind: 'reserved' }>>;
    }>
    | undefined;

  if (census !== undefined && census.value.attention) {
    throw pluginError(
      'channels_ingress_occurrence_conflict',
      'The provider occurrence has contradictory immutable ingress evidence.',
    );
  }

  if (census !== undefined && !matchesIngressCensus({
    census: census.value.payload,
    ingress: input.observation,
  })) {
    await markIngressCensusOccurrenceConflict({
      context,
      source,
      observation: input.observation,
      connection: connectionState,
      census,
    });
    throw pluginError(
      'channels_ingress_occurrence_conflict',
      'The provider occurrence conflicts with its first immutable ingress evidence.',
    );
  }

  const fullText = fullTextObservation(input.observation);
  if (pairing !== undefined && fullText !== undefined) {
    const materialization = source.kind === 'providerObservation'
      ? source.caller?.materialization
      : source.executionOrigin.materializationRef;
    if (materialization !== undefined) {
      const preparedPairing = pairing.preparePreBindingMessage({
        censusId,
        connectionId: connectionState.value.id,
        materialization,
        endpoint: fullText.endpoint,
        actor: fullText.actor,
        contentProvenance: fullText.message.contentProvenance,
        command: classifyConversationCommand(fullText.message.text),
      });
      if (preparedPairing.kind === 'reserved') {
        pairingReservation = { pairing, reservation: preparedPairing };
      }
    }
  }

  if (census === undefined) {
    const bindings = pairingReservation === undefined
      ? (await readBindingsForConnection({
        context,
        connectionId: connectionState.value.id,
      })).filter((binding) => (
        binding.value.payload.enabled
          && binding.value.payload.deletionState === 'none'
          && areConversationEndpointIdentitiesEqual(binding.value.payload.endpoint, shell.endpoint)
      )).sort((left, right) => compareCanonicalBindingId(left.value.id, right.value.id))
      : [];
    const censusValue = createIngressCensusValue({
      censusId,
      connectionId: connectionState.value.id,
      ingress: input.observation,
      connectionAuthorityEpoch: connectionState.value.payload.authorityEpoch,
      maximumObservationAgeMs: connectionState.value.payload.maximumObservationAgeMs,
      matchedBindings: bindings.map((binding) => ({
        bindingId: binding.value.id,
        bindingRevision: binding.row.revision,
        bindingAuthorityEpoch: binding.value.payload.authorityEpoch,
      })),
      now: Date.now(),
    });
    const result = await collection.batch([
      {
        kind: 'assert',
        rowId: connectionState.row.rowId,
        expectedRevision: connectionState.row.revision,
      },
      { kind: 'put', value: censusValue, expectedRevision: 'absent' },
    ], { signal: context.signal });
    if (result.status === 'conflict') {
      census = asIngressCensus(readStateRow(await collection.get(
        censusId,
        { signal: context.signal },
      )) ?? null);
      if (census === undefined) {
        throw pluginError(
          'channels_ingress_stale_authority',
          'Channel authority changed before the immutable ingress census could commit.',
          true,
        );
      }
      if (!matchesIngressCensus({
        census: census.value.payload,
        ingress: input.observation,
      })) {
        await markIngressCensusOccurrenceConflict({
          context,
          source,
          observation: input.observation,
          connection: connectionState,
          census,
        });
        throw pluginError(
          'channels_ingress_occurrence_conflict',
          'The provider occurrence conflicts with its first immutable ingress evidence.',
        );
      }
    } else {
      const revision = result.results.find((entry) => entry.rowId === censusId && !entry.deleted)?.revision;
      census = revision === undefined
        ? undefined
        : asIngressCensus({ rowId: censusId, revision, value: censusValue });
    }
  }

  if (census === undefined) {
    throw pluginError('channels_ingress_census_invalid', 'The ingress census was not persisted or rejoined.', true);
  }

  const pairingConsumed = pairingReservation !== undefined;
  if (pairingReservation !== undefined) {
    // A valid reservation is terminal for this occurrence even if a later
    // manager-local race consumes/cancels its challenge. It must never fall
    // through to ordinary binding routing after the census exists.
    pairingReservation.pairing.commitPreBindingMessage(pairingReservation.reservation);
  }

  if (census.value.payload.phase === 'preparing') {
    const frozenConnection = frozenConnectionForIngressCensus({
      connection: connectionState.value,
      census: census.value.payload,
    });
    const currentBindings = new Map((await readBindingsForConnection({
      context,
      connectionId: connectionState.value.id,
    })).map((binding) => [binding.value.id, binding]));
    const missingValues: JsonRecord[] = [];
    for (const member of census.value.payload.matchedBindings) {
      const obligationId = await opaqueHmacRowId({
        routingIdentityKey: connectionState.value.payload.routingIdentityKey,
        domain: 'ingress-obligation',
        parts: [connectionState.value.id, member.bindingId, shell.occurrenceId],
      });
      const existing = asIngressObligation(readStateRow(await collection.get(
        obligationId,
        { signal: context.signal },
      )) ?? null);
      if (existing !== undefined) {
        if (
          existing.value.payload.censusId !== census.value.id
          || existing.value.payload.sourceAuthority.bindingRevision !== member.bindingRevision
          || existing.value.payload.sourceAuthority.bindingAuthorityEpoch !== member.bindingAuthorityEpoch
        ) {
          throw pluginError('channels_ingress_obligation_conflict', 'An ingress census member conflicts with its durable obligation.');
        }
        continue;
      }
      const binding = currentBindings.get(member.bindingId);
      if (
        binding === undefined
        || binding.row.revision !== member.bindingRevision
        || binding.value.payload.authorityEpoch !== member.bindingAuthorityEpoch
      ) {
        missingValues.push(createStaleIngressObligationValue({
          obligationId,
          censusId: census.value.id,
          connectionId: connectionState.value.id,
          connectionAuthorityEpoch: census.value.payload.connectionAuthorityEpoch,
          member,
          occurrenceId: shell.occurrenceId,
          now: Date.now(),
        }));
        continue;
      }
      const decision = ingressAdmissionDecision({
        binding: binding.value,
        bindingRevision: binding.row.revision,
        ingress: census.value.payload.normalizedIngress,
      });
      missingValues.push(createIngressObligationValue({
        censusId: census.value.id,
        obligationId,
        connection: frozenConnection,
        binding: binding.value,
        bindingRevision: binding.row.revision,
        ingress: census.value.payload.normalizedIngress,
        target: frozenTargetForBinding({
          obligationId,
          connection: frozenConnection,
          binding: binding.value,
          bindingRevision: binding.row.revision,
          ingress: census.value.payload.normalizedIngress,
          newSession: decision.newSession,
          approval: decision.approval,
        }),
        terminalOutcome: decision.terminalOutcome,
        now: Date.now(),
      }));
    }
    if (missingValues.length > 0) {
      const fence = {
        kind: 'assert' as const,
        rowId: census.row.rowId,
        expectedRevision: census.row.revision,
      };
      const puts = missingValues.map((value) => ({
        kind: 'put' as const,
        value,
        expectedRevision: 'absent' as const,
      }));
      const [limits, measurement] = await Promise.all([
        collection.limits({ signal: context.signal }),
        collection.measureBatch([fence, ...puts], { signal: context.signal }),
      ]);
      for (const values of partitionIngressPreparationValues({
        values: missingValues,
        limits,
        measurement,
      })) {
        const result = await collection.batch([
          fence,
          ...values.map((value) => ({ kind: 'put' as const, value, expectedRevision: 'absent' as const })),
        ], { signal: context.signal });
        if (result.status === 'conflict') {
          throw pluginError('channels_ingress_preparation_conflict', 'Ingress obligation preparation conflicted and must rejoin.', true);
        }
      }
    }
    const preparedValue = preparedIngressCensusValue({ census: census.value, now: Date.now() });
    const preparedResult = await collection.batch([
      { kind: 'put', value: preparedValue, expectedRevision: census.row.revision },
    ], { signal: context.signal });
    if (preparedResult.status === 'conflict') {
      census = asIngressCensus(readStateRow(await collection.get(censusId, { signal: context.signal })) ?? null);
    } else {
      const revision = preparedResult.results.find((entry) => entry.rowId === censusId && !entry.deleted)?.revision;
      census = revision === undefined ? undefined : asIngressCensus({ rowId: censusId, revision, value: preparedValue });
    }
  }

  if (census === undefined || census.value.payload.phase !== 'prepared') {
    throw pluginError('channels_ingress_census_unprepared', 'Ingress admission cannot begin before its census is prepared.', true);
  }

  if (pairingConsumed) return 'checkpointSafe';

  let checkpointOutcome: IngressCheckpointOutcome = 'checkpointSafe';
  for (const member of census.value.payload.matchedBindings) {
    assertNotAborted(context.signal);
    const obligationId = await opaqueHmacRowId({
      routingIdentityKey: connectionState.value.payload.routingIdentityKey,
      domain: 'ingress-obligation',
      parts: [connectionState.value.id, member.bindingId, shell.occurrenceId],
    });
    const obligation = asIngressObligation(readStateRow(await collection.get(
      obligationId,
      { signal: context.signal },
    )) ?? null);
    if (obligation === undefined) {
      throw pluginError(
        'channels_ingress_obligation_missing',
        'The immutable ingress census has no corresponding durable obligation.',
        true,
      );
    }
    if (obligation.value.payload.censusId !== census.value.id) {
      throw pluginError(
        'channels_ingress_occurrence_conflict',
        'The provider occurrence conflicts with its first immutable ingress evidence.',
      );
    }
    let outcome: IngressCheckpointOutcome;
    try {
      outcome = await dispatchIngressObligation({
        context,
        source,
        connectionId: connectionState.value.id,
        bindingId: member.bindingId,
        obligation,
        ingress: census.value.payload.normalizedIngress,
      });
    } catch (error) {
      if (
        source.kind !== 'checkpointedPoll'
        || (isPluginError(error) && error.code === 'channels_ingress_stale_authority')
      ) {
        throw error;
      }
      assertNotAborted(context.signal);
      outcome = await settleFailedIngressDueWork({ context, obligation });
    }
    checkpointOutcome = combineIngressCheckpointOutcomes(checkpointOutcome, outcome);
  }

  return checkpointOutcome;
}

function throwIfIngressObservationUnsettled(outcome: IngressObservationOutcome): void {
  if (outcome !== 'unsettled') return;
  throw pluginError(
    'channels_ingress_admission_unsettled',
    'The provider observation has an unsettled durable admission outcome.',
    true,
  );
}

/**
 * Provider callers can create/rejoin ingress obligations but cannot write the
 * connection checkpoint. Checkpointed-pull progress is owned below by the core
 * supervisor after its whole poll result settles.
 */
export async function ingestConversationProviderObservationForInvocation(
  input: ConversationProviderObservationIngestInputV1,
  context: PluginInvocationContext,
): Promise<void> {
  throwIfIngressObservationUnsettled(await ingestConversationObservationForInvocation(input, context, {
    kind: 'providerObservation',
    caller: stampedPluginCaller(context),
    directAction: false,
  }));
}

/**
 * A boundary failure after the guarded `attempting` write belongs to that one
 * retained row; neither in-page ingress nor the due-work pump may strand the
 * rest of its page behind an in-memory supervisor retry.
 */
async function settleFailedIngressDueWork(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
}>): Promise<IngressCheckpointOutcome> {
  assertNotAborted(input.context.signal);
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const current = asIngressObligation(readStateRow(await collection.get(
    input.obligation.row.rowId,
    { signal: input.context.signal },
  )) ?? null);
  if (current === undefined) return 'unsettled';
  if (current.value.terminal) return 'checkpointSafe';
  if (current.value.payload.lifecycle.phase === 'blocked') return 'checkpointSafe';
  if (current.value.payload.lifecycle.phase !== 'attempting') return 'unsettled';
  const exhausted = current.value.payload.lifecycle.attemptCount >= MAX_CONVERSATION_DELIVERY_ATTEMPTS;
  const value = exhausted
    ? blockedIngressObligationValue({ obligation: current.value, now: Date.now() })
    : retryDueIngressObligationValue({ obligation: current.value, now: Date.now() });
  try {
    const result = await collection.batch([
      { kind: 'put', value, expectedRevision: current.row.revision },
    ], { signal: input.context.signal });
    return result.status === 'conflict'
      ? 'unsettled'
      : exhausted ? 'checkpointSafe' : 'unsettled';
  } catch {
    assertNotAborted(input.context.signal);
    return 'unsettled';
  }
}

/** Sole durable due-work pump consumed by the core ingress supervisor. */
export async function runConversationIngressDueWorkForInvocation(input: Readonly<{
  now?: number;
  limit?: number;
}>, context: PluginInvocationContext): Promise<number> {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? 32;
  if (!isNonNegativeSafeInteger(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Ingress due-work bounds are invalid.');
  }
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const page = await collection.query({
    index: CHANNEL_STATE_INDEX_ID.byIngressDue,
    prefix: [CHANNEL_STATE_RECORD_KIND.ingressObligation],
    range: { upper: now },
    order: 'asc',
    limit,
  }, { signal: context.signal });
  let processed = 0;
  for (const raw of page.rows) {
    const obligation = asIngressObligation(readStateRow(raw) ?? null);
    if (
      obligation === undefined
      || obligation.value.terminal
      || obligation.value.payload.lifecycle.dueAt === null
      || obligation.value.payload.lifecycle.dueAt > now
    ) continue;
    try {
      const ingress = await readPreparedIngressForObligation({ context, obligation: obligation.value });
      const connection = asConnection(readStateRow(await collection.get(
        obligation.value['connection-id'],
        { signal: context.signal },
      )) ?? null);
      if (connection === undefined) continue;
      const source: IngressExecutionSource = {
        kind: 'checkpointedPoll',
        executionOrigin: connection.value.payload.transportOrigin,
        authorityEpoch: connection.value.payload.authorityEpoch,
      };
      await dispatchIngressObligation({
        context,
        source,
        connectionId: obligation.value['connection-id'],
        bindingId: obligation.value['binding-id'],
        obligation,
        ingress,
      });
    } catch {
      assertNotAborted(context.signal);
      await settleFailedIngressDueWork({ context, obligation });
    }
    processed += 1;
  }
  return processed;
}

type IngressRetentionCandidate = Readonly<{
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
  obligations: readonly Readonly<{ row: StateRow; value: IngressObligationRecord }>[];
}>;

/**
 * Replay coverage is transport-shaped. A checkpointed pull can re-deliver an
 * occurrence until its checkpoint advances past it, so only the checkpoint
 * commit may declare replay unnecessary there. Direct socket and durable-push
 * ingress has no such cursor: nothing can re-present the occurrence once its
 * obligations are terminal, and the frozen observation window plus the
 * connection-local expansion floor already reject a late re-delivery. Demanding
 * a checkpoint fact those transports can never receive is what retained their
 * complete inbound message bodies indefinitely.
 */
function requiresIngressCensusCheckpointCoverage(census: IngressCensusRecord): boolean {
  return ingressShell(census.payload.normalizedIngress).transport.kind === 'poll';
}

function isIngressCensusPastFrozenRetentionHorizon(input: Readonly<{
  census: IngressCensusRecord;
  now: number;
}>): boolean {
  const occurredAt = ingressShell(input.census.payload.normalizedIngress).occurredAt;
  return input.now > occurredAt
    && input.now - occurredAt > input.census.payload.maximumObservationAgeMs;
}

/**
 * A census becomes retirable only when replay is impossible and every member
 * has settled terminally. A checkpointed pull proves the replay half with its
 * coverage fact; direct ingress has no replay source to prove. A member row
 * that disappears afterward is a completed deletion, not a retry obligation.
 *
 * A terminal member's `attention` is an owner-visible diagnostic with no
 * recovery action attached, so it expires with the row exactly as c0.56's
 * outward `notDelivered` does. What still pins a census is unfinished work an
 * owner can act on: a non-terminal `blocked` member awaiting its retry, and
 * contradictory occurrence evidence on the census itself.
 */
async function readIngressRetentionCandidate(input: Readonly<{
  context: PluginInvocationContext;
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
  now: number;
}>): Promise<IngressRetentionCandidate | undefined> {
  const { census } = input;
  if (
    // Contradictory occurrence evidence is the ingress analogue of unresolved
    // outward ambiguity: it names a fact an owner still has to reconcile, so it
    // is retained indefinitely rather than expiring with the horizon.
    census.value.attention
    || census.value.payload.conflict !== null
    // A `preparing` census is unfinished admitted work, not expired evidence.
    // Its members may not all exist yet and it still holds the only copy of the
    // captured inbound message, so the horizon may never reclaim it: a replay
    // rejoins the census and finishes preparation instead.
    || census.value.payload.phase !== 'prepared'
    || (requiresIngressCensusCheckpointCoverage(census.value)
      && census.value.payload.checkpointCoveredAt === null)
    || !isIngressCensusPastFrozenRetentionHorizon({ census: census.value, now: input.now })
  ) return undefined;

  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connection = asConnection(readStateRow(await collection.get(
    census.value['connection-id'],
    { signal: input.context.signal },
  )) ?? null);
  if (connection === undefined) return undefined;
  const shell = ingressShell(census.value.payload.normalizedIngress);
  const obligations: Array<Readonly<{ row: StateRow; value: IngressObligationRecord }>> = [];
  for (const member of census.value.payload.matchedBindings) {
    const obligationId = await opaqueHmacRowId({
      routingIdentityKey: connection.value.payload.routingIdentityKey,
      domain: 'ingress-obligation',
      parts: [census.value['connection-id'], member.bindingId, shell.occurrenceId],
    });
    const obligation = asIngressObligation(readStateRow(await collection.get(
      obligationId,
      { signal: input.context.signal },
    )) ?? null);
    // Members are only ever deleted by this same unit-wide sweep, so an absent
    // row is a completed prior deletion of an already-eligible unit. A retained
    // row must still satisfy the monotonic terminal invariant itself: a member
    // that has not settled is unfinished work, never expired evidence.
    if (obligation === undefined) continue;
    if (obligation.value.payload.censusId !== census.value.id) return undefined;
    if (!obligation.value.terminal || obligation.value.payload.lifecycle.phase !== 'terminal') {
      return undefined;
    }
    obligations.push(obligation);
  }
  return { census, obligations };
}

async function deleteIngressRetentionCandidate(input: Readonly<{
  context: PluginInvocationContext;
  candidate: IngressRetentionCandidate;
}>): Promise<boolean> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  // The in-force batch-row limit, not the protocol ceiling: an operator can
  // lower it, and the ingress preparation packer already plans against the
  // published value. A retention delete sized to the ceiling would be rejected
  // outright on such a deployment and retention would silently stop.
  const { maxBatchRows } = await collection.limits({ signal: input.context.signal });
  assertNotAborted(input.context.signal);
  for (let offset = 0; offset < input.candidate.obligations.length; offset += maxBatchRows) {
    assertNotAborted(input.context.signal);
    const result = await collection.batch(input.candidate.obligations.slice(
      offset,
      offset + maxBatchRows,
    ).map((obligation) => ({
      kind: 'delete' as const,
      rowId: obligation.row.rowId,
      expectedRevision: obligation.row.revision,
    })), { signal: input.context.signal });
    if (result.status === 'conflict') return false;
  }
  assertNotAborted(input.context.signal);
  const result = await collection.batch([{
    kind: 'delete' as const,
    rowId: input.candidate.census.row.rowId,
    expectedRevision: input.candidate.census.row.revision,
  }], { signal: input.context.signal });
  return result.status === 'updated';
}

export type ConversationIngressRetentionRunResult = Readonly<{
  deletedCensuses: number;
  nextCursor?: string;
}>;

/**
 * Retention stays inside the sole ingress supervisor: it keyset-scans the
 * existing census collection index and performs no server-side scheduler,
 * quota projection, or alternate persistence path.
 */
export async function runConversationIngressRetentionForInvocation(input: Readonly<{
  now?: number;
  limit?: number;
  cursor?: string;
}>, context: PluginInvocationContext): Promise<ConversationIngressRetentionRunResult> {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE;
  if (
    !isNonNegativeSafeInteger(now)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > MAX_CHANNEL_ACCOUNT_COLLECTION_QUERY_PAGE_SIZE
  ) {
    throw new Error('Ingress retention bounds are invalid.');
  }
  assertNotAborted(context.signal);
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const page = await collection.query({
    index: CHANNEL_STATE_INDEX_ID.byKind,
    prefix: [CHANNEL_STATE_RECORD_KIND.ingressCensus],
    order: 'asc',
    limit,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  }, { signal: context.signal });
  let deletedCensuses = 0;
  for (const raw of page.rows) {
    assertNotAborted(context.signal);
    const census = asIngressCensus(readStateRow(raw) ?? null);
    if (census === undefined) continue;
    const candidate = await readIngressRetentionCandidate({ context, census, now });
    if (candidate === undefined) continue;
    if (await deleteIngressRetentionCandidate({ context, candidate })) deletedCensuses += 1;
  }
  return {
    deletedCensuses,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

export async function retryConversationIngressForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<JsonValue> {
  if (!isJsonRecord(input) || Object.keys(input).some((key) => key !== 'obligationId' && key !== 'expectedRevision')) {
    throw pluginError('channels_ingress_retry_input_invalid', 'Ingress retry input is invalid.');
  }
  const obligationId = own(input, 'obligationId');
  const expectedRevision = own(input, 'expectedRevision');
  if (
    typeof obligationId !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(obligationId)
    || !isPositiveSafeInteger(expectedRevision)
  ) {
    throw pluginError('channels_ingress_retry_input_invalid', 'Ingress retry input is invalid.');
  }
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const obligation = asIngressObligation(readStateRow(await collection.get(
    obligationId,
    { signal: context.signal },
  )) ?? null);
  if (
    obligation === undefined
    || obligation.row.revision !== expectedRevision
    || obligation.value.payload.lifecycle.phase !== 'blocked'
  ) {
    throw pluginError('channels_ingress_retry_conflict', 'The blocked ingress obligation changed before retry.', true);
  }
  const now = Date.now();
  const value: JsonRecord = {
    ...obligation.value,
    [CHANNEL_STATE_FIELD.terminal]: false,
    [CHANNEL_STATE_FIELD.attention]: false,
    [CHANNEL_STATE_FIELD.dueAt]: now,
    [CHANNEL_STATE_FIELD.updatedAt]: now,
    payload: {
      ...obligation.value.payload,
      lifecycle: { phase: 'retryDue', attemptCount: 0, dueAt: now },
      disposition: null,
      nonAdmission: null,
    },
  };
  const retried = await putIngressObligationLifecycle({ context, obligation, value });
  return {
    kind: 'retryScheduled',
    obligationId,
    revision: retried.row.revision,
  };
}

/** Live activation injects its one pairing manager; direct callers cannot mint one per observation. */
export function createConversationProviderObservationIngestHandler(pairing: ConversationPairingManager) {
  return async (
    input: ConversationProviderObservationIngestInputV1,
    context: PluginInvocationContext,
  ): Promise<void> => {
    throwIfIngressObservationUnsettled(await ingestConversationObservationForInvocation(input, context, {
      kind: 'providerObservation',
      caller: stampedPluginCaller(context),
      directAction: true,
    }, pairing));
  };
}

type ConversationStreamBaselineAcceptInput = Readonly<{
  connectionId: string;
  expectedRevision: number;
}>;

type ConversationConnectionUpdateResult = Readonly<{
  kind: 'updated' | 'unchanged';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
}>;

function readConversationStreamBaselineAcceptInput(
  input: JsonValue,
): ConversationStreamBaselineAcceptInput {
  if (!isJsonRecord(input) || Object.keys(input).some((key) => (
    key !== 'connectionId' && key !== 'expectedRevision'
  ))) {
    throw pluginError(
      'channels_stream_baseline_input_invalid',
      'Baseline acceptance input was not admitted by its strict contract.',
    );
  }
  const connectionId = own(input, 'connectionId');
  const expectedRevision = own(input, 'expectedRevision');
  if (
    typeof connectionId !== 'string'
    || !ConversationConnectionIdV1Schema.safeParse(connectionId).success
    || !isPositiveSafeInteger(expectedRevision)
  ) {
    throw pluginError(
      'channels_stream_baseline_input_invalid',
      'Baseline acceptance input was not admitted by its strict contract.',
    );
  }
  return { connectionId, expectedRevision };
}

function assertCurrentBaselineConnection(input: Readonly<{
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  expectedRevision: number;
}>): void {
  if (input.connection.row.revision !== input.expectedRevision) {
    throw pluginError(
      'channels_stream_baseline_conflict',
      'The Channel connection changed before its history baseline could be accepted.',
      true,
    );
  }
  if (
    !input.connection.value.payload.enabled
    || input.connection.value.payload.deletionState !== 'none'
    || hasUnsettledDestructiveOldTransportStop(input.connection.value.payload)
  ) {
    throw pluginError(
      'channels_stream_baseline_connection_unavailable',
      'The Channel connection is disabled or deleting and cannot accept a history baseline.',
      true,
    );
  }
}

function clearConnectionHistoryGapValue(input: Readonly<{
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  now: number;
}>): JsonRecord {
  const payload = own(input.connection.row.value, 'payload');
  if (!isJsonRecord(payload)) {
    throw pluginError(
      'channels_stream_baseline_connection_corrupt',
      'The current Channel connection cannot produce its canonical baseline reset.',
    );
  }
  return {
    ...input.connection.row.value,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...payload,
      historyGap: null,
      pollFailure: null,
    },
  } satisfies JsonRecord;
}

function connectionPollFailureValue(input: Readonly<{
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  pollFailure: ConversationConnectionPollFailureV1 | null;
  now: number;
}>): JsonRecord {
  const payload = own(input.connection.row.value, 'payload');
  if (!isJsonRecord(payload)) {
    throw pluginError(
      'channels_checkpointed_poll_connection_corrupt',
      'The current Channel connection cannot produce its canonical poll-failure transition.',
    );
  }
  return {
    ...input.connection.row.value,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...payload,
      pollFailure: input.pollFailure,
    },
  } satisfies JsonRecord;
}

function createCheckpointValue(input: Readonly<{
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  checkpointId: string;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined;
  checkpointAfter: JsonValue;
  lastOccurrenceId: string | null;
  nextPollNotBeforeMs: number | null;
  now: number;
}>): JsonRecord {
  const previousRevision = input.checkpoint?.value.payload.revision ?? 0;
  if (previousRevision >= Number.MAX_SAFE_INTEGER) {
    throw pluginError(
      'channels_stream_baseline_checkpoint_exhausted',
      'The Channel checkpoint revision cannot advance further.',
    );
  }
  return {
    id: input.checkpointId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.checkpoint,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connection.value.id,
    [CHANNEL_STATE_FIELD.createdAt]: input.checkpoint?.value['created-at'] ?? input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      authorityEpoch: input.connection.value.payload.authorityEpoch,
      opaqueToken: input.checkpointAfter,
      lastOccurrenceId: input.lastOccurrenceId,
      revision: previousRevision + 1,
      nextPollNotBeforeMs: input.nextPollNotBeforeMs,
    },
  } satisfies JsonRecord;
}

/** Preserves retained provider progress while moving only the connection authority fence. */
function createCheckpointAuthorityFenceValue(input: Readonly<{
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }>;
  authorityEpoch: number;
  now: number;
}>): JsonRecord {
  return {
    ...input.checkpoint.value,
    [CHANNEL_STATE_FIELD.version]: 1,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.checkpoint.value.payload,
      authorityEpoch: input.authorityEpoch,
    },
  } satisfies JsonRecord;
}

function updateResult(input: Readonly<{
  kind: 'updated' | 'unchanged';
  connectionId: string;
  revision: number;
  authorityEpoch: number;
}>): ConversationConnectionUpdateResult {
  return {
    kind: input.kind,
    connectionId: input.connectionId,
    revision: input.revision,
    authorityEpoch: input.authorityEpoch,
  };
}

async function readCurrentBaselineConnection(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  expectedRevision: number;
}>): Promise<Readonly<{ row: StateRow; value: ChannelConnectionRecord }>> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connection = asConnection(readStateRow(await collection.get(
    input.connectionId,
    { signal: input.context.signal },
  )) ?? null);
  if (connection === undefined) {
    throw pluginError(
      'channels_stream_baseline_connection_unavailable',
      'The requested Channel connection is unavailable for history baseline acceptance.',
      true,
    );
  }
  assertCurrentBaselineConnection({ connection, expectedRevision: input.expectedRevision });
  return connection;
}

async function readConnectionCheckpoint(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  checkpointId: string;
}>): Promise<Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const raw = await collection.get(input.checkpointId, { signal: input.context.signal });
  if (raw === null) return undefined;
  const checkpoint = asCheckpoint(readStateRow(raw) ?? null);
  if (checkpoint === undefined) {
    throw pluginError(
      'channels_stream_baseline_checkpoint_corrupt',
      'The retained Channel checkpoint is not a canonical connection checkpoint row.',
    );
  }
  if (checkpoint.value['connection-id'] !== input.connectionId) {
    throw pluginError(
      'channels_stream_baseline_checkpoint_corrupt',
      'The retained Channel checkpoint does not belong to its requested connection.',
    );
  }
  return checkpoint;
}

/**
 * A retained checkpoint can only be created by the core's checkpointed-poll
 * commit, whose first write accepts a no-history `checkpointOnly` result.
 * This is a read-only lifecycle predicate; it does not grant another writer.
 */
export async function hasConversationCheckpointedPullBaseline(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  routingIdentityKey: string;
}>): Promise<boolean> {
  const checkpointId = await deriveConversationCheckpointRowId({
    connectionId: input.connectionId,
    routingIdentityKey: input.routingIdentityKey,
  });
  return await readConnectionCheckpoint({
    context: input.context,
    connectionId: input.connectionId,
    checkpointId,
  }) !== undefined;
}

/**
 * The ingress checkpoint codec supplies the lifecycle owner with one exact
 * retained-row mutation. Transfer retains no progress-write authority: it
 * composes this opaque fence move with its replacement connection CAS.
 */
export type ConversationCheckpointTransferFence = Readonly<{
  checkpointId: string;
  expectedRevision: number;
  value: Readonly<Record<string, JsonValue>>;
}>;

export async function prepareConversationCheckpointTransferFence(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  routingIdentityKey: string;
  currentAuthorityEpoch: number;
  nextAuthorityEpoch: number;
  now: number;
}>): Promise<ConversationCheckpointTransferFence | undefined> {
  if (input.nextAuthorityEpoch !== input.currentAuthorityEpoch + 1) {
    throw pluginError(
      'channels_connection_transfer_checkpoint_transition_invalid',
      'A compatible connection transfer must advance its checkpoint fence by exactly one epoch.',
    );
  }
  assertNotAborted(input.context.signal);
  const checkpointId = await deriveConversationCheckpointRowId({
    routingIdentityKey: input.routingIdentityKey,
    connectionId: input.connectionId,
  });
  const checkpoint = await readConnectionCheckpoint({
    context: input.context,
    connectionId: input.connectionId,
    checkpointId,
  });
  if (checkpoint === undefined) return undefined;
  // Ordinary connection-policy edits advance authority without resetting retained
  // transport progress. A compatible transfer may therefore inherit an older fence;
  // the checkpoint-row revision and connection CAS below still guard the atomic write.
  // A checkpoint from a future authority is inconsistent and must fail closed.
  if (checkpoint.value.payload.authorityEpoch > input.currentAuthorityEpoch) {
    throw pluginError(
      'channels_connection_transfer_checkpoint_stale',
      'The retained checkpoint no longer has the current transfer authority fence.',
      true,
    );
  }
  return {
    checkpointId,
    expectedRevision: checkpoint.row.revision,
    value: createCheckpointAuthorityFenceValue({
      checkpoint,
      authorityEpoch: input.nextAuthorityEpoch,
      now: input.now,
    }),
  };
}

async function clearCurrentHistoryGapWithoutCheckpoint(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
}>): Promise<ConversationConnectionUpdateResult> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const result = await collection.batch([
    {
      kind: 'put',
      value: clearConnectionHistoryGapValue({ connection: input.connection, now: Date.now() }),
      expectedRevision: input.connection.row.revision,
    },
  ], { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_stream_baseline_conflict',
      'The Channel connection changed before its history baseline reset could commit.',
      true,
    );
  }
  const row = result.results.find((entry) => entry.rowId === input.connection.value.id && !entry.deleted);
  if (row === undefined) {
    throw pluginError(
      'channels_stream_baseline_result_invalid',
      'The Channel history baseline reset did not return its connection row.',
      true,
    );
  }
  return updateResult({
    kind: 'updated',
    connectionId: input.connection.value.id,
    revision: row.revision,
    authorityEpoch: input.connection.value.payload.authorityEpoch,
  });
}

type CheckpointedPollCommitMode = 'baseline' | 'normal';

type IngressCensusCheckpointSettlement = Readonly<{
  kind: 'cover' | 'assert';
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
}>;

async function commitCurrentCheckpointedPoll(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  expectedRevision: number;
  authorityEpoch: number;
  executionOrigin: PluginMachineExecutionOriginV1;
  checkpointId: string;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined;
  checkpointAfter: JsonValue;
  lastOccurrenceId: string | null;
  nextPollNotBeforeMs: number | null;
  censusSettlements?: readonly IngressCensusCheckpointSettlement[];
  mode: CheckpointedPollCommitMode;
}>): Promise<ConversationConnectionUpdateResult> {
  const connection = await readCurrentBaselineConnection({
    context: input.context,
    connectionId: input.connectionId,
    expectedRevision: input.expectedRevision,
  });
  const source: IngressExecutionSource = {
    kind: 'checkpointedPoll',
    executionOrigin: input.executionOrigin,
    authorityEpoch: input.authorityEpoch,
  };
  if (
    (input.mode === 'baseline') !== (connection.value.payload.historyGap !== null)
    || connection.value.payload.transport.kind !== 'checkpointedPull'
    || connection.value.payload.replayContinuity !== 'checkpointed'
  ) {
    throw pluginError(
      input.mode === 'baseline'
        ? 'channels_stream_baseline_conflict'
        : 'channels_checkpointed_poll_conflict',
      input.mode === 'baseline'
        ? 'The Channel connection no longer has the checkpointed history gap being baselined.'
        : 'The Channel connection no longer has the checkpointed poll authority being settled.',
      true,
    );
  }
  assertCurrentConnection({
    connection: connection.value,
    source,
  });
  const settlementById = new Map<string, IngressCensusCheckpointSettlement>();
  for (const settlement of input.censusSettlements ?? []) {
    const existing = settlementById.get(settlement.census.value.id);
    if (
      existing !== undefined
      && (
        existing.census.row.revision !== settlement.census.row.revision
        || existing.kind !== settlement.kind
      )
    ) {
      throw pluginError(
        'channels_checkpointed_poll_coverage_invalid',
        'The same ingress census cannot have two checkpoint settlement revisions.',
        true,
      );
    }
    if (
      settlement.census.value.attention
      || settlement.census.value.payload.conflict !== null
      || (settlement.kind === 'cover') !== (settlement.census.value.payload.checkpointCoveredAt === null)
    ) {
      throw pluginError(
        'channels_checkpointed_poll_coverage_invalid',
        'The checkpointed poll cannot settle an attention, conflicting, or mismatched ingress census.',
        true,
      );
    }
    settlementById.set(settlement.census.value.id, settlement);
  }
  const censusSettlements = [...settlementById.values()];
  if (censusSettlements.length > MAX_CHECKPOINTED_POLL_COVERAGE_OBSERVATIONS) {
    throw pluginError(
      'channels_checkpointed_poll_coverage_invalid',
      'The checkpointed poll has more census coverage writes than its atomic Account Collection batch permits.',
      true,
    );
  }
  const writesConnection = input.mode === 'baseline' || connection.value.payload.pollFailure !== null;
  const now = Date.now();
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const result = await collection.batch([
    ...(input.mode === 'baseline'
      ? [{
          kind: 'put' as const,
          value: clearConnectionHistoryGapValue({ connection, now }),
          expectedRevision: connection.row.revision,
        }]
      : writesConnection
        ? [{
            kind: 'put' as const,
            value: connectionPollFailureValue({ connection, pollFailure: null, now }),
            expectedRevision: connection.row.revision,
          }]
      : [{
          kind: 'assert' as const,
          rowId: connection.row.rowId,
          expectedRevision: connection.row.revision,
        }]),
    {
      kind: 'put' as const,
      value: createCheckpointValue({
        connection,
        checkpointId: input.checkpointId,
        checkpoint: input.checkpoint,
        checkpointAfter: input.checkpointAfter,
        lastOccurrenceId: input.lastOccurrenceId,
        nextPollNotBeforeMs: input.nextPollNotBeforeMs,
        now,
      }),
      expectedRevision: input.checkpoint?.row.revision ?? 'absent',
    },
    ...censusSettlements.map((settlement) => (
      settlement.kind === 'cover'
        ? {
            kind: 'put' as const,
            value: checkpointCoveredIngressCensusValue({ census: settlement.census.value, now }),
            expectedRevision: settlement.census.row.revision,
          }
        : {
            kind: 'assert' as const,
            rowId: settlement.census.row.rowId,
            expectedRevision: settlement.census.row.revision,
          }
    )),
  ], { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      input.mode === 'baseline'
        ? 'channels_stream_baseline_conflict'
        : 'channels_checkpointed_poll_conflict',
      input.mode === 'baseline'
        ? 'The Channel connection or checkpoint changed before its baseline could commit.'
        : 'The Channel connection or checkpoint changed before its poll result could commit.',
      true,
    );
  }
  const checkpointRow = result.results.find((entry) => entry.rowId === input.checkpointId && !entry.deleted);
  if (checkpointRow === undefined) {
    throw pluginError(
      input.mode === 'baseline'
        ? 'channels_stream_baseline_result_invalid'
        : 'channels_checkpointed_poll_result_invalid',
      'The Channel checkpoint settlement did not return its retained checkpoint row.',
      true,
    );
  }
  const row = writesConnection
    ? result.results.find((entry) => entry.rowId === input.connectionId && !entry.deleted)
    : connection.row;
  if (row === undefined) {
    throw pluginError(
      input.mode === 'baseline'
        ? 'channels_stream_baseline_result_invalid'
        : 'channels_checkpointed_poll_result_invalid',
      input.mode === 'baseline'
        ? 'The Channel baseline checkpoint did not return its connection row.'
        : 'The Channel poll checkpoint did not return its cleared connection row.',
      true,
    );
  }
  return updateResult({
    kind: 'updated',
    connectionId: input.connectionId,
    revision: row.revision,
    authorityEpoch: connection.value.payload.authorityEpoch,
  });
}

async function commitCurrentCheckpointedBaseline(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  expectedRevision: number;
  authorityEpoch: number;
  executionOrigin: PluginMachineExecutionOriginV1;
  checkpointId: string;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined;
  checkpointAfter: JsonValue;
  lastOccurrenceId: string | null;
  nextPollNotBeforeMs: number | null;
}>): Promise<ConversationConnectionUpdateResult> {
  return await commitCurrentCheckpointedPoll({
    ...input,
    mode: 'baseline',
  });
}

/**
 * The one connection-keyed checkpoint writer. A provider result is usable
 * only after the exact current poll origin and every ingress obligation are
 * revalidated; socket/provider observation ingestion has no checkpoint arm.
 */
export async function acceptConversationStreamBaselineForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationConnectionUpdateResult> {
  const request = readConversationStreamBaselineAcceptInput(input);
  assertNotAborted(context.signal);
  let connection = await readCurrentBaselineConnection({
    context,
    connectionId: request.connectionId,
    expectedRevision: request.expectedRevision,
  });
  const capturedInvocation = captureCheckpointedPollInvocation(connection);
  if (connection.value.payload.historyGap === null) {
    return updateResult({
      kind: 'unchanged',
      connectionId: connection.value.id,
      revision: connection.row.revision,
      authorityEpoch: connection.value.payload.authorityEpoch,
    });
  }
  if (connection.value.payload.replayContinuity !== 'checkpointed') {
    return await clearCurrentHistoryGapWithoutCheckpoint({ context, connection });
  }
  if (connection.value.payload.transport.kind !== 'checkpointedPull') {
    throw pluginError(
      'channels_stream_baseline_transport_unavailable',
      'Only a checkpointed-pull connection can establish a replacement replay baseline.',
      true,
    );
  }

  const checkpointId = await deriveConversationCheckpointRowId({
    routingIdentityKey: connection.value.payload.routingIdentityKey,
    connectionId: connection.value.id,
  });
  const checkpoint = await readConnectionCheckpoint({
    context,
    connectionId: connection.value.id,
    checkpointId,
  });
  let pollInput: ReturnType<typeof ConversationPollInputV1Schema.parse>;
  try {
    pollInput = ConversationPollInputV1Schema.parse({
      v: 1,
      connectionId: connection.value.id,
      providerConnectionKey: connection.value.payload.providerConnectionKey,
      providerConfigVersion: connection.value.payload.providerConfigVersion,
      providerConfig: connection.value.payload.providerConfig,
      credentialRef: connection.value.payload.credentialRef,
      checkpoint: null,
      limit: MAX_CHECKPOINTED_POLL_COVERAGE_OBSERVATIONS,
      waitMs: 0,
    });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_stream_baseline_connection_corrupt',
      message: 'The Channel connection cannot produce its canonical poll input.',
    }, { cause });
  }
  const provider = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: context.services.targetedContributions,
      signal: context.signal,
    },
    providerPluginId: connection.value.payload.providerPluginId,
    providerContributionSelection: connection.value.payload.providerContributionSelection,
  });
  const poll = provider.operations.observationsPoll;
  if (poll === undefined) {
    throw pluginError(
      'channels_stream_baseline_provider_poll_unavailable',
      'The current provider contribution does not support checkpointed-pull baselines.',
      true,
    );
  }
  const execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
    poll,
    pollInput,
    {
      signal: context.signal,
      expectedExecutionOrigin: connection.value.payload.transportOrigin,
    },
  );
  assertNotAborted(context.signal);
  if (!arePluginMachineExecutionOriginsEqual(
    execution.executionOrigin,
    connection.value.payload.transportOrigin,
  )) {
    throw pluginError(
      'channels_stream_baseline_stale_authority',
      'The provider poll settled from an origin that is no longer current for the Channel connection.',
      true,
    );
  }
  let result: ReturnType<typeof ConversationPollResultV1Schema.parse>;
  try {
    result = readConversationPollResultForAdmission(execution.result);
  } catch (cause) {
    await settleCapturedCheckpointedPollStop({
      context,
      connectionId: connection.value.id,
      capturedInvocation,
    });
    throw new PluginError({
      code: 'channels_stream_baseline_result_invalid',
      message: 'The provider poll did not return the strict Channel poll result.',
    }, { cause });
  }
  if (result.kind === 'batch' || result.kind === 'checkpointOnly') {
    const transferSettlement = await settleConversationProviderExclusiveCheckpointedPollReplacementForInvocation({
      connectionId: connection.value.id,
      expectedRevision: connection.row.revision,
      authorityEpoch: connection.value.payload.authorityEpoch,
      executionOrigin: execution.executionOrigin,
    }, context);
    if (transferSettlement.kind === 'staleAuthority') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: connection.value.id,
        capturedInvocation,
      });
      throw pluginError(
        'channels_stream_baseline_conflict',
        'The Channel replacement changed before provider-exclusive transfer custody could settle.',
        true,
      );
    }
    if (transferSettlement.kind === 'settled') {
      let settledConnection: typeof connection;
      try {
        settledConnection = await readCurrentBaselineConnection({
          context,
          connectionId: connection.value.id,
          expectedRevision: transferSettlement.revision,
        });
      } catch (cause) {
        if (!context.signal.aborted) {
          await settleCapturedCheckpointedPollStop({
            context,
            connectionId: connection.value.id,
            capturedInvocation,
          });
        }
        throw cause;
      }
      if (
        settledConnection.value.payload.authorityEpoch !== connection.value.payload.authorityEpoch
        || !arePluginMachineExecutionOriginsEqual(
          settledConnection.value.payload.transportOrigin,
          execution.executionOrigin,
        )
      ) {
        await settleCapturedCheckpointedPollStop({
          context,
          connectionId: connection.value.id,
          capturedInvocation,
        });
        throw pluginError(
          'channels_stream_baseline_conflict',
          'The Channel replacement changed after provider-exclusive transfer custody settled.',
          true,
        );
      }
      connection = settledConnection;
    }
  }
  if (result.kind === 'historyGap') {
    await settleCapturedCheckpointedPollStop({
      context,
      connectionId: connection.value.id,
      capturedInvocation,
    });
    throw pluginError(
      'channels_stream_baseline_provider_history_gap',
      'The provider cannot establish a replacement replay baseline from its current history.',
      true,
    );
  }
  if (result.kind === 'notReady') {
    await settleCapturedCheckpointedPollStop({
      context,
      connectionId: connection.value.id,
      capturedInvocation,
    });
    throw pluginError(
      'channels_stream_baseline_provider_not_ready',
      'The provider is not ready to establish a replacement replay baseline.',
      true,
    );
  }
  if (result.kind === 'batch') {
    await settleCapturedCheckpointedPollStop({
      context,
      connectionId: connection.value.id,
      capturedInvocation,
    });
    throw pluginError(
      'channels_stream_baseline_requires_checkpoint_only',
      'A replacement replay baseline can commit only a provider checkpoint without routing historical observations.',
      true,
    );
  }

  try {
    return await commitCurrentCheckpointedBaseline({
      context,
      connectionId: connection.value.id,
      expectedRevision: connection.row.revision,
      authorityEpoch: connection.value.payload.authorityEpoch,
      executionOrigin: execution.executionOrigin,
      checkpointId,
      checkpoint,
      checkpointAfter: result.checkpointAfterBatch,
      lastOccurrenceId: null,
      nextPollNotBeforeMs: result.retryHint === undefined ? null : Date.now() + result.retryHint.retryAfterMs,
    });
  } catch (cause) {
    if (!context.signal.aborted) {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: connection.value.id,
        capturedInvocation,
      });
    }
    throw cause;
  }
}

export type ConversationCheckpointedPollRunResult =
  | Readonly<{ kind: 'ineligible' }>
  | Readonly<{ kind: 'historyGap'; disposition: 'recorded' | 'rejoined' }>
  | Readonly<{ kind: 'retry'; retryAfterMs?: number }>
  | Readonly<{ kind: 'blocked' }>
  | Readonly<{
    kind: 'committed';
    connectionId: string;
    revision: number;
    authorityEpoch: number;
    retryAfterMs?: number;
  }>;

function boundedPollActionText(value: unknown, maximumUtf8Bytes: number, fallback: string): string {
  const source = typeof value === 'string' && value.length > 0 ? value : fallback;
  let result = '';
  let usedBytes = 0;
  for (const character of source) {
    const characterBytes = utf8ByteLength(character);
    if (usedBytes + characterBytes > maximumUtf8Bytes) break;
    result += character;
    usedBytes += characterBytes;
  }
  return result.length > 0 ? result : fallback;
}

function pollActionFailureEvidence(cause: unknown): ConversationConnectionPollFailureEvidenceV1 {
  const code = isPluginError(cause)
    ? cause.code
    : 'channels_checkpointed_poll_action_failed';
  const message = cause instanceof Error
    ? cause.message
    : 'The contributed provider poll Action failed before returning a result.';
  return {
    kind: 'action',
    code: boundedPollActionText(code, 256, 'channels_checkpointed_poll_action_failed'),
    message: boundedPollActionText(
      message,
      1024,
      'The contributed provider poll Action failed before returning a result.',
    ),
  };
}

/**
 * The Action owner establishes these around the contributed handler. They are
 * currentness loss, not a provider poll failure, so the connection row must
 * not turn a superseded origin into a durable user-unblock state.
 */
function isPollActionOriginCurrentnessLoss(cause: unknown): boolean {
  return isPluginError(cause) && (
    cause.code === 'plugin_action_execution_origin_mismatch'
    || cause.code === 'plugin_action_execution_origin_unavailable'
    || cause.code === 'plugin_action_execution_origin_changed'
  );
}

async function settleCurrentCheckpointedPollFailure(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  evidence: ConversationConnectionPollFailureEvidenceV1;
  retryAfterMs?: number;
  retryableProviderResult: boolean;
}>): Promise<Extract<ConversationCheckpointedPollRunResult, Readonly<{ kind: 'retry' | 'blocked' | 'ineligible' }>>> {
  assertNotAborted(input.context.signal);
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const currentRow = await collection.get(
    input.connection.value.id,
    { signal: input.context.signal },
  );
  assertNotAborted(input.context.signal);
  const current = asConnection(readStateRow(currentRow) ?? null);
  if (
    current === undefined
    || current.row.revision !== input.connection.row.revision
    || current.value.payload.authorityEpoch !== input.connection.value.payload.authorityEpoch
    || !arePluginMachineExecutionOriginsEqual(
      current.value.payload.transportOrigin,
      input.connection.value.payload.transportOrigin,
    )
  ) {
    return { kind: 'ineligible' };
  }
  const nextAttemptCount = (current.value.payload.pollFailure?.attemptCount ?? 0) + 1;
  const retryable = input.retryableProviderResult && nextAttemptCount < 5;
  const now = Date.now();
  const retryAfterMs = input.retryAfterMs ?? conversationRetryDelayMs(nextAttemptCount);
  const pollFailure: ConversationConnectionPollFailureV1 = retryable
    ? {
        phase: 'retryDue',
        attemptCount: nextAttemptCount as 1 | 2 | 3 | 4,
        retryNotBeforeMs: now + retryAfterMs,
        evidence: input.evidence,
      }
    : {
        phase: 'blocked',
        attemptCount: nextAttemptCount as 1 | 2 | 3 | 4 | 5,
        retryNotBeforeMs: null,
        evidence: input.evidence,
      };
  const value = connectionPollFailureValue({ connection: current, pollFailure, now });
  const result = await collection.batch([
    { kind: 'put', value, expectedRevision: current.row.revision },
  ], { signal: input.context.signal });
  if (result.status === 'conflict') return { kind: 'ineligible' };
  const row = result.results.find((entry) => entry.rowId === current.value.id && !entry.deleted);
  if (row === undefined) {
    const reread = asConnection(readStateRow(await collection.get(
      current.value.id,
      { signal: input.context.signal },
    )) ?? null);
    if (
      reread === undefined
      || reread.value.payload.pollFailure?.phase !== pollFailure.phase
      || reread.value.payload.pollFailure.attemptCount !== pollFailure.attemptCount
    ) return { kind: 'ineligible' };
  }
  return retryable
    ? (input.retryAfterMs === undefined ? { kind: 'retry' } : { kind: 'retry', retryAfterMs: input.retryAfterMs })
    : { kind: 'blocked' };
}

function isEligibleCheckpointedPollConnection(
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>,
): boolean {
  const payload = connection.value.payload;
  return payload.enabled
    && payload.deletionState === 'none'
    && !hasUnsettledDestructiveOldTransportStop(payload)
    && payload.historyGap === null
    && payload.transport.kind === 'checkpointedPull'
    && payload.replayContinuity === 'checkpointed'
    && (
      payload.pollFailure === null
      || (
        payload.pollFailure.phase === 'retryDue'
        && payload.pollFailure.retryNotBeforeMs <= Date.now()
      )
    );
}

async function readEligibleCheckpointedPollConnection(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
}>): Promise<Readonly<{ row: StateRow; value: ChannelConnectionRecord }> | undefined> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const raw = await collection.get(input.connectionId, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (raw === null) return undefined;
  const connection = asConnection(readStateRow(raw) ?? null);
  if (connection === undefined) {
    throw pluginError(
      'channels_checkpointed_poll_connection_corrupt',
      'The retained Channel connection is not a canonical checkpointed-poll row.',
    );
  }
  if (!isEligibleCheckpointedPollConnection(connection)) return undefined;

  const conflictPage = await collection.query({
    index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
    prefix: [
      input.connectionId,
      null,
      CHANNEL_STATE_RECORD_KIND.ingressCensus,
      true,
    ],
    order: 'asc',
    limit: 1,
  }, { signal: input.context.signal });
  assertNotAborted(input.context.signal);
  if (conflictPage.rows.length === 0) return connection;
  const conflict = asIngressCensus(readStateRow(conflictPage.rows[0]) ?? null);
  if (
    conflict === undefined
    || conflict.value['connection-id'] !== input.connectionId
    || !conflict.value.attention
    || conflict.value.payload.conflict?.kind !== 'occurrenceEvidenceMismatch'
  ) {
    throw pluginError(
      'channels_checkpointed_poll_connection_corrupt',
      'The retained Channel conflict index row is not a canonical ingress census conflict.',
    );
  }
  return undefined;
}

function createCurrentCheckpointedPollInput(input: Readonly<{
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined;
  waitMs: number;
}>): ReturnType<typeof ConversationPollInputV1Schema.parse> {
  try {
    return ConversationPollInputV1Schema.parse({
      v: 1,
      connectionId: input.connection.value.id,
      providerConnectionKey: input.connection.value.payload.providerConnectionKey,
      providerConfigVersion: input.connection.value.payload.providerConfigVersion,
      providerConfig: input.connection.value.payload.providerConfig,
      credentialRef: input.connection.value.payload.credentialRef,
      checkpoint: input.checkpoint?.value.payload.opaqueToken ?? null,
      limit: MAX_CHECKPOINTED_POLL_COVERAGE_OBSERVATIONS,
      waitMs: input.waitMs,
    });
  } catch (cause) {
    throw new PluginError({
      code: 'channels_checkpointed_poll_connection_corrupt',
      message: 'The Channel connection cannot produce its canonical poll input.',
    }, { cause });
  }
}

type CapturedCheckpointedPollInvocation = ConversationCheckpointedPollInvocationBasisV1;

function captureCheckpointedPollInvocation(
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>,
): CapturedCheckpointedPollInvocation {
  return {
    connectionRevision: connection.row.revision,
    authorityEpoch: connection.value.payload.authorityEpoch,
    transportOrigin: connection.value.payload.transportOrigin,
  };
}

/**
 * An old poll may prove quiescence only after it has returned from its exact
 * captured invocation. The current retained slot supplies the frozen request;
 * the lifecycle owner re-reads and exact-compares both before its one CAS.
 */
async function settleCapturedCheckpointedPollStop(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  capturedInvocation: CapturedCheckpointedPollInvocation;
}>): Promise<void> {
  if (input.context.signal.aborted) return;
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const raw = await collection.get(input.connectionId, { signal: input.context.signal });
  if (raw === null) return;
  const current = asConnection(readStateRow(raw) ?? null);
  const frozenStopRequest = current?.value.payload.pendingOldTransportStop?.stopRequest;
  if (frozenStopRequest === undefined) return;
  await confirmConversationCheckpointedPollStopForInvocation({
    connectionId: input.connectionId,
    capturedInvocation: input.capturedInvocation,
    frozenStopRequest,
  }, input.context);
}

/**
 * Coverage records exactly one fact: the checkpoint being committed in this
 * batch advances the provider cursor past this occurrence, so no later poll
 * can re-present it. That is true of every observation the committing batch
 * carries, including one whose obligation is still blocked — the cursor is
 * held back only when the whole batch is unsettled, and then nothing commits.
 *
 * Member custody is deliberately not folded in here. Retention re-derives it
 * from the live rows anyway, and requiring it at commit time stranded any
 * occurrence that blocked at poll time: it is never presented again, so the
 * coverage it had already earned could never be written and its complete
 * inbound body was retained forever even after a manual retry settled it.
 */
async function readIngressCensusCheckpointCoverageCandidate(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  observation: ConversationNormalizedIngressV1;
}>): Promise<IngressCensusCheckpointSettlement | undefined> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connection = asConnection(readStateRow(await collection.get(
    input.connectionId,
    { signal: input.context.signal },
  )) ?? null);
  if (connection === undefined) return undefined;
  const shell = ingressShell(input.observation);
  const censusId = await deriveIngressCensusRowId({
    routingIdentityKey: connection.value.payload.routingIdentityKey,
    connectionId: input.connectionId,
    occurrenceId: shell.occurrenceId,
  });
  const census = asIngressCensus(readStateRow(await collection.get(
    censusId,
    { signal: input.context.signal },
  )) ?? null);
  if (
    census === undefined
    || census.value['connection-id'] !== input.connectionId
    || census.value.payload.phase !== 'prepared'
    || census.value.attention
    || census.value.payload.conflict !== null
  ) return undefined;
  return {
    kind: census.value.payload.checkpointCoveredAt === null ? 'cover' : 'assert',
    census,
  };
}

/**
 * One bounded poll result is admitted in provider order. The enclosing
 * supervisor invokes one poll result at a time, so the provider batch bound is
 * also the maximum retained work without a second queue or cursor owner.
 */
async function routeCheckpointedPollBatch(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  pairing?: ConversationPairingManager;
  source: Extract<IngressExecutionSource, Readonly<{ kind: 'checkpointedPoll' }>>;
  observations: readonly ConversationNormalizedIngressV1[];
}>): Promise<
  | Readonly<{
    kind: 'checkpointSafe';
    censusSettlements: readonly IngressCensusCheckpointSettlement[];
  }>
  | Readonly<{ kind: 'unsettled' }>
> {
  let outcome: 'checkpointSafe' | 'unsettled' = 'checkpointSafe';
  const censusSettlements = new Map<string, IngressCensusCheckpointSettlement>();
  for (const observation of input.observations) {
    assertNotAborted(input.context.signal);
    const observationOutcome = await ingestConversationObservationForInvocation(
      { connectionId: input.connectionId, observation },
      input.context,
      input.source,
      input.pairing,
    );
    if (observationOutcome === 'unsettled') {
      outcome = 'unsettled';
      continue;
    }
    if (observationOutcome === 'checkpointSafeNoCensus') continue;
    const settlement = await readIngressCensusCheckpointCoverageCandidate({
      context: input.context,
      connectionId: input.connectionId,
      observation,
    });
    if (settlement !== undefined) censusSettlements.set(settlement.census.value.id, settlement);
  }
  return outcome === 'unsettled'
    ? { kind: 'unsettled' }
    : { kind: 'checkpointSafe', censusSettlements: [...censusSettlements.values()] };
}

/**
 * The selected core poll consumer. It rereads the Account row before the
 * provider effect and again before every ingress/checkpoint/history-gap
 * effect; no provider-local token survives an uncommitted guarded write.
 */
export async function runConversationCheckpointedPollForInvocation(input: Readonly<{
  connectionId: string;
  waitMs?: number;
}>, context: PluginInvocationContext, pairing?: ConversationPairingManager): Promise<ConversationCheckpointedPollRunResult> {
  const waitMs = input.waitMs ?? MAX_CONVERSATION_RECEIVE_WAIT_MS;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_CONVERSATION_RECEIVE_WAIT_MS) {
    throw new Error('Checkpointed poll wait must be a bounded non-negative safe integer.');
  }
  assertNotAborted(context.signal);
  const connection = await readEligibleCheckpointedPollConnection({ context, connectionId: input.connectionId });
  if (connection === undefined) {
    await confirmConversationCheckpointedPollStopForInvocation({ connectionId: input.connectionId }, context);
    return { kind: 'ineligible' };
  }
  const capturedInvocation = captureCheckpointedPollInvocation(connection);

  const checkpointId = await deriveConversationCheckpointRowId({
    routingIdentityKey: connection.value.payload.routingIdentityKey,
    connectionId: connection.value.id,
  });
  const checkpoint = await readConnectionCheckpoint({
    context,
    connectionId: connection.value.id,
    checkpointId,
  });
  if (
    checkpoint?.value.payload.nextPollNotBeforeMs !== null
    && checkpoint?.value.payload.nextPollNotBeforeMs !== undefined
    && checkpoint.value.payload.nextPollNotBeforeMs > Date.now()
  ) {
    return {
      kind: 'retry',
      retryAfterMs: checkpoint.value.payload.nextPollNotBeforeMs - Date.now(),
    };
  }
  let execution: Awaited<ReturnType<PluginInvocationContext['services']['actions']['executeAdmittedTargetedOperationWithExecutionOrigin']>>;
  try {
    const provider = await readCurrentProviderContributionForPersistedSelection({
      context: {
        targetedContributions: context.services.targetedContributions,
        signal: context.signal,
      },
      providerPluginId: connection.value.payload.providerPluginId,
      providerContributionSelection: connection.value.payload.providerContributionSelection,
    });
    const poll = provider.operations.observationsPoll;
    if (poll === undefined) {
      throw pluginError(
        'channels_checkpointed_poll_provider_unavailable',
        'The current provider contribution does not support checkpointed polling.',
        true,
      );
    }
    execution = await context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
      poll,
      createCurrentCheckpointedPollInput({ connection, checkpoint, waitMs }),
      {
        signal: context.signal,
        expectedExecutionOrigin: connection.value.payload.transportOrigin,
      },
    );
  } catch (cause) {
    assertNotAborted(context.signal);
    if (isPollActionOriginCurrentnessLoss(cause)) {
      if (isPluginError(cause) && cause.code === 'plugin_action_execution_origin_changed') {
        await settleCapturedCheckpointedPollStop({
          context,
          connectionId: input.connectionId,
          capturedInvocation,
        });
      }
      return { kind: 'ineligible' };
    }
    const failure = await settleCurrentCheckpointedPollFailure({
      context,
      connection,
      evidence: pollActionFailureEvidence(cause),
      retryableProviderResult: false,
    });
    if (failure.kind === 'ineligible') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
    }
    return failure;
  }
  assertNotAborted(context.signal);
  if (!arePluginMachineExecutionOriginsEqual(execution.executionOrigin, connection.value.payload.transportOrigin)) {
    return await settleCurrentCheckpointedPollFailure({
      context,
      connection,
      evidence: {
        kind: 'action',
        code: 'channels_checkpointed_poll_execution_origin_mismatch',
        message: 'The provider poll settled from an origin that is no longer current for the Channel connection.',
      },
      retryableProviderResult: false,
    });
  }

  let current = await readEligibleCheckpointedPollConnection({ context, connectionId: input.connectionId });
  if (
    current === undefined
    || current.row.revision !== connection.row.revision
    || !arePluginMachineExecutionOriginsEqual(
      current.value.payload.transportOrigin,
      execution.executionOrigin,
    )
  ) {
    await settleCapturedCheckpointedPollStop({
      context,
      connectionId: input.connectionId,
      capturedInvocation,
    });
    return { kind: 'ineligible' };
  }

  let result: ReturnType<typeof ConversationPollResultV1Schema.parse>;
  try {
    result = readConversationPollResultForAdmission(execution.result);
  } catch (cause) {
    const failure = await settleCurrentCheckpointedPollFailure({
      context,
      connection: current,
      evidence: {
        kind: 'action',
        code: 'channels_checkpointed_poll_result_invalid',
        message: 'The provider poll did not return the strict Channel poll result.',
      },
      retryableProviderResult: false,
    });
    if (failure.kind === 'ineligible') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
    }
    return failure;
  }
  if (result.kind === 'batch' || result.kind === 'checkpointOnly') {
    const transferSettlement = await settleConversationProviderExclusiveCheckpointedPollReplacementForInvocation({
      connectionId: current.value.id,
      expectedRevision: current.row.revision,
      authorityEpoch: current.value.payload.authorityEpoch,
      executionOrigin: execution.executionOrigin,
    }, context);
    if (transferSettlement.kind === 'staleAuthority') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
      return { kind: 'ineligible' };
    }
    if (transferSettlement.kind === 'settled') {
      const settledCurrent = await readEligibleCheckpointedPollConnection({
        context,
        connectionId: input.connectionId,
      });
      if (
        settledCurrent === undefined
        || settledCurrent.row.revision !== transferSettlement.revision
        || settledCurrent.value.payload.authorityEpoch !== current.value.payload.authorityEpoch
        || !arePluginMachineExecutionOriginsEqual(
          settledCurrent.value.payload.transportOrigin,
          execution.executionOrigin,
        )
      ) {
        await settleCapturedCheckpointedPollStop({
          context,
          connectionId: input.connectionId,
          capturedInvocation,
        });
        return { kind: 'ineligible' };
      }
      current = settledCurrent;
    }
  }
  if (result.kind === 'notReady') {
    const failure = await settleCurrentCheckpointedPollFailure({
      context,
      connection: current,
      evidence: {
        kind: 'provider',
        reason: result.reason,
        ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      },
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
      retryableProviderResult: result.reason === 'network' || result.reason === 'rateLimited',
    });
    if (failure.kind === 'ineligible') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
    }
    return failure;
  }
  if (result.kind === 'historyGap') {
    const disposition = await recordConversationCheckpointedPollHistoryGapForInvocation({
      connectionId: current.value.id,
      expectedRevision: current.row.revision,
      authorityEpoch: current.value.payload.authorityEpoch,
      executionOrigin: execution.executionOrigin,
      fact: {
        reason: result.reason,
        ...(result.diagnostic === undefined ? {} : { diagnostic: result.diagnostic }),
      },
    }, context);
    if (disposition === 'staleAuthority') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
      return { kind: 'ineligible' };
    }
    return { kind: 'historyGap', disposition };
  }
  if (result.kind === 'batch' && checkpoint === undefined) {
    // A null checkpoint is a no-history baseline. Only checkpointOnly may make
    // that provider token current; ordinary observations remain untouched.
    const failure = await settleCurrentCheckpointedPollFailure({
      context,
      connection: current,
      evidence: {
        kind: 'action',
        code: 'channels_checkpointed_poll_baseline_required',
        message: 'A provider batch cannot advance a Channel connection before its checkpoint baseline exists.',
      },
      retryableProviderResult: false,
    });
    if (failure.kind === 'ineligible') {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
    }
    return failure;
  }

  const source: Extract<IngressExecutionSource, Readonly<{ kind: 'checkpointedPoll' }>> = {
    kind: 'checkpointedPoll',
    executionOrigin: execution.executionOrigin,
    authorityEpoch: current.value.payload.authorityEpoch,
  };
  let settled: ConversationConnectionUpdateResult;
  let censusSettlements: readonly IngressCensusCheckpointSettlement[] = [];
  try {
    if (result.kind === 'batch') {
      const batchOutcome = await routeCheckpointedPollBatch({
        context,
        connectionId: current.value.id,
        pairing,
        source,
        observations: result.observations,
      });
      if (batchOutcome.kind === 'unsettled') return { kind: 'retry' };
      censusSettlements = batchOutcome.censusSettlements;
    }
    settled = await commitCurrentCheckpointedPoll({
      context,
      connectionId: current.value.id,
      expectedRevision: current.row.revision,
      authorityEpoch: current.value.payload.authorityEpoch,
      executionOrigin: execution.executionOrigin,
      checkpointId,
      checkpoint,
      checkpointAfter: result.checkpointAfterBatch,
      lastOccurrenceId: result.kind === 'batch'
        ? (result.observations.at(-1) === undefined ? null : ingressShell(result.observations.at(-1)!).occurrenceId)
        : null,
      nextPollNotBeforeMs: result.retryHint === undefined ? null : Date.now() + result.retryHint.retryAfterMs,
      censusSettlements,
      mode: 'normal',
    });
  } catch (cause) {
    if (!context.signal.aborted) {
      await settleCapturedCheckpointedPollStop({
        context,
        connectionId: input.connectionId,
        capturedInvocation,
      });
    }
    throw cause;
  }
  const committed: Extract<ConversationCheckpointedPollRunResult, Readonly<{ kind: 'committed' }>> = {
    kind: 'committed',
    connectionId: settled.connectionId,
    revision: settled.revision,
    authorityEpoch: settled.authorityEpoch,
  };
  return result.retryHint !== undefined
    ? { ...committed, retryAfterMs: result.retryHint.retryAfterMs }
    : committed;
}
