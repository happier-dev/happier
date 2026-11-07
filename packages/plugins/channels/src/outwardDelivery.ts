import { matchesConversationBindingEndpoint } from './bindingEndpoints.js';
import type {
  ConversationDeliveryLinkPreviewPolicyV1,

  ConversationOutboundTextLimitV1,
  ConversationDeliveryReplyContextV1,
  ConversationDeliveryResultV1,
  ConversationDeliveryContentV1,
  ConversationDeliveryNewThreadV1,
  ConversationStartSourceV1,
  ConversationResolvedEndpointV1,
  ConversationPermissionMediationSourceCurrentnessInputV1,
  ConversationPermissionMediationSourceCurrentnessResultV1,
  ConversationSessionLastDeliveryV1,
  ConversationRecommendedRecoveryV1,
} from '@happier-dev/channels-protocol/v1';
import {
  areConversationEndpointIdentitiesEqual,
  ConversationBindingTargetV1Schema,
  ConversationBindingIdV1Schema,
  ConversationConnectionIdV1Schema,
  ConversationDeliveryReplyContextV1Schema,
  ConversationDeliveryContentV1Schema,
  ConversationDeliveryNewThreadV1Schema,
  ConversationStartSourceV1Schema,
  ConversationProviderConnectionInputV1Schema,
  ConversationOutboundTextLimitV1Schema,
  ConversationPermissionMediationSourceCurrentnessInputV1Schema,
  ConversationPermissionMediationSourceCurrentnessResultV1Schema,
  ConversationResolvedEndpointV1Schema,
  MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
  countConversationTextUnits,
} from '@happier-dev/channels-protocol/v1';
import {
  AutomationResultDeliverySourceV1Schema,
  type AutomationResultDeliverySourceV1,
} from '@happier-dev/plugin-sdk/automations';
import {
  isPluginError,
  PluginError,
  type PluginInvocationContext,
} from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { createProtocolStoredReadSchema, pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import type { ConversationConnectionTransportOriginV1 } from './connectionLifecycle.js';
import {
  PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginAccountCollectionForDefinition,
} from '@happier-dev/plugin-sdk/collections';
import {
  MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1,
  type PluginTranscriptActivitySnapshotV1,
} from '@happier-dev/plugin-sdk/resources';

import {
  CONVERSATION_DELIVERY_CUSTODY_STATES,
  createReadyConversationDeliveryCustody,
  deriveConversationDeliveryAttention,
  deriveConversationDeliveryLastOutcome,
  deriveConversationDeliveryProjection,
  isConversationDeliveryAutomaticTerminal,
  isConversationDeliveryContentFree,
  isConversationDeliveryRetentionEligible,
  hasPendingConversationThreadBinding,
  resolveConversationDeliveryCustody,
  settleConversationDeliveryForBindingDeletion,
  settleConversationDeliveryForConnectionDeletion,
  settleConversationDeliveryAttempt,
  startConversationDeliveryAttempt,
  settleConversationDeliveryBeforeProviderEffect,
  type ConversationDeliveryCustody,
} from './deliveryCustody.js';
import { hasConversationApprovalPolicyEnabled } from './bindingTransition.js';
import {
  importHmacSha256Key,
  signLengthPrefixedUtf8HmacSha256Base64Url,
  tryDecodeBase64Url,
} from './privateRowIdentity.js';
import type { PersistedConversationProviderContributionSelection } from './collections.js';
import type { ConversationPendingPermissionRequest } from './permissionMediation.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { recommendConversationDeliveryRecovery } from './recoveryRecommendation.js';

/**
 * Loading the collection definition during generic delivery-module evaluation
 * creates an ESM initialization cycle through the contract package. The
 * concrete adapter loads the canonical declaration only when it is invoked.
 */
type ConversationCollectionsModule = typeof import('./collections.js');
type ConversationAccountLocalBindingPolicyModule = typeof import('./accountLocalBindingPolicy.js');

const storedDeliveryContentSchema = createProtocolStoredReadSchema(ConversationDeliveryContentV1Schema);
const storedDeliveryNewThreadSchema = createProtocolStoredReadSchema(ConversationDeliveryNewThreadV1Schema);
const storedDeliveryEndpointSchema = createProtocolStoredReadSchema(ConversationResolvedEndpointV1Schema);
const storedStartSourceSchema = createProtocolStoredReadSchema(ConversationStartSourceV1Schema);
const storedOutboundTextLimitSchema = createProtocolStoredReadSchema(ConversationOutboundTextLimitV1Schema);

let conversationCollectionsModulePromise: Promise<ConversationCollectionsModule> | undefined;
let conversationAccountLocalBindingPolicyModulePromise: Promise<ConversationAccountLocalBindingPolicyModule> | undefined;

function loadConversationCollectionsModule(): Promise<ConversationCollectionsModule> {
  conversationCollectionsModulePromise ??= import('./collections.js');
  return conversationCollectionsModulePromise;
}

export function loadConversationAccountLocalBindingPolicyModule(): Promise<ConversationAccountLocalBindingPolicyModule> {
  conversationAccountLocalBindingPolicyModulePromise ??= import('./accountLocalBindingPolicy.js');
  return conversationAccountLocalBindingPolicyModulePromise;
}

export type ConversationControlResponseKind =
  | 'pairing'
  | 'newSession'
  | 'approval'
  | 'userAction'
  | 'stop'
  | 'refusal'
  | 'recovery';

/**
 * Read-only predecessor stamps. Current send policy is read at claim;
 * retained rows may still carry the former route revision and epochs.
 */
export type ConversationOutwardDeliveryConnectionRouteAuthority = Readonly<{
  connectionAuthorityEpoch?: number;
}>;

export type ConversationOutwardDeliveryBindingRouteAuthority = Readonly<{
  connectionAuthorityEpoch?: number;
  bindingRevision?: number;
  bindingAuthorityEpoch?: number;
}>;

export type ConversationOutwardDeliveryRouteAuthority =
  | ConversationOutwardDeliveryConnectionRouteAuthority
  | ConversationOutwardDeliveryBindingRouteAuthority;

/** The closed source identity carried by every Channels outward effect. */
export type ConversationOutwardSourceV1 =
  | ConversationStartSourceV1
  | Readonly<{ kind: 'sessionProjection'; sessionId: string; semanticItemId: string }>
  | Readonly<{ kind: 'discussionProjection'; discussionId: string; semanticItemId: string }>
  | AutomationResultDeliverySourceV1
  | Readonly<{ kind: 'permissionWait'; sessionId: string; turnId: string; requestId: string }>
  | Readonly<{
    kind: 'controlResponse';
    controlId: string;
    controlKind: ConversationControlResponseKind;
  }>;

/**
 * The one persisted write-ahead obligation shape. Source-specific owners only
 * supply their closed source identity; custody/currentness remains here.
 */
type ConversationOutwardDeliveryObligationCommon = Readonly<{
  connectionId: string;
  source: ConversationOutwardSourceV1;
  endpoint: ConversationResolvedEndpointV1;
  content: ConversationDeliveryContentV1;
  newThread?: ConversationDeliveryNewThreadV1;
  deliveryKey: string;
  replyContext?: ConversationDeliveryReplyContextV1;

  linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
}>;

type ConversationOutwardDeliveryRoute =
  | Readonly<{
    bindingId: string;
    routeAuthority: ConversationOutwardDeliveryBindingRouteAuthority;
  }>
  | Readonly<{
    bindingId?: undefined;
    routeAuthority: ConversationOutwardDeliveryConnectionRouteAuthority;
  }>;

export type ConversationOutwardDeliveryObligation =
  ConversationOutwardDeliveryObligationCommon & ConversationOutwardDeliveryRoute;

/**
 * A compacted custody row retains source and effect identity, never the
 * outbound body. It remains distinct from an admission obligation: callers
 * can construct only a body-bearing obligation for a new provider effect.
 */
type ConversationStoredOutwardDeliveryObligation =
  | ConversationOutwardDeliveryObligation
  | (Omit<ConversationOutwardDeliveryObligationCommon, 'content'>
    & ConversationOutwardDeliveryRoute
    & Readonly<{
      content: null;
    }>);

export type ConversationOutwardDeliveryRecord = Readonly<{
  /** Opaque physical Account-Collection row ID; never caller supplied. */
  custodyId: string;
  revision: number;
  createdAt: number;
  obligation: ConversationStoredOutwardDeliveryObligation;
  custody: ConversationDeliveryCustody;
}>;

export type ConversationOutwardDeliveryLookup =
  | Readonly<{ kind: 'rejoined'; record: ConversationOutwardDeliveryRecord }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'invalid'; reason: 'invalidRow' | 'rowTooLarge' }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'connectionUnavailable' | 'connectionCorrupt' | 'storageUnavailable';
  }>;

export interface ConversationOutwardDeliveryStore {
  /**
   * Resolves the deterministic channel-deliveries row without writing. It
   * exists so admission can settle an already-durable obligation before any
   * mutable route fact is read: an accepted response that was lost must rejoin
   * the same custody even after its binding was edited, disabled, or deleted,
   * because route currentness governs only whether a *new* obligation may be
   * created.
   */
  lookup(obligation: ConversationOutwardDeliveryObligation): Promise<ConversationOutwardDeliveryLookup>;
  /**
   * Atomically creates or rejoins the deterministic channel-deliveries row,
   * after canonical schema and complete encoded-row-size validation.
   */
  ensure(obligation: ConversationOutwardDeliveryObligation): Promise<
    | Readonly<{ kind: 'created' | 'rejoined'; record: ConversationOutwardDeliveryRecord }>
    | Readonly<{ kind: 'retired' }>
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'invalid'; reason: 'invalidRow' | 'rowTooLarge' }>
    | Readonly<{
      kind: 'unavailable';
      reason: 'cancelled' | 'connectionUnavailable' | 'connectionCorrupt' | 'storageUnavailable';
    }>
  >;
  /** CASes custody only after the same complete encoded-row validation. */
  compareAndSwap(input: Readonly<{
    custodyId: string;
    expectedRevision: number;
    custody: ConversationDeliveryCustody;
  }>): Promise<
    | Readonly<{ kind: 'updated'; record: ConversationOutwardDeliveryRecord }>
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'invalid'; reason: 'invalidRow' | 'rowTooLarge' }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  >;
  /**
   * Atomically forgets each terminal row selected by the retention owner from
   * its exact live revision. A crash leaves remaining rows discoverable.
   */
  retireSelected(input: Readonly<{
    records: readonly Readonly<{
      custodyId: string;
      expectedRevision: number;
    }>[];
  }>): Promise<
    | Readonly<{ kind: 'retired' }>
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  >;
}

export type ConversationOutboundTextLimit = Readonly<ConversationOutboundTextLimitV1>;

export type ConversationOutwardDeliveryPreCustodyRejection =
  | 'invalidObligation'
  | 'invalidOutboundTextLimit';

function hasBoundedSourceId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && countConversationTextUnits(value, 'utf8Bytes') <= 256;
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value >= 1;
}

function hasConversationOutwardRouteAuthority(input: Readonly<{
  bindingId: string | undefined;
  routeAuthority: unknown;
}>): boolean {
  if (input.routeAuthority === null
    || typeof input.routeAuthority !== 'object'
    || Array.isArray(input.routeAuthority)) return false;
  const authority = input.routeAuthority as Readonly<Record<string, unknown>>;
  const keys = input.bindingId === undefined ? ['connectionAuthorityEpoch']
    : ['connectionAuthorityEpoch', 'bindingRevision', 'bindingAuthorityEpoch'];
  return Object.entries(authority).every(([key, value]) => keys.includes(key) && isPositiveSafeInteger(value));
}

export function isConversationOutwardSourceV1(source: unknown): source is ConversationOutwardSourceV1 {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  const sourceRecord = source as Readonly<Record<string, unknown>>;
  switch (sourceRecord.kind) {
    case 'conversationStart':
      return ConversationStartSourceV1Schema.safeParse(source).success;
    case 'sessionProjection':
      return hasExactKeys(sourceRecord, ['kind', 'sessionId', 'semanticItemId'])
        && hasBoundedSourceId(sourceRecord.sessionId)
        && hasBoundedSourceId(sourceRecord.semanticItemId);
    case 'discussionProjection':
      return hasExactKeys(sourceRecord, ['kind', 'discussionId', 'semanticItemId'])
        && hasBoundedSourceId(sourceRecord.discussionId)
        && hasBoundedSourceId(sourceRecord.semanticItemId);
    case 'automationResult':
      return AutomationResultDeliverySourceV1Schema.safeParse(source).success;
    case 'permissionWait':
      return hasExactKeys(sourceRecord, ['kind', 'sessionId', 'turnId', 'requestId'])
        && hasBoundedSourceId(sourceRecord.sessionId)
        && hasBoundedSourceId(sourceRecord.turnId)
        && hasBoundedSourceId(sourceRecord.requestId);
    case 'controlResponse':
      return hasExactKeys(sourceRecord, ['kind', 'controlId', 'controlKind'])
        && hasBoundedSourceId(sourceRecord.controlId)
        && typeof sourceRecord.controlKind === 'string'
        && CONVERSATION_CONTROL_RESPONSE_KINDS.has(
          sourceRecord.controlKind as ConversationControlResponseKind,
        );
    default:
      return false;
  }
}

export function validateConversationOutwardDeliveryBeforeCustody(input: Readonly<{
  obligation: ConversationOutwardDeliveryObligation;
  outboundTextLimit?: ConversationOutboundTextLimit;
}>): ConversationOutwardDeliveryPreCustodyRejection | null {
  const { obligation, outboundTextLimit } = input;
  if (!ConversationDeliveryContentV1Schema.safeParse(obligation.content).success
    || typeof obligation.deliveryKey !== 'string'
    || obligation.deliveryKey.length === 0
    || !isConversationOutwardSourceV1(obligation.source)
    || !ConversationConnectionIdV1Schema.safeParse(obligation.connectionId).success
    || (obligation.bindingId !== undefined
      && !ConversationBindingIdV1Schema.safeParse(obligation.bindingId).success)
    || !ConversationResolvedEndpointV1Schema.safeParse(obligation.endpoint).success
    || !hasConversationOutwardRouteAuthority({
      bindingId: obligation.bindingId,
      routeAuthority: obligation.routeAuthority,
    })
    || (obligation.replyContext !== undefined
      && !ConversationDeliveryReplyContextV1Schema.safeParse(obligation.replyContext).success)
    || countConversationTextUnits(obligation.deliveryKey, 'utf8Bytes')
      > MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES
    || (obligation.newThread !== undefined
      && !ConversationDeliveryNewThreadV1Schema.safeParse(obligation.newThread).success)
    || ((obligation.source.kind === 'conversationStart') !== (obligation.newThread !== undefined))
    || (obligation.newThread !== undefined && obligation.replyContext !== undefined)) {
    return 'invalidObligation';
  }
  if (outboundTextLimit !== undefined && !ConversationOutboundTextLimitV1Schema.safeParse(outboundTextLimit).success) {
    return 'invalidOutboundTextLimit';
  }
  return null;
}

type JsonRecord = Readonly<Record<string, JsonValue>>;
export type StoredCollectionRow = Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
}>;
export type ChannelStateCollection = Pick<
  PluginAccountCollectionForDefinition<ConversationCollectionsModule['CHANNEL_STATE_COLLECTION']>,
  'get'
>;
type ChannelDeliveriesCollection = Pick<
  PluginAccountCollectionForDefinition<ConversationCollectionsModule['CHANNEL_DELIVERIES_COLLECTION']>,
  'forget' | 'get' | 'put' | 'query'
>;

/**
 * The privacy-safe projection used by mounted management UI. It deliberately
 * keeps content, provider evidence, and delivery identity inside the Account
 * envelope, exposing CAS facts, the owning binding, and the parent required to
 * confirm a new thread. Connection-only custody has no owning binding.
 */
