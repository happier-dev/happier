import {
  isPluginError,
  PluginError,
  arePluginMachineExecutionOriginsEqual,
  type JsonValue,
  type PluginInvocationCaller,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import {
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1,
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginCollectionBatchMeasurement,
  type PluginCollectionLimits,
  type PluginCollectionMutation,
} from '@happier-dev/plugin-sdk/collections';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type {
  PluginActionResultById,
  PluginMachineExecutionOriginV1,
} from '@happier-dev/plugin-sdk/actions';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/plugin-sdk/actions';
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
  ConversationIngressAutomationEventCandidateV1Schema,
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
  type ConversationIngressAutomationEventCandidateV1,
  type ConversationIngressObservedEntryV1,
  ConversationProviderAutomationEventAdmitResultV1Schema,
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
import {
  isConversationPollFailureAttemptCount,
  isConversationPollRetryAttemptCount,
} from './connectionPollFailureBounds.js';
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
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { conversationRetryDelayMs } from './retryBackoff.js';
import {
  acceptConversationOutwardDeliveryReady,
  createConversationOutwardDeliveryCollectionStore,
  prepareConversationOutwardDeliveryReady,
  type ConversationControlResponseKind,
  type ConversationOutwardDeliveryObligation,
} from './outwardDelivery.js';
import {
  readConversationPendingPermissions,
  type ConversationPendingPermissionProjection,
} from './permissionMediation.js';
import {
  asChannelStateRow as readStateRow,
  readConversationBindingUpdateRow,
  readConversationConnectionUpdateRow,
  type ChannelStateRow as StateRow,
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
  for (const entry of result.observations) {
    const observation = entry.observation;
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
  /**
   * The one frozen `/answer` payload this obligation may pass unchanged to
   * the canonical AskUserQuestion owner. Choice membership, required answers,
   * and answer shape remain Session-owned.
   */
  userActionAnswer: Readonly<{
    requestId: string;
    answers: readonly Readonly<{
      questionIndex: number;
      values: readonly string[];
    }>[];
  }> | null;
}>;

type FrozenAutomationTarget = Readonly<{
  kind: 'automation';
  automationId: string;
  occurrenceKey: string;
  resultDelivery: AutomationConversationResultDeliveryV1;
}>;

/**
 * A provider-owned Automation Event candidate under the selected provider
 * contribution. This is intentionally not a binding target: the provider
 * Action owns definition selection/admission, while Channels owns its one
 * ingress retry/checkpoint lifecycle.
 */
type FrozenEventTarget = Readonly<{
  kind: 'event';
  candidate: ConversationIngressAutomationEventCandidateV1;
  providerPluginId: string;
  providerContributionSelection: PersistedConversationProviderContributionSelection;
  executionOrigin: PluginMachineExecutionOriginV1;
}>;

type FrozenIngressTarget = FrozenSessionTarget | FrozenAutomationTarget | FrozenEventTarget;

type IngressCheckpointOutcome = 'checkpointSafe' | 'unsettled';
type IngressObservationOutcome = 'checkpointSafe' | 'checkpointSafeNoCensus' | 'unsettled';

type IngressDisposition =
  | 'admitted'
  | 'rejected'
  | 'suppressed'
  | 'pairingConsumed'
  | 'approvalConsumed'
  | 'userActionConsumed'
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
    bindingRevision: number | null;
    bindingAuthorityEpoch: number | null;
  }>;
  lifecycle: Readonly<{
    phase: 'debounceDue' | 'ready' | 'attempting' | 'retryDue' | 'blocked' | 'terminal';
    attemptCount: number;
    dueAt: number | null;
  }>;
  /**
   * The host-stamped turn resolved for this obligation's frozen chat approval,
   * persisted before the irreversible mediation effect. `sessionId`,
   * `requestId`, `decision`, and `scope` are already immutable in the frozen
   * target and the idempotency key is derived from this row's id, so the turn
   * is the one member of the canonical owner's replay tuple that a projection
   * would otherwise have to re-supply after the answer stopped being pending.
   */
  approvalTurnId: string | null;
  /**
   * The exact host-stamped turn for the frozen user-action answer. This lives
   * on the incumbent ingress obligation before the irreversible Action call;
   * it is not a second request/result store.
   */
  userActionAnswerTurnId: string | null;
  disposition: IngressDisposition | null;
  nonAdmission: IngressNonAdmission | null;
}>;

type IngressObligationRecord = Readonly<{
  id: string;
  'record-kind': typeof CHANNEL_STATE_RECORD_KIND.ingressObligation;
  v: 1;
  'connection-id': string;
  /** Omitted for connection-owned provider Event obligations. */
  'binding-id'?: string;
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

/** The one census has binding fanout plus at most one provider Event member. */
type IngressCensusObligationMember =
  | Readonly<{ kind: 'binding'; binding: IngressCensusMatchedBinding }>
  | Readonly<{ kind: 'event'; candidate: ConversationIngressAutomationEventCandidateV1 }>;

/**
 * The body-free replay identity a settled census keeps in place of the full
 * admitted ingress: the authenticated envelope it was already able to publish
 * without a body, plus one connection-keyed digest of the admitted text. Both
 * halves of replay equality — exact re-delivery and a later unsupported edit
 * of the same message revision — still decide from it, while the message text
 * itself stops being duplicated outside the Session transcript.
 */
type IngressCensusCompacted = Readonly<{
  shell: ConversationAuthenticatedObservationShellV1;
  textDigest: string;
  /** Exact terminal-attention members retained until this census horizon. */
  retainedAttentionObligationRowIds: readonly string[];
}>;

type IngressCensusCommonPayload = Readonly<{
  phase: 'preparing' | 'prepared';
  connectionAuthorityEpoch: number;
  maximumObservationAgeMs: number;
  /**
   * Set only in the checkpoint CAS that carries this occurrence, and only for
   * a prepared, conflict-free census. It records that the provider cursor has
   * moved past the occurrence, not that its members finished: a member the
   * retry ladder has exhausted keeps durable Account custody plus its manual
   * retry, and requiring member custody here stranded exactly those units,
   * because the provider never presents them again and the coverage they had
   * already earned could then never be written. Member custody is re-derived
   * from the live rows by retention, which is the owner that needs it.
   */
  checkpointCoveredAt: number | null;
  /** Strict terminal fact for contradictory immutable occurrence evidence. */
  conflict: Readonly<{ kind: 'occurrenceEvidenceMismatch' }> | null;
  /** One optional provider Event candidate, never a binding fanout. */
  eventCandidate: ConversationIngressAutomationEventCandidateV1 | null;
  matchedBindings: readonly IngressCensusMatchedBinding[];
}>;

type IngressCensusPayload =
  | (IngressCensusCommonPayload & Readonly<{
    normalizedIngress: ConversationNormalizedIngressV1;
    compacted: null;
  }>)
  | (IngressCensusCommonPayload & Readonly<{
    normalizedIngress: null;
    compacted: IngressCensusCompacted;
  }>);

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

function ingressCensusObligationMembers(
  payload: IngressCensusPayload,
): readonly IngressCensusObligationMember[] {
  return [
    ...payload.matchedBindings.map((binding) => ({ kind: 'binding' as const, binding })),
    ...(payload.eventCandidate === null
      ? []
      : [{ kind: 'event' as const, candidate: payload.eventCandidate }]),
  ];
}

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
const MAX_CHECKPOINTED_POLL_COVERAGE_OBSERVATIONS =
  PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 - 2;
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
    const frozenUserActionAnswer = own(value, 'userActionAnswer');
    let userActionAnswer: FrozenSessionTarget['userActionAnswer'];
    if (frozenUserActionAnswer === undefined || frozenUserActionAnswer === null) {
      userActionAnswer = null;
    } else if (isJsonRecord(frozenUserActionAnswer)) {
      const requestId = own(frozenUserActionAnswer, 'requestId');
      const frozenAnswers = own(frozenUserActionAnswer, 'answers');
      if (typeof requestId !== 'string' || !Array.isArray(frozenAnswers) || frozenAnswers.length === 0) {
        return undefined;
      }
      const answers: Array<Readonly<{ questionIndex: number; values: readonly string[] }>> = [];
      for (const frozenAnswer of frozenAnswers) {
        if (!isJsonRecord(frozenAnswer)) return undefined;
        const questionIndex = own(frozenAnswer, 'questionIndex');
        const frozenValues = own(frozenAnswer, 'values');
        if (
          typeof questionIndex !== 'number'
          || !Number.isSafeInteger(questionIndex)
          || !Array.isArray(frozenValues)
          || frozenValues.length === 0
        ) {
          return undefined;
        }
        const values: string[] = [];
        for (const value of frozenValues) {
          if (typeof value !== 'string') return undefined;
          values.push(value);
        }
        answers.push({ questionIndex, values });
      }
      userActionAnswer = { requestId, answers };
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
      userActionAnswer,
    };
  }
  if (kind === 'event') {
    const candidate = ConversationIngressAutomationEventCandidateV1Schema.safeParse(own(value, 'candidate'));
    const providerPluginId = own(value, 'providerPluginId');
    const selection = own(value, 'providerContributionSelection');
    const executionOrigin = PluginMachineExecutionOriginV1Schema.safeParse(own(value, 'executionOrigin'));
    if (!isJsonRecord(selection)) return undefined;
    const contributionId = own(selection, 'contributionId');
    const immutableGenerationId = own(selection, 'immutableGenerationId');
    if (
      !candidate.success
      || typeof providerPluginId !== 'string'
      || typeof contributionId !== 'string'
      || typeof immutableGenerationId !== 'string'
      || !executionOrigin.success
    ) return undefined;
    return {
      kind,
      candidate: candidate.data,
      providerPluginId,
      providerContributionSelection: { contributionId, immutableGenerationId },
      executionOrigin: executionOrigin.data,
    };
  }
  if (kind !== 'automation') return undefined;
  const automationId = own(value, 'automationId');
  const occurrenceKey = own(value, 'occurrenceKey');
  const resultDelivery = AutomationConversationResultDeliveryV1Schema.safeParse(own(value, 'resultDelivery'));
  if (
    typeof automationId !== 'string'
    || typeof occurrenceKey !== 'string'
    || !resultDelivery.success
  ) return undefined;
  return {
    kind,
    automationId,
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
  'userActionConsumed',
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
    || (bindingId !== undefined && typeof bindingId !== 'string')
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
  const approvalTurnIdValue = own(payload, 'approvalTurnId');
  const approvalTurnId = approvalTurnIdValue === undefined || approvalTurnIdValue === null
    ? null
    : approvalTurnIdValue;
  const userActionAnswerTurnIdValue = own(payload, 'userActionAnswerTurnId');
  const userActionAnswerTurnId = userActionAnswerTurnIdValue === undefined || userActionAnswerTurnIdValue === null
    ? null
    : userActionAnswerTurnIdValue;
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
    || (approvalTurnId !== null && typeof approvalTurnId !== 'string')
    || (userActionAnswerTurnId !== null && typeof userActionAnswerTurnId !== 'string')
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
  // A terminal stale Event has no live target, but remains connection-owned
  // (no invented binding id) so baseline/recovery can still retain its fact.
  const isConnectionOwned = target?.kind === 'event' || (target === null && bindingId === undefined);
  if (!isPositiveSafeInteger(connectionAuthorityEpoch)) return undefined;
  let parsedSourceAuthority: IngressObligationPayload['sourceAuthority'];
  if (isConnectionOwned) {
    if (bindingId !== undefined || bindingRevision !== null || bindingAuthorityEpoch !== null) return undefined;
    parsedSourceAuthority = { connectionAuthorityEpoch, bindingRevision: null, bindingAuthorityEpoch: null };
  } else if (
    typeof bindingId !== 'string'
    || !isPositiveSafeInteger(bindingRevision)
    || !isPositiveSafeInteger(bindingAuthorityEpoch)
  ) return undefined;
  else {
    parsedSourceAuthority = { connectionAuthorityEpoch, bindingRevision, bindingAuthorityEpoch };
  }
  return {
    row,
    value: {
      id,
      'record-kind': CHANNEL_STATE_RECORD_KIND.ingressObligation,
      v: 1,
      'connection-id': connectionId,
      ...(bindingId === undefined ? {} : { 'binding-id': bindingId }),
      terminal,
      attention,
      'due-at': dueAtProjection,
      'created-at': createdAt,
      'updated-at': updatedAt,
      payload: {
        occurrenceIds,
        censusId,
        target,
        sourceAuthority: parsedSourceAuthority,
        lifecycle: { phase, attemptCount, dueAt },
        approvalTurnId,
        userActionAnswerTurnId,
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
  const normalizedIngressValue = own(payload, 'normalizedIngress');
  const normalizedIngress = normalizedIngressValue === null
    ? null
    : ConversationNormalizedIngressV1Schema.safeParse(normalizedIngressValue);
  const compacted = readIngressCensusCompacted(own(payload, 'compacted'));
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
  // Censuses written before provider Event ingress deliberately have no field;
  // their only compatible meaning is no frozen Event candidate.
  const eventCandidateValue = own(payload, 'eventCandidate');
  const eventCandidate = eventCandidateValue === undefined || eventCandidateValue === null
    ? null
    : ConversationIngressAutomationEventCandidateV1Schema.safeParse(eventCandidateValue);
  const matchedBindings = own(payload, 'matchedBindings');
  if (
    (normalizedIngress !== null && !normalizedIngress.success)
    // Exactly one of the two carries the occurrence: a census with neither has
    // no replay identity at all, and one with both has two.
    || compacted === undefined
    || (normalizedIngress === null) !== (compacted !== null)
    || (normalizedIngress === null && eventCandidate !== null)
    || phase === undefined
    || !isPositiveSafeInteger(connectionAuthorityEpoch)
    || !isValidMaximumObservationAge(maximumObservationAgeMs)
    || (checkpointCoveredAt !== null && !isNonNegativeSafeInteger(checkpointCoveredAt))
    || typeof attention !== 'boolean'
    || conflict === undefined
    || (eventCandidate !== null && !eventCandidate.success)
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
        ...(normalizedIngress === null
          ? { normalizedIngress: null, compacted: compacted as IngressCensusCompacted }
          : { normalizedIngress: normalizedIngress.data, compacted: null }),
        phase,
        connectionAuthorityEpoch,
        maximumObservationAgeMs,
        checkpointCoveredAt,
        conflict,
        eventCandidate: eventCandidate === null ? null : eventCandidate.data,
        matchedBindings: normalizedBindings,
      },
    },
  };
}

/**
 * `undefined` is the parse rejection; `null` is the ordinary uncompacted
 * census. The digest is the full base64url HMAC-SHA256 every private Channels
 * identity already uses.
 */
function readIngressCensusCompacted(value: JsonValue | undefined): IngressCensusCompacted | null | undefined {
  if (value === null) return null;
  if (!isJsonRecord(value)) return undefined;
  const textDigest = own(value, 'textDigest');
  const shell = ConversationAuthenticatedObservationShellV1Schema.safeParse(own(value, 'shell'));
  const retainedAttentionObligationRowIds = own(value, 'retainedAttentionObligationRowIds');
  if (
    Object.keys(value).length !== 3
    || typeof textDigest !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/u.test(textDigest)
    || !shell.success
    || !Array.isArray(retainedAttentionObligationRowIds)
    || retainedAttentionObligationRowIds.some((rowId) => (
      typeof rowId !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(rowId)
    ))
    || new Set(retainedAttentionObligationRowIds).size !== retainedAttentionObligationRowIds.length
  ) return undefined;
  return {
    shell: shell.data,
    textDigest,
    retainedAttentionObligationRowIds: retainedAttentionObligationRowIds as readonly string[],
  };
}

async function readPreparedIngressCensusForObligation(input: Readonly<{
  context: PluginInvocationContext;
  obligation: IngressObligationRecord;
}>): Promise<IngressCensusPayload> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const census = asIngressCensus(readStateRow(await collection.get(
    input.obligation.payload.censusId,
    { signal: input.context.signal },
  )) ?? null);
  const target = input.obligation.payload.target;
  const matchingPreparedMember = target?.kind === 'event'
    ? census?.value.payload.eventCandidate !== null
      && census?.value.payload.eventCandidate !== undefined
      && pluginJsonValuesEqual(census.value.payload.eventCandidate, target.candidate)
    : input.obligation['binding-id'] !== undefined
      && input.obligation.payload.sourceAuthority.bindingRevision !== null
      && input.obligation.payload.sourceAuthority.bindingAuthorityEpoch !== null
      && census?.value.payload.matchedBindings.some((member) => (
        member.bindingId === input.obligation['binding-id']
        && member.bindingRevision === input.obligation.payload.sourceAuthority.bindingRevision
        && member.bindingAuthorityEpoch === input.obligation.payload.sourceAuthority.bindingAuthorityEpoch
      ));
  if (
    census === undefined
    || census.value.payload.phase !== 'prepared'
    || census.value['connection-id'] !== input.obligation['connection-id']
    || !matchingPreparedMember
  ) {
    throw pluginError(
      'channels_ingress_census_unprepared',
      'The ingress obligation does not reference its exact prepared census.',
      true,
    );
  }
  return census.value.payload;
}