export type ConversationOutwardDeliveryResolutionRow = Readonly<{
  recommendedRecovery?: ConversationRecommendedRecoveryV1 | null;
  custodyId: string;
  bindingId?: string;
  revision: number;
  /** When the delivery was queued: with its conversation, how a person tells one undecided delivery from another. */
  createdAt: number;
  state: 'partial' | 'outcomeUnknown' | 'archiveRecoverable';
  /**
   * How many native parts the provider already accepted before the ambiguity. Only the count: the
   * provider's message IDs stay out of this projection like the content does.
   */
  acceptedPartCount: number;
  /** The zero-based native chunk that failed in a partial delivery. */
  failedChunk?: number;
  createdThreadEndpointRequired?: Readonly<{ parentId: string }>;
}>;

export type ConversationOutwardDeliveryResolutionPage = Readonly<{
  rows: readonly ConversationOutwardDeliveryResolutionRow[];
  nextCursor?: string;
}>;

export type ConversationOutwardDeliveryDetailResult =
  | Readonly<{ kind: 'notFound' }>
  | Readonly<{ kind: 'ready'; delivery: Readonly<{
    recommendedRecovery?: ConversationRecommendedRecoveryV1 | null;
    custodyId: string;
    revision: number;
    connectionId: string;
    bindingId?: string;
    state: ConversationDeliveryCustody['state'];
    reason?: ConversationDeliveryCustody['reason'];
    outcome?: ConversationDeliveryCustody['outcome'];
    projection: ReturnType<typeof deriveConversationDeliveryProjection>;
    lastOutcome: ReturnType<typeof deriveConversationDeliveryLastOutcome>;
    createdThreadEndpointRequired?: Readonly<{ parentId: string }>;
  }> }>;

function createdThreadEndpointRequirement(record: ConversationOutwardDeliveryRecord): Readonly<{
  createdThreadEndpointRequired?: Readonly<{ parentId: string }>;
}> {
  return record.obligation.newThread !== undefined && record.custody.endpoint === undefined
    ? { createdThreadEndpointRequired: { parentId: record.obligation.endpoint.id } }
    : {};
}

function resolutionError(code: string, message: string, retryable = false): PluginError {
  return new PluginError({ code, message, retryable });
}

function assertDeliveryResolutionCurrent(input: Readonly<{
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): void {
  input.assertCurrent?.();
  if (!input.signal?.aborted) return;
  throw resolutionError(
    // The Action may already have reached the Account collection.  Reuse the
    // host client's canonical ambiguity code so a mounted consumer rereads the
    // retained custody row instead of offering an unobserved retry.
    'aborted',
    'Delivery resolution was cancelled before its Account mutation completed.',
    true,
  );
}

function isDeliveryResolutionCustodyId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

/** Owner decisions settle ambiguity without invoking a provider. */
export type ConversationDeliveryResolutionDecision =
  | 'accepted'
  | 'discarded';

function isDeliveryResolution(value: unknown): value is ConversationDeliveryResolutionDecision {
  return value === 'accepted' || value === 'discarded';
}

function isPluginCollectionConflict(error: unknown): boolean {
  return error !== null
    && typeof error === 'object'
    && 'code' in error
    && error.code === 'plugin_collection_conflict';
}

/**
 * The one SDK-backed adapter for the already-declared `channelDeliveries`
 * Collection. It does not own currentness: the delivery authority re-reads
 * live connection/binding/runtime facts immediately before provider I/O.
 */
export type ConversationOutwardDeliveryCollectionStoreInput = Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  signal: AbortSignal;
  now?: () => number;
}>;

/** Read-only companion to the one custody store; it introduces no queue or row shape. */
export type ConversationOutwardDeliveryCollectionScannerInput = Readonly<{
  deliveriesCollection: ChannelDeliveriesCollection;
  signal: AbortSignal;
}>;

export interface ConversationOutwardDeliveryCollectionScanner {
  scan(input: Readonly<{
    now: number;
    limit: number;
    cursor?: string;
  }>): Promise<
    | Readonly<{
      kind: 'ready';
      records: readonly ConversationOutwardDeliveryRecord[];
      nextCursor?: string;
      nextRetryAt?: number;
    }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  >;
  scanRetention(input: Readonly<{
    cutoff: number;
    limit: number;
    cursor?: string;
  }>): Promise<
    | Readonly<{
      kind: 'ready';
      records: readonly ConversationOutwardDeliveryRecord[];
      nextCursor?: string;
      /**
       * The smallest terminal-entry `updatedAt` this page retained only
       * because it has not reached the cutoff yet. Its owner adds the
       * recovery window to learn the exact wall clock at which the page can
       * first reclaim anything, so an exhausted sweep does not have to walk
       * the whole terminal index again to discover that nothing changed.
       * Custody that never expires by time — unresolved ambiguity — is not a
       * candidate and deliberately contributes nothing.
       */
      earliestRetainedUpdatedAt?: number;
    }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  >;
}

/**
 * Read-only status projection for the existing custody rows. It has no
 * persistence or lifecycle authority: callers obtain a fresh snapshot through
 * the same parser that guards custody writes and recovery scans.
 */
export type ConversationOutwardDeliveryConnectionAttention = Readonly<{
  retryDue: boolean;
  notDelivered: boolean;
  partial: boolean;
  outcomeUnknown: boolean;
  /**
   * At least one retained delivery carries the provider's authoritative
   * archived-endpoint evidence with the owner-led recovery arm, so the present
   * user can unarchive the destination and retry the exact obligation.
   */
  archiveRecovery: boolean;
}>;

export type ConversationOutwardDeliveryConnectionAttentionReaderInput = Readonly<{
  deliveriesCollection: Pick<ChannelDeliveriesCollection, 'query'>;
  signal: AbortSignal;
  connectionIds: readonly string[];
}>;

export type ConversationOutwardDeliveryConnectionAttentionReadResult =
  | Readonly<{
    kind: 'ready';
    attentionByConnection: ReadonlyMap<string, ConversationOutwardDeliveryConnectionAttention>;
  }>
  | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>;

export type ConversationOutwardDeliveryTranscriptActivitiesReaderInput = Readonly<{
  deliveriesCollection: Pick<ChannelDeliveriesCollection, 'query'>;
  signal: AbortSignal;
  bindingTargets: readonly Readonly<{
    connectionId: string;
    bindingId: string;
  }>[];
}>;

export type ConversationOutwardDeliveryTranscriptActivitiesReadResult =
  | Readonly<{
    kind: 'ready';
    activities: readonly PluginTranscriptActivitySnapshotV1[];
  }>
  | Readonly<{ kind: 'invalid'; reason: 'invalidRow' }>
  | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>;

export type ConversationOutwardDeliveryLastDeliveriesReadResult =
  | Readonly<{ kind: 'ready'; lastDeliveries: readonly ConversationSessionLastDeliveryV1[] }>
  | Readonly<{ kind: 'invalid'; reason: 'invalidRow' }>
  | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>;

function compareCanonicalChannelRelationId(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceIdentityParts(source: ConversationOutwardSourceV1): readonly string[] {
  switch (source.kind) {
    case 'conversationStart':
      return [source.kind, source.sessionId, source.requestId];
    case 'sessionProjection':
      return [source.kind, source.sessionId, source.semanticItemId];
    case 'discussionProjection':
      return [source.kind, source.discussionId, source.semanticItemId];
    case 'automationResult':
      return [
        source.kind,
        source.automationRunId,
        source.resultId,
        source.automationId,
        source.resultDelivery,
      ];
    case 'permissionWait':
      return [source.kind, source.sessionId, source.turnId, source.requestId];
    case 'controlResponse':
      return [source.kind, source.controlId, source.controlKind];
  }
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return null;
  return tryDecodeBase64Url(value);
}

export async function deriveConversationOutwardDeliveryCustodyId(input: Readonly<{
  routingIdentityKey: string;
  obligation: ConversationOutwardDeliveryObligation;
}>): Promise<string | null> {
  const keyMaterial = decodeBase64Url(input.routingIdentityKey);
  const subtle = globalThis.crypto?.subtle;
  if (keyMaterial === null || subtle === undefined) return null;
  try {
    const key = await importHmacSha256Key(subtle, keyMaterial);
    return await signLengthPrefixedUtf8HmacSha256Base64Url({
      subtle,
      key,
      parts: [
        'channels:outward-delivery:v1',
        input.obligation.connectionId,
        input.obligation.bindingId === undefined ? 'connection' : 'binding',
        ...(input.obligation.bindingId === undefined ? [] : [input.obligation.bindingId]),
        ...sourceIdentityParts(input.obligation.source),
      ],
    });
  } catch {
    return null;
  }
}

export function hasRetainedConversationOutwardDeliveryContent(
  obligation: ConversationStoredOutwardDeliveryObligation,
): obligation is ConversationOutwardDeliveryObligation {
  return obligation.content !== null;
}

/** Immutable semantic identity already addressed by the deterministic custody ID. */
function sameConversationOutwardDeliveryCustodyIdentity(
  left: ConversationStoredOutwardDeliveryObligation,
  right: ConversationOutwardDeliveryObligation,
): boolean {
  return left.connectionId === right.connectionId
    && left.bindingId === right.bindingId
    && pluginJsonValuesEqual(left.source, right.source);
}

/** Mutable route and presentation facts remain exact until the effect is terminal. */
function sameConversationOutwardDeliveryLiveObligation(
  left: ConversationStoredOutwardDeliveryObligation,
  right: ConversationOutwardDeliveryObligation,
): boolean {
  return sameConversationOutwardDeliveryCustodyIdentity(left, right)
    && left.deliveryKey === right.deliveryKey
    && left.linkPreviewPolicy === right.linkPreviewPolicy
    && pluginJsonValuesEqual(left.endpoint, right.endpoint)
    && pluginJsonValuesEqual(left.replyContext ?? null, right.replyContext ?? null)
    && pluginJsonValuesEqual(left.newThread ?? null, right.newThread ?? null);
}

async function matchesConversationOutwardDeliveryObligation(input: Readonly<{
  stored: ConversationStoredOutwardDeliveryObligation;
  storedCustody: ConversationDeliveryCustody;
  incoming: ConversationOutwardDeliveryObligation;
}>): Promise<boolean> {
  const terminal = isConversationDeliveryAutomaticTerminal(input.storedCustody);
  if (terminal) return sameConversationOutwardDeliveryCustodyIdentity(input.stored, input.incoming);
  return sameConversationOutwardDeliveryLiveObligation(input.stored, input.incoming)
    && hasRetainedConversationOutwardDeliveryContent(input.stored)
    && pluginJsonValuesEqual(input.stored.content, input.incoming.content);
}

function readConversationDeliveryCustody(input: Readonly<{
  payload: JsonRecord;
  retryNotBefore: JsonValue | undefined;
}>): ConversationDeliveryCustody | null {
  const { payload: value } = input;
  const state = value.state;
  const attemptCount = value.attemptCount;
  const attemptId = value.attemptId;
  const providerMessageIds = value.providerMessageIds;
  const failedChunk = value.failedChunk;
  const archiveRecovery = value.archiveRecovery;
  const reason = value.reason;
  const outcome = value.outcome;
  const endpoint = value.deliveryEndpoint == null ? undefined : storedDeliveryEndpointSchema.safeParse(value.deliveryEndpoint);
  if (endpoint !== undefined && !endpoint.success) return null;
  if (value.threadBindingPending !== undefined && typeof value.threadBindingPending !== 'boolean') return null;
  if (typeof state !== 'string'
    || !(CONVERSATION_DELIVERY_CUSTODY_STATES as readonly string[]).includes(state)
    || typeof attemptCount !== 'number'
    || !Number.isSafeInteger(attemptCount)
    || attemptCount < 0
    || !Array.isArray(providerMessageIds)
    || !providerMessageIds.every((id) => typeof id === 'string')
    || (attemptId !== null && typeof attemptId !== 'string')
    || (failedChunk !== null && !isNonNegativeSafeInteger(failedChunk))
    || (archiveRecovery !== null && typeof archiveRecovery !== 'string')
    || (state === 'notSent' && reason !== 'providerRefused' && reason !== 'policySuppressed'
      && reason !== 'connectionDeleted' && reason !== 'ownerMustUnarchiveOrRebind')
    || (state === 'resolved' && outcome !== 'accepted' && outcome !== 'discarded')) {
    return null;
  }
  const retryNotBefore = input.retryNotBefore;
  if (retryNotBefore !== undefined && !isNonNegativeSafeInteger(retryNotBefore)) return null;
  return {
    state,
    ...(state === 'notSent' ? { reason } : {}),
    ...(state === 'resolved' ? { outcome } : {}),
    attemptCount,
    providerMessageIds,
    ...(attemptId === null ? {} : { attemptId }),
    ...(failedChunk === null ? {} : { failedChunk }),
    ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
    ...(archiveRecovery === null ? {} : { archiveRecovery }),
    ...(endpoint === undefined || !endpoint.success ? {} : { endpoint: endpoint.data }),
    ...(value.threadBindingPending === undefined ? {} : { threadBindingPending: value.threadBindingPending }),
  } as ConversationDeliveryCustody;
}

function readConversationOutwardDeliveryRecord(input: Readonly<{
  collections: ConversationCollectionsModule;
  row: StoredCollectionRow;
}>): ConversationOutwardDeliveryRecord | null {
  const { collections, row } = input;
  if (!isJsonRecord(row.value)
    || row.value[collections.CHANNEL_DELIVERIES_FIELD.id] !== row.rowId
    || row.value[collections.CHANNEL_DELIVERIES_FIELD.recordKind]
      !== collections.CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery
    || !ConversationConnectionIdV1Schema.safeParse(
      row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId],
    ).success
    || (row.value[collections.CHANNEL_DELIVERIES_FIELD.bindingId] !== undefined
      && !ConversationBindingIdV1Schema.safeParse(
        row.value[collections.CHANNEL_DELIVERIES_FIELD.bindingId],
      ).success)
    || !isJsonRecord(row.value.payload)) {
    return null;
  }
  const createdAt = row.value[collections.CHANNEL_DELIVERIES_FIELD.createdAt];
  const updatedAt = row.value[collections.CHANNEL_DELIVERIES_FIELD.updatedAt];
  if (!isNonNegativeSafeInteger(createdAt) || !isNonNegativeSafeInteger(updatedAt)) return null;
  const payload = row.value.payload;
  const parsedStartSource = isJsonRecord(payload.source) && payload.source.kind === 'conversationStart'
    ? storedStartSourceSchema.safeParse(payload.source) : undefined;
  const source = parsedStartSource?.success ? parsedStartSource.data : payload.source;
  const bindingId = row.value[collections.CHANNEL_DELIVERIES_FIELD.bindingId];
  const content = payload.content;
  const parsedContent = content === null ? undefined : storedDeliveryContentSchema.safeParse(content);
  const newThread = payload.newThread === undefined ? undefined : storedDeliveryNewThreadSchema.safeParse(payload.newThread);
  const contentFingerprint = payload.contentFingerprint;
  if (!isConversationOutwardSourceV1(source)
    || (parsedContent !== undefined && !parsedContent.success)
    || (newThread !== undefined && !newThread.success)
    || (content !== null && contentFingerprint !== undefined && contentFingerprint !== null)
    || typeof payload.deliveryKey !== 'string'
    || typeof payload.linkPreviewPolicy !== 'string'
    || !hasConversationOutwardRouteAuthority({
      bindingId: typeof bindingId === 'string' ? bindingId : undefined,
      routeAuthority: payload.routeAuthority,
    })) return null;
  const endpoint = ConversationResolvedEndpointV1Schema.safeParse(payload.endpoint);
  const replyContext = payload.replyContext === null
    ? { success: true as const, data: undefined }
    : ConversationDeliveryReplyContextV1Schema.safeParse(payload.replyContext);
  if (!endpoint.success || !replyContext.success) return null;
  const custody = readConversationDeliveryCustody({
    payload,
    retryNotBefore: row.value[collections.CHANNEL_DELIVERIES_FIELD.retryNotBefore],
  });
  if (custody === null) return null;
  if ((source.kind === 'conversationStart') !== (newThread?.success === true)
    || (source.kind === 'conversationStart' && bindingId === undefined)
    || (source.kind !== 'conversationStart' && custody.threadBindingPending !== undefined)) return null;
  const projection = deriveConversationDeliveryProjection(custody);
  const storedAttention = row.value[collections.CHANNEL_DELIVERIES_FIELD.attention];
  if (row.value[collections.CHANNEL_DELIVERIES_FIELD.terminal] !== projection.terminal
    || (storedAttention !== projection.attention && custody.state !== 'retryDue')
    || row.value[collections.CHANNEL_DELIVERIES_FIELD.retryNotBefore] !== projection.retryNotBefore) {
    return null;
  }
  if (content === null) {
    if (
      (contentFingerprint !== undefined && contentFingerprint !== null
        && (typeof contentFingerprint !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(contentFingerprint)))
      || !isConversationDeliveryContentFree(custody)
    ) return null;
    const obligation: ConversationStoredOutwardDeliveryObligation = bindingId === undefined
      ? {
        connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
        routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryConnectionRouteAuthority,
        source,
        endpoint: endpoint.data,
        content: null,
        ...(newThread?.success ? { newThread: newThread.data } : {}),
        deliveryKey: payload.deliveryKey,
        ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),

        linkPreviewPolicy: payload.linkPreviewPolicy as ConversationDeliveryLinkPreviewPolicyV1,
      }
      : {
        connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
        bindingId: bindingId as string,
        routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryBindingRouteAuthority,
        source,
        endpoint: endpoint.data,
        content: null,
        ...(newThread?.success ? { newThread: newThread.data } : {}),
        deliveryKey: payload.deliveryKey,
        ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),

        linkPreviewPolicy: payload.linkPreviewPolicy as ConversationDeliveryLinkPreviewPolicyV1,
      };
    return {
      custodyId: row.rowId,
      revision: row.revision,
      createdAt,
      obligation,
      custody,
    };
  }
  if (parsedContent === undefined || !parsedContent.success) return null;
  const obligation: ConversationStoredOutwardDeliveryObligation = bindingId === undefined
    ? {
      connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
      routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryConnectionRouteAuthority,
      source,
      endpoint: endpoint.data,
      content: parsedContent.data,
      ...(newThread?.success ? { newThread: newThread.data } : {}),
      deliveryKey: payload.deliveryKey,
      ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),

      linkPreviewPolicy: payload.linkPreviewPolicy as ConversationDeliveryLinkPreviewPolicyV1,
    }
    : {
      connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
      bindingId: bindingId as string,
      routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryBindingRouteAuthority,
      source,
      endpoint: endpoint.data,
      content: parsedContent.data,
      ...(newThread?.success ? { newThread: newThread.data } : {}),
      deliveryKey: payload.deliveryKey,
      ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),

      linkPreviewPolicy: payload.linkPreviewPolicy as ConversationDeliveryLinkPreviewPolicyV1,
    };
  return {
    custodyId: row.rowId,
    revision: row.revision,
    createdAt,
    obligation,
    custody,
  };
}

function serializeConversationOutwardDeliveryRecord(input: Readonly<{
  collections: ConversationCollectionsModule;
  custodyId: string;
  obligation: ConversationStoredOutwardDeliveryObligation;
  custody: ConversationDeliveryCustody;
  createdAt: number;
  updatedAt: number;
}>): JsonRecord {
  const { collections } = input;
  const projection = deriveConversationDeliveryProjection(input.custody);
  return {
    [collections.CHANNEL_DELIVERIES_FIELD.id]: input.custodyId,
    [collections.CHANNEL_DELIVERIES_FIELD.recordKind]: collections.CHANNEL_DELIVERIES_RECORD_KIND.outwardDelivery,
    [collections.CHANNEL_DELIVERIES_FIELD.version]: 1,
    [collections.CHANNEL_DELIVERIES_FIELD.connectionId]: input.obligation.connectionId,
    ...(input.obligation.bindingId === undefined
      ? {}
      : { [collections.CHANNEL_DELIVERIES_FIELD.bindingId]: input.obligation.bindingId }),
    [collections.CHANNEL_DELIVERIES_FIELD.terminal]: projection.terminal,
    [collections.CHANNEL_DELIVERIES_FIELD.attention]: projection.attention,
    ...(projection.retryNotBefore === undefined
      ? {}
      : { [collections.CHANNEL_DELIVERIES_FIELD.retryNotBefore]: projection.retryNotBefore }),
    [collections.CHANNEL_DELIVERIES_FIELD.createdAt]: input.createdAt,
    [collections.CHANNEL_DELIVERIES_FIELD.updatedAt]: input.updatedAt,
    payload: {
      source: input.obligation.source,
      routeAuthority: input.obligation.routeAuthority,
      endpoint: input.obligation.endpoint,
      content: input.obligation.content,
      ...(input.obligation.newThread === undefined ? {} : { newThread: input.obligation.newThread }),
      deliveryKey: input.obligation.deliveryKey,
      replyContext: input.obligation.replyContext ?? null,

      linkPreviewPolicy: input.obligation.linkPreviewPolicy,
      state: input.custody.state,
      ...(input.custody.reason === undefined ? {} : { reason: input.custody.reason }),
      ...(input.custody.outcome === undefined ? {} : { outcome: input.custody.outcome }),
      attemptCount: input.custody.attemptCount,
      attemptId: input.custody.attemptId ?? null,
      providerMessageIds: input.custody.providerMessageIds,
      failedChunk: input.custody.failedChunk ?? null,
      archiveRecovery: input.custody.archiveRecovery ?? null,
      ...(input.custody.endpoint === undefined ? {} : { deliveryEndpoint: input.custody.endpoint }),
      ...(input.custody.threadBindingPending === undefined ? {} : { threadBindingPending: input.custody.threadBindingPending }),
    },
  };
}

/**
 * Reads one bounded page from the connection/attention index. This is not
 * an attention Resource or a second projection: every row is revalidated by
 * the same strict parser that guards custody writes before its minimal UI
 * representation is returned.
 */