/**
 * Dispatch needs the admitted body, so it may only read a census that still
 * carries one. Compaction requires every member to have settled terminally
 * and terminal is monotonic, so a non-terminal obligation over a compacted
 * census is corrupt state rather than an ordinary retention outcome.
 */
async function readPreparedIngressForObligation(input: Readonly<{
  context: PluginInvocationContext;
  obligation: IngressObligationRecord;
}>): Promise<ConversationNormalizedIngressV1> {
  const payload = await readPreparedIngressCensusForObligation(input);
  if (payload.normalizedIngress === null) {
    throw pluginError(
      'channels_ingress_census_compacted',
      'The ingress obligation references a settled census that no longer retains its input.',
    );
  }
  return payload.normalizedIngress;
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

/**
 * The one census reader for occurrence identity, endpoint, and the frozen
 * retention anchor. A compacted census keeps exactly this envelope, so every
 * consumer of those facts survives the loss of the message body.
 */
function censusIngressShell(
  payload: IngressCensusPayload,
): ConversationAuthenticatedObservationShellV1 {
  return payload.normalizedIngress === null
    ? payload.compacted.shell
    : ingressShell(payload.normalizedIngress);
}

function normalizedIngressDiscriminant(
  input: ConversationNormalizedIngressV1,
): ConversationNormalizedIngressV1 {
  return ConversationNormalizedIngressV1Schema.parse(input);
}

/**
 * A compacted census answers both arms from the retained envelope: exact
 * re-delivery adds the keyed text digest to the structural shell comparison,
 * and a later unsupported edit never depended on the body at all.
 */
async function immutableIngressMatches(
  census: IngressCensusPayload,
  routingIdentityKey: string,
  input: ConversationIngressObservedEntryV1,
): Promise<boolean> {
  const normalized = normalizedIngressDiscriminant(input.observation);
  const compacted = census.compacted;
  if (compacted === null) {
    if (
      pluginJsonValuesEqual(census.normalizedIngress, normalized)
      && pluginJsonValuesEqual(census.eventCandidate, input.eventCandidate)
    ) return true;
  } else if (
    normalized.kind === 'fullText'
    && pluginJsonValuesEqual(compacted.shell, ingressShell(normalized))
    && await deriveIngressCensusTextDigest({
      routingIdentityKey,
      text: normalized.observation.message.text,
    }) === compacted.textDigest
  ) return true;
  // Only a full-text admission can be superseded by an unsupported edit, and
  // only a full-text admission is ever compacted.
  if (
    (compacted === null && census.normalizedIngress.kind !== 'fullText')
    || normalized.kind !== 'routableNonAdmission'
    || normalized.reason !== 'unsupportedEdit'
  ) return false;
  const admittedShell = censusIngressShell(census);
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
  userActionAnswer: FrozenSessionTarget['userActionAnswer'];
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
      userActionAnswer: null,
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
      userActionAnswer: null,
    };
  }
  if (policy.kind === 'userActionAnswer') {
    return {
      terminalOutcome: undefined,
      newSession: null,
      approval: null,
      userActionAnswer: {
        requestId: policy.requestId,
        answers: policy.answers,
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
      userActionAnswer: null,
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
      userActionAnswer: null,
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
      userActionAnswer: null,
    };
  }
  return { terminalOutcome: undefined, newSession: null, approval: null, userActionAnswer: null };
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
  domain:
    | 'ingress-obligation'
    | 'ingress-event-obligation'
    | 'ingress-census'
    | 'checkpoint'
    | 'session-rotation';
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

/**
 * The one keyed digest that survives census compaction. It stays in the same
 * connection-keyed private namespace as the row identities, so a retained
 * digest is neither correlatable across Accounts nor reversible to the text.
 */
async function deriveIngressCensusTextDigest(input: Readonly<{
  routingIdentityKey: string;
  text: string;
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
    parts: ['channels:ingress:v1', 'ingress-census-text', input.text],
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

/**
 * A normalized ingress has at most one provider Event candidate. Its durable
 * obligation consequently belongs to the connection/occurrence pair, rather
 * than inventing a binding or a second provider-local cursor.
 */
async function deriveIngressEventObligationRowId(input: Readonly<{
  routingIdentityKey: string;
  connectionId: string;
  occurrenceId: string;
}>): Promise<string> {
  return await opaqueHmacRowId({
    routingIdentityKey: input.routingIdentityKey,
    domain: 'ingress-event-obligation',
    parts: [input.connectionId, input.occurrenceId],
  });
}

async function deriveIngressObligationRowIdForCensusMember(input: Readonly<{
  routingIdentityKey: string;
  connectionId: string;
  occurrenceId: string;
  member: IngressCensusObligationMember;
}>): Promise<string> {
  if (input.member.kind === 'event') {
    return await deriveIngressEventObligationRowId({
      routingIdentityKey: input.routingIdentityKey,
      connectionId: input.connectionId,
      occurrenceId: input.occurrenceId,
    });
  }
  return await opaqueHmacRowId({
    routingIdentityKey: input.routingIdentityKey,
    domain: 'ingress-obligation',
    parts: [input.connectionId, input.member.binding.bindingId, input.occurrenceId],
  });
}

/**
 * The census is the one writer of the frozen member set. Every lifecycle
 * reader reuses this correspondence check instead of independently deciding
 * whether a binding or connection-owned Event row belongs to that census.
 */
function ingressObligationMatchesCensusMember(input: Readonly<{
  censusId: string;
  member: IngressCensusObligationMember;
  obligation: IngressObligationRecord;
}>): boolean {
  const { obligation, member } = input;
  if (obligation.payload.censusId !== input.censusId) return false;
  if (member.kind === 'event') {
    return obligation['binding-id'] === undefined
      && obligation.payload.sourceAuthority.bindingRevision === null
      && obligation.payload.sourceAuthority.bindingAuthorityEpoch === null
      && (
        (obligation.payload.target?.kind === 'event'
          && pluginJsonValuesEqual(obligation.payload.target.candidate, member.candidate))
        // A stale connection can terminalize the Event before a current
        // provider Action exists. Its empty target is the incumbent terminal
        // Event shape, not an unowned binding row.
        || (obligation.payload.target === null && obligation.terminal)
      );
  }
  return obligation['binding-id'] === member.binding.bindingId
    && obligation.payload.sourceAuthority.bindingRevision === member.binding.bindingRevision
    && obligation.payload.sourceAuthority.bindingAuthorityEpoch === member.binding.bindingAuthorityEpoch;
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
  eventCandidate?: ConversationIngressAutomationEventCandidateV1 | null;
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
      compacted: null,
      phase: 'preparing',
      connectionAuthorityEpoch: input.connectionAuthorityEpoch,
      maximumObservationAgeMs: input.maximumObservationAgeMs,
      checkpointCoveredAt: null,
      conflict: null,
      eventCandidate: input.eventCandidate ?? null,
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
      limit: Math.min(remaining, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1),
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
  userActionAnswer: FrozenSessionTarget['userActionAnswer'];
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
      userActionAnswer: input.userActionAnswer,
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

function frozenTargetForEvent(input: Readonly<{
  obligationId: string;
  connection: ChannelConnectionRecord;
  candidate: ConversationIngressAutomationEventCandidateV1;
}>): FrozenEventTarget {
  if (input.candidate.eventRef.pluginId !== input.connection.payload.providerPluginId) {
    throw pluginError(
      'channels_ingress_event_provider_mismatch',
      'The provider Event candidate does not belong to the selected connection provider.',
    );
  }
  const target: FrozenEventTarget = {
    kind: 'event',
    candidate: input.candidate,
    providerPluginId: input.connection.payload.providerPluginId,
    providerContributionSelection: input.connection.payload.providerContributionSelection,
    executionOrigin: input.connection.payload.transportOrigin,
  };
  if (!isCanonicalChannelStateRecordIdentity({
    rowId: input.obligationId,
    recordKind: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    ingressTargetKind: target.kind,
  })) {
    throw pluginError(
      'channels_ingress_identity_invalid',
      'The derived provider Event ingress obligation identity is not canonical.',
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
      approvalTurnId: null,
      userActionAnswerTurnId: null,
      disposition: input.terminalOutcome?.disposition ?? null,
      nonAdmission: input.terminalOutcome?.nonAdmission ?? null,
    },
  };
}

function createEventIngressObligationValue(input: Readonly<{
  censusId: string;
  obligationId: string;
  connection: ChannelConnectionRecord;
  ingress: ConversationNormalizedIngressV1;
  candidate: ConversationIngressAutomationEventCandidateV1;
  now: number;
}>): JsonRecord {
  const shell = ingressShell(input.ingress);
  return {
    id: input.obligationId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connection.id,
    [CHANNEL_STATE_FIELD.terminal]: false,
    [CHANNEL_STATE_FIELD.attention]: false,
    [CHANNEL_STATE_FIELD.dueAt]: input.now,
    [CHANNEL_STATE_FIELD.createdAt]: input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      occurrenceIds: [shell.occurrenceId],
      censusId: input.censusId,
      target: frozenTargetForEvent({
        obligationId: input.obligationId,
        connection: input.connection,
        candidate: input.candidate,
      }),
      sourceAuthority: {
        connectionAuthorityEpoch: input.connection.payload.authorityEpoch,
        bindingRevision: null,
        bindingAuthorityEpoch: null,
      },
      lifecycle: { phase: 'ready', attemptCount: 0, dueAt: input.now },
      approvalTurnId: null,
      userActionAnswerTurnId: null,
      disposition: null,
      nonAdmission: null,
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
      approvalTurnId: null,
      userActionAnswerTurnId: null,
      disposition: 'staleAuthority',
      nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
    },
  };
}

function createStaleEventIngressObligationValue(input: Readonly<{
  obligationId: string;
  censusId: string;
  connectionId: string;
  connectionAuthorityEpoch: number;
  occurrenceId: string;
  now: number;
}>): JsonRecord {
  return {
    id: input.obligationId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.ingressObligation,
    v: 1,
    [CHANNEL_STATE_FIELD.connectionId]: input.connectionId,
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
        bindingRevision: null,
        bindingAuthorityEpoch: null,
      },
      lifecycle: { phase: 'terminal', attemptCount: 0, dueAt: null },
      approvalTurnId: null,
      userActionAnswerTurnId: null,
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
  prepare?: boolean;
}>): JsonRecord {
  if (input.census.attention || input.census.payload.conflict !== null) {
    throw pluginError(
      'channels_ingress_occurrence_conflict',
      'A conflicting ingress census can never receive checkpoint coverage.',
    );
  }
  if (
    (input.prepare === true && input.census.payload.phase !== 'preparing')
    || (input.prepare !== true && input.census.payload.phase !== 'prepared')
  ) {
    throw pluginError(
      'channels_checkpointed_poll_coverage_invalid',
      'Checkpoint coverage requires a prepared ingress census or its one baseline preparation transition.',
      true,
    );
  }
  return {
    ...input.census,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.census.payload,
      ...(input.prepare === true ? { phase: 'prepared' as const } : {}),
      checkpointCoveredAt: input.now,
    },
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
  entry: ConversationIngressObservedEntryV1;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
}>): Promise<void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const shell = ingressShell(input.entry.observation);
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
    if (await matchesIngressCensus({
      census: rereadCensus.value.payload,
      routingIdentityKey: rereadConnection.value.payload.routingIdentityKey,
      entry: input.entry,
    })) {
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
 * `measurement` must describe `[fences..., ...values as puts]`, in that order.
 */
export function partitionIngressPreparationValues(input: Readonly<{
  values: readonly JsonRecord[];
  limits: PluginCollectionLimits;
  measurement: PluginCollectionBatchMeasurement;
  fenceOperationCount?: number;
}>): readonly (readonly JsonRecord[])[] {
  const { values, limits, measurement } = input;
  if (values.length === 0) return [];
  const fenceOperationCount = input.fenceOperationCount ?? 1;
  const fenceEncodedBytes = measurement.operationEncodedBytes.slice(0, fenceOperationCount)
    .reduce((total, bytes) => total + bytes, 0);
  if (
    !Number.isSafeInteger(fenceOperationCount)
    || fenceOperationCount < 1
    || measurement.operationEncodedBytes.length !== values.length + fenceOperationCount
  ) {
    throw pluginError(
      'channels_ingress_preparation_unmeasured',
      'Ingress preparation batching requires a measurement of its fence and every prepared value.',
    );
  }
  const budgetEncodedBytes = limits.maxBatchBytes
    - measurement.overheadEncodedBytes
    - fenceEncodedBytes;
  const maximumPutsPerBatch = limits.maxBatchRows - fenceOperationCount;
  const batches: JsonRecord[][] = [];
  let current: JsonRecord[] = [];
  let currentEncodedBytes = 0;
  for (const [index, value] of values.entries()) {
    const putEncodedBytes = measurement.operationEncodedBytes[index + fenceOperationCount]!;
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
    bindingId?: string;
    value: JsonRecord;
  }>
  | Readonly<{
    kind: 'terminal';
    connectionId: string;
    bindingId?: string;
  }>
  | Readonly<{
    kind: 'blocked';
    connectionId: string;
    bindingId?: string;
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

/**
 * Freezes the resolved mediation turn onto the incumbent obligation row before
 * the irreversible remote effect. This is the same row and the same CAS the
 * lifecycle already uses; it is not a second custody store, ledger, or
 * approval queue.
 */
function approvalTurnIngressObligationValue(input: Readonly<{
  obligation: IngressObligationRecord;
  turnId: string;
  now: number;
}>): JsonRecord {
  const { [CHANNEL_STATE_FIELD.dueAt]: dueAt, ...obligationWithoutDueAt } = input.obligation;
  return {
    ...obligationWithoutDueAt,
    ...(dueAt === null ? {} : { [CHANNEL_STATE_FIELD.dueAt]: dueAt }),
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.obligation.payload,
      approvalTurnId: input.turnId,
    },
  };
}

/**
 * Persists the host-stamped turn for a frozen `/answer` before the canonical
 * Session Action runs. The incumbent ingress obligation remains the only
 * retry/currentness owner; this stores no answer result.
 */
function userActionAnswerTurnIngressObligationValue(input: Readonly<{
  obligation: IngressObligationRecord;
  turnId: string;
  now: number;
}>): JsonRecord {
  const { [CHANNEL_STATE_FIELD.dueAt]: dueAt, ...obligationWithoutDueAt } = input.obligation;
  return {
    ...obligationWithoutDueAt,
    ...(dueAt === null ? {} : { [CHANNEL_STATE_FIELD.dueAt]: dueAt }),
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      ...input.obligation.payload,
      userActionAnswerTurnId: input.turnId,
    },
  };
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

function arePersistedProviderContributionSelectionsEqual(
  left: PersistedConversationProviderContributionSelection,
  right: PersistedConversationProviderContributionSelection,
): boolean {
  return left.contributionId === right.contributionId
    && left.immutableGenerationId === right.immutableGenerationId;
}

async function revalidateFirstDispatchAuthority(input: Readonly<{
  context: PluginInvocationContext;
  source: IngressExecutionSource;
  connectionId: string;
  bindingId: string | undefined;
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
  const target = input.obligation.payload.target;
  if (target?.kind === 'event') {
    if (
      input.bindingId !== undefined
      || input.obligation.payload.sourceAuthority.bindingRevision !== null
      || input.obligation.payload.sourceAuthority.bindingAuthorityEpoch !== null
      || connection.value.payload.providerPluginId !== target.providerPluginId
      || !arePersistedProviderContributionSelectionsEqual(
        connection.value.payload.providerContributionSelection,
        target.providerContributionSelection,
      )
      || !arePluginMachineExecutionOriginsEqual(
        connection.value.payload.transportOrigin,
        target.executionOrigin,
      )
    ) return undefined;
    return { connection, bindings: [] };
  }
  if (
    input.bindingId === undefined
    || input.obligation.payload.sourceAuthority.bindingRevision === null
    || input.obligation.payload.sourceAuthority.bindingAuthorityEpoch === null
  ) return undefined;
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
  const outward: ConversationOutwardDeliveryObligation = {
    connectionId: input.obligation.value['connection-id'],
    bindingId: binding.value.id,
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
  outward: ConversationOutwardDeliveryObligation;
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
 * The one durable answer a successful `/pair` gives the external person.
 *
 * It says only that the request arrived and where the rest of it happens: the
 * paused binding does not exist until its owner finalizes the proposal, and an
 * unmatched, expired, or consumed token stays silent so a stranger learns
 * nothing about this Account's pairing state.
 */
const PAIRING_CONTROL_RESPONSE_TEXT =
  'Pairing request received. Finish it in Happier to connect this conversation.';

/**
 * Enqueues that answer through the one outward custody owner.
 *
 * The route is connection-owned because a pairing proposal has no binding yet,
 * and the immutable census row ID is this occurrence's identity — so an equal
 * replay, a lost response, or a restarted daemon rejoins exactly one custody
 * row rather than sending a second message.
 */
async function writePairingControlResponseCustody(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
  connectionAuthorityEpoch: number;
  censusId: string;
  shell: ConversationAuthenticatedObservationShellV1;
}>): Promise<IngressCheckpointOutcome> {
  const outward: ConversationOutwardDeliveryObligation = {
    connectionId: input.connectionId,
    routeAuthority: { connectionAuthorityEpoch: input.connectionAuthorityEpoch },
    source: {
      kind: 'controlResponse',
      controlId: input.censusId,
      controlKind: 'pairing',
    },
    endpoint: input.shell.endpoint,
    content: PAIRING_CONTROL_RESPONSE_TEXT,
    deliveryKey: `ingress-pairing:${input.censusId}`,
    replyContext: { replyToMessageId: input.shell.message.id },
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
  return await acceptIngressControlResponseCustody({
    context: input.context,
    outward,
    invalidCode: 'channels_ingress_pairing_custody_invalid',
    invalidMessage: 'The pairing control-response custody obligation is invalid.',
  });
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

const USER_ACTION_CONTROL_RESPONSE_TEXT = {
  settled: 'That question is no longer pending.',
  refused: 'That answer could not be accepted.',
} as const;

type UserActionControlResponseText =
  (typeof USER_ACTION_CONTROL_RESPONSE_TEXT)[keyof typeof USER_ACTION_CONTROL_RESPONSE_TEXT];

type MediatedControlResponseKind = Extract<ConversationControlResponseKind, 'approval' | 'userAction'>;
type MediatedControlResponseText = ApprovalControlResponseText | UserActionControlResponseText;

/**
 * Both mediated command families write their acknowledgement through this one
 * custody owner. Their Session effects remain distinct Actions, but neither
 * receives a local delivery row, retry loop, or result cache.
 */
async function writeMediatedControlResponseCustody(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  controlKind: MediatedControlResponseKind;
  content: MediatedControlResponseText;
}>): Promise<IngressCheckpointOutcome> {
  const bindingId = input.obligation.value['binding-id'];
  const bindingRevision = input.obligation.value.payload.sourceAuthority.bindingRevision;
  const bindingAuthorityEpoch = input.obligation.value.payload.sourceAuthority.bindingAuthorityEpoch;
  if (
    bindingId === undefined
    || bindingRevision === null
    || bindingAuthorityEpoch === null
  ) {
    throw pluginError(
      'channels_ingress_mediation_custody_invalid',
      'A binding-owned mediated-command obligation lost its frozen route authority.',
    );
  }
  const shell = ingressShell(await readPreparedIngressForObligation({
    context: input.context,
    obligation: input.obligation.value,
  }));
  const outward: ConversationOutwardDeliveryObligation = {
    connectionId: input.obligation.value['connection-id'],
    bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: input.obligation.value.payload.sourceAuthority.connectionAuthorityEpoch,
      bindingRevision,
      bindingAuthorityEpoch,
    },
    source: {
      kind: 'controlResponse',
      controlId: input.obligation.value.id,
      controlKind: input.controlKind,
    },
    endpoint: shell.endpoint,
    content: input.content,
    deliveryKey: `ingress-${input.controlKind}:${input.obligation.value.id}`,
    replyContext: { replyToMessageId: shell.message.id },
    mentionPolicy: 'suppress',
    linkPreviewPolicy: 'suppress',
  };
  return await acceptIngressControlResponseCustody({
    context: input.context,
    outward,
    invalidCode: 'channels_ingress_mediation_custody_invalid',
    invalidMessage: 'The mediated-command control-response custody obligation is invalid.',
  });
}

/**
 * A canonical-owner outcome that cannot be settled now. The obligation keeps
 * the incumbent bounded attempt/backoff ladder instead of a mediation-local
 * timer, queue, or retry ledger.
 */
async function retryMediatedIngressControl(input: Readonly<{
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

async function settleMediatedIngressControlTerminal(input: Readonly<{
  context: PluginInvocationContext;
  authority: IngressAuthorityFence | undefined;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  disposition: Extract<IngressDisposition, 'approvalConsumed' | 'userActionConsumed' | 'rejected'>;
  controlKind: MediatedControlResponseKind;
  content: MediatedControlResponseText;
}>): Promise<IngressCheckpointOutcome> {
  const custody = await writeMediatedControlResponseCustody({
    context: input.context,
    obligation: input.obligation,
    controlKind: input.controlKind,
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
    return await retryMediatedIngressControl({ context: input.context, obligation: input.obligation });
  }
  let obligation = input.obligation;
  const sourceAuthority = obligation.value.payload.sourceAuthority;
  const source = {
    sessionId: target.sessionId,
    sourceRef: `channels:binding:${input.bindingId}`,
    sourceRevisionOrEpoch: `${sourceAuthority.connectionAuthorityEpoch}:${sourceAuthority.bindingAuthorityEpoch}`,
  } as const;

  // A resolved turn is durable evidence that this obligation already reached
  // the canonical owner. The projection is a discovery step, not the custody
  // record: once the tuple is frozen, replay must re-ask the idempotent owner,
  // which answers `alreadyApplied` for a committed effect whose response was
  // lost. Re-listing instead would report an applied decision as no longer
  // pending.
  let turnId = obligation.value.payload.approvalTurnId;
  if (turnId === null) {
    let pending: ConversationPendingPermissionProjection;
    try {
      pending = await readConversationPendingPermissions({
        actions: input.context.services.actions,
        source,
        signal: input.context.signal,
      });
    } catch (error) {
      assertNotAborted(input.context.signal);
      // A definite refusal from the canonical owner cannot become a permanent
      // ingest throw: that would re-observe the same message forever and hold
      // the connection checkpoint. Settle it truthfully instead.
      if (isPluginError(error) && error.retryable === false) {
        return await settleMediatedIngressControlTerminal({
          context: input.context,
          authority: input.authority,
          obligation,
          disposition: 'rejected',
          controlKind: 'approval',
          content: APPROVAL_CONTROL_RESPONSE_TEXT.refused,
        });
      }
      return await retryMediatedIngressControl({ context: input.context, obligation });
    }
    const match = pending.requests.find(
      (request) => request.kind !== 'user_action' && request.requestId === approval.requestId,
    );
    if (match === undefined) {
      // A truncated projection cannot prove absence, so the obligation stays on
      // its bounded retry ladder rather than settling a request the owner is
      // still withholding from its projection.
      if (pending.truncated) {
        return await retryMediatedIngressControl({ context: input.context, obligation });
      }
      return await settleMediatedIngressControlTerminal({
        context: input.context,
        authority: input.authority,
        obligation,
        disposition: 'rejected',
        controlKind: 'approval',
        content: APPROVAL_CONTROL_RESPONSE_TEXT.notPending,
      });
    }
    // Persisted before the effect: a conflict here is a lifecycle race that has
    // performed no mediation, and the incumbent recovery owner reclaims it.
    obligation = await putIngressObligationLifecycle({
      context: input.context,
      obligation,
      value: approvalTurnIngressObligationValue({
        obligation: obligation.value,
        turnId: match.turnId,
        now: Date.now(),
      }),
    });
    turnId = match.turnId;
  }

  let responded: PluginActionResultById['session.permission.remote.respond'];
  try {
    responded = await input.context.services.actions.execute(
      'session.permission.remote.respond',
      {
        ...source,
        turnId,
        requestId: approval.requestId,
        idempotencyKey: `channels:approval:v1:${obligation.value.id}`,
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
      return await settleMediatedIngressControlTerminal({
        context: input.context,
        authority: input.authority,
        obligation,
        disposition: 'rejected',
        controlKind: 'approval',
        content: APPROVAL_CONTROL_RESPONSE_TEXT.refused,
      });
    }
    return await retryMediatedIngressControl({ context: input.context, obligation });
  }

  if (responded.status === 'rejected') {
    if (
      responded.code === 'mediationStateUnavailable'
      || responded.code === 'sessionUnavailable'
      || responded.code === 'ownerMachineUnavailable'
      || responded.code === 'canceled'
    ) {
      return await retryMediatedIngressControl({ context: input.context, obligation });
    }
    return await settleMediatedIngressControlTerminal({
      context: input.context,
      authority: input.authority,
      obligation,
      disposition: 'rejected',
      controlKind: 'approval',
      content: responded.code === 'requestNotFound' || responded.code === 'requestNotPending'
        ? APPROVAL_CONTROL_RESPONSE_TEXT.notPending
        : APPROVAL_CONTROL_RESPONSE_TEXT.refused,
    });
  }
  return await settleMediatedIngressControlTerminal({
    context: input.context,
    authority: input.authority,
    obligation,
    disposition: 'approvalConsumed',
    controlKind: 'approval',
    content: responded.decision === 'allow'
      ? APPROVAL_CONTROL_RESPONSE_TEXT.allowed
      : APPROVAL_CONTROL_RESPONSE_TEXT.denied,
  });
}

/**
 * Settles one frozen `/answer` through the canonical AskUserQuestion owner.
 *
 * The pending projection supplies the host-stamped turn only once. After that
 * the incumbent ingress row retries the same Action tuple; this owner has no
 * answer-result lookup, so a post-effect retry that finds the request no
 * longer pending receives the deliberately neutral acknowledgement below.
 */
async function dispatchUserActionAnswerMediation(input: Readonly<{
  context: PluginInvocationContext;
  bindingId: string;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  authority: IngressAuthorityFence | undefined;
  target: FrozenSessionTarget;
  userActionAnswer: NonNullable<FrozenSessionTarget['userActionAnswer']>;
}>): Promise<IngressCheckpointOutcome> {
  const { target, userActionAnswer } = input;
  let obligation = input.obligation;
  const sourceAuthority = obligation.value.payload.sourceAuthority;
  const source = {
    sessionId: target.sessionId,
    sourceRef: `channels:binding:${input.bindingId}`,
    sourceRevisionOrEpoch: `${sourceAuthority.connectionAuthorityEpoch}:${sourceAuthority.bindingAuthorityEpoch}`,
  } as const;

  let turnId = obligation.value.payload.userActionAnswerTurnId;
  if (turnId === null) {
    let pending: ConversationPendingPermissionProjection;
    try {
      pending = await readConversationPendingPermissions({
        actions: input.context.services.actions,
        source,
        signal: input.context.signal,
      });
    } catch (error) {
      assertNotAborted(input.context.signal);
      if (isPluginError(error) && error.retryable === false) {
        return await settleMediatedIngressControlTerminal({
          context: input.context,
          authority: input.authority,
          obligation,
          disposition: 'rejected',
          controlKind: 'userAction',
          content: USER_ACTION_CONTROL_RESPONSE_TEXT.refused,
        });
      }
      return await retryMediatedIngressControl({ context: input.context, obligation });
    }
    const match = pending.requests.find(
      (request) => request.kind === 'user_action' && request.requestId === userActionAnswer.requestId,
    );
    if (match === undefined) {
      // A truncated owner projection cannot prove that this question is gone.
      if (pending.truncated) {
        return await retryMediatedIngressControl({ context: input.context, obligation });
      }
      return await settleMediatedIngressControlTerminal({
        context: input.context,
        authority: input.authority,
        obligation,
        disposition: 'rejected',
        controlKind: 'userAction',
        content: USER_ACTION_CONTROL_RESPONSE_TEXT.settled,
      });
    }
    // Persisted before the Session effect. A lifecycle conflict has not sent an
    // answer and remains on the incumbent retry/currentness path.
    obligation = await putIngressObligationLifecycle({
      context: input.context,
      obligation,
      value: userActionAnswerTurnIngressObligationValue({
        obligation: obligation.value,
        turnId: match.turnId,
        now: Date.now(),
      }),
    });
    turnId = match.turnId;
  }

  let responded: PluginActionResultById['session.user_action.remote.answer'];
  try {
    responded = await input.context.services.actions.execute(
      'session.user_action.remote.answer',
      {
        ...source,
        turnId,
        requestId: userActionAnswer.requestId,
        answers: userActionAnswer.answers.map((answer) => ({
          questionIndex: answer.questionIndex,
          values: [...answer.values],
        })),
      },
      { signal: input.context.signal },
    );
  } catch (error) {
    assertNotAborted(input.context.signal);
    if (isPluginError(error) && error.retryable === false) {
      return await settleMediatedIngressControlTerminal({
        context: input.context,
        authority: input.authority,
        obligation,
        disposition: 'rejected',
        controlKind: 'userAction',
        content: USER_ACTION_CONTROL_RESPONSE_TEXT.refused,
      });
    }
    return await retryMediatedIngressControl({ context: input.context, obligation });
  }

  if (responded.status === 'rejected') {
    if (
      responded.code === 'mediationStateUnavailable'
      || responded.code === 'sessionUnavailable'
      || responded.code === 'ownerMachineUnavailable'
      || responded.code === 'canceled'
    ) {
      return await retryMediatedIngressControl({ context: input.context, obligation });
    }
    return await settleMediatedIngressControlTerminal({
      context: input.context,
      authority: input.authority,
      obligation,
      disposition: 'rejected',
      controlKind: 'userAction',
      content: responded.code === 'requestNotFound' || responded.code === 'requestNotPending'
        ? USER_ACTION_CONTROL_RESPONSE_TEXT.settled
        : USER_ACTION_CONTROL_RESPONSE_TEXT.refused,
    });
  }
  return await settleMediatedIngressControlTerminal({
    context: input.context,
    authority: input.authority,
    obligation,
    disposition: 'userActionConsumed',
    controlKind: 'userAction',
    content: USER_ACTION_CONTROL_RESPONSE_TEXT.settled,
  });
}

async function settleTerminalRefusalCustody(input: Readonly<{
  context: PluginInvocationContext;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
}>): Promise<IngressCheckpointOutcome> {
  const { obligation } = input;
  const nonAdmission = obligation.value.payload.nonAdmission;
  if (nonAdmission === null || !nonAdmission.senderFeedbackEligible) return 'checkpointSafe';
  const bindingId = obligation.value['binding-id'];
  const bindingRevision = obligation.value.payload.sourceAuthority.bindingRevision;
  const bindingAuthorityEpoch = obligation.value.payload.sourceAuthority.bindingAuthorityEpoch;
  if (
    bindingId === undefined
    || bindingRevision === null
    || bindingAuthorityEpoch === null
  ) {
    throw pluginError(
      'channels_ingress_refusal_custody_invalid',
      'A sender-refusal obligation lost its frozen binding route authority.',
    );
  }

  // Sender refusal needs the envelope, never the body, so it keeps working
  // across a compacted census.
  const shell = censusIngressShell(await readPreparedIngressCensusForObligation({
    context: input.context,
    obligation: obligation.value,
  }));
  const outward: ConversationOutwardDeliveryObligation = {
    connectionId: obligation.value['connection-id'],
    bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: obligation.value.payload.sourceAuthority.connectionAuthorityEpoch,
      bindingRevision,
      bindingAuthorityEpoch,
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
  bindingId: string | undefined;
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  /** `null` once the census settled and dropped its body; see below. */
  ingress: ConversationNormalizedIngressV1 | null;
}>): Promise<IngressCheckpointOutcome> {
  let obligation = input.obligation;
  let authority: IngressAuthorityFence | undefined;
  if (obligation.value.payload.lifecycle.phase === 'terminal') {
    return settleTerminalRefusalCustody({ context: input.context, obligation });
  }
  if (obligation.value.payload.lifecycle.phase === 'blocked') return 'checkpointSafe';
  // Compaction proves every member already settled terminally, and both
  // terminal states returned above. Reaching here means the unit lost its
  // input while work was still outstanding.
  const ingress = input.ingress;
  if (ingress === null) {
    throw pluginError(
      'channels_ingress_census_compacted',
      'A settled ingress census cannot dispatch an obligation that never terminalized.',
    );
  }
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
      ingress,
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
  const fullText = fullTextObservation(ingress);
  if (fullText === undefined) {
    throw pluginError(
      'channels_ingress_input_invalid',
      'A bodyless non-admission cannot enter Session or Automation admission.',
    );
  }
  if (obligation.value.payload.target === null) {
    throw pluginError('channels_ingress_target_missing', 'An active ingress obligation has no frozen target.');
  }
  if (obligation.value.payload.target.kind === 'event') {
    const target = obligation.value.payload.target;
    const provider = await readCurrentProviderContributionForPersistedSelection({
      context: {
        targetedContributions: input.context.services.targetedContributions,
        signal: input.context.signal,
      },
      providerPluginId: target.providerPluginId,
      providerContributionSelection: target.providerContributionSelection,
    });
    const operation = provider.operations.automationEventAdmit;
    if (operation === undefined) {
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
    const execution = await input.context.services.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
      operation,
      {
        connectionId: input.connectionId,
        candidate: target.candidate,
        occurrenceId: ingressShell(ingress).occurrenceId,
        occurredAt: ingressShell(ingress).occurredAt,
        observationReceivedAt: obligation.value['created-at'],
        observedDelta: obligation.value.payload.lifecycle.attemptCount === 1 ? 1 : 0,
      },
      {
        signal: input.context.signal,
        expectedExecutionOrigin: target.executionOrigin,
      },
    );
    if (!arePluginMachineExecutionOriginsEqual(execution.executionOrigin, target.executionOrigin)) {
      throw pluginError(
        'channels_ingress_event_execution_origin_changed',
        'The provider Event action settled from an origin that is no longer frozen for this ingress obligation.',
        true,
      );
    }
    const admission = ConversationProviderAutomationEventAdmitResultV1Schema.parse(execution.result);
    if (admission.kind === 'unsettled') {
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
    await settleIngressEffectTerminal({
      context: input.context,
      authority,
      obligation,
      disposition: 'admitted',
    });
    return 'checkpointSafe';
  }
  if (input.bindingId === undefined) {
    throw pluginError(
      'channels_ingress_binding_missing',
      'A binding-owned ingress obligation has no frozen binding identity.',
    );
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
    if (target.userActionAnswer !== null) {
      return await dispatchUserActionAnswerMediation({
        context: input.context,
        bindingId: input.bindingId,
        obligation,
        authority,
        target,
        userActionAnswer: target.userActionAnswer,
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

async function matchesIngressCensus(input: Readonly<{
  census: IngressCensusPayload;
  routingIdentityKey: string;
  entry: ConversationIngressObservedEntryV1;
}>): Promise<boolean> {
  // The frozen census names the authority that admitted its first effect, but
  // authority epoch is a currentness fence rather than occurrence identity.
  // A compatible E→E+1 transfer must rejoin the same immutable occurrence
  // without allowing an old poller to settle a new effect.
  return await immutableIngressMatches(input.census, input.routingIdentityKey, input.entry);
}

/**
 * The connection-scoped conflict index is the one durable latch for
 * contradictory ingress. Pull eligibility and direct socket/durable-push
 * admission consume this same fact instead of accumulating another conflict
 * census for every later provider occurrence.
 */
async function readConversationIngressConflictCensus(input: Readonly<{
  context: PluginInvocationContext;
  connectionId: string;
}>): Promise<'conflict' | 'invalid' | undefined> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const page = await collection.query({
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
  if (page.rows.length === 0) return undefined;
  const conflict = asIngressCensus(readStateRow(page.rows[0]) ?? null);
  return (
    conflict === undefined
    || conflict.value['connection-id'] !== input.connectionId
    || !conflict.value.attention
    || conflict.value.payload.conflict?.kind !== 'occurrenceEvidenceMismatch'
  )
    ? 'invalid'
    : 'conflict';
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
  const entry = input.entry;
  const ingress = entry.observation;
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const connectionState = asConnection(readStateRow(await collection.get(
    input.connectionId,
    { signal: context.signal },
  )) ?? null);
  if (connectionState === undefined) {
    throw pluginError('channels_ingress_connection_unavailable', 'The requested Channel connection is unavailable.', true);
  }
  const shell = ingressShell(ingress);
  assertCurrentConnection({
    connection: connectionState.value,
    source,
    observation: shell,
  });
  const existingConflict = (
    source.kind === 'providerObservation'
    && connectionState.value.payload.transport.kind !== 'checkpointedPull'
  )
    ? await readConversationIngressConflictCensus({
      context,
      connectionId: connectionState.value.id,
    })
    : undefined;
  if (existingConflict === 'invalid') {
    throw pluginError(
      'channels_ingress_conflict_invalid',
      'The retained Channel conflict index row is not a canonical ingress census conflict.',
    );
  }
  if (existingConflict === 'conflict') {
    throw pluginError(
      'channels_ingress_occurrence_conflict',
      'The Channel connection has unresolved contradictory ingress evidence.',
    );
  }
  if (
    entry.eventCandidate !== null
    && (
      fullTextObservation(ingress) === undefined
      || entry.eventCandidate.eventRef.pluginId !== connectionState.value.payload.providerPluginId
    )
  ) {
    throw pluginError(
      'channels_ingress_event_candidate_invalid',
      'A provider Event candidate must accompany full text from the selected connection provider.',
    );
  }

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

  if (census !== undefined && !await matchesIngressCensus({
    census: census.value.payload,
    routingIdentityKey: connectionState.value.payload.routingIdentityKey,
    entry,
  })) {
    await markIngressCensusOccurrenceConflict({
      context,
      source,
      entry,
      connection: connectionState,
      census,
    });
    throw pluginError(
      'channels_ingress_occurrence_conflict',
      'The provider occurrence conflicts with its first immutable ingress evidence.',
    );
  }

  const fullText = fullTextObservation(ingress);
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
      ingress,
      connectionAuthorityEpoch: connectionState.value.payload.authorityEpoch,
      maximumObservationAgeMs: connectionState.value.payload.maximumObservationAgeMs,
      eventCandidate: entry.eventCandidate,
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
      if (!await matchesIngressCensus({
        census: census.value.payload,
        routingIdentityKey: connectionState.value.payload.routingIdentityKey,
        entry,
      })) {
        await markIngressCensusOccurrenceConflict({
          context,
          source,
          entry,
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

  // A valid reservation is terminal for this occurrence even if a later
  // manager-local race consumes/cancels its challenge. It must never fall
  // through to ordinary binding routing after the census exists.
  const pairingSettlement = pairingReservation === undefined
    ? undefined
    : pairingReservation.pairing.commitPreBindingMessage(pairingReservation.reservation);

  // A `preparing` census is never compacted: compaction requires a prepared
  // unit whose every member settled. A row claiming both falls through to the
  // unprepared refusal below rather than preparing obligations without a body.
  const admittedIngress = census.value.payload.normalizedIngress;
  if (census.value.payload.phase === 'preparing' && admittedIngress !== null) {
    const frozenConnection = frozenConnectionForIngressCensus({
      connection: connectionState.value,
      census: census.value.payload,
    });
    const currentBindings = new Map((await readBindingsForConnection({
      context,
      connectionId: connectionState.value.id,
    })).map((binding) => [binding.value.id, binding]));
    const missingValues: JsonRecord[] = [];
    for (const member of ingressCensusObligationMembers(census.value.payload)) {
      const obligationId = await deriveIngressObligationRowIdForCensusMember({
        routingIdentityKey: connectionState.value.payload.routingIdentityKey,
        connectionId: connectionState.value.id,
        occurrenceId: shell.occurrenceId,
        member,
      });
      const existing = asIngressObligation(readStateRow(await collection.get(
        obligationId,
        { signal: context.signal },
      )) ?? null);
      if (existing !== undefined) {
        if (!ingressObligationMatchesCensusMember({
          censusId: census.value.id,
          member,
          obligation: existing.value,
        })) {
          throw pluginError('channels_ingress_obligation_conflict', 'An ingress census member conflicts with its durable obligation.');
        }
        continue;
      }
      if (member.kind === 'event') {
        if (connectionState.value.payload.authorityEpoch !== census.value.payload.connectionAuthorityEpoch) {
          missingValues.push(createStaleEventIngressObligationValue({
            obligationId,
            censusId: census.value.id,
            connectionId: connectionState.value.id,
            connectionAuthorityEpoch: census.value.payload.connectionAuthorityEpoch,
            occurrenceId: shell.occurrenceId,
            now: Date.now(),
          }));
        } else {
          missingValues.push(createEventIngressObligationValue({
            censusId: census.value.id,
            obligationId,
            connection: frozenConnection,
            ingress: admittedIngress,
            candidate: member.candidate,
            now: Date.now(),
          }));
        }
        continue;
      }
      const bindingMember = member.binding;
      const binding = currentBindings.get(bindingMember.bindingId);
      if (
        binding === undefined
        || binding.row.revision !== bindingMember.bindingRevision
        || binding.value.payload.authorityEpoch !== bindingMember.bindingAuthorityEpoch
      ) {
        missingValues.push(createStaleIngressObligationValue({
          obligationId,
          censusId: census.value.id,
          connectionId: connectionState.value.id,
          connectionAuthorityEpoch: census.value.payload.connectionAuthorityEpoch,
          member: bindingMember,
          occurrenceId: shell.occurrenceId,
          now: Date.now(),
        }));
        continue;
      }
      const decision = ingressAdmissionDecision({
        binding: binding.value,
        bindingRevision: binding.row.revision,
        ingress: admittedIngress,
      });
      missingValues.push(createIngressObligationValue({
        censusId: census.value.id,
        obligationId,
        connection: frozenConnection,
        binding: binding.value,
        bindingRevision: binding.row.revision,
        ingress: admittedIngress,
        target: frozenTargetForBinding({
          obligationId,
          connection: frozenConnection,
          binding: binding.value,
          bindingRevision: binding.row.revision,
          ingress: admittedIngress,
          newSession: decision.newSession,
          approval: decision.approval,
          userActionAnswer: decision.userActionAnswer,
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

  let checkpointOutcome: IngressCheckpointOutcome = 'checkpointSafe';
  if (pairingSettlement !== undefined) {
    // A pairing reservation prevents ordinary binding routing, but it never
    // owns or bypasses the same observation's provider Event obligation.
    const pairingOutcome = pairingSettlement.kind === 'matched'
      ? await writePairingControlResponseCustody({
        context,
        connectionId: connectionState.value.id,
        connectionAuthorityEpoch: connectionState.value.payload.authorityEpoch,
        censusId: census.value.id,
        shell,
      })
      : 'checkpointSafe';
    checkpointOutcome = combineIngressCheckpointOutcomes(checkpointOutcome, pairingOutcome);
  }
  for (const member of ingressCensusObligationMembers(census.value.payload)) {
    assertNotAborted(context.signal);
    const obligationId = await deriveIngressObligationRowIdForCensusMember({
      routingIdentityKey: connectionState.value.payload.routingIdentityKey,
      connectionId: connectionState.value.id,
      occurrenceId: shell.occurrenceId,
      member,
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
    const bindingId = member.kind === 'binding' ? member.binding.bindingId : undefined;
    if (!ingressObligationMatchesCensusMember({
      censusId: census.value.id,
      member,
      obligation: obligation.value,
    })) {
      throw pluginError(
        'channels_ingress_obligation_conflict',
        'The ingress obligation no longer matches its immutable census member.',
      );
    }
    let outcome: IngressCheckpointOutcome;
    try {
      outcome = await dispatchIngressObligation({
        context,
        source,
        connectionId: connectionState.value.id,
        bindingId,
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
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
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
  return censusIngressShell(census.payload).transport.kind === 'poll';
}

function isIngressCensusPastFrozenRetentionHorizon(input: Readonly<{
  census: IngressCensusRecord;
  now: number;
}>): boolean {
  const occurredAt = censusIngressShell(input.census.payload).occurredAt;
  return input.now > occurredAt
    && input.now - occurredAt > input.census.payload.maximumObservationAgeMs;
}

/**
 * A census unit is settled when replay is impossible and every member has
 * settled terminally. A checkpointed pull proves the replay half with its
 * coverage fact; direct ingress has no replay source to prove. A contradictory
 * immutable-evidence fact also closes replay: it is retained as attention
 * evidence, but must not keep duplicating a body after its members settle. A
 * member row that disappears afterward is a completed deletion, not a retry
 * obligation.
 *
 * A terminal member's `attention` is an owner-visible diagnostic with no
 * recovery action attached, so it expires with the row exactly as c0.56's
 * outward `notDelivered` does. What still pins a census is unfinished work an
 * owner can act on: a non-terminal `blocked` member awaiting its retry.
 * Contradictory occurrence evidence remains indefinitely, but its terminal
 * shape is the compact census itself rather than every historical fanout row.
 *
 * Settlement is what makes the retained body redundant, and the horizon is
 * what makes the whole unit expendable, so this one predicate serves both the
 * in-place compaction and the delete.
 */
async function readSettledIngressUnit(input: Readonly<{
  context: PluginInvocationContext;
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
}>): Promise<IngressRetentionCandidate | undefined> {
  const { census } = input;
  const hasConflict = census.value.payload.conflict !== null;
  if (
    // A `preparing` census is unfinished admitted work, not expired evidence.
    // Its members may not all exist yet and it still holds the only copy of the
    // captured inbound message, so the horizon may never reclaim it: a replay
    // rejoins the census and finishes preparation instead.
    census.value.payload.phase !== 'prepared'
    || (!hasConflict
      && requiresIngressCensusCheckpointCoverage(census.value)
      && census.value.payload.checkpointCoveredAt === null)
  ) return undefined;

  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const connection = asConnection(readStateRow(await collection.get(
    census.value['connection-id'],
    { signal: input.context.signal },
  )) ?? null);
  if (connection === undefined) return undefined;
  const shell = censusIngressShell(census.value.payload);
  const obligations: Array<Readonly<{ row: StateRow; value: IngressObligationRecord }>> = [];
  const compactedAttentionIds = census.value.payload.compacted?.retainedAttentionObligationRowIds;
  const obligationIdentities = compactedAttentionIds === undefined
    ? await Promise.all(ingressCensusObligationMembers(census.value.payload).map(async (member) => ({
      obligationId: await deriveIngressObligationRowIdForCensusMember({
        routingIdentityKey: connection.value.payload.routingIdentityKey,
        connectionId: census.value['connection-id'],
        occurrenceId: shell.occurrenceId,
        member,
      }),
      member,
    })))
    : compactedAttentionIds.map((obligationId) => ({ obligationId, member: undefined }));
  for (const { obligationId, member } of obligationIdentities) {
    const obligation = asIngressObligation(readStateRow(await collection.get(
      obligationId,
      { signal: input.context.signal },
    )) ?? null);
    // Members are only ever deleted by this same unit-wide sweep, so an absent
    // row is a completed prior deletion of an already-eligible unit. A retained
    // row must still satisfy the monotonic terminal invariant itself: a member
    // that has not settled is unfinished work, never expired evidence.
    if (obligation === undefined) continue;
    if (member === undefined) {
      if (
        obligation.value.payload.censusId !== census.value.id
        || !obligation.value.attention
      ) return undefined;
    } else if (!ingressObligationMatchesCensusMember({
      censusId: census.value.id,
      member,
      obligation: obligation.value,
    })) return undefined;
    if (!obligation.value.terminal || obligation.value.payload.lifecycle.phase !== 'terminal') {
      return undefined;
    }
    obligations.push(obligation);
  }
  return { census, connection, obligations };
}

async function deleteIngressRetentionCandidate(input: Readonly<{
  context: PluginInvocationContext;
  candidate: IngressRetentionCandidate;
}>): Promise<boolean> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  // This caller has already proved the replay/checkpoint horizon in
  // readSettledIngressUnit before deleting any retained identity.
  // The in-force batch-row limit, not the protocol ceiling: an operator can
  // lower it, and the ingress preparation packer already plans against the
  // published value. A retention delete sized to the ceiling would be rejected
  // outright on such a deployment and retention would silently stop.
  const { maxBatchRows } = await collection.limits({ signal: input.context.signal });
  const obligations = input.candidate.obligations;
  assertNotAborted(input.context.signal);
  for (let offset = 0; offset < obligations.length; offset += maxBatchRows) {
    assertNotAborted(input.context.signal);
    const result = await collection.batch(obligations.slice(
      offset,
      offset + maxBatchRows,
    ).map((obligation) => ({
      kind: 'delete' as const,
      rowId: obligation.row.rowId,
      expectedRevision: obligation.row.revision,
    })), { signal: input.context.signal });
    if (result.status === 'conflict') return false;
    for (const entry of result.results) {
      if (!entry.deleted) return false;
      try {
        await collection.forget(entry.rowId, {
        expectedRevision: entry.revision,
        signal: input.context.signal,
        });
      } catch {
        return false;
      }
    }
  }
  assertNotAborted(input.context.signal);
  const result = await collection.batch([{
    kind: 'delete' as const,
    rowId: input.candidate.census.row.rowId,
    expectedRevision: input.candidate.census.row.revision,
  }], { signal: input.context.signal });
  if (result.status !== 'updated') return false;
  const census = result.results[0];
  if (!census?.deleted) return false;
  try {
    await collection.forget(census.rowId, {
      expectedRevision: census.revision,
      signal: input.context.signal,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * In-place compaction of a settled unit. The full admitted ingress is replaced
 * by the envelope the protocol already publishes without a body plus one
 * connection-keyed digest of the admitted text, so the message text stops
 * being duplicated outside the Session transcript for the rest of the frozen
 * window while replay equality, the retention anchor, and sender-refusal
 * custody all keep deciding from the retained envelope.
 */
function compactedIngressCensusValue(input: Readonly<{
  census: IngressCensusRecord;
  compacted: IngressCensusCompacted;
  now: number;
}>): JsonRecord {
  const {
    phase,
    connectionAuthorityEpoch,
    maximumObservationAgeMs,
    checkpointCoveredAt,
    conflict,
  } = input.census.payload;
  return {
    ...input.census,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      normalizedIngress: null,
      compacted: input.compacted,
      phase,
      connectionAuthorityEpoch,
      maximumObservationAgeMs,
      checkpointCoveredAt,
      conflict,
      // The compact shell/digest plus exact retained-attention row identities
      // are now the complete replay/retention witness, so no original fanout
      // or Event payload survives here.
      eventCandidate: null,
      matchedBindings: [],
    },
  };
}

/**
 * Terminal attention has no retry or external effect left to reconstruct. Its
 * public projection needs only the row identity, owner, terminal lifecycle and
 * non-admission fact, so discard the frozen target and mediation tuples while
 * preserving the original attention timestamp and member correspondence.
 */
function compactedTerminalAttentionObligationValue(
  obligation: IngressObligationRecord,
): JsonRecord {
  return {
    ...obligation,
    payload: {
      ...obligation.payload,
      target: null,
      approvalTurnId: null,
      userActionAnswerTurnId: null,
    },
  };
}

/**
 * Only an admitted body is duplicated content: a `routableNonAdmission`
 * census already retains nothing but its envelope, so it has nothing to
 * compact and stays exactly as written.
 */
async function compactSettledIngressCensus(input: Readonly<{
  context: PluginInvocationContext;
  candidate: IngressRetentionCandidate;
  now: number;
}>): Promise<boolean> {
  const { census, connection } = input.candidate;
  const normalizedIngress = census.value.payload.normalizedIngress;
  const priorCompacted = census.value.payload.compacted;
  if (normalizedIngress !== null && normalizedIngress.kind !== 'fullText') return false;
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  // Ordinary terminal attention remains independently inspectable until the
  // frozen horizon and its compact census keeps the exact row identities for
  // deletion. A census conflict is already the durable minimal explanation;
  // all terminal member rows are redundant and must be removed instead of
  // becoming unreachable orphans.
  const retainedAttentionObligations = census.value.payload.conflict === null
    ? input.candidate.obligations.filter((obligation) => obligation.value.attention)
    : [];
  const retainedAttentionRowIds = new Set(
    retainedAttentionObligations.map((obligation) => obligation.row.rowId),
  );
  const prunableObligations = input.candidate.obligations.filter(
    (obligation) => !retainedAttentionRowIds.has(obligation.row.rowId),
  );
  const { maxBatchRows } = await collection.limits({ signal: input.context.signal });
  for (let offset = 0; offset < prunableObligations.length; offset += maxBatchRows) {
    assertNotAborted(input.context.signal);
    const result = await collection.batch(prunableObligations.slice(
      offset,
      offset + maxBatchRows,
    ).map((obligation) => ({
      kind: 'delete' as const,
      rowId: obligation.row.rowId,
      expectedRevision: obligation.row.revision,
    })), { signal: input.context.signal });
    // A later sweep rereads the member set. Already deleted terminal rows are
    // a completed prefix, while a concurrent revision keeps the full census
    // intact until the owner can decide it again.
    if (result.status === 'conflict') return false;
  }
  const attentionCompactions = retainedAttentionObligations.filter((obligation) => (
    obligation.value.payload.target !== null
    || obligation.value.payload.approvalTurnId !== null
    || obligation.value.payload.userActionAnswerTurnId !== null
  ));
  for (let offset = 0; offset < attentionCompactions.length; offset += maxBatchRows) {
    assertNotAborted(input.context.signal);
    const result = await collection.batch(attentionCompactions.slice(
      offset,
      offset + maxBatchRows,
    ).map((obligation) => ({
      kind: 'put' as const,
      value: compactedTerminalAttentionObligationValue(obligation.value),
      expectedRevision: obligation.row.revision,
    })), { signal: input.context.signal });
    if (result.status === 'conflict') return false;
  }
  const nextRetainedAttentionObligationRowIds = retainedAttentionObligations.map(
    (obligation) => obligation.row.rowId,
  );
  if (
    normalizedIngress === null
    && priorCompacted !== null
    && pluginJsonValuesEqual(
      priorCompacted.retainedAttentionObligationRowIds,
      nextRetainedAttentionObligationRowIds,
    )
  ) return false;
  assertNotAborted(input.context.signal);
  const result = await collection.batch([{
    kind: 'put',
    value: compactedIngressCensusValue({
      census: census.value,
      compacted: normalizedIngress === null
        ? {
          ...priorCompacted as IngressCensusCompacted,
          retainedAttentionObligationRowIds: nextRetainedAttentionObligationRowIds,
        }
        : {
          shell: ingressShell(normalizedIngress),
          textDigest: await deriveIngressCensusTextDigest({
            routingIdentityKey: connection.value.payload.routingIdentityKey,
            text: normalizedIngress.observation.message.text,
          }),
          retainedAttentionObligationRowIds: nextRetainedAttentionObligationRowIds,
        },
      now: input.now,
    }),
    expectedRevision: census.row.revision,
  }], { signal: input.context.signal });
  return result.status === 'updated';
}

export type ConversationIngressRetentionRunResult = Readonly<{
  compactedCensuses: number;
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
  const limit = input.limit ?? PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;
  if (
    !isNonNegativeSafeInteger(now)
    || !Number.isSafeInteger(limit)
    || limit < 1
    || limit > PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1
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
  let compactedCensuses = 0;
  let deletedCensuses = 0;
  for (const raw of page.rows) {
    assertNotAborted(context.signal);
    const census = asIngressCensus(readStateRow(raw) ?? null);
    if (census === undefined) continue;
    const candidate = await readSettledIngressUnit({ context, census });
    if (candidate === undefined) continue;
    if (
      census.value.payload.conflict === null
      && isIngressCensusPastFrozenRetentionHorizon({ census: census.value, now })
    ) {
      if (await deleteIngressRetentionCandidate({ context, candidate })) deletedCensuses += 1;
      continue;
    }
    if (await compactSettledIngressCensus({ context, candidate, now })) compactedCensuses += 1;
  }
  return {
    compactedCensuses,
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

/**
 * Finishes one census that preparation never completed, as the ordinary
 * stale-authority terminal outcome its members already have for a revoked
 * authority. Members that are already terminal, or that hold `attempting` or
 * `blocked` custody a downstream effect may depend on, keep their incumbent
 * recovery owner and their retained input.
 */
async function abandonPreparingIngressCensus(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
}>): Promise<void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const shell = censusIngressShell(input.census.value.payload);
  const fence = {
    kind: 'assert' as const,
    rowId: input.census.row.rowId,
    expectedRevision: input.census.row.revision,
  };
  const settlements: Array<Readonly<{ value: JsonRecord; expectedRevision: number }>> = [];
  for (const member of ingressCensusObligationMembers(input.census.value.payload)) {
    assertNotAborted(input.context.signal);
    const obligationId = await deriveIngressObligationRowIdForCensusMember({
      routingIdentityKey: input.connection.value.payload.routingIdentityKey,
      connectionId: input.connection.value.id,
      occurrenceId: shell.occurrenceId,
      member,
    });
    const row = readStateRow(await collection.get(obligationId, { signal: input.context.signal })) ?? null;
    if (row === null) continue;
    const obligation = asIngressObligation(row);
    if (
      obligation === undefined
      || !ingressObligationMatchesCensusMember({
        censusId: input.census.value.id,
        member,
        obligation: obligation.value,
      })
    ) return;
    const settlement = prepareConversationIngressObligationForDeletion({
      rowId: row.rowId,
      revision: row.revision,
      value: row.value,
      now: Date.now(),
      disposition: 'staleAuthority',
      nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
    });
    // An unreadable member or one belonging to another connection is corrupt
    // state an owner still has to see; it must not be swept by this transition.
    if (settlement.kind === 'invalid' || settlement.connectionId !== input.connection.value.id) return;
    if (settlement.kind !== 'readyToSettle') continue;
    settlements.push({ value: settlement.value, expectedRevision: row.revision });
  }
  const { maxBatchRows } = await collection.limits({ signal: input.context.signal });
  const perBatch = Math.max(maxBatchRows - 1, 1);
  for (let offset = 0; offset < settlements.length; offset += perBatch) {
    assertNotAborted(input.context.signal);
    const result = await collection.batch([
      fence,
      ...settlements.slice(offset, offset + perBatch).map((settlement) => ({
        kind: 'put' as const,
        value: settlement.value,
        expectedRevision: settlement.expectedRevision,
      })),
    ], { signal: input.context.signal });
    if (result.status === 'conflict') return;
  }
  assertNotAborted(input.context.signal);
  await collection.batch([{
    kind: 'put',
    value: preparedIngressCensusValue({ census: input.census.value, now: Date.now() }),
    expectedRevision: input.census.row.revision,
  }], { signal: input.context.signal });
}

/**
 * A `preparing` census is admitted work only a replay of its occurrence can
 * finish, and preparation is reachable only from the ingress path. A
 * checkpointed pull keeps that producer, so its unfinished units are left
 * alone. Socket and durable-push ingress has no cursor to re-present the
 * occurrence, and accepting the history gap is the owner's decision that the
 * lost window is gone: nothing will ever reach `prepared`, so the members
 * would keep refilling the first due page ahead of valid work while retention
 * — which reclaims only prepared units — could never expire the row.
 */
async function abandonUnreplayablePreparingIngressCensuses(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
}>): Promise<void> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  let cursor: string | undefined;
  do {
    assertNotAborted(input.context.signal);
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
      prefix: [
        input.connection.value.id,
        null,
        CHANNEL_STATE_RECORD_KIND.ingressCensus,
        false,
      ],
      order: 'asc',
      limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: input.context.signal });
    for (const raw of page.rows) {
      const census = asIngressCensus(readStateRow(raw) ?? null);
      if (census === undefined || census.value.payload.phase !== 'preparing') continue;
      await abandonPreparingIngressCensus({ ...input, census });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}

async function clearCurrentHistoryGapWithoutCheckpoint(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
}>): Promise<ConversationConnectionUpdateResult> {
  // Abandonment precedes the gap clear so an interrupted acceptance repeats it
  // rather than leaving the stranded units behind a cleared gap.
  await abandonUnreplayablePreparingIngressCensuses(input);
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

type IngressCensusCheckpointSettlement = Readonly<{
  kind: 'cover' | 'assert';
  census: Readonly<{ row: StateRow; value: IngressCensusRecord }>;
  /** Only a replacement baseline may prepare-and-cover its stranded census. */
  prepare?: true;
}>;

type IngressObligationCheckpointSettlement = Readonly<{
  kind: 'terminalize';
  obligation: Readonly<{ row: StateRow; value: IngressObligationRecord }>;
  value: JsonRecord;
}>;

type CheckpointedBaselineIngressSettlements = Readonly<{
  censusSettlements: readonly IngressCensusCheckpointSettlement[];
  obligationSettlements: readonly IngressObligationCheckpointSettlement[];
}>;

/**
 * A replacement checkpoint makes this connection's earlier provider window
 * unreachable. Before it can clear that history gap, this same ingress owner
 * converts every replayable, unattempted member from that window into its
 * minimal stale-authority terminal fact, then covers every census while the
 * history gap still fences new ingress. A blocked member keeps its explicit
 * recovery custody independently, matching ordinary poll coverage; it does
 * not become a global checkpoint assertion. An already-attempting member has
 * an external effect in flight and therefore rejects the observed baseline.
 *
 * Provider ingress is already rejected while `historyGap` is set, which is the
 * connection-level admission fence that makes each staged CAS current until
 * the final CAS clears the gap.
 */
async function readCheckpointedBaselineIngressSettlements(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
}>): Promise<CheckpointedBaselineIngressSettlements> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const censusSettlements = new Map<string, IngressCensusCheckpointSettlement>();
  const obligationSettlements = new Map<string, IngressObligationCheckpointSettlement>();
  for (const attention of [false, true] as const) {
    let cursor: string | undefined;
    do {
      assertNotAborted(input.context.signal);
      const page = await collection.query({
        index: CHANNEL_STATE_INDEX_ID.byConnectionBindingV2,
        prefix: [
          input.connection.value.id,
          null,
          CHANNEL_STATE_RECORD_KIND.ingressCensus,
          attention,
        ],
        order: 'asc',
        limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal: input.context.signal });
      for (const raw of page.rows) {
        assertNotAborted(input.context.signal);
        const census = asIngressCensus(readStateRow(raw) ?? null);
        if (census === undefined || census.value['connection-id'] !== input.connection.value.id) {
          continue;
        }
        if (
          census.value.payload.phase === 'preparing'
          && census.value.payload.checkpointCoveredAt !== null
        ) {
          throw pluginError(
            'channels_stream_baseline_unsettled_ingress',
            'A preparing ingress census cannot already be covered by a replacement checkpoint.',
            true,
          );
        }
        // This census was already crossed by a committed provider cursor.
        // Its retained replay/attention horizon is owned by ingress retention,
        // not by a later replacement baseline, so asserting it again would
        // let arbitrary covered history consume the bounded atomic settlement
        // batch and prevent recovery from clearing an unrelated new gap.
        if (census.value.payload.checkpointCoveredAt !== null) continue;
        if (census.value.attention || census.value.payload.conflict !== null) {
          throw pluginError(
            'channels_stream_baseline_unsettled_ingress',
            'A conflicting uncovered ingress census requires owner attention before this replacement checkpoint can advance.',
            true,
          );
        }
        const shell = censusIngressShell(census.value.payload);
        for (const member of ingressCensusObligationMembers(census.value.payload)) {
          const obligationId = await deriveIngressObligationRowIdForCensusMember({
            routingIdentityKey: input.connection.value.payload.routingIdentityKey,
            connectionId: input.connection.value.id,
            occurrenceId: shell.occurrenceId,
            member,
          });
          const obligation = asIngressObligation(readStateRow(await collection.get(
            obligationId,
            { signal: input.context.signal },
          )) ?? null);
          // An absent member was already terminally reclaimed by this owner's
          // retention path. A retained member must be exactly the frozen
          // census member, or the replacement cannot safely decide it.
          if (obligation === undefined) continue;
          if (
            obligation.value['connection-id'] !== input.connection.value.id
            || !ingressObligationMatchesCensusMember({
              censusId: census.value.id,
              member,
              obligation: obligation.value,
            })
          ) {
            throw pluginError(
              'channels_stream_baseline_unsettled_ingress',
              'A retained ingress member no longer matches the immutable census it belongs to.',
              true,
            );
          }
          const settlement = prepareConversationIngressObligationForDeletion({
            rowId: obligation.row.rowId,
            revision: obligation.row.revision,
            value: obligation.row.value,
            now: Date.now(),
            disposition: 'staleAuthority',
            nonAdmission: { reason: 'staleAuthority', senderFeedbackEligible: false },
          });
          if (settlement.kind === 'invalid' || settlement.connectionId !== input.connection.value.id) {
            throw pluginError(
              'channels_stream_baseline_unsettled_ingress',
              'The replacement checkpoint found an unreadable ingress member.',
              true,
            );
          }
          let planned: IngressObligationCheckpointSettlement | undefined;
          if (settlement.kind === 'readyToSettle') {
            planned = { kind: 'terminalize', obligation, value: settlement.value };
          } else if (settlement.kind === 'blocked') {
            if (obligation.value.payload.lifecycle.phase === 'attempting') {
              throw pluginError(
                'channels_stream_baseline_unsettled_ingress',
                'An in-flight ingress member must settle before checkpoint replacement.',
                true,
              );
            }
            if (
              obligation.value.payload.lifecycle.phase !== 'blocked'
              || !obligation.value.attention
            ) {
              throw pluginError(
                'channels_stream_baseline_unsettled_ingress',
                'The replacement checkpoint found an invalid retained ingress recovery state.',
                true,
              );
            }
            // Manual recovery custody remains independently visible/retryable.
            // A concurrent retry after this read is equivalent to retrying an
            // already-covered ordinary-poll obligation and needs no checkpoint
            // assertion of its own.
          }
          if (planned !== undefined) {
            const existing = obligationSettlements.get(obligation.row.rowId);
            if (
              existing !== undefined
              && (
                existing.obligation.row.revision !== obligation.row.revision
                || existing.kind !== planned.kind
              )
            ) {
              throw pluginError(
                'channels_stream_baseline_unsettled_ingress',
                'The replacement checkpoint found two revisions of one ingress member.',
                true,
              );
            }
            obligationSettlements.set(obligation.row.rowId, planned);
          }
        }
        const prepare = census.value.payload.phase === 'preparing';
        const kind = census.value.payload.checkpointCoveredAt === null ? 'cover' : 'assert';
        if (prepare && kind !== 'cover') {
          throw pluginError(
            'channels_stream_baseline_unsettled_ingress',
            'A preparing ingress census cannot be asserted as already checkpoint-covered.',
            true,
          );
        }
        const existing = censusSettlements.get(census.value.id);
        if (existing !== undefined && existing.census.row.revision !== census.row.revision) {
          throw pluginError(
            'channels_stream_baseline_unsettled_ingress',
            'The replacement checkpoint found two revisions of one ingress census.',
            true,
          );
        }
        censusSettlements.set(census.value.id, {
          kind,
          census,
          ...(prepare ? { prepare: true as const } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return {
    censusSettlements: [...censusSettlements.values()],
    obligationSettlements: [...obligationSettlements.values()],
  };
}

/**
 * A single census may legitimately fan out to every Account binding, which is
 * larger than one checkpoint transaction. While the connection's history gap
 * still fences new provider ingress, settle only the ready, debounce-due, and
 * retry-due members in deployment-sized batches under the exact connection
 * revision, reread, durably stage the replacement provider checkpoint, and
 * only then cover the resulting censuses under both exact fences. The owner
 * clears the history gap only after another reread finds no uncovered census
 * or actionable member. A crash therefore leaves either no coverage or a
 * durable cursor that already crossed every reclaimable occurrence.
 */
async function stageCheckpointedBaselineValues(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  checkpoint?: Readonly<{ row: StateRow; value: CheckpointRecord }>;
  values: readonly Readonly<{ value: JsonRecord; expectedRevision: number }>[];
}>): Promise<void> {
  if (input.values.length === 0) return;
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const fences = [{
    kind: 'assert' as const,
    rowId: input.connection.row.rowId,
    expectedRevision: input.connection.row.revision,
  }, ...(input.checkpoint === undefined ? [] : [{
    kind: 'assert' as const,
    rowId: input.checkpoint.row.rowId,
    expectedRevision: input.checkpoint.row.revision,
  }])];
  const maximumMeasuredValues = PLUGIN_COLLECTION_MUTATION_BATCH_MAX_ROWS_V1 - fences.length;
  for (let offset = 0; offset < input.values.length; offset += maximumMeasuredValues) {
    const measuredValues = input.values.slice(offset, offset + maximumMeasuredValues);
    const puts = measuredValues.map((entry) => ({
      kind: 'put' as const,
      value: entry.value,
      expectedRevision: entry.expectedRevision,
    }));
    const [limits, measurement] = await Promise.all([
      collection.limits({ signal: input.context.signal }),
      collection.measureBatch([...fences, ...puts], { signal: input.context.signal }),
    ]);
    const valueById = new Map(
      measuredValues.map((entry) => [own(entry.value, CHANNEL_STATE_FIELD.id), entry]),
    );
    for (const values of partitionIngressPreparationValues({
      values: measuredValues.map((entry) => entry.value),
      limits,
      measurement,
      fenceOperationCount: fences.length,
    })) {
      assertNotAborted(input.context.signal);
      const result = await collection.batch([
        ...fences,
        ...values.map((value) => {
          const rowId = own(value, CHANNEL_STATE_FIELD.id);
          const entry = typeof rowId === 'string' ? valueById.get(rowId) : undefined;
          if (entry === undefined) {
            throw pluginError(
              'channels_stream_baseline_unsettled_ingress',
              'The staged replacement baseline lost an ingress row identity.',
              true,
            );
          }
          return {
            kind: 'put' as const,
            value,
            expectedRevision: entry.expectedRevision,
          };
        }),
      ], { signal: input.context.signal });
      if (result.status === 'conflict') {
        throw pluginError(
          'channels_stream_baseline_conflict',
          'The Channel connection or an ingress row changed during staged baseline settlement.',
          true,
        );
      }
    }
  }
}

async function stageCheckpointedBaselineIngressTerminalizations(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  settlements: CheckpointedBaselineIngressSettlements;
}>): Promise<CheckpointedBaselineIngressSettlements> {
  await stageCheckpointedBaselineValues({
    context: input.context,
    connection: input.connection,
    values: input.settlements.obligationSettlements.map((settlement) => ({
      value: settlement.value,
      expectedRevision: settlement.obligation.row.revision,
    })),
  });
  const afterTerminalization = input.settlements.obligationSettlements.length === 0
    ? input.settlements
    : await readCheckpointedBaselineIngressSettlements({
      context: input.context,
      connection: input.connection,
    });
  return afterTerminalization;
}

async function stageCheckpointedBaselineIngressCoverage(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }>;
  settlements: CheckpointedBaselineIngressSettlements;
}>): Promise<CheckpointedBaselineIngressSettlements> {
  const now = Date.now();
  await stageCheckpointedBaselineValues({
    context: input.context,
    connection: input.connection,
    checkpoint: input.checkpoint,
    values: input.settlements.censusSettlements.filter(
      (settlement) => settlement.kind === 'cover',
    ).map((settlement) => ({
      value: checkpointCoveredIngressCensusValue({
        census: settlement.census.value,
        now,
        ...(settlement.prepare === true ? { prepare: true } : {}),
      }),
      expectedRevision: settlement.census.row.revision,
    })),
  });
  return await readCheckpointedBaselineIngressSettlements({
    context: input.context,
    connection: input.connection,
  });
}

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
    connection.value.payload.historyGap !== null
    || connection.value.payload.transport.kind !== 'checkpointedPull'
    || connection.value.payload.replayContinuity !== 'checkpointed'
  ) {
    throw pluginError(
      'channels_checkpointed_poll_conflict',
      'The Channel connection no longer has the checkpointed poll authority being settled.',
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
        || existing.prepare !== settlement.prepare
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
      || settlement.prepare === true
      || (settlement.prepare !== true && settlement.kind === 'cover'
        && settlement.census.value.payload.phase !== 'prepared')
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
  const writesConnection = connection.value.payload.pollFailure !== null;
  const now = Date.now();
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const operations: readonly PluginCollectionMutation<JsonRecord>[] = [
    ...(writesConnection
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
            value: checkpointCoveredIngressCensusValue({
              census: settlement.census.value,
              now,
              ...(settlement.prepare === true ? { prepare: true } : {}),
            }),
            expectedRevision: settlement.census.row.revision,
          }
        : {
            kind: 'assert' as const,
            rowId: settlement.census.row.rowId,
            expectedRevision: settlement.census.row.revision,
      }
    )),
  ];
  const result = await collection.batch(operations, { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_checkpointed_poll_conflict',
      'The Channel connection or checkpoint changed before its poll result could commit.',
      true,
    );
  }
  const checkpointRow = result.results.find((entry) => entry.rowId === input.checkpointId && !entry.deleted);
  if (checkpointRow === undefined) {
    throw pluginError(
      'channels_checkpointed_poll_result_invalid',
      'The Channel checkpoint settlement did not return its retained checkpoint row.',
      true,
    );
  }
  const row = writesConnection
    ? result.results.find((entry) => entry.rowId === input.connectionId && !entry.deleted)
    : connection.row;
  if (row === undefined) {
    throw pluginError(
      'channels_checkpointed_poll_result_invalid',
      'The Channel poll checkpoint did not return its cleared connection row.',
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

async function stageCurrentCheckpointedBaselineCheckpoint(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  checkpointId: string;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }> | undefined;
  checkpointAfter: JsonValue;
  nextPollNotBeforeMs: number | null;
}>): Promise<Readonly<{ row: StateRow; value: CheckpointRecord }>> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const now = Date.now();
  const value = createCheckpointValue({
    connection: input.connection,
    checkpointId: input.checkpointId,
    checkpoint: input.checkpoint,
    checkpointAfter: input.checkpointAfter,
    lastOccurrenceId: null,
    nextPollNotBeforeMs: input.nextPollNotBeforeMs,
    now,
  });
  const result = await collection.batch([
    {
      kind: 'assert',
      rowId: input.connection.row.rowId,
      expectedRevision: input.connection.row.revision,
    },
    {
      kind: 'put',
      value,
      expectedRevision: input.checkpoint?.row.revision ?? 'absent',
    },
  ], { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_stream_baseline_conflict',
      'The Channel connection or staged replacement checkpoint changed before it could commit.',
      true,
    );
  }
  const row = result.results.find((entry) => entry.rowId === input.checkpointId && !entry.deleted);
  const staged = row === undefined ? undefined : asCheckpoint({ rowId: row.rowId, revision: row.revision, value });
  if (staged === undefined) {
    throw pluginError(
      'channels_stream_baseline_result_invalid',
      'The staged replacement checkpoint did not return its canonical row.',
      true,
    );
  }
  return staged;
}

async function clearCurrentCheckpointedBaselineGap(input: Readonly<{
  context: PluginInvocationContext;
  connection: Readonly<{ row: StateRow; value: ChannelConnectionRecord }>;
  checkpoint: Readonly<{ row: StateRow; value: CheckpointRecord }>;
}>): Promise<ConversationConnectionUpdateResult> {
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  const result = await collection.batch([
    {
      kind: 'put',
      value: clearConnectionHistoryGapValue({ connection: input.connection, now: Date.now() }),
      expectedRevision: input.connection.row.revision,
    },
    {
      kind: 'assert',
      rowId: input.checkpoint.row.rowId,
      expectedRevision: input.checkpoint.row.revision,
    },
  ], { signal: input.context.signal });
  if (result.status === 'conflict') {
    throw pluginError(
      'channels_stream_baseline_conflict',
      'The Channel connection or staged replacement checkpoint changed before the history gap could clear.',
      true,
    );
  }
  const row = result.results.find((entry) => entry.rowId === input.connection.row.rowId && !entry.deleted);
  if (row === undefined) {
    throw pluginError(
      'channels_stream_baseline_result_invalid',
      'The Channel history-gap clear did not return its connection row.',
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
    const terminalized = await stageCheckpointedBaselineIngressTerminalizations({
      context,
      connection,
      settlements: await readCheckpointedBaselineIngressSettlements({ context, connection }),
    });
    const stagedCheckpoint = await stageCurrentCheckpointedBaselineCheckpoint({
      context,
      connection,
      checkpointId,
      checkpoint,
      checkpointAfter: result.checkpointAfterBatch,
      nextPollNotBeforeMs: result.retryHint === undefined ? null : Date.now() + result.retryHint.retryAfterMs,
    });
    const covered = await stageCheckpointedBaselineIngressCoverage({
      context,
      connection,
      checkpoint: stagedCheckpoint,
      settlements: terminalized,
    });
    if (covered.censusSettlements.length > 0 || covered.obligationSettlements.length > 0) {
      throw pluginError(
        'channels_stream_baseline_unsettled_ingress',
        'The staged replacement baseline still has uncovered ingress work.',
        true,
      );
    }
    return await clearCurrentCheckpointedBaselineGap({
      context,
      connection,
      checkpoint: stagedCheckpoint,
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
  if (!isConversationPollFailureAttemptCount(nextAttemptCount)) {
    throw pluginError(
      'channels_checkpointed_poll_connection_corrupt',
      'The current Channel connection cannot advance its bounded poll-failure lifecycle.',
    );
  }
  const now = Date.now();
  const retryAfterMs = input.retryAfterMs ?? conversationRetryDelayMs(nextAttemptCount);
  const pollFailure: ConversationConnectionPollFailureV1 = (
    input.retryableProviderResult && isConversationPollRetryAttemptCount(nextAttemptCount)
  )
    ? {
        phase: 'retryDue',
        attemptCount: nextAttemptCount,
        retryNotBeforeMs: now + retryAfterMs,
        evidence: input.evidence,
      }
    : {
        phase: 'blocked',
        attemptCount: nextAttemptCount,
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
  return pollFailure.phase === 'retryDue'
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

  const conflict = await readConversationIngressConflictCensus({
    context: input.context,
    connectionId: input.connectionId,
  });
  if (conflict === 'invalid') {
    throw pluginError(
      'channels_checkpointed_poll_connection_corrupt',
      'The retained Channel conflict index row is not a canonical ingress census conflict.',
    );
  }
  return conflict === undefined
    ? connection
    : undefined;
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
  observations: readonly ConversationIngressObservedEntryV1[];
}>): Promise<
  | Readonly<{
    kind: 'checkpointSafe';
    censusSettlements: readonly IngressCensusCheckpointSettlement[];
  }>
  | Readonly<{ kind: 'unsettled' }>
> {
  let outcome: 'checkpointSafe' | 'unsettled' = 'checkpointSafe';
  const censusSettlements = new Map<string, IngressCensusCheckpointSettlement>();
  for (const entry of input.observations) {
    assertNotAborted(input.context.signal);
    const observationOutcome = await ingestConversationObservationForInvocation(
      { connectionId: input.connectionId, entry },
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
      observation: entry.observation,
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
        ? (result.observations.at(-1) === undefined
          ? null
          : ingressShell(result.observations.at(-1)!.observation).occurrenceId)
        : null,
      nextPollNotBeforeMs: result.retryHint === undefined ? null : Date.now() + result.retryHint.retryAfterMs,
      censusSettlements,
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