export async function readConversationOutwardDeliveryResolutionPage(input: Readonly<{
  deliveriesCollection: Pick<ChannelDeliveriesCollection, 'query'>;
  connectionId: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<ConversationOutwardDeliveryResolutionPage> {
  if (!ConversationConnectionIdV1Schema.safeParse(input.connectionId).success) {
    throw resolutionError(
      'channels_delivery_resolution_page_input_invalid',
      'Delivery resolution page requires a canonical connection identity.',
    );
  }
  const limit = Math.min(input.limit ?? PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw resolutionError(
      'channels_delivery_resolution_page_input_invalid',
      'Delivery resolution page has an invalid bound.',
    );
  }
  assertDeliveryResolutionCurrent(input);
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    throw resolutionError(
      'channels_delivery_resolution_page_unavailable',
      'Delivery resolution details are temporarily unavailable.',
      true,
    );
  }
  assertDeliveryResolutionCurrent(input);

  let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
  try {
    page = await input.deliveriesCollection.query({
      index: collections.CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention,
      prefix: [input.connectionId],
      // The declared index orders [connection, attention, binding, id], so the
      // range applies to the next component after the connection prefix and
      // selects unresolved rows across every binding. The strict custody
      // parser and actionable-state filter below stay the exactness owners.
      range: { lower: true, upper: true },
      order: 'asc',
      limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, input.signal === undefined ? undefined : { signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) {
      assertDeliveryResolutionCurrent(input);
    }
    throw resolutionError(
      'channels_delivery_resolution_page_unavailable',
      'Delivery resolution details are temporarily unavailable.',
      true,
    );
  }
  assertDeliveryResolutionCurrent(input);

  const rows: ConversationOutwardDeliveryResolutionRow[] = [];
  for (const row of page.rows) {
    const record = readConversationOutwardDeliveryRecord({
      collections,
      row: row as unknown as StoredCollectionRow,
    });
    if (record === null || record.obligation.connectionId !== input.connectionId) {
      throw resolutionError(
        'channels_delivery_resolution_page_foreign',
        'Delivery resolution details did not match the current Account connection.',
      );
    }
    const state = record.custody.state === 'partial' || record.custody.state === 'outcomeUnknown'
      ? record.custody.state
      : isConversationDeliveryArchiveRecoverable(record.custody)
        ? 'archiveRecoverable' as const
        : undefined;
    if (state === undefined) continue;
    rows.push({
      custodyId: record.custodyId,
      ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
      revision: record.revision,
      createdAt: record.createdAt,
      state,
      acceptedPartCount: record.custody.providerMessageIds.length,
      ...(record.custody.failedChunk === undefined ? {} : { failedChunk: record.custody.failedChunk }),
      ...createdThreadEndpointRequirement(record),
      recommendedRecovery: recommendConversationDeliveryRecovery({ custodyId: record.custodyId, revision: record.revision, state }),
    });
  }
  return {
    rows,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}

/** Reads current delivery status and recovery facts through the same custody parser. */
export async function readConversationOutwardDeliveryDetail(input: Readonly<{
  deliveriesCollection: Pick<ChannelDeliveriesCollection, 'get'>;
  custodyId: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>): Promise<ConversationOutwardDeliveryDetailResult> {
  assertDeliveryResolutionCurrent(input);
  let collections: ConversationCollectionsModule;
  let row: StoredCollectionRow | null;
  try {
    collections = await loadConversationCollectionsModule();
    assertDeliveryResolutionCurrent(input);
    row = await input.deliveriesCollection.get(input.custodyId,
      input.signal === undefined ? undefined : { signal: input.signal }) as unknown as StoredCollectionRow | null;
  } catch {
    assertDeliveryResolutionCurrent(input);
    throw resolutionError('channels_delivery_read_unavailable', 'Delivery details are temporarily unavailable.', true);
  }
  assertDeliveryResolutionCurrent(input);
  if (row === null) return { kind: 'notFound' };
  const record = readConversationOutwardDeliveryRecord({ collections, row });
  if (record === null || record.custodyId !== input.custodyId) {
    throw resolutionError('channels_delivery_read_foreign', 'Delivery details did not match the current Account custody.');
  }
  const recommendedRecovery = recommendConversationDeliveryRecovery({ custodyId: record.custodyId, revision: record.revision,
    state: isConversationDeliveryArchiveRecoverable(record.custody) ? 'archiveRecoverable' : record.custody.state });
  return { kind: 'ready', delivery: {
    custodyId: record.custodyId,
    revision: record.revision,
    connectionId: record.obligation.connectionId,
    ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
    state: record.custody.state,
    ...(record.custody.reason === undefined ? {} : { reason: record.custody.reason }),
    ...(record.custody.outcome === undefined ? {} : { outcome: record.custody.outcome }),
    projection: deriveConversationDeliveryProjection(record.custody),
    lastOutcome: deriveConversationDeliveryLastOutcome(record.custody),
    ...createdThreadEndpointRequirement(record),
    ...(recommendedRecovery === null ? {} : { recommendedRecovery }),
  } };
}

/**
 * The sole direct persistence path for a present-user delivery decision. It
 * has no provider call, retry branch, or alternate custody representation:
 * the existing row is reread, parsed, transitioned by the custody owner, and
 * written under its exact revision.
 */
export async function resolveConversationOutwardDeliveryCustodyInAccountCollection(input: Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: Pick<ChannelDeliveriesCollection, 'get' | 'put'>;
  custodyId: string;
  expectedRevision: number;
  resolution: ConversationDeliveryResolutionDecision;
  endpoint?: ConversationResolvedEndpointV1;
  signal?: AbortSignal;
  assertCurrent?: () => void;
  assertExecutionPlacement?: (connectionId: string) => Promise<void>;
  now?: () => number;
}>): Promise<Readonly<{
  kind: 'resolved';
  custodyId: string;
  revision: number;
  resolution: ConversationDeliveryResolutionDecision;
}>> {
  if (!isDeliveryResolutionCustodyId(input.custodyId)
    || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1
    || !isDeliveryResolution(input.resolution)) {
    throw resolutionError(
      'channels_delivery_resolve_input_invalid',
      'Delivery resolution input was not admitted by its strict contract.',
    );
  }
  assertDeliveryResolutionCurrent(input);
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    throw resolutionError(
      'channels_delivery_resolve_unavailable',
      'Delivery resolution is temporarily unavailable.',
      true,
    );
  }
  assertDeliveryResolutionCurrent(input);

  let row: StoredCollectionRow | null;
  try {
    row = await input.deliveriesCollection.get(
      input.custodyId,
      input.signal === undefined ? undefined : { signal: input.signal },
    ) as unknown as StoredCollectionRow | null;
  } catch {
    if (input.signal?.aborted) {
      assertDeliveryResolutionCurrent(input);
    }
    throw resolutionError(
      'channels_delivery_resolve_unavailable',
      'Delivery resolution is temporarily unavailable.',
      true,
    );
  }
  assertDeliveryResolutionCurrent(input);
  if (row === null) {
    throw resolutionError(
      'channels_delivery_resolve_not_found',
      'Delivery resolution target does not exist.',
    );
  }
  if (row.revision !== input.expectedRevision) {
    throw resolutionError(
      'channels_delivery_resolve_conflict',
      'Delivery resolution requires the current retained custody revision.',
      true,
    );
  }

  const record = readConversationOutwardDeliveryRecord({ collections, row });
  if (record === null || record.custodyId !== input.custodyId) {
    throw resolutionError(
      'channels_delivery_resolve_foreign',
      'Delivery resolution target is not canonical outward custody.',
    );
  }
  await input.assertExecutionPlacement?.(record.obligation.connectionId);
  assertDeliveryResolutionCurrent(input);
  if (record.obligation.newThread !== undefined && input.resolution === 'accepted') {
    const endpoint = input.endpoint ?? record.custody.endpoint;
    if (endpoint === undefined || endpoint.kind !== 'thread' || endpoint.parentId !== record.obligation.endpoint.id
      || (record.custody.endpoint !== undefined && input.endpoint !== undefined
        && !areConversationEndpointIdentitiesEqual(record.custody.endpoint, input.endpoint))) {
      throw resolutionError('channels_delivery_resolve_endpoint_required', 'Accepting a started conversation requires its created thread endpoint.');
    }
  } else if (input.endpoint !== undefined) {
    throw resolutionError('channels_delivery_resolve_endpoint_invalid', 'Only a started conversation acceptance can supply a created endpoint.');
  }
  const transition = resolveConversationDeliveryCustody({
      custody: record.custody,
      resolution: input.resolution,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    });
  if (transition.kind !== 'resolved') {
    throw resolutionError(
      'channels_delivery_resolve_not_resolvable',
      'Delivery resolution requires a partial or unknown custody state.',
    );
  }

  const obligation = compactConversationOutwardDeliveryObligation({
    obligation: record.obligation,
    custody: transition.custody,
  });

  const value = serializeConversationOutwardDeliveryRecord({
    collections,
    custodyId: record.custodyId,
    obligation,
    custody: transition.custody,
    createdAt: record.createdAt,
    updatedAt: (input.now ?? Date.now)(),
  });
  assertDeliveryResolutionCurrent(input);
  let persisted: StoredCollectionRow;
  try {
    persisted = await input.deliveriesCollection.put(value as never, {
      expectedRevision: record.revision,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }) as unknown as StoredCollectionRow;
  } catch (error) {
    if (input.signal?.aborted) {
      assertDeliveryResolutionCurrent(input);
    }
    const errorCode = (error as Readonly<{ code?: unknown }> | null)?.code;
    if (typeof errorCode !== 'string'
      || (!errorCode.startsWith('collection_')
        && errorCode !== 'plugin_collection_conflict'
        && errorCode !== 'plugin_collection_invalid_value'
        && errorCode !== 'plugin_collection_undeclared')) {
      throw resolutionError(
        // The Account mutation may have committed before its response or
        // current-generation proof was lost. Keep the present-user decision
        // locked until the retained row is read directly again.
        'aborted',
        'Delivery resolution could not confirm its Account mutation outcome.',
        true,
      );
    }
    throw resolutionError(
      'channels_delivery_resolve_conflict',
      'Delivery resolution lost its retained-row compare-and-swap.',
      true,
    );
  }
  assertDeliveryResolutionCurrent(input);
  if (persisted.rowId !== input.custodyId || persisted.revision <= record.revision) {
    throw resolutionError(
      'channels_delivery_resolve_result_invalid',
      'Delivery resolution did not return its retained custody result.',
      true,
    );
  }
  return {
    kind: 'resolved',
    custodyId: input.custodyId,
    revision: persisted.revision,
    resolution: input.resolution,
  };
}

/**
 * Constructs the only Collection-backed custody store. Logical source identity
 * is HMAC-addressed with the private connection routing key; raw source and
 * destination facts remain exclusively in the Collection envelope.
 */
export function createConversationOutwardDeliveryCollectionStore(
  input: ConversationOutwardDeliveryCollectionStoreInput,
): ConversationOutwardDeliveryStore {
  const now = input.now ?? Date.now;
  const readDelivery = async (readInput: Readonly<{
    collections: ConversationCollectionsModule;
    custodyId: string;
    signal: AbortSignal | undefined;
  }>): Promise<
    | Readonly<{ kind: 'found'; record: ConversationOutwardDeliveryRecord; updatedAt: number }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  > => {
    if (readInput.signal?.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    try {
      const row = await input.deliveriesCollection.get(readInput.custodyId, { signal: readInput.signal });
      if (row === null) return { kind: 'missing' };
      const record = readConversationOutwardDeliveryRecord({
        collections: readInput.collections,
        row: row as unknown as StoredCollectionRow,
      });
      const storedRow = row as unknown as StoredCollectionRow;
      const updatedAt = isJsonRecord(storedRow.value)
        ? storedRow.value[readInput.collections.CHANNEL_DELIVERIES_FIELD.updatedAt]
        : undefined;
      return record === null || !isNonNegativeSafeInteger(updatedAt)
        ? { kind: 'invalid' }
        : { kind: 'found', record, updatedAt };
    } catch {
      return {
        kind: 'unavailable',
        reason: readInput.signal?.aborted ? 'cancelled' : 'storageUnavailable',
      };
    }
  };

  /** Creation facts a live connection still supplies for an absent obligation. */
  type ExistingCustodyCreation = Readonly<{
    collections: ConversationCollectionsModule;
    custodyId: string;
  }>;

  /**
   * Connection deletion physically removes the row that carried the routing
   * identity key, so the deterministic custody id can no longer be derived.
   * Deletion settles every non-terminal custody row first — attempting,
   * partial, and unknown custody block the finalizer — so whatever remains is
   * terminal evidence whose connection/binding/source identity is intact.
   * This walks the same owner-attention index the deletion finalizer walks
   * and resolves the exact existing custody without a live connection; only
   * creating an absent delivery still requires one.
   */
  const resolveExistingWithoutLiveConnection = async (
    obligation: ConversationOutwardDeliveryObligation,
    collections: ConversationCollectionsModule,
  ): Promise<
    | Exclude<ConversationOutwardDeliveryLookup, Readonly<{ kind: 'absent' }>>
    | Readonly<{ kind: 'absent' }>
  > => {
    let cursor: string | undefined;
    do {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
      try {
        page = await input.deliveriesCollection.query({
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
          prefix: [obligation.connectionId],
          order: 'asc',
          limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
          ...(cursor === undefined ? {} : { cursor }),
        }, { signal: input.signal });
      } catch {
        return {
          kind: 'unavailable',
          reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
        };
      }
      for (const row of page.rows) {
        const record = readConversationOutwardDeliveryRecord({
          collections,
          row: row as unknown as StoredCollectionRow,
        });
        // The deletion finalizer refuses to remove a connection whose scoped
        // custody rows are unreadable, so an unreadable row here is corrupt
        // durable state and fails closed like every other identity read.
        if (record === null) return { kind: 'unavailable', reason: 'connectionCorrupt' };
        if (!sameConversationOutwardDeliveryCustodyIdentity(record.obligation, obligation)) continue;
        return await matchesConversationOutwardDeliveryObligation({
          stored: record.obligation,
          storedCustody: record.custody,
          incoming: obligation,
        })
          ? { kind: 'rejoined', record }
          : { kind: 'conflict' };
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return { kind: 'absent' };
  };

  /**
   * The one deterministic-identity resolver shared by read-only lookup and
   * create-or-rejoin admission, so the two can never disagree about which row
   * an obligation addresses or whether it matches.
   */
  const resolveExisting = async (
    obligation: ConversationOutwardDeliveryObligation,
  ): Promise<
    | Exclude<ConversationOutwardDeliveryLookup, Readonly<{ kind: 'absent' }>>
    | Readonly<{ kind: 'absent'; creation?: ExistingCustodyCreation }>
  > => {
    if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    let collections: ConversationCollectionsModule;
    try {
      collections = await loadConversationCollectionsModule();
    } catch {
      return { kind: 'unavailable', reason: 'storageUnavailable' };
    }
    let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
    try {
      accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
    } catch {
      return { kind: 'unavailable', reason: 'storageUnavailable' };
    }
    if (!isConversationOutwardSourceV1(obligation.source)
      || !ConversationConnectionIdV1Schema.safeParse(obligation.connectionId).success
      || (obligation.bindingId !== undefined
        && !ConversationBindingIdV1Schema.safeParse(obligation.bindingId).success)
      || !hasConversationOutwardRouteAuthority({
        bindingId: obligation.bindingId,
        routeAuthority: obligation.routeAuthority,
      })) {
      return { kind: 'invalid', reason: 'invalidRow' };
    }
    let connection: StoredCollectionRow | null;
    try {
      connection = await input.stateCollection.get(
        obligation.connectionId,
        { signal: input.signal },
      ) as unknown as StoredCollectionRow | null;
    } catch {
      return {
        kind: 'unavailable',
        reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
      };
    }
    if (connection === null) {
      return await resolveExistingWithoutLiveConnection(obligation, collections);
    }
    const connectionFacts = readConnectionFacts({
      accountLocalBindingPolicy,
      row: connection,
      connectionId: obligation.connectionId,
    });
    if (connectionFacts === null) return { kind: 'unavailable', reason: 'connectionCorrupt' };
    const custodyId = await deriveConversationOutwardDeliveryCustodyId({
      routingIdentityKey: connectionFacts.routingIdentityKey,
      obligation,
    });
    if (custodyId === null) return { kind: 'unavailable', reason: 'connectionCorrupt' };
    const existing = await readDelivery({ collections, custodyId, signal: input.signal });
    if (existing.kind === 'unavailable') return existing;
    if (existing.kind === 'invalid') return { kind: 'invalid', reason: 'invalidRow' };
    if (existing.kind === 'found') {
      return await matchesConversationOutwardDeliveryObligation({
        stored: existing.record.obligation,
        storedCustody: existing.record.custody,
        incoming: obligation,
      })
        ? { kind: 'rejoined', record: existing.record }
        : { kind: 'conflict' };
    }
    return {
      kind: 'absent',
      creation: {
        collections,
        custodyId,
      },
    };
  };

  return {
    async lookup(obligation) {
      const existing = await resolveExisting(obligation);
      return existing.kind === 'absent' ? { kind: 'absent' } : existing;
    },
    async ensure(obligation) {
      const resolved = await resolveExisting(obligation);
      if (resolved.kind !== 'absent') return resolved;
      const creation = resolved.creation;
      if (creation === undefined) {
        // The live connection is gone, so there is neither a route to admit a
        // new delivery against nor an identity key to mint its custody id
        // from. Creating an absent delivery still requires the live
        // connection; only the exact-custody rejoin resolves without it.
        return { kind: 'unavailable', reason: 'connectionUnavailable' };
      }
      const { collections, custodyId } = creation;

      const createdAt = now();
      const value = serializeConversationOutwardDeliveryRecord({
        collections,
        custodyId,
        obligation,
        custody: { ...createReadyConversationDeliveryCustody(),
          ...(obligation.newThread === undefined ? {} : { threadBindingPending: true }),
        },
        createdAt,
        updatedAt: createdAt,
      });
      try {
        const row = await input.deliveriesCollection.put(value as never, {
          expectedRevision: 'absent',
          signal: input.signal,
        });
        const record = readConversationOutwardDeliveryRecord({
          collections,
          row: row as unknown as StoredCollectionRow,
        });
        return record === null
          ? { kind: 'invalid', reason: 'invalidRow' }
          : { kind: 'created', record };
      } catch (error) {
        const conflicted = isPluginCollectionConflict(error);
        const rejoined = await readDelivery({ collections, custodyId, signal: input.signal });
        if (rejoined.kind === 'unavailable') return rejoined;
        if (rejoined.kind === 'invalid') return { kind: 'invalid', reason: 'invalidRow' };
        if (rejoined.kind === 'missing') {
          if (conflicted && !input.signal.aborted) return { kind: 'retired' };
          return {
            kind: 'unavailable',
            reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
          };
        }
        return await matchesConversationOutwardDeliveryObligation({
          stored: rejoined.record.obligation,
          storedCustody: rejoined.record.custody,
          incoming: obligation,
        })
          ? { kind: 'rejoined', record: rejoined.record }
          : { kind: 'conflict' };
      }
    },
    async compareAndSwap(cas) {
      let collections: ConversationCollectionsModule;
      try {
        collections = await loadConversationCollectionsModule();
      } catch {
        return { kind: 'unavailable', reason: 'storageUnavailable' };
      }
      // Local provider cancellation must not strand claim release/settlement.
      // The Collection's bound host lifetime still governs these writes.
      const existing = await readDelivery({ collections, custodyId: cas.custodyId, signal: undefined });
      if (existing.kind === 'unavailable') return existing;
      if (existing.kind === 'invalid') return { kind: 'invalid', reason: 'invalidRow' };
      if (existing.kind === 'missing' || existing.record.revision !== cas.expectedRevision) {
        return { kind: 'conflict' };
      }
      const obligation = compactConversationOutwardDeliveryObligation({
        obligation: existing.record.obligation,
        custody: cas.custody,
      });
      const value = serializeConversationOutwardDeliveryRecord({
        collections,
        custodyId: existing.record.custodyId,
        obligation,
        custody: cas.custody,
        createdAt: existing.record.createdAt,
        updatedAt: isConversationDeliveryRetentionEligible(existing.record.custody)
          && isConversationDeliveryRetentionEligible(cas.custody)
          ? existing.updatedAt
          : now(),
      });
      try {
        const row = await input.deliveriesCollection.put(value as never, {
          expectedRevision: cas.expectedRevision,
        });
        const record = readConversationOutwardDeliveryRecord({
          collections,
          row: row as unknown as StoredCollectionRow,
        });
        return record === null
          ? { kind: 'invalid', reason: 'invalidRow' }
          : { kind: 'updated', record };
      } catch {
        return { kind: 'conflict' };
      }
    },
    async retireSelected(retireInput) {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      try {
        for (const selected of retireInput.records) {
          await input.deliveriesCollection.forget(selected.custodyId, {
            expectedRevision: selected.expectedRevision,
            signal: input.signal,
          });
        }
        return { kind: 'retired' };
      } catch (error) {
        if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
        return isPluginCollectionConflict(error)
          ? { kind: 'conflict' }
          : { kind: 'unavailable', reason: 'storageUnavailable' };
      }
    },
  };
}

/**
 * Enumerates only durable work from the existing `byRetryDue` projection. It
 * parses rows through the exact custody parser above, skips corrupt/terminal or
 * not-yet-due rows, and hands its opaque keyset cursor to the generation-owned
 * supervisor. It is deliberately not another delivery queue or registry.
 */
export function createConversationOutwardDeliveryCollectionScanner(
  input: ConversationOutwardDeliveryCollectionScannerInput,
): ConversationOutwardDeliveryCollectionScanner {
  return {
    async scan(scanInput) {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      if (!Number.isSafeInteger(scanInput.now)
        || !Number.isSafeInteger(scanInput.limit)
        || scanInput.limit < 1) {
        return { kind: 'ready', records: [] };
      }
      let collections: ConversationCollectionsModule;
      try {
        collections = await loadConversationCollectionsModule();
      } catch {
        return { kind: 'unavailable', reason: 'storageUnavailable' };
      }
      try {
        const page = await input.deliveriesCollection.query({
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byRetryDue,
          prefix: [false],
          order: 'asc',
          limit: scanInput.limit,
          ...(scanInput.cursor === undefined ? {} : { cursor: scanInput.cursor }),
        }, { signal: input.signal });
        const records: ConversationOutwardDeliveryRecord[] = [];
        let nextRetryAt: number | undefined;
        for (const row of page.rows) {
          const record = readConversationOutwardDeliveryRecord({
            collections,
            row: row as unknown as StoredCollectionRow,
          });
          if (record === null) continue;
          if (record.custody.state === 'ready' || record.custody.state === 'attempting' || hasPendingConversationThreadBinding(record.custody)) {
            records.push(record);
            continue;
          }
          if (record.custody.state === 'retryDue'
            && (record.custody.retryNotBefore === undefined || record.custody.retryNotBefore <= scanInput.now)) {
            records.push(record);
          } else if (record.custody.state === 'retryDue' && record.custody.retryNotBefore !== undefined) {
            nextRetryAt = Math.min(nextRetryAt ?? Infinity, record.custody.retryNotBefore);
          }
        }
        return {
          kind: 'ready',
          records,
          ...(nextRetryAt === undefined ? {} : { nextRetryAt }),
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      } catch (error) {
        if (isPluginError(error)) throw error;
        return {
          kind: 'unavailable',
          reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
        };
      }
    },
    async scanRetention(scanInput) {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      if (!Number.isSafeInteger(scanInput.cutoff)
        || scanInput.cutoff < 0
        || !Number.isSafeInteger(scanInput.limit)
        || scanInput.limit < 1) {
        return { kind: 'ready', records: [] };
      }
      let collections: ConversationCollectionsModule;
      try {
        collections = await loadConversationCollectionsModule();
      } catch {
        return { kind: 'unavailable', reason: 'storageUnavailable' };
      }
      try {
        const page = await input.deliveriesCollection.query({
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byRetryDue,
          prefix: [true],
          order: 'asc',
          limit: scanInput.limit,
          ...(scanInput.cursor === undefined ? {} : { cursor: scanInput.cursor }),
        }, { signal: input.signal });
        const records: ConversationOutwardDeliveryRecord[] = [];
        let earliestRetainedUpdatedAt: number | undefined;
        for (const row of page.rows) {
          const storedRow = row as unknown as StoredCollectionRow;
          const updatedAt = isJsonRecord(storedRow.value)
            ? storedRow.value[collections.CHANNEL_DELIVERIES_FIELD.updatedAt]
            : undefined;
          if (!isNonNegativeSafeInteger(updatedAt)) continue;
          const record = readConversationOutwardDeliveryRecord({ collections, row: storedRow });
          if (record === null || !isConversationDeliveryRetentionEligible(record.custody)) continue;
          if (updatedAt > scanInput.cutoff) {
            earliestRetainedUpdatedAt = earliestRetainedUpdatedAt === undefined
              ? updatedAt
              : Math.min(earliestRetainedUpdatedAt, updatedAt);
            continue;
          }
          records.push(record);
        }
        return {
          kind: 'ready',
          records,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
          ...(earliestRetainedUpdatedAt === undefined ? {} : { earliestRetainedUpdatedAt }),
        };
      } catch (error) {
        if (isPluginError(error)) throw error;
        return {
          kind: 'unavailable',
          reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
        };
      }
    },
  };
}

export type ConversationOutwardDeliveryConnectionDeletionSettlement =
  | Readonly<{ kind: 'settled' }>
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'blocked'; reason: 'externalEffectMayExist' | 'invalidRow' }>;

/** Binding cleanup has the same existing custody/wake outcome surface. */
export type ConversationOutwardDeliveryBindingDeletionSettlement =
  ConversationOutwardDeliveryConnectionDeletionSettlement;

type ConversationOutwardDeliveryDeletionCustodyDisposition =
  | Readonly<{ kind: 'retained' }>
  | Readonly<{ kind: 'replace'; custody: ConversationDeliveryCustody }>
  | Readonly<{ kind: 'blocked'; reason: 'externalEffectMayExist' }>;

/**
 * The existing custody-index traversal used by both connection and binding
 * finalization. It does not own a cursor or wake: each invocation rereads the
 * same bounded index pages and the incumbent supervisor calls it again after
 * a conflict or crash.
 */
async function settleConversationOutwardDeliveriesForDeletion(input: Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  connectionId: string;
  bindingId?: string;
  signal: AbortSignal;
  now: () => number;
  settle: (custody: ConversationDeliveryCustody) => ConversationOutwardDeliveryDeletionCustodyDisposition;
}>): Promise<ConversationOutwardDeliveryConnectionDeletionSettlement> {
  if (input.signal.aborted) return { kind: 'pending' };
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return { kind: 'pending' };
  }

  const prefix = input.bindingId === undefined
    ? [input.connectionId]
    : [input.connectionId, input.bindingId];
  const recordMatchesScope = (record: ConversationOutwardDeliveryRecord): boolean => (
    record.obligation.connectionId === input.connectionId
      && (input.bindingId === undefined || record.obligation.bindingId === input.bindingId)
  );
  const inspectPage = (row: StoredCollectionRow):
    | Readonly<{ kind: 'alreadySettled' }>
    | Readonly<{ kind: 'needsSettlement' }>
    | Readonly<{ kind: 'blocked'; reason: 'externalEffectMayExist' | 'invalidRow' }> => {
    const record = readConversationOutwardDeliveryRecord({ collections, row });
    if (record === null || !recordMatchesScope(record)) {
      return { kind: 'blocked', reason: 'invalidRow' };
    }
    const settled = input.settle(record.custody);
    if (settled.kind === 'blocked') return settled;
    return settled.kind === 'retained' || (settled.custody.state === record.custody.state
      && settled.custody.threadBindingPending === record.custody.threadBindingPending)
      ? { kind: 'alreadySettled' }
      : { kind: 'needsSettlement' };
  };

  let cursor: string | undefined;
  let needsSettlement = false;
  do {
    if (input.signal.aborted) return { kind: 'pending' };
    let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
    try {
      page = await input.deliveriesCollection.query({
        index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
        prefix,
        order: 'asc',
        limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal: input.signal });
    } catch {
      return { kind: 'pending' };
    }
    for (const row of page.rows) {
      const disposition = inspectPage(row as unknown as StoredCollectionRow);
      if (disposition.kind === 'blocked') return disposition;
      needsSettlement ||= disposition.kind === 'needsSettlement';
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  if (!needsSettlement) return { kind: 'settled' };

  const store = createConversationOutwardDeliveryCollectionStore({
    stateCollection: input.stateCollection,
    deliveriesCollection: input.deliveriesCollection,
    signal: input.signal,
    now: input.now,
  });
  cursor = undefined;
  do {
    if (input.signal.aborted) return { kind: 'pending' };
    let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
    try {
      page = await input.deliveriesCollection.query({
        index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
        prefix,
        order: 'asc',
        limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal: input.signal });
    } catch {
      return { kind: 'pending' };
    }
    for (const row of page.rows) {
      const record = readConversationOutwardDeliveryRecord({
        collections,
        row: row as unknown as StoredCollectionRow,
      });
      if (record === null || !recordMatchesScope(record)) {
        return { kind: 'blocked', reason: 'invalidRow' };
      }
      const settled = input.settle(record.custody);
      if (settled.kind === 'blocked') return settled;
      if (settled.kind === 'retained' || (settled.custody.state === record.custody.state
        && settled.custody.threadBindingPending === record.custody.threadBindingPending)) continue;
      const persisted = await store.compareAndSwap({
        custodyId: record.custodyId,
        expectedRevision: record.revision,
        custody: settled.custody,
      });
      if (persisted.kind !== 'updated') return { kind: 'pending' };
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  // A separate wake re-reads all custody after the CASes before state cleanup.
  return { kind: 'pending' };
}

/**
 * Settles only the retained custody states which cannot have caused an
 * external effect during connection deletion. Terminal evidence remains under
 * the existing custody retention owner rather than being rewritten blindly.
 */
export async function settleConversationOutwardDeliveriesForConnectionDeletion(input: Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  connectionId: string;
  signal: AbortSignal;
  now: () => number;
}>): Promise<ConversationOutwardDeliveryConnectionDeletionSettlement> {
  return await settleConversationOutwardDeliveriesForDeletion({
    ...input,
    settle: (custody) => {
      const settled = settleConversationDeliveryForConnectionDeletion({ custody });
      return settled.kind === 'notDeletable'
        ? { kind: 'blocked', reason: settled.reason }
        : settled.kind === 'retained' && settled.custody === custody
          ? { kind: 'retained' }
          : { kind: 'replace', custody: settled.custody };
    },
  });
}

/**
 * A binding delete leaves its terminal delivery evidence intact. Only ready
 * and retry-due custody is suppressed; attempting, partial, and unknown
 * effects keep the retained binding visible for the canonical recovery path.
 */
export async function settleConversationOutwardDeliveriesForBindingDeletion(input: Readonly<{
  stateCollection: ChannelStateCollection;
  deliveriesCollection: ChannelDeliveriesCollection;
  connectionId: string;
  bindingId: string;
  signal: AbortSignal;
  now: () => number;
}>): Promise<ConversationOutwardDeliveryBindingDeletionSettlement> {
  return await settleConversationOutwardDeliveriesForDeletion({
    ...input,
    settle: (custody) => {
      const settled = settleConversationDeliveryForBindingDeletion({ custody });
      return settled.kind === 'notDeletable'
        ? { kind: 'blocked', reason: settled.reason }
        : settled.kind === 'retained' && settled.custody === custody
          ? settled
          : { kind: 'replace', custody: settled.custody };
    },
  });
}

/**
 * Derives management-safe delivery attention from the canonical custody rows.
 * The existing connection-attention index excludes healthy retained bodies.
 * This projection retains neither a cache nor a summary row, so a fresh
 * Resource read cannot report stale delivery health.
 */
export async function readConversationOutwardDeliveryConnectionAttention(
  input: ConversationOutwardDeliveryConnectionAttentionReaderInput,
): Promise<ConversationOutwardDeliveryConnectionAttentionReadResult> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
    };
  }

  const emptyAttention: ConversationOutwardDeliveryConnectionAttention = {
    retryDue: false,
    notDelivered: false,
    partial: false,
    outcomeUnknown: false,
    archiveRecovery: false,
  };
  const connectionIds = [...new Set(input.connectionIds)];
  const attentionByConnection = new Map<string, ConversationOutwardDeliveryConnectionAttention>(
    connectionIds.map((connectionId) => [connectionId, emptyAttention]),
  );

  for (const connectionId of connectionIds) {
    let cursor: string | undefined;
    do {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
      try {
        page = await input.deliveriesCollection.query({
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byConnectionAttention,
          prefix: [connectionId, true],
          order: 'asc',
          limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
          ...(cursor === undefined ? {} : { cursor }),
        }, { signal: input.signal });
      } catch {
        return {
          kind: 'unavailable',
          reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
        };
      }

      for (const row of page.rows) {
        const record = readConversationOutwardDeliveryRecord({
          collections,
          row: row as unknown as StoredCollectionRow,
        });
        const current = attentionByConnection.get(connectionId) ?? emptyAttention;
        // One unreadable custody row is exactly one delivery whose outcome
        // this reader cannot establish. It degrades to the existing
        // `outcomeUnknown` attention marker for its own connection, matching
        // the supervisor scan that skips the same row, rather than discarding
        // every other connection's readable delivery health.
        const unreadable = record === null || record.obligation.connectionId !== connectionId;
        const custodyAttention = unreadable
          ? { retryDue: false, notDelivered: false, partial: false, outcomeUnknown: true }
          : deriveConversationDeliveryAttention(record.custody);
        attentionByConnection.set(connectionId, {
          retryDue: current.retryDue || custodyAttention.retryDue,
          notDelivered: current.notDelivered || custodyAttention.notDelivered,
          partial: current.partial || custodyAttention.partial,
          outcomeUnknown: current.outcomeUnknown || custodyAttention.outcomeUnknown,
          archiveRecovery: current.archiveRecovery
            || (!unreadable && isConversationDeliveryArchiveRecoverable(record.custody)),
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  return { kind: 'ready', attentionByConnection };
}

/**
 * Archived destinations need owner repair; retained delivery never resends.
 */
function isConversationDeliveryArchiveRecoverable(custody: ConversationDeliveryCustody): boolean {
  return (custody.state === 'notSent' && custody.reason === 'ownerMustUnarchiveOrRebind')
    || (custody.state === 'notDelivered' && custody.archiveRecovery !== undefined);
}

function deriveConversationOutwardDeliveryTranscriptActivityId(custodyId: string): string | null {
  const bytes = decodeBase64Url(custodyId);
  if (bytes === null) return null;
  return `delivery-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A custody row that this reader cannot parse, or whose obligation does not
 * match the index prefix it was returned under, is still one real retained
 * delivery. It is disclosed as its own unreadable activity so a single corrupt
 * row cannot erase every readable delivery in the same snapshot.
 */
function projectUnreadableConversationOutwardDeliveryTranscriptActivity(
  rowId: string,
): PluginTranscriptActivitySnapshotV1 | null {
  const localActivityId = deriveConversationOutwardDeliveryTranscriptActivityId(rowId);
  if (localActivityId === null) return null;
  return Object.freeze({
    localActivityId,
    title: 'External delivery',
    checklist: [],
    actions: [],
    phase: 'failed' as const,
    status: 'Delivery details could not be read',
    dismissible: true,
  });
}

function projectConversationOutwardDeliveryTranscriptActivity(
  record: ConversationOutwardDeliveryRecord,
): PluginTranscriptActivitySnapshotV1 | null {
  const localActivityId = deriveConversationOutwardDeliveryTranscriptActivityId(record.custodyId);
  if (localActivityId === null) return null;
  const base = {
    localActivityId,
    title: 'External delivery',
    checklist: [],
    actions: [],
  };
  switch (record.custody.state) {
    case 'ready':
      return Object.freeze({
        ...base,
        phase: 'running' as const,
        status: 'Waiting to deliver',
        dismissible: false,
      });
    case 'retryDue':
      return Object.freeze({
        ...base,
        phase: 'running' as const,
        status: 'Delivery will retry',
        dismissible: false,
      });
    case 'attempting':
      return Object.freeze({
        ...base,
        phase: 'running' as const,
        status: 'Delivering',
        dismissible: false,
      });
    case 'notDelivered':
    case 'notSent':
      if (!deriveConversationDeliveryProjection(record.custody).attention) return null;
      return Object.freeze({
        ...base,
        phase: 'failed' as const,
        status: isConversationDeliveryArchiveRecoverable(record.custody)
          ? 'Delivery was not sent: the destination is archived'
          : 'Delivery was not sent',
        dismissible: true,
      });
    case 'partial':
      return Object.freeze({
        ...base,
        phase: 'failed' as const,
        status: 'Delivery was only partly sent',
        dismissible: true,
      });
    case 'outcomeUnknown':
      return Object.freeze({
        ...base,
        phase: 'failed' as const,
        status: 'Delivery outcome is unknown',
        dismissible: true,
      });
    case 'delivered':
    case 'suppressed':
    case 'resolvedAccepted':
    case 'resolvedDiscarded':
    case 'resolved':
    case 'connectionDeleted':
      return null;
  }
}

/**
 * Projects a bounded transcript-tail snapshot from the exact existing
 * binding-qualified custody index. It adds no delivery lifecycle, cache, or
 * retention state; a Resource reread is the only snapshot authority.
 */
export async function readConversationOutwardDeliveryTranscriptActivities(
  input: ConversationOutwardDeliveryTranscriptActivitiesReaderInput,
): Promise<ConversationOutwardDeliveryTranscriptActivitiesReadResult> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
    };
  }

  const targetsByKey = new Map<string, Readonly<{ connectionId: string; bindingId: string }>>();
  for (const target of input.bindingTargets) {
    if (!ConversationConnectionIdV1Schema.safeParse(target.connectionId).success
      || !ConversationBindingIdV1Schema.safeParse(target.bindingId).success) {
      return { kind: 'invalid', reason: 'invalidRow' };
    }
    targetsByKey.set(`${target.connectionId}\0${target.bindingId}`, target);
  }
  const targets = [...targetsByKey.values()].sort((left, right) => (
    compareCanonicalChannelRelationId(left.connectionId, right.connectionId)
    || compareCanonicalChannelRelationId(left.bindingId, right.bindingId)
  ));
  const activities: PluginTranscriptActivitySnapshotV1[] = [];
  const activityIds = new Set<string>();

  for (const target of targets) {
    let cursor: string | undefined;
    do {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
      try {
        page = await input.deliveriesCollection.query({
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
          prefix: [target.connectionId, target.bindingId],
          order: 'asc',
          limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
          ...(cursor === undefined ? {} : { cursor }),
        }, { signal: input.signal });
      } catch {
        return {
          kind: 'unavailable',
          reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
        };
      }
      for (const row of page.rows) {
        const storedRow = row as unknown as StoredCollectionRow;
        const record = readConversationOutwardDeliveryRecord({
          collections,
          row: storedRow,
        });
        const activity = record === null
          || record.obligation.connectionId !== target.connectionId
          || record.obligation.bindingId !== target.bindingId
          ? projectUnreadableConversationOutwardDeliveryTranscriptActivity(storedRow.rowId)
          : projectConversationOutwardDeliveryTranscriptActivity(record);
        if (activity === null) continue;
        if (activityIds.has(activity.localActivityId)) {
          return { kind: 'invalid', reason: 'invalidRow' };
        }
        activityIds.add(activity.localActivityId);
        activities.push(activity);
        if (activities.length === MAX_PLUGIN_TRANSCRIPT_ACTIVITIES_PER_RESOURCE_V1) {
          return { kind: 'ready', activities: Object.freeze(activities) };
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }

  return { kind: 'ready', activities: Object.freeze(activities) };
}

/**
 * Reads the newest retained custody update for each exact binding. The existing
 * index is not time-ordered, so every page is visited; retention remains owned
 * by the delivery store. No send time or inbound activity is inferred.
 */
export async function readConversationOutwardDeliveryLastDeliveries(
  input: ConversationOutwardDeliveryTranscriptActivitiesReaderInput,
): Promise<ConversationOutwardDeliveryLastDeliveriesReadResult> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return { kind: 'unavailable', reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable' };
  }
  const targetsByBindingId = new Map(input.bindingTargets.map((target) => [target.bindingId, target]));
  const lastDeliveries: ConversationSessionLastDeliveryV1[] = [];
  for (const target of targetsByBindingId.values()) {
    if (!ConversationConnectionIdV1Schema.safeParse(target.connectionId).success
      || !ConversationBindingIdV1Schema.safeParse(target.bindingId).success) {
      return { kind: 'invalid', reason: 'invalidRow' };
    }
    let latest: Readonly<{ custodyId: string; delivery: ConversationSessionLastDeliveryV1 }> | undefined;
    let cursor: string | undefined;
    do {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      let page: Awaited<ReturnType<ChannelDeliveriesCollection['query']>>;
      try {
        page = await input.deliveriesCollection.query({
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
          prefix: [target.connectionId, target.bindingId],
          order: 'asc',
          limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
          ...(cursor === undefined ? {} : { cursor }),
        }, { signal: input.signal });
      } catch {
        return { kind: 'unavailable', reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable' };
      }
      for (const row of page.rows) {
        const record = readConversationOutwardDeliveryRecord({ collections, row: row as unknown as StoredCollectionRow });
        const atMs = isJsonRecord(row.value) ? row.value[collections.CHANNEL_DELIVERIES_FIELD.updatedAt] : undefined;
        if (record === null || !isNonNegativeSafeInteger(atMs)
          || record.obligation.connectionId !== target.connectionId
          || record.obligation.bindingId !== target.bindingId) {
          return { kind: 'invalid', reason: 'invalidRow' };
        }
        if (latest === undefined || atMs > latest.delivery.atMs
          || (atMs === latest.delivery.atMs && compareCanonicalChannelRelationId(record.custodyId, latest.custodyId) > 0)) {
          latest = {
            custodyId: record.custodyId,
            delivery: {
              bindingId: target.bindingId,
              atMs,
              outcome: deriveConversationDeliveryLastOutcome(record.custody),
            },
          };
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    if (latest !== undefined) lastDeliveries.push(latest.delivery);
  }
  return { kind: 'ready', lastDeliveries: Object.freeze(lastDeliveries) };
}

export type ConversationOutwardDeliveryReadyPreparation =
  | Readonly<{
    kind: 'ready';
    obligation: ConversationOutwardDeliveryObligation;
    outboundTextLimit?: ConversationOutboundTextLimit;
  }>
  | Readonly<{
    kind: 'suppressed';
    reason: ConversationOutwardDeliverySuppressionReason;
  }>
  | Readonly<{
    kind: 'invalid';
    reason:
      | ConversationOutwardDeliveryPreCustodyRejection
      | 'routeMismatch'
      | 'invalidRow'
      | 'rowTooLarge';
  }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt' | 'bindingUnavailable';
  }>;

export type ConversationOutwardDeliveryReadyAcceptance =
  | Readonly<{
    kind: 'accepted';
    custodyId: string;
    custody: ConversationDeliveryCustody;
    /** The admitted record can be driven immediately without another scan. */
    record: ConversationOutwardDeliveryRecord;
  }>
  | Readonly<{ kind: 'retired' }>
  | Extract<ConversationOutwardDeliveryReadyPreparation, Readonly<{ kind: 'suppressed' }>>
  | Extract<ConversationOutwardDeliveryReadyPreparation, Readonly<{ kind: 'invalid' }>>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt' | 'storageUnavailable' | 'bindingUnavailable';
  }>;

type ConversationOutwardDeliveryConnectionFacts = Readonly<{
  revision: number;
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  credentialRef: JsonValue | null;
  transportOrigin: ConversationConnectionTransportOriginV1;
  routingIdentityKey: string;
  outboundTextLimit?: ConversationOutboundTextLimit;
  providerAction: Readonly<{
    providerPluginId: string;
    providerContributionSelection: PersistedConversationProviderContributionSelection;
    providerConnectionKey: string;
    providerConfigVersion: number;
    providerConfig: JsonValue;
  }>;
}>;
type ConversationOutwardDeliveryBindingFacts = Readonly<{
  revision: number;
  connectionId: string;
  parentBindingId?: string;
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'finalizingDelete';
  endpoint: ConversationResolvedEndpointV1;
  allowedPrincipalIds: readonly string[];
  target: JsonValue;
  linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1 | undefined;
}>;

/**
 * Projects the one canonical retained-connection reader for outward custody.
 * This consumer never accepts a partial row or downgrades missing provider
 * authority to an optional action: corrupt durable state is unavailable before
 * ready custody, identity derivation, or provider I/O can begin.
 */
export function readConnectionFacts(input: Readonly<{
  accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  row: StoredCollectionRow;
  connectionId: string;
}>): ConversationOutwardDeliveryConnectionFacts | null {
  if (!isJsonRecord(input.row.value)) return null;
  let connection: ReturnType<ConversationAccountLocalBindingPolicyModule['readConversationConnectionUpdateRow']>;
  try {
    connection = input.accountLocalBindingPolicy.readConversationConnectionUpdateRow({
      row: {
        rowId: input.row.rowId,
        revision: input.row.revision,
        value: input.row.value,
      },
      connectionId: input.connectionId,
    });
  } catch {
    return null;
  }
  const { payload } = connection;
  let outboundTextLimit: ConversationOutboundTextLimit | undefined;
  if (payload.outboundTextLimit !== undefined) {
    const parsed = storedOutboundTextLimitSchema.safeParse(payload.outboundTextLimit);
    if (!parsed.success) return null;
    outboundTextLimit = parsed.data;
  }
  const providerConnection = ConversationProviderConnectionInputV1Schema.safeParse({
    v: 1,
    connectionId: input.connectionId,
    providerConnectionKey: payload.providerConnectionKey,
    providerConfigVersion: payload.providerConfigVersion,
    providerConfig: payload.providerConfig,
    credentialRef: payload.credentialRef,
  });
  if (!providerConnection.success) return null;
  return {
    revision: input.row.revision,
    authorityEpoch: connection.lifecycle.authorityEpoch,
    enabled: connection.lifecycle.enabled,
    deletionState: connection.lifecycle.deletionState,
    credentialRef: providerConnection.data.credentialRef,
    transportOrigin: connection.transportOrigin,
    routingIdentityKey: connection.routingIdentityKey,
    ...(outboundTextLimit === undefined ? {} : { outboundTextLimit }),
    providerAction: {
      providerPluginId: connection.providerPluginId,
      providerContributionSelection: connection.providerContributionSelection,
      providerConnectionKey: providerConnection.data.providerConnectionKey,
      providerConfigVersion: providerConnection.data.providerConfigVersion,
      providerConfig: providerConnection.data.providerConfig,
    },
  };
}

function compactConversationOutwardDeliveryObligation(input: Readonly<{
  obligation: ConversationStoredOutwardDeliveryObligation;
  custody: ConversationDeliveryCustody;
}>): ConversationStoredOutwardDeliveryObligation {
  if (!isConversationDeliveryContentFree(input.custody)) return input.obligation;
  if (!hasRetainedConversationOutwardDeliveryContent(input.obligation)) return input.obligation;
  return { ...input.obligation, content: null };
}

export function readBindingFacts(input: Readonly<{
  accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  row: StoredCollectionRow;
  bindingId: string;
}>): ConversationOutwardDeliveryBindingFacts | null {
  const value = input.row.value;
  if (!isJsonRecord(value)) return null;
  let current: ReturnType<ConversationAccountLocalBindingPolicyModule['readConversationBindingUpdateRow']>;
  try {
    current = input.accountLocalBindingPolicy.readConversationBindingUpdateRow({
      row: {
        rowId: input.row.rowId,
        revision: input.row.revision,
        value,
      },
      bindingId: input.bindingId,
    });
  } catch (error) {
    if (isPluginError(error) && error.code === 'channels_binding_target_unavailable') throw error;
    return null;
  }
  const { binding } = current;
  return {
    revision: input.row.revision,
    connectionId: binding.connectionId,
    ...(binding.parentBindingId === undefined ? {} : { parentBindingId: binding.parentBindingId }),
    authorityEpoch: binding.authorityEpoch,
    enabled: binding.enabled,
    deletionState: binding.deletionState,
    endpoint: binding.endpoint,
    allowedPrincipalIds: binding.allowedPrincipalIds,
    target: binding.target,
    linkPreviewPolicy: binding.linkPreviewPolicy,
  };
}

type ConversationOutwardDeliveryRouteCurrentness =
  | Readonly<{
    kind: 'current';
    outboundTextLimit?: ConversationOutboundTextLimit;
    connection: ConversationOutwardDeliveryConnectionFacts;
  }>
  | Readonly<{
    kind: 'suppressed';
    reason: ConversationOutwardDeliverySuppressionReason;
  }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt' | 'bindingUnavailable';
  }>;

function matchesAutomationTarget(input: Readonly<{
  current: JsonValue;
  expected: Extract<ConversationOutwardSourceV1, Readonly<{ kind: 'automationResult' }>>;
}>): boolean {
  const current = ConversationBindingTargetV1Schema.safeParse(input.current);
  if (!current.success
    || current.data.kind !== 'automation'
    || current.data.automationId !== input.expected.automationId
    || current.data.policy.resultDelivery !== input.expected.resultDelivery) {
    return false;
  }
  return true;
}

function matchesSessionTarget(input: Readonly<{
  current: JsonValue;
  sessionId: string;
}>): boolean {
  const current = ConversationBindingTargetV1Schema.safeParse(input.current);
  return current.success
    && current.data.kind === 'session'
    && current.data.sessionId === input.sessionId;
}

/**
 * The one current send-policy owner, shared by ready admission and send claim.
 * Presentation revisions do not authorize or revoke delivery. A retained
 * Session projection keeps only its source-eligibility binding stamp.
 */
export async function checkConversationOutwardDeliveryRouteCurrentness(input: Readonly<{
  stateCollection: ChannelStateCollection;
  signal: AbortSignal;
  obligation: ConversationOutwardDeliveryObligation;
}>): Promise<ConversationOutwardDeliveryRouteCurrentness> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  try {
    accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
  } catch {
    return { kind: 'unavailable', reason: 'stateUnavailable' };
  }
  let connectionRow: StoredCollectionRow | null;
  try {
    connectionRow = await input.stateCollection.get(
      input.obligation.connectionId,
      { signal: input.signal },
    ) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'stateUnavailable',
    };
  }
  if (connectionRow === null) return { kind: 'suppressed', reason: 'connectionUnavailable' };
  const connection = readConnectionFacts({
    accountLocalBindingPolicy,
    row: connectionRow,
    connectionId: input.obligation.connectionId,
  });
  if (connection === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (!connection.enabled || connection.deletionState !== 'none') {
    return { kind: 'suppressed', reason: 'connectionDisabled' };
  }
  if (input.obligation.bindingId === undefined) {
    return input.signal.aborted
      ? { kind: 'unavailable', reason: 'cancelled' }
      : {
        kind: 'current',
        ...(connection.outboundTextLimit === undefined ? {} : { outboundTextLimit: connection.outboundTextLimit }),
        connection,
      };
  }

  let bindingRow: StoredCollectionRow | null;
  try {
    bindingRow = await input.stateCollection.get(
      input.obligation.bindingId,
      { signal: input.signal },
    ) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'stateUnavailable',
    };
  }
  if (bindingRow === null) return { kind: 'suppressed', reason: 'bindingUnavailable' };
  let binding: ConversationOutwardDeliveryBindingFacts | null;
  try {
    binding = readBindingFacts({ accountLocalBindingPolicy, row: bindingRow, bindingId: input.obligation.bindingId });
  } catch (error) {
    if (isPluginError(error) && error.code === 'channels_binding_target_unavailable') {
      return { kind: 'unavailable', reason: 'bindingUnavailable' };
    }
    throw error;
  }
  if (binding === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (!binding.enabled || binding.deletionState !== 'none') {
    return { kind: 'suppressed', reason: 'bindingDisabled' };
  }
  if (binding.connectionId !== input.obligation.connectionId) return { kind: 'suppressed', reason: 'targetChanged' };
  // A retained projection stores its semantic item identity, but no consumed
  // input origins. Keep its existing binding stamp so a changed delivery mode
  // cannot turn an old mirrored item into a replies-only send after reload.
  if ((input.obligation.source.kind === 'sessionProjection' || input.obligation.source.kind === 'discussionProjection')
    && input.obligation.routeAuthority.bindingAuthorityEpoch !== binding.authorityEpoch) {
    return { kind: 'suppressed', reason: 'targetChanged' };
  }
  const parent = await accountLocalBindingPolicy.readConversationBindingParentEligibility({
    collection: input.stateCollection, binding, signal: input.signal,
  });
  if (parent.kind === 'unavailable') return parent;
  if (parent.kind === 'notEligible') return { kind: 'suppressed', reason: 'bindingDisabled' };
  if (!matchesConversationBindingEndpoint(binding.endpoint, input.obligation.endpoint)) {
    return { kind: 'suppressed', reason: 'audienceChanged' };
  }
  if (input.obligation.newThread !== undefined) {
    const allowedPrincipals = new Set(binding.allowedPrincipalIds);
    if (input.obligation.newThread.recipients.some(principal => !allowedPrincipals.has(principal))) {
      return { kind: 'suppressed', reason: 'audienceChanged' };
    }
  }
  if (binding.linkPreviewPolicy === undefined) {
    return { kind: 'unavailable', reason: 'stateCorrupt' };
  }
  if (input.obligation.source.kind === 'automationResult') {
    if (!matchesAutomationTarget({
      current: binding.target,
      expected: input.obligation.source,
    })) {
      return { kind: 'suppressed', reason: 'targetChanged' };
    }
  }
  if ((input.obligation.source.kind === 'sessionProjection'
    || input.obligation.source.kind === 'permissionWait')
    && !matchesSessionTarget({
      current: binding.target,
      sessionId: input.obligation.source.sessionId,
    })) {
    return { kind: 'suppressed', reason: 'targetChanged' };
  }
  if (input.obligation.source.kind === 'discussionProjection') {
    const target = ConversationBindingTargetV1Schema.safeParse(binding.target);
    if (!target.success || target.data.kind !== 'discussion'
      || target.data.discussionId !== input.obligation.source.discussionId) {
      return { kind: 'suppressed', reason: 'targetChanged' };
    }
  }
  return input.signal.aborted
    ? { kind: 'unavailable', reason: 'cancelled' }
    : {
      kind: 'current',
      ...(connection.outboundTextLimit === undefined ? {} : { outboundTextLimit: connection.outboundTextLimit }),
      connection,
    };
}

/**
 * The public projection of a current source binding that is eligible to ask
 * the generic Permission owner for pending mediation. It intentionally
 * contains only source authority and the exact Session identity. The caller
 * supplies a separately bounded semantic summary from the canonical Session
 * owner; raw tool payloads, rules, and provider credentials never enter here.
 */
export type ConversationPermissionWaitMediationSource = Readonly<{
  connectionId: string;
  bindingId: string;
  sessionId: string;
  sourceRef: string;
  sourceRevisionOrEpoch: string;
  connectionAuthorityEpoch: number;
  bindingAuthorityEpoch: number;
}>;

export type ConversationPermissionWaitMediationSourceReadResult =
  | Readonly<{
    kind: 'ready';
    source: ConversationPermissionWaitMediationSource;
    permissionApprovalsEnabled: boolean;
  }>
  | Readonly<{ kind: 'notEligible' }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt' | 'bindingUnavailable';
  }>;

type CurrentConversationPermissionWaitMediationSource = Extract<
  ConversationPermissionWaitMediationSourceReadResult,
  Readonly<{ kind: 'ready' }>
> & Readonly<{
  endpoint: ConversationResolvedEndpointV1;
  linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
  routingIdentityKey: string;
  remoteApprovalMaxScope: 'off' | 'request' | 'session';
}>;

type CurrentConversationPermissionWaitMediationSourceReadResult =
  | CurrentConversationPermissionWaitMediationSource
  | Exclude<
    ConversationPermissionWaitMediationSourceReadResult,
    Readonly<{ kind: 'ready' }>
  >;

/**
 * Reads the one canonical binding/connection authority pair for the C5
 * consumer. It reuses the retained-row parsers and the existing binding-policy
 * predicate instead of reconstructing either in the supervisor.
 */
async function readCurrentConversationPermissionWaitMediationSource(input: Readonly<{
  stateCollection: ChannelStateCollection;
  bindingId: string;
  signal: AbortSignal;
}>): Promise<CurrentConversationPermissionWaitMediationSourceReadResult> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  try {
    accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
  } catch {
    return { kind: 'unavailable', reason: 'stateUnavailable' };
  }
  let bindingRow: StoredCollectionRow | null;
  try {
    bindingRow = await input.stateCollection.get(input.bindingId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'stateUnavailable',
    };
  }
  if (bindingRow === null) return { kind: 'notEligible' };
  let binding: ConversationOutwardDeliveryBindingFacts | null;
  try {
    binding = readBindingFacts({ accountLocalBindingPolicy, row: bindingRow, bindingId: input.bindingId });
  } catch (error) {
    if (isPluginError(error) && error.code === 'channels_binding_target_unavailable') {
      return { kind: 'unavailable', reason: 'bindingUnavailable' };
    }
    throw error;
  }
  if (binding === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (!binding.enabled || binding.deletionState !== 'none') return { kind: 'notEligible' };
  const parent = await accountLocalBindingPolicy.readConversationBindingParentEligibility({
    collection: input.stateCollection, binding, signal: input.signal,
  });
  if (parent.kind !== 'eligible') return parent;
  if (binding.linkPreviewPolicy === undefined) {
    return { kind: 'unavailable', reason: 'stateCorrupt' };
  }
  const target = ConversationBindingTargetV1Schema.safeParse(binding.target);
  if (!target.success) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (target.data.kind !== 'session') {
    return { kind: 'notEligible' };
  }
  let connectionRow: StoredCollectionRow | null;
  try {
    connectionRow = await input.stateCollection.get(binding.connectionId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'stateUnavailable',
    };
  }
  if (connectionRow === null) return { kind: 'notEligible' };
  const connection = readConnectionFacts({
    accountLocalBindingPolicy,
    row: connectionRow,
    connectionId: binding.connectionId,
  });
  if (connection === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (!connection.enabled || connection.deletionState !== 'none') return { kind: 'notEligible' };
  return {
    kind: 'ready',
    permissionApprovalsEnabled: hasConversationApprovalPolicyEnabled(target.data),
    source: {
      connectionId: binding.connectionId,
      bindingId: input.bindingId,
      sessionId: target.data.sessionId,
      sourceRef: `channels:binding:${input.bindingId}`,
      sourceRevisionOrEpoch: `${connection.authorityEpoch}:${binding.authorityEpoch}`,
      connectionAuthorityEpoch: connection.authorityEpoch,
      bindingAuthorityEpoch: binding.authorityEpoch,
    },
    endpoint: binding.endpoint,
    linkPreviewPolicy: binding.linkPreviewPolicy,
    routingIdentityKey: connection.routingIdentityKey,
    remoteApprovalMaxScope: target.data.policy.approvals.kind === 'enabled'
      ? target.data.policy.approvals.maximumScope
      : 'off',
  };
}

/**
 * Exact source-currentness operation for host-owned delayed work. It delegates
 * all binding/connection eligibility to the same retained-row reader used by
 * live permission mediation. Verified currentness is a boolean; unavailable
 * authority reads reject rather than assert revocation.
 */
export async function readConversationPermissionMediationSourceCurrentnessForInvocation(
  input: JsonValue,
  context: PluginInvocationContext,
): Promise<ConversationPermissionMediationSourceCurrentnessResultV1> {
  const accepted = ConversationPermissionMediationSourceCurrentnessInputV1Schema.parse(input);
  const collections = await loadConversationCollectionsModule();
  const stateCollection = requireChannelsAccountStorage(context).collection(
    collections.CHANNEL_STATE_COLLECTION,
  );
  return ConversationPermissionMediationSourceCurrentnessResultV1Schema.parse({
    current: await isConversationPermissionMediationSourceCurrent({
      stateCollection,
      accepted,
      signal: context.signal,
    }),
  });
}

/** Canonical retained-row check shared by the Action adapter and owner tests. */
export async function isConversationPermissionMediationSourceCurrent(input: Readonly<{
  stateCollection: ChannelStateCollection;
  accepted: ConversationPermissionMediationSourceCurrentnessInputV1;
  signal: AbortSignal;
}>): Promise<boolean> {
  const sourcePrefix = 'channels:binding:';
  if (!input.accepted.sourceRef.startsWith(sourcePrefix)) return false;
  const bindingId = ConversationBindingIdV1Schema.safeParse(
    input.accepted.sourceRef.slice(sourcePrefix.length),
  );
  if (!bindingId.success) return false;
  const current = await readCurrentConversationPermissionWaitMediationSource({
    stateCollection: input.stateCollection,
    bindingId: bindingId.data,
    signal: input.signal,
  });
  if (current.kind === 'unavailable') {
    input.signal.throwIfAborted();
    throw new Error('conversation_source_currentness_unavailable');
  }
  return current.kind === 'ready'
    && current.source.sourceRef === input.accepted.sourceRef
    && current.source.sourceRevisionOrEpoch === input.accepted.sourceRevisionOrEpoch
    && current.remoteApprovalMaxScope === input.accepted.remoteApprovalMaxScope;
}

/**
 * Supplies only the generic Permission Action's source context. The caller
 * must reread it through the acceptance function below before custody changes.
 */
export async function readConversationPermissionWaitMediationSource(input: Readonly<{
  stateCollection: ChannelStateCollection;
  bindingId: string;
  signal: AbortSignal;
}>): Promise<ConversationPermissionWaitMediationSourceReadResult> {
  const current = await readCurrentConversationPermissionWaitMediationSource(input);
  return current.kind === 'ready'
    ? {
      kind: 'ready',
      source: current.source,
      permissionApprovalsEnabled: current.permissionApprovalsEnabled,
    }
    : current;
}

function isSameConversationPermissionWaitMediationSource(
  left: ConversationPermissionWaitMediationSource,
  right: ConversationPermissionWaitMediationSource,
): boolean {
  return left.connectionId === right.connectionId
    && left.bindingId === right.bindingId
    && left.sessionId === right.sessionId
    && left.sourceRef === right.sourceRef
    && left.sourceRevisionOrEpoch === right.sourceRevisionOrEpoch
    && left.connectionAuthorityEpoch === right.connectionAuthorityEpoch
    && left.bindingAuthorityEpoch === right.bindingAuthorityEpoch;
}

/**
 * The chat surface is a renderer only: it receives bounded summaries from the
 * canonical Session permission owner and carries the existing opaque request
 * identity back to the canonical Action. It neither parses a raw tool input
 * nor owns an approval/answer decision.
 */
function renderConversationPendingPermissionRequest(
  request: ConversationPendingPermissionRequest,
): string {
  if (request.kind === 'permission') {
    const summary = request.agentRequestSummary;
    return `${summary.title}\n${summary.detail}\n`
      + `Reply /allow ${request.requestId} or /deny ${request.requestId}.`;
  }

  const fullForm = request.agentRequestSummary.fullForm;
  if (fullForm) return `Answer all ${fullForm.questionCount} in Happier\n${fullForm.url}`;

  const questions = request.agentRequestSummary.questions.map((question, index) => {
    const selection = question.selection === 'text'
      ? 'write text'
      : question.selection === 'multiple'
        ? 'select one or more'
        : 'select one';
    const qualifier = `${question.required ? 'required' : 'optional'}; ${selection}`
      + (question.allowCustom && question.selection !== 'text' ? '; custom text allowed' : '');
    const choices = question.choices.length === 0
      ? ''
      : `\n${question.choices.map((choice, choiceIndex) => `  ${choiceIndex + 1}. ${choice}`).join('\n')}`;
    return `${index + 1}. ${question.question} (${qualifier})${choices}`;
  });
  return `This Session needs your input:\n${questions.join('\n')}\n`
    + `Reply /answer ${request.requestId} [{"questionIndex":0,"values":["<answer>"]}] in one message. `
    + 'Use displayed choice labels, or free text only where allowed; include every required question.';
}

async function createConversationPermissionWaitOutwardDeliveryObligation(input: Readonly<{
  current: CurrentConversationPermissionWaitMediationSource;
  request: ConversationPendingPermissionRequest;
}>): Promise<ConversationOutwardDeliveryObligation | null> {
  const { request } = input;
  const provisional: ConversationOutwardDeliveryObligation = {
    connectionId: input.current.source.connectionId,
    bindingId: input.current.source.bindingId,
    routeAuthority: {},
    source: {
      kind: 'permissionWait',
      sessionId: input.current.source.sessionId,
      turnId: request.turnId,
      requestId: request.requestId,
    },
    endpoint: input.current.endpoint,
    content: { text: renderConversationPendingPermissionRequest(request) },
    // The existing custody HMAC is length-prefixed over the exact source
    // tuple. Reusing it makes the provider key bounded, opaque, and immune to
    // delimiter collisions in provider-native request identifiers.
    deliveryKey: 'channels:permission-wait:v1:pending',

    linkPreviewPolicy: input.current.linkPreviewPolicy,
  };
  const custodyId = await deriveConversationOutwardDeliveryCustodyId({
    routingIdentityKey: input.current.routingIdentityKey,
    obligation: provisional,
  });
  return custodyId === null
    ? null
    : {
      ...provisional,
      deliveryKey: `channels:permission-wait:v1:${custodyId}`,
    };
}

export type ConversationPermissionWaitOutwardDeliveryAcceptance =
  | ConversationOutwardDeliveryReadyAcceptance
  | Readonly<{ kind: 'notEligible' }>;

/**
 * The C5 producer's only write. It proves the source binding is unchanged
 * after the generic pending read, then enters the incumbent ready-custody
 * admission path without invoking a provider Action.
 */
export async function acceptConversationPermissionWaitOutwardDelivery(input: Readonly<{
  stateCollection: ChannelStateCollection;
  store: ConversationOutwardDeliveryStore;
  source: ConversationPermissionWaitMediationSource;
  request: ConversationPendingPermissionRequest;
  signal: AbortSignal;
}>): Promise<ConversationPermissionWaitOutwardDeliveryAcceptance> {
  const current = await readCurrentConversationPermissionWaitMediationSource({
    stateCollection: input.stateCollection,
    bindingId: input.source.bindingId,
    signal: input.signal,
  });
  if (current.kind !== 'ready') return current;
  if (input.request.kind !== 'user_action' && !current.permissionApprovalsEnabled) {
    return { kind: 'notEligible' };
  }
  if (!isSameConversationPermissionWaitMediationSource(current.source, input.source)) {
    return { kind: 'notEligible' };
  }
  const obligation = await createConversationPermissionWaitOutwardDeliveryObligation({
    current,
    request: input.request,
  });
  if (obligation === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  return await admitConversationOutwardDeliveryReady({
    stateCollection: input.stateCollection,
    store: input.store,
    obligation,
    signal: input.signal,
  });
}

/**
 * Reads the canonical Account rows once to prepare a durable ready-custody
 * acceptance. It performs no delivery write or provider I/O; the future
 * delivery caller must re-run currentness after claim through the same owner.
 */
export async function prepareConversationOutwardDeliveryReady(input: Readonly<{
  stateCollection: ChannelStateCollection;
  signal: AbortSignal;
  obligation: ConversationOutwardDeliveryObligation;
}>): Promise<ConversationOutwardDeliveryReadyPreparation> {
  const currentness = await checkConversationOutwardDeliveryRouteCurrentness({
    stateCollection: input.stateCollection,
    signal: input.signal,
    obligation: input.obligation,
  });
  if (currentness.kind !== 'current') return currentness;
  const rejection = validateConversationOutwardDeliveryBeforeCustody({
    obligation: input.obligation,
    ...(currentness.outboundTextLimit === undefined ? {} : { outboundTextLimit: currentness.outboundTextLimit }),
  });
  if (rejection !== null) {
    return { kind: 'invalid', reason: rejection };
  }
  return {
    kind: 'ready',
    obligation: input.obligation,
    ...(currentness.outboundTextLimit === undefined ? {} : { outboundTextLimit: currentness.outboundTextLimit }),
  };
}

/**
 * The Automation bridge owns only ready-custody admission. This wrapper keeps
 * its write on the same store/API as C4 and never crosses a provider boundary.
 */
export async function acceptConversationOutwardDeliveryReady(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  prepared: ConversationOutwardDeliveryReadyPreparation;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryReadyAcceptance> {
  if (input.prepared.kind !== 'ready') return input.prepared;
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  try {
    const ensured = await input.store.ensure(input.prepared.obligation);
    if (ensured.kind === 'unavailable') {
      return {
        kind: 'unavailable',
        reason: ensured.reason === 'connectionCorrupt'
          ? 'stateCorrupt'
          : ensured.reason === 'connectionUnavailable'
            ? 'stateUnavailable'
            : ensured.reason === 'storageUnavailable'
              ? 'storageUnavailable'
              : 'cancelled',
      };
    }
    if (ensured.kind === 'invalid') return { kind: 'invalid', reason: ensured.reason };
    if (ensured.kind === 'conflict') return { kind: 'invalid', reason: 'routeMismatch' };
    if (ensured.kind === 'retired') return ensured;
    return {
      kind: 'accepted',
      custodyId: ensured.record.custodyId,
      custody: ensured.record.custody,
      record: ensured.record,
    };
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
    };
  }
}

/**
 * The one ready-custody admission entry point every outward producer uses.
 *
 * It resolves the deterministic custody identity *before* any mutable route
 * fact is read. An accepted response that never reached its caller must rejoin
 * exactly the same durable obligation, so a replay that arrives after the
 * binding was edited, disabled, or deleted still settles `accepted` and creates
 * no second external effect. Route currentness keeps its full authority over
 * the only decision it actually owns: whether a *new* obligation may be
 * created. This adds no second custody owner — rejoin, conflict, and creation
 * all remain the store's deterministic-identity resolution.
 */
export async function admitConversationOutwardDeliveryReady(input: Readonly<{
  stateCollection: ChannelStateCollection;
  store: ConversationOutwardDeliveryStore;
  obligation: ConversationOutwardDeliveryObligation;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryReadyAcceptance> {
  const existing = await input.store.lookup(input.obligation);
  if (existing.kind === 'rejoined') {
    return {
      kind: 'accepted',
      custodyId: existing.record.custodyId,
      custody: existing.record.custody,
      record: existing.record,
    };
  }
  if (existing.kind === 'conflict') return { kind: 'invalid', reason: 'routeMismatch' };
  if (existing.kind === 'invalid') return existing;
  if (existing.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      reason: existing.reason === 'connectionCorrupt'
        ? 'stateCorrupt'
        : existing.reason === 'connectionUnavailable'
          ? 'stateUnavailable'
          : existing.reason === 'storageUnavailable'
            ? 'storageUnavailable'
            : 'cancelled',
    };
  }
  return await acceptConversationOutwardDeliveryReady({
    store: input.store,
    prepared: await prepareConversationOutwardDeliveryReady({
      stateCollection: input.stateCollection,
      signal: input.signal,
      obligation: input.obligation,
    }),
    signal: input.signal,
  });
}

const CONVERSATION_CONTROL_RESPONSE_KINDS = new Set<ConversationControlResponseKind>([
  'pairing',
  'newSession',
  'approval',
  'userAction',
  'stop',
  'refusal',
  'recovery',
]);

export const CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASONS = [
  'cancelled',
  'currentnessUnavailable',
  'connectionUnavailable',
  'connectionDisabled',
  'bindingUnavailable',
  'bindingDisabled',
  'targetChanged',
  'providerGenerationRetired',
  'audienceChanged',
  'permissionNoLongerPending',
] as const;

export type ConversationOutwardDeliverySuppressionReason =
  (typeof CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASONS)[number];

const CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASON_SET =
  new Set<string>(CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASONS);

export type ConversationOutwardDeliveryCurrentnessResult =
  | Readonly<{ kind: 'current' }>
  | Readonly<{ kind: 'unavailable'; reason: 'stateUnavailable' }>
  | Readonly<{
    kind: 'suppressed';
    reason: ConversationOutwardDeliverySuppressionReason;
  }>;

/**
 * Adapter for the Channels core's canonical Account authority/currentness
 * reader. Provider delivery callbacks never decide this policy themselves.
 */
export interface ConversationOutwardDeliveryAuthority {
  checkCurrentness(input: Readonly<{
    record: ConversationOutwardDeliveryRecord;
    signal: AbortSignal;
  }>): Promise<ConversationOutwardDeliveryCurrentnessResult>;
}

/**
 * Re-reads canonical Account rows immediately before provider I/O. Collection
 * callers and the provider Action boundary share the same reader/classification.
 */
export function createConversationOutwardDeliveryCollectionAuthority(input: Readonly<{
  stateCollection: ChannelStateCollection;
}>): ConversationOutwardDeliveryAuthority {
  return {
    async checkCurrentness(check) {
      if (!hasRetainedConversationOutwardDeliveryContent(check.record.obligation)) {
        return { kind: 'suppressed', reason: 'currentnessUnavailable' };
      }
      const result = await checkConversationOutwardDeliveryRouteCurrentness({
        stateCollection: input.stateCollection,
        signal: check.signal,
        obligation: check.record.obligation,
      });
      return normalizeConversationOutwardDeliveryCurrentnessResult(result);
    },
  };
}

/** Both Account adapters preserve transient reads; malformed authority stays terminal. */
export function normalizeConversationOutwardDeliveryCurrentnessResult(value: unknown): ConversationOutwardDeliveryCurrentnessResult {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    if (record.kind === 'current') return { kind: 'current' };
    if (record.kind === 'unavailable') {
      if (record.reason === 'stateUnavailable') return { kind: 'unavailable', reason: 'stateUnavailable' };
      if (record.reason === 'cancelled') return { kind: 'suppressed', reason: 'cancelled' };
    }
    if (record.kind === 'suppressed'
      && typeof record.reason === 'string'
      && CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASON_SET.has(record.reason)) {
      return {
        kind: 'suppressed',
        reason: record.reason as ConversationOutwardDeliverySuppressionReason,
      };
    }
  }
  return { kind: 'suppressed', reason: 'currentnessUnavailable' };
}

/** Cancellation and reader failures have one classification for send and recovery. */
async function readConversationOutwardDeliveryCurrentness(input: Readonly<{
  authority: ConversationOutwardDeliveryAuthority;
  record: ConversationOutwardDeliveryRecord;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryCurrentnessResult> {
  if (input.signal.aborted) return { kind: 'suppressed', reason: 'cancelled' };
  let currentness: ConversationOutwardDeliveryCurrentnessResult;
  try {
    currentness = normalizeConversationOutwardDeliveryCurrentnessResult(await input.authority.checkCurrentness({
      record: input.record,
      signal: input.signal,
    }));
  } catch {
    currentness = { kind: 'unavailable', reason: 'stateUnavailable' };
  }
  return currentness;
}

/** External-effect evidence cannot bind a returned thread to a different mailbox. */
export function normalizeConversationStartedThreadResult(
  obligation: ConversationStoredOutwardDeliveryObligation,
  result: ConversationDeliveryResultV1,
): ConversationDeliveryResultV1 {
  if (obligation.newThread === undefined || (result.kind !== 'delivered' && result.kind !== 'outcomeUnknown')
    || result.endpoint === undefined
    || (result.endpoint.kind === 'thread' && result.endpoint.parentId === obligation.endpoint.id)) return result;
  return { kind: 'outcomeUnknown', ...(result.providerMessageIds === undefined ? {} : { providerMessageIds: result.providerMessageIds }) };
}

/** Invocation-local evidence only; rejoining terminal custody is not a new settlement. */
type ConversationOutwardDeliveryAttemptSettlement = Readonly<{
  custodyId: string;
  operation: 'deliver' | 'reconcile';
  providerResult: ConversationDeliveryResultV1;
}>;

export type ConversationOutwardDeliveryResult =
  | Readonly<{ kind: 'settled'; custody: ConversationDeliveryCustody; attemptSettlement?: ConversationOutwardDeliveryAttemptSettlement }>
  | Readonly<{ kind: 'retired' }>
  | Readonly<{
    kind: 'suppressed';
    reason: ConversationOutwardDeliverySuppressionReason;
    custody: ConversationDeliveryCustody;
  }>
  | Readonly<{
    kind: 'settlementPending';
    custody: ConversationDeliveryCustody;
    providerResult: ConversationDeliveryResultV1;
    attemptSettlement?: ConversationOutwardDeliveryAttemptSettlement;
    suppressionReason?: ConversationOutwardDeliverySuppressionReason;
  }>
  | Readonly<{
    kind: 'notAttempted';
    reason:
      | 'obligationConflict'
      | 'attemptInProgress'
      | 'notDue'
      | 'custodyChangedBeforeAttempt'
      | 'cancelled'
      | 'connectionUnavailable'
      | 'connectionCorrupt'
      | 'custodyUnavailable'
      | ConversationOutwardDeliveryPreCustodyRejection
      | 'invalidRow'
      | 'rowTooLarge';
  }>;

export type ConversationOutwardDeliveryRecoveryResult =
  | Extract<ConversationOutwardDeliveryResult, Readonly<{ kind: 'settled' | 'settlementPending' }>>
  | Readonly<{
    kind: 'notAttempted';
    reason: 'cancelled' | 'notAttempting' | 'custodyUnavailable' | 'invalidRow' | 'rowTooLarge';
  }>;

/** A host-proven pre-handler miss has no provider effect and can suppress custody. */
type ConversationOutwardDeliveryPreEffectSuppression = Readonly<{
  kind: 'suppressedBeforeProviderEffect';
  reason: ConversationOutwardDeliverySuppressionReason;
}>;

export type ConversationOutwardDeliveryProviderInvocationResult =
  | ConversationDeliveryResultV1
  | ConversationOutwardDeliveryPreEffectSuppression;

export function isConversationOutwardDeliveryPreEffectSuppression(
  value: ConversationOutwardDeliveryProviderInvocationResult,
): value is ConversationOutwardDeliveryPreEffectSuppression {
  return value.kind === 'suppressedBeforeProviderEffect';
}

async function persistConversationOutwardDeliveryBeforeProviderEffect(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  attemptId: string;
  reason: ConversationOutwardDeliverySuppressionReason;
}>): Promise<ConversationOutwardDeliveryResult> {
  const suppressed = settleConversationDeliveryBeforeProviderEffect({
    custody: input.record.custody,
    attemptId: input.attemptId,
    reason: input.reason === 'cancelled' ? 'cancelled' : 'policySuppressed',
  });
  if (suppressed.kind === 'staleAttempt') {
    return {
      kind: 'settlementPending',
      custody: input.record.custody,
      providerResult: { kind: 'notDelivered', retry: 'never' },
      suppressionReason: input.reason,
    };
  }
  let persisted: Awaited<ReturnType<ConversationOutwardDeliveryStore['compareAndSwap']>>;
  try {
    persisted = await input.store.compareAndSwap({
      custodyId: input.record.custodyId,
      expectedRevision: input.record.revision,
      custody: suppressed.custody,
    });
  } catch {
    persisted = { kind: 'unavailable', reason: 'storageUnavailable' };
  }
  if (persisted.kind === 'conflict' || persisted.kind === 'invalid' || persisted.kind === 'unavailable') {
    return {
      kind: 'settlementPending',
      custody: suppressed.custody,
      providerResult: { kind: 'notDelivered', retry: 'never' },
      suppressionReason: input.reason,
    };
  }
  if (input.reason === 'cancelled') return { kind: 'notAttempted', reason: 'cancelled' };
  return {
    kind: 'suppressed',
    reason: input.reason,
    custody: persisted.record.custody,
  };
}

/** The only outward delivery path: persist known no-effect or win custody, invoke, then settle. */
export async function deliverConversationOutwardDelivery(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  obligation: ConversationOutwardDeliveryObligation;
  /** A provider-native ceiling when declared; retained rows were already admitted. */
  outboundTextLimit?: ConversationOutboundTextLimit;
  /**
   * The canonical scanner may redrive its exact parsed row without re-running
   * pre-custody admission. It never supplies a synthetic obligation or queue.
   */
  retainedRecord?: ConversationOutwardDeliveryRecord;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
  authority: ConversationOutwardDeliveryAuthority;
  deliver: (input: Readonly<{
    obligation: ConversationOutwardDeliveryObligation;
    signal: AbortSignal;
  }>) => Promise<ConversationOutwardDeliveryProviderInvocationResult>;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  let ensured: Awaited<ReturnType<ConversationOutwardDeliveryStore['ensure']>>;
  if (input.retainedRecord === undefined) {
    const preCustodyRejection = validateConversationOutwardDeliveryBeforeCustody({
      obligation: input.obligation,
      outboundTextLimit: input.outboundTextLimit,
    });
    if (preCustodyRejection !== null) return { kind: 'notAttempted', reason: preCustodyRejection };
    try {
      ensured = await input.store.ensure(input.obligation);
    } catch {
      return {
        kind: 'notAttempted',
        reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
      };
    }
    if (ensured.kind === 'unavailable') {
      return {
        kind: 'notAttempted',
        reason: ensured.reason === 'storageUnavailable' ? 'custodyUnavailable' : ensured.reason,
      };
    }
    if (ensured.kind === 'invalid') {
      return { kind: 'notAttempted', reason: ensured.reason };
    }
    if (ensured.kind === 'conflict') {
      return { kind: 'notAttempted', reason: 'obligationConflict' };
    }
    if (ensured.kind === 'retired') return ensured;
  } else {
    ensured = { kind: 'rejoined', record: input.retainedRecord };
  }

  if (isConversationDeliveryAutomaticTerminal(ensured.record.custody)) {
    return { kind: 'settled', custody: ensured.record.custody };
  }
  if (!hasRetainedConversationOutwardDeliveryContent(ensured.record.obligation)) {
    return { kind: 'notAttempted', reason: 'invalidRow' };
  }

  const started = startConversationDeliveryAttempt({
    custody: ensured.record.custody,
    attemptId: input.attemptId,
    startedAt: input.now(),
  });
  if (started.kind === 'notStartable') {
    return { kind: 'notAttempted', reason: started.reason };
  }
  let claimed: Awaited<ReturnType<ConversationOutwardDeliveryStore['compareAndSwap']>>;
  try {
    claimed = await input.store.compareAndSwap({
      custodyId: ensured.record.custodyId,
      expectedRevision: ensured.record.revision,
      custody: started.custody,
    });
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (claimed.kind === 'unavailable') {
    return {
      kind: 'notAttempted',
      reason: claimed.reason === 'storageUnavailable' ? 'custodyUnavailable' : claimed.reason,
    };
  }
  if (claimed.kind === 'conflict') {
    return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  }
  if (claimed.kind === 'invalid') {
    return { kind: 'notAttempted', reason: claimed.reason };
  }
  if (!hasRetainedConversationOutwardDeliveryContent(claimed.record.obligation)) {
    return { kind: 'notAttempted', reason: 'invalidRow' };
  }

  let currentness = await readConversationOutwardDeliveryCurrentness({
    authority: input.authority, record: claimed.record, signal: input.signal,
  });
  // Check in this continuation: cancellation can win as the reader resolves.
  if (input.signal.aborted) currentness = { kind: 'suppressed', reason: 'cancelled' };

  if (currentness.kind === 'suppressed') {
    return await persistConversationOutwardDeliveryBeforeProviderEffect({
      store: input.store,
      record: claimed.record,
      attemptId: input.attemptId,
      reason: currentness.reason,
    });
  }

  let providerResult: ConversationDeliveryResultV1;
  if (currentness.kind === 'unavailable') {
    // Nothing crossed the provider boundary. The existing custody owner retains
    // content and schedules growing backoff, then rechecks authority next time.
    providerResult = { kind: 'notDelivered', retry: 'safe' };
  } else {
    try {
      const invocation = await input.deliver({
        obligation: claimed.record.obligation,
        signal: input.signal,
      });
      if (isConversationOutwardDeliveryPreEffectSuppression(invocation)) {
        return await persistConversationOutwardDeliveryBeforeProviderEffect({
          store: input.store,
          record: claimed.record,
          attemptId: input.attemptId,
          reason: invocation.reason,
        });
      }
      providerResult = invocation;
    } catch {
      providerResult = { kind: 'outcomeUnknown' };
    }
  }
  const attemptSettlement = { custodyId: claimed.record.custodyId, operation: 'deliver', providerResult } as const;
  const settled = settleConversationDeliveryAttempt({
    custody: claimed.record.custody,
    attemptId: input.attemptId,
    result: normalizeConversationStartedThreadResult(claimed.record.obligation, providerResult),
    now: input.now(),
  });
  if (settled.kind === 'staleAttempt') {
    return {
      kind: 'settlementPending',
      custody: claimed.record.custody,
      providerResult,
      attemptSettlement,
    };
  }
  let persisted: Awaited<ReturnType<ConversationOutwardDeliveryStore['compareAndSwap']>>;
  try {
    persisted = await input.store.compareAndSwap({
      custodyId: claimed.record.custodyId,
      expectedRevision: claimed.record.revision,
      custody: settled.custody,
    });
  } catch {
    persisted = { kind: 'unavailable', reason: 'storageUnavailable' };
  }
  if (persisted.kind === 'conflict' || persisted.kind === 'invalid' || persisted.kind === 'unavailable') {
    return {
      kind: 'settlementPending',
      custody: settled.custody,
      providerResult,
      attemptSettlement,
    };
  }
  return { kind: 'settled', custody: persisted.record.custody, attemptSettlement };
}

/**
 * Reuses the sole custody state machine for a row that was parsed from the
 * canonical deliveries Collection. It deliberately skips only fresh-obligation
 * admission: its existing row remains subject to the same CAS and currentness
 * checks before any provider call.
 */
export async function redriveConversationOutwardDelivery(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
  authority: ConversationOutwardDeliveryAuthority;
  deliver: (input: Readonly<{
    obligation: ConversationOutwardDeliveryObligation;
    signal: AbortSignal;
  }>) => Promise<ConversationOutwardDeliveryProviderInvocationResult>;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return isConversationDeliveryAutomaticTerminal(input.record.custody)
      ? { kind: 'settled', custody: input.record.custody }
      : { kind: 'notAttempted', reason: 'invalidRow' };
  }
  return await deliverConversationOutwardDelivery({
    store: input.store,
    obligation: input.record.obligation,
    retainedRecord: input.record,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: input.authority,
    deliver: input.deliver,
  });
}

/**
 * Reconciles an interrupted attempt without guessing from its age or resending.
 * An unknown result releases ordering and remains visible for owner resolution;
 * a retired invocation cannot replace that retained outcome.
 */
export async function reconcileConversationOutwardDeliveryAttempt(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  now: () => number;
  signal: AbortSignal;
  authority: ConversationOutwardDeliveryAuthority;
  reconcile?: (input: Readonly<{
    obligation: ConversationOutwardDeliveryObligation;
    signal: AbortSignal;
  }>) => Promise<ConversationDeliveryResultV1>;
}>): Promise<ConversationOutwardDeliveryRecoveryResult> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  if (input.record.custody.state !== 'attempting' || input.record.custody.attemptId === undefined) {
    return { kind: 'notAttempted', reason: 'notAttempting' };
  }
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return { kind: 'notAttempted', reason: 'invalidRow' };
  }

  let currentness = await readConversationOutwardDeliveryCurrentness({
    authority: input.authority, record: input.record, signal: input.signal,
  });
  if (input.signal.aborted) currentness = { kind: 'suppressed', reason: 'cancelled' };

  let providerResult: ConversationDeliveryResultV1 = { kind: 'outcomeUnknown' };
  if (currentness.kind === 'current' && input.reconcile !== undefined) {
    try {
      providerResult = await input.reconcile({
        obligation: input.record.obligation,
        signal: input.signal,
      });
    } catch {
      providerResult = { kind: 'outcomeUnknown' };
    }
  }
  const attemptSettlement = { custodyId: input.record.custodyId, operation: 'reconcile', providerResult } as const;
  const settled = settleConversationDeliveryAttempt({
    custody: input.record.custody,
    attemptId: input.record.custody.attemptId,
    result: normalizeConversationStartedThreadResult(input.record.obligation, providerResult),
    now: input.now(),
  });
  if (settled.kind === 'staleAttempt') {
    return { kind: 'settlementPending', custody: input.record.custody, providerResult, attemptSettlement };
  }
  let persisted: Awaited<ReturnType<ConversationOutwardDeliveryStore['compareAndSwap']>>;
  try {
    persisted = await input.store.compareAndSwap({
      custodyId: input.record.custodyId,
      expectedRevision: input.record.revision,
      custody: settled.custody,
    });
  } catch {
    persisted = { kind: 'unavailable', reason: 'storageUnavailable' };
  }
  if (persisted.kind === 'conflict' || persisted.kind === 'invalid' || persisted.kind === 'unavailable') {
    return { kind: 'settlementPending', custody: settled.custody, providerResult, attemptSettlement };
  }
  return { kind: 'settled', custody: persisted.record.custody, attemptSettlement };
}

export function createReadyConversationOutwardDeliveryRecord(input: Readonly<{
  custodyId: string;
  revision: number;
  createdAt: number;
  obligation: ConversationOutwardDeliveryObligation;
}>): ConversationOutwardDeliveryRecord {
  return {
    custodyId: input.custodyId,
    revision: input.revision,
    createdAt: input.createdAt,
    obligation: input.obligation,
    custody: createReadyConversationDeliveryCustody(),
  };
}
