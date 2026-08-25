import type {
  ConversationDeliveryInputV1,
  ConversationDeliveryLinkPreviewPolicyV1,
  ConversationDeliveryMentionPolicyV1,
  ConversationDeliveryReconcileInputV1,
  ConversationOutboundTextUnitV1,
  ConversationDeliveryReplyContextV1,
  ConversationDeliveryResultV1,
  ConversationResolvedEndpointV1,
} from '@happier-dev/channels-protocol/v1';
import {
  areConversationEndpointIdentitiesEqual,
  ConversationBindingTargetV1Schema,
  ConversationBindingIdV1Schema,
  ConversationConnectionIdV1Schema,
  ConversationDeliveryInputV1Schema,
  ConversationDeliveryReconcileInputV1Schema,
  ConversationDeliveryReplyContextV1Schema,
  ConversationDeliveryResultV1Schema,
  ConversationProviderConnectionInputV1Schema,
  ConversationResolvedEndpointV1Schema,
  CONVERSATION_OUTBOUND_TEXT_UNITS_V1,
  MAX_CONVERSATION_DELIVERY_CHUNKS,
  MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES,
  MAX_CONVERSATION_SESSION_IDEMPOTENCY_KEY_UTF8_BYTES,
  countConversationTextUnits,
} from '@happier-dev/channels-protocol/v1';
import {
  AutomationResultDeliverySourceV1Schema,
  type AutomationResultDeliverySourceV1,
} from '@happier-dev/plugin-sdk/automations';
import {
  arePluginMachineExecutionOriginsEqual,
  isPluginError,
  PluginError,
  type TargetedContributionsService,
} from '@happier-dev/plugin-sdk';
import type {
  JsonValue,
} from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  isPluginActionHandlerInvocationKnownNotStarted,
  type AdmittedTargetedOperationExecutionHandle,
  type ActionsService,
  type PluginMachineExecutionOriginV1,
} from '@happier-dev/plugin-sdk/actions';
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
  claimStaleConversationDeliveryAttemptRecovery,
  createReadyConversationDeliveryCustody,
  deriveConversationDeliveryAttention,
  deriveConversationDeliveryProjection,
  isConversationDeliveryAutomaticTerminal,
  isConversationDeliveryRetentionEligible,
  resolveConversationDeliveryCustody,
  retryConversationDeliveryAfterArchiveRecovery,
  settleConversationDeliveryForBindingDeletion,
  settleConversationDeliveryForConnectionDeletion,
  settleConversationDeliveryAttempt,
  settleConversationDeliveryKnownNoEffectBeforeProvider,
  startConversationDeliveryAttempt,
  suppressConversationDeliveryAttempt,
  type ConversationDeliveryCustody,
} from './deliveryCustody.js';
import { hasConversationApprovalPolicyEnabled } from './bindingTransition.js';
import {
  importHmacSha256Key,
  signLengthPrefixedUtf8HmacSha256Base64Url,
  tryDecodeBase64Url,
} from './privateRowIdentity.js';
import { readCurrentProviderContributionForPersistedSelection } from './providerContributions.js';
import type { PersistedConversationProviderContributionSelection } from './collections.js';
import type {
  ConversationSessionProjectionBinding,
  ConversationSessionProjectionSource,
} from './sessionProjection.js';
import type { ConversationPendingPermissionRequest } from './permissionMediation.js';

/**
 * Loading the collection definition during generic delivery-module evaluation
 * creates an ESM initialization cycle through the contract package. The
 * concrete adapter loads the canonical declaration only when it is invoked.
 */
type ConversationCollectionsModule = typeof import('./collections.js');
type ConversationAccountLocalBindingPolicyModule = typeof import('./accountLocalBindingPolicy.js');

let conversationCollectionsModulePromise: Promise<ConversationCollectionsModule> | undefined;
let conversationAccountLocalBindingPolicyModulePromise: Promise<ConversationAccountLocalBindingPolicyModule> | undefined;

function loadConversationCollectionsModule(): Promise<ConversationCollectionsModule> {
  conversationCollectionsModulePromise ??= import('./collections.js');
  return conversationCollectionsModulePromise;
}

function loadConversationAccountLocalBindingPolicyModule(): Promise<ConversationAccountLocalBindingPolicyModule> {
  conversationAccountLocalBindingPolicyModulePromise ??= import('./accountLocalBindingPolicy.js');
  return conversationAccountLocalBindingPolicyModulePromise;
}

export type ConversationControlResponseKind =
  | 'pairing'
  | 'newSession'
  | 'approval'
  | 'userAction'
  | 'refusal'
  | 'recovery';

/**
 * The sole persisted route authority union. Its arm is correlated with the
 * existing binding ID: a connection-owned response has only the connection
 * epoch; a binding-owned response additionally freezes its admission revision
 * and authority epoch. Automation target facts belong exclusively to source.
 */
export type ConversationOutwardDeliveryConnectionRouteAuthority = Readonly<{
  connectionAuthorityEpoch: number;
}>;

export type ConversationOutwardDeliveryBindingRouteAuthority = Readonly<{
  connectionAuthorityEpoch: number;
  bindingRevision: number;
  bindingAuthorityEpoch: number;
}>;

export type ConversationOutwardDeliveryRouteAuthority =
  | ConversationOutwardDeliveryConnectionRouteAuthority
  | ConversationOutwardDeliveryBindingRouteAuthority;

/** The closed source identity carried by every Channels outward effect. */
export type ConversationOutwardSourceV1 =
  | Readonly<{ kind: 'sessionProjection'; sessionId: string; semanticItemId: string }>
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
  content: string;
  deliveryKey: string;
  replyContext?: ConversationDeliveryReplyContextV1;
  mentionPolicy: ConversationDeliveryMentionPolicyV1;
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
 * A compacted custody row retains only a keyed equality proof, never the
 * outbound body. It remains distinct from an admission obligation: callers
 * can construct only a body-bearing obligation for a new provider effect.
 */
type ConversationStoredOutwardDeliveryObligation =
  | ConversationOutwardDeliveryObligation
  | (Omit<ConversationOutwardDeliveryObligationCommon, 'content'>
    & ConversationOutwardDeliveryRoute
    & Readonly<{
      content: null;
      contentFingerprint: string;
    }>);

/** Compatibility view for C2 control-response callers; it uses the same owner. */
export type ConversationControlResponseObligation = ConversationOutwardDeliveryObligation & Readonly<{
  source: Extract<ConversationOutwardSourceV1, Readonly<{ kind: 'controlResponse' }>>;
}>;

export type ConversationOutwardDeliveryRecord = Readonly<{
  /** Opaque physical Account-Collection row ID; never caller supplied. */
  custodyId: string;
  revision: number;
  createdAt: number;
  obligation: ConversationStoredOutwardDeliveryObligation;
  custody: ConversationDeliveryCustody;
}>;

export interface ConversationOutwardDeliveryStore {
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
  /** Logically retires one exact terminal custody row under its live revision. */
  retire(input: Readonly<{
    custodyId: string;
    expectedRevision: number;
  }>): Promise<
    | Readonly<{ kind: 'retired' }>
    | Readonly<{ kind: 'conflict' }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  >;
}

export type ConversationOutboundTextLimit = Readonly<{
  maximum: number;
  unit: ConversationOutboundTextUnitV1;
}>;

export type ConversationOutwardDeliveryPreCustodyRejection =
  | 'invalidObligation'
  | 'invalidOutboundTextLimit'
  | 'contentUtf8LimitExceeded'
  | 'providerChunkLimitExceeded';

type ConversationOutwardDeliveryKnownNoEffect = Extract<
  ConversationOutwardDeliveryPreCustodyRejection,
  'contentUtf8LimitExceeded' | 'providerChunkLimitExceeded'
>;

function isConversationOutwardDeliveryKnownNoEffect(
  rejection: ConversationOutwardDeliveryPreCustodyRejection,
): rejection is ConversationOutwardDeliveryKnownNoEffect {
  return rejection === 'contentUtf8LimitExceeded' || rejection === 'providerChunkLimitExceeded';
}

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
  if (input.bindingId === undefined) {
    return hasExactKeys(authority, ['connectionAuthorityEpoch'])
      && isPositiveSafeInteger(authority.connectionAuthorityEpoch);
  }
  return hasExactKeys(authority, [
    'connectionAuthorityEpoch',
    'bindingRevision',
    'bindingAuthorityEpoch',
  ])
    && isPositiveSafeInteger(authority.connectionAuthorityEpoch)
    && isPositiveSafeInteger(authority.bindingRevision)
    && isPositiveSafeInteger(authority.bindingAuthorityEpoch);
}

export function isConversationOutwardSourceV1(source: unknown): source is ConversationOutwardSourceV1 {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return false;
  const sourceRecord = source as Readonly<Record<string, unknown>>;
  switch (sourceRecord.kind) {
    case 'sessionProjection':
      return hasExactKeys(sourceRecord, ['kind', 'sessionId', 'semanticItemId'])
        && hasBoundedSourceId(sourceRecord.sessionId)
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
  outboundTextLimit: ConversationOutboundTextLimit;
}>): ConversationOutwardDeliveryPreCustodyRejection | null {
  const { obligation, outboundTextLimit } = input;
  if (typeof obligation.content !== 'string'
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
    || obligation.content.length === 0) {
    return 'invalidObligation';
  }
  if (!Number.isSafeInteger(outboundTextLimit.maximum) || outboundTextLimit.maximum < 1) {
    return 'invalidOutboundTextLimit';
  }
  if (!CONVERSATION_OUTBOUND_TEXT_UNITS_V1.includes(outboundTextLimit.unit)) {
    return 'invalidOutboundTextLimit';
  }
  const contentUtf8Bytes = countConversationTextUnits(obligation.content, 'utf8Bytes');
  if (contentUtf8Bytes > MAX_CONVERSATION_DELIVERY_TEXT_UTF8_BYTES) {
    return 'contentUtf8LimitExceeded';
  }
  const providerUnits = countConversationTextUnits(obligation.content, outboundTextLimit.unit);
  const maximumCompleteItemUnits = outboundTextLimit.maximum
    > Math.floor(Number.MAX_SAFE_INTEGER / MAX_CONVERSATION_DELIVERY_CHUNKS)
    ? Number.MAX_SAFE_INTEGER
    : outboundTextLimit.maximum * MAX_CONVERSATION_DELIVERY_CHUNKS;
  return providerUnits > maximumCompleteItemUnits ? 'providerChunkLimitExceeded' : null;
}

type JsonRecord = Readonly<Record<string, JsonValue>>;
type StoredCollectionRow = Readonly<{
  rowId: string;
  revision: number;
  value: JsonValue;
}>;
type ChannelStateCollection = Pick<
  PluginAccountCollectionForDefinition<ConversationCollectionsModule['CHANNEL_STATE_COLLECTION']>,
  'get'
>;
type ChannelDeliveriesCollection = Pick<
  PluginAccountCollectionForDefinition<ConversationCollectionsModule['CHANNEL_DELIVERIES_COLLECTION']>,
  'delete' | 'get' | 'put' | 'query'
>;

/**
 * The privacy-safe projection used by mounted management UI. It deliberately
 * keeps endpoint, content, provider evidence, and delivery identity inside the
 * Account envelope while exposing only the exact CAS facts for a resolution.
 */
export type ConversationOutwardDeliveryResolutionRow = Readonly<{
  custodyId: string;
  revision: number;
  state: 'partial' | 'outcomeUnknown' | 'archiveRecoverable';
}>;

export type ConversationOutwardDeliveryResolutionPage = Readonly<{
  rows: readonly ConversationOutwardDeliveryResolutionRow[];
  nextCursor?: string;
}>;

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

/**
 * The present-user decisions the custody owner supports. `retryAfterUnarchive`
 * is the owner-led recovery arm for an authoritative archived-endpoint refusal:
 * the provider proved no effect, so the exact obligation may be reopened.
 */
export type ConversationDeliveryResolutionDecision =
  | 'accepted'
  | 'discarded'
  | 'retryAfterUnarchive';

function isDeliveryResolution(value: unknown): value is ConversationDeliveryResolutionDecision {
  return value === 'accepted' || value === 'discarded' || value === 'retryAfterUnarchive';
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
  deliveriesCollection: ChannelDeliveriesCollection;
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

function compareCanonicalChannelRelationId(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceIdentityParts(source: ConversationOutwardSourceV1): readonly string[] {
  switch (source.kind) {
    case 'sessionProjection':
      return [source.kind, source.sessionId, source.semanticItemId];
    case 'automationResult':
      return [
        source.kind,
        source.automationRunId,
        source.resultId,
        source.automationId,
        String(source.templateVersion),
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

async function deriveConversationOutwardDeliveryCustodyId(input: Readonly<{
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

function hasRetainedConversationOutwardDeliveryContent(
  obligation: ConversationStoredOutwardDeliveryObligation,
): obligation is ConversationOutwardDeliveryObligation {
  return typeof obligation.content === 'string';
}

async function deriveConversationOutwardDeliveryContentFingerprint(input: Readonly<{
  routingIdentityKey: string;
  content: string;
}>): Promise<string | null> {
  const keyMaterial = decodeBase64Url(input.routingIdentityKey);
  const subtle = globalThis.crypto?.subtle;
  if (keyMaterial === null || subtle === undefined) return null;
  try {
    const key = await importHmacSha256Key(subtle, keyMaterial);
    return await signLengthPrefixedUtf8HmacSha256Base64Url({
      subtle,
      key,
      parts: ['channels:outward-delivery-content:v1', input.content],
    });
  } catch {
    return null;
  }
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
    && left.mentionPolicy === right.mentionPolicy
    && left.linkPreviewPolicy === right.linkPreviewPolicy
    && pluginJsonValuesEqual(left.endpoint, right.endpoint)
    && pluginJsonValuesEqual(left.replyContext ?? null, right.replyContext ?? null)
    && pluginJsonValuesEqual(left.routeAuthority, right.routeAuthority);
}

async function matchesConversationOutwardDeliveryObligation(input: Readonly<{
  stored: ConversationStoredOutwardDeliveryObligation;
  storedCustody: ConversationDeliveryCustody;
  incoming: ConversationOutwardDeliveryObligation;
  routingIdentityKey: string;
}>): Promise<boolean> {
  const terminal = isConversationDeliveryAutomaticTerminal(input.storedCustody);
  if (terminal
    ? !sameConversationOutwardDeliveryCustodyIdentity(input.stored, input.incoming)
    : !sameConversationOutwardDeliveryLiveObligation(input.stored, input.incoming)) return false;
  if (hasRetainedConversationOutwardDeliveryContent(input.stored)) {
    return input.stored.content === input.incoming.content;
  }
  const fingerprint = await deriveConversationOutwardDeliveryContentFingerprint({
    routingIdentityKey: input.routingIdentityKey,
    content: input.incoming.content,
  });
  return fingerprint !== null && fingerprint === input.stored.contentFingerprint;
}

function shouldCompactConversationOutwardDeliveryContent(custody: ConversationDeliveryCustody): boolean {
  return isConversationDeliveryRetentionEligible(custody)
    && retryConversationDeliveryAfterArchiveRecovery({ custody }).kind !== 'retryReady';
}

function readConversationDeliveryCustody(input: Readonly<{
  payload: JsonRecord;
  retryNotBefore: JsonValue | undefined;
}>): ConversationDeliveryCustody | null {
  const { payload: value } = input;
  const state = value.state;
  const attemptCount = value.attemptCount;
  const attemptId = value.attemptId;
  const startedAt = value.startedAt;
  const providerMessageIds = value.providerMessageIds;
  const failedChunk = value.failedChunk;
  const archiveRecovery = value.archiveRecovery;
  if (typeof state !== 'string'
    || !(CONVERSATION_DELIVERY_CUSTODY_STATES as readonly string[]).includes(state)
    || typeof attemptCount !== 'number'
    || !Number.isSafeInteger(attemptCount)
    || attemptCount < 0
    || !Array.isArray(providerMessageIds)
    || !providerMessageIds.every((id) => typeof id === 'string')
    || (attemptId !== null && typeof attemptId !== 'string')
    || (startedAt !== null && !isNonNegativeSafeInteger(startedAt))
    || (failedChunk !== null && !isNonNegativeSafeInteger(failedChunk))
    || (archiveRecovery !== null && typeof archiveRecovery !== 'string')) {
    return null;
  }
  const retryNotBefore = input.retryNotBefore;
  if (retryNotBefore !== undefined && !isNonNegativeSafeInteger(retryNotBefore)) return null;
  return {
    state,
    attemptCount,
    providerMessageIds,
    ...(attemptId === null ? {} : { attemptId }),
    ...(startedAt === null ? {} : { startedAt }),
    ...(failedChunk === null ? {} : { failedChunk }),
    ...(retryNotBefore === undefined ? {} : { retryNotBefore }),
    ...(archiveRecovery === null ? {} : { archiveRecovery }),
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
  const source = payload.source;
  const bindingId = row.value[collections.CHANNEL_DELIVERIES_FIELD.bindingId];
  const content = payload.content;
  const contentFingerprint = payload.contentFingerprint;
  if (!isConversationOutwardSourceV1(source)
    || (typeof content !== 'string' && content !== null)
    || (typeof content === 'string' && contentFingerprint !== undefined && contentFingerprint !== null)
    || typeof payload.deliveryKey !== 'string'
    || typeof payload.mentionPolicy !== 'string'
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
  const projection = deriveConversationDeliveryProjection(custody);
  if (row.value[collections.CHANNEL_DELIVERIES_FIELD.terminal] !== projection.terminal
    || row.value[collections.CHANNEL_DELIVERIES_FIELD.attention] !== projection.attention
    || row.value[collections.CHANNEL_DELIVERIES_FIELD.retryNotBefore] !== projection.retryNotBefore) {
    return null;
  }
  if (content === null) {
    if (
      typeof contentFingerprint !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/u.test(contentFingerprint)
      || !shouldCompactConversationOutwardDeliveryContent(custody)
    ) return null;
    const obligation: ConversationStoredOutwardDeliveryObligation = bindingId === undefined
      ? {
        connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
        routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryConnectionRouteAuthority,
        source,
        endpoint: endpoint.data,
        content: null,
        contentFingerprint,
        deliveryKey: payload.deliveryKey,
        ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),
        mentionPolicy: payload.mentionPolicy as ConversationDeliveryMentionPolicyV1,
        linkPreviewPolicy: payload.linkPreviewPolicy as ConversationDeliveryLinkPreviewPolicyV1,
      }
      : {
        connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
        bindingId: bindingId as string,
        routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryBindingRouteAuthority,
        source,
        endpoint: endpoint.data,
        content: null,
        contentFingerprint,
        deliveryKey: payload.deliveryKey,
        ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),
        mentionPolicy: payload.mentionPolicy as ConversationDeliveryMentionPolicyV1,
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
  const obligation: ConversationStoredOutwardDeliveryObligation = bindingId === undefined
    ? {
      connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
      routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryConnectionRouteAuthority,
      source,
      endpoint: endpoint.data,
      content,
      deliveryKey: payload.deliveryKey,
      ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),
      mentionPolicy: payload.mentionPolicy as ConversationDeliveryMentionPolicyV1,
      linkPreviewPolicy: payload.linkPreviewPolicy as ConversationDeliveryLinkPreviewPolicyV1,
    }
    : {
      connectionId: row.value[collections.CHANNEL_DELIVERIES_FIELD.connectionId] as string,
      bindingId: bindingId as string,
      routeAuthority: payload.routeAuthority as ConversationOutwardDeliveryBindingRouteAuthority,
      source,
      endpoint: endpoint.data,
      content,
      deliveryKey: payload.deliveryKey,
      ...(replyContext.data === undefined ? {} : { replyContext: replyContext.data }),
      mentionPolicy: payload.mentionPolicy as ConversationDeliveryMentionPolicyV1,
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
      contentFingerprint: input.obligation.content === null
        ? input.obligation.contentFingerprint
        : null,
      deliveryKey: input.obligation.deliveryKey,
      replyContext: input.obligation.replyContext ?? null,
      mentionPolicy: input.obligation.mentionPolicy,
      linkPreviewPolicy: input.obligation.linkPreviewPolicy,
      state: input.custody.state,
      attemptCount: input.custody.attemptCount,
      attemptId: input.custody.attemptId ?? null,
      startedAt: input.custody.startedAt ?? null,
      providerMessageIds: input.custody.providerMessageIds,
      failedChunk: input.custody.failedChunk ?? null,
      archiveRecovery: input.custody.archiveRecovery ?? null,
    },
  };
}

/**
 * Reads one bounded page from the existing owner/attention index. This is not
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
      index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
      prefix: [input.connectionId],
      order: 'asc',
      limit,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
    }, input.signal === undefined ? undefined : { signal: input.signal });
  } catch {
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
      revision: record.revision,
      state,
    });
  }
  return {
    rows,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
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
  signal?: AbortSignal;
  assertCurrent?: () => void;
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
  let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  try {
    collections = await loadConversationCollectionsModule();
    accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
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
  const transition = input.resolution === 'retryAfterUnarchive'
    ? retryConversationDeliveryAfterArchiveRecovery({ custody: record.custody })
    : resolveConversationDeliveryCustody({
      custody: record.custody,
      resolution: input.resolution,
    });
  if (transition.kind !== 'resolved' && transition.kind !== 'retryReady') {
    throw resolutionError(
      'channels_delivery_resolve_not_resolvable',
      'Delivery resolution requires a partial, unknown, or archive-recoverable custody state.',
    );
  }

  const obligation = await compactConversationOutwardDeliveryObligation({
    obligation: record.obligation,
    custody: transition.custody,
    stateCollection: input.stateCollection,
    accountLocalBindingPolicy,
    signal: input.signal ?? new AbortController().signal,
  });
  if (obligation === undefined) {
    throw resolutionError(
      'channels_delivery_resolve_unavailable',
      'Delivery resolution cannot safely compact its retained custody content.',
      true,
    );
  }

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
  }>): Promise<
    | Readonly<{ kind: 'found'; record: ConversationOutwardDeliveryRecord; updatedAt: number }>
    | Readonly<{ kind: 'missing' }>
    | Readonly<{ kind: 'invalid' }>
    | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'storageUnavailable' }>
  > => {
    if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    try {
      const row = await input.deliveriesCollection.get(readInput.custodyId, { signal: input.signal });
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
        reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
      };
    }
  };

  return {
    async ensure(obligation) {
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
      } catch (error) {
        return {
          kind: 'unavailable',
          reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
        };
      }
      if (connection === null) return { kind: 'unavailable', reason: 'connectionUnavailable' };
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
      const existing = await readDelivery({ collections, custodyId });
      if (existing.kind === 'unavailable') return existing;
      if (existing.kind === 'invalid') return { kind: 'invalid', reason: 'invalidRow' };
      if (existing.kind === 'found') {
        return await matchesConversationOutwardDeliveryObligation({
          stored: existing.record.obligation,
          storedCustody: existing.record.custody,
          incoming: obligation,
          routingIdentityKey: connectionFacts.routingIdentityKey,
        })
          ? { kind: 'rejoined', record: existing.record }
          : { kind: 'conflict' };
      }

      const createdAt = now();
      const value = serializeConversationOutwardDeliveryRecord({
        collections,
        custodyId,
        obligation,
        custody: createReadyConversationDeliveryCustody(),
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
        const rejoined = await readDelivery({ collections, custodyId });
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
          routingIdentityKey: connectionFacts.routingIdentityKey,
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
      const existing = await readDelivery({ collections, custodyId: cas.custodyId });
      if (existing.kind === 'unavailable') return existing;
      if (existing.kind === 'invalid') return { kind: 'invalid', reason: 'invalidRow' };
      if (existing.kind === 'missing' || existing.record.revision !== cas.expectedRevision) {
        return { kind: 'conflict' };
      }
      let obligation = existing.record.obligation;
      if (shouldCompactConversationOutwardDeliveryContent(cas.custody)) {
        let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
        try {
          accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
        } catch {
          return { kind: 'unavailable', reason: 'storageUnavailable' };
        }
        const compacted = await compactConversationOutwardDeliveryObligation({
          obligation,
          custody: cas.custody,
          stateCollection: input.stateCollection,
          accountLocalBindingPolicy,
          signal: input.signal,
        });
        if (compacted === undefined) {
          return {
            kind: 'unavailable',
            reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
          };
        }
        obligation = compacted;
      }
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
          signal: input.signal,
        });
        const record = readConversationOutwardDeliveryRecord({
          collections,
          row: row as unknown as StoredCollectionRow,
        });
        return record === null
          ? { kind: 'invalid', reason: 'invalidRow' }
          : { kind: 'updated', record };
      } catch {
        return input.signal.aborted
          ? { kind: 'unavailable', reason: 'cancelled' }
          : { kind: 'conflict' };
      }
    },
    async retire(retireInput) {
      if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
      try {
        await input.deliveriesCollection.delete(retireInput.custodyId, {
          expectedRevision: retireInput.expectedRevision,
          signal: input.signal,
        });
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
        for (const row of page.rows) {
          const record = readConversationOutwardDeliveryRecord({
            collections,
            row: row as unknown as StoredCollectionRow,
          });
          if (record === null) continue;
          if (record.custody.state === 'ready' || record.custody.state === 'attempting') {
            records.push(record);
            continue;
          }
          if (record.custody.state === 'retryDue'
            && (record.custody.retryNotBefore === undefined || record.custody.retryNotBefore <= scanInput.now)) {
            records.push(record);
          }
        }
        return {
          kind: 'ready',
          records,
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
    return settled.kind === 'retained' || settled.custody.state === record.custody.state
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
      if (settled.kind === 'retained' || settled.custody.state === record.custody.state) continue;
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
      if (custody.state === 'delivered'
        || custody.state === 'resolvedAccepted'
        || custody.state === 'resolvedDiscarded'
        || custody.state === 'connectionDeleted') {
        return { kind: 'retained' };
      }
      const settled = settleConversationDeliveryForConnectionDeletion({ custody });
      return settled.kind === 'notDeletable'
        ? { kind: 'blocked', reason: settled.reason }
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
        : settled.kind === 'retained'
          ? settled
          : { kind: 'replace', custody: settled.custody };
    },
  });
}

/**
 * Derives management-safe delivery attention from the canonical custody rows.
 * `byOwnerAttention` is the declared owner index for this connection-scoped
 * read; this projection deliberately retains neither a cache nor a summary
 * row, so a fresh Resource read cannot report stale delivery health.
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
          index: collections.CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention,
          prefix: [connectionId],
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
 * The single reader-side test for the one recovery arm the custody owner will
 * actually reset. Every surface that offers the retry, and the retry itself,
 * agree through `retryConversationDeliveryAfterArchiveRecovery`.
 */
function isConversationDeliveryArchiveRecoverable(custody: ConversationDeliveryCustody): boolean {
  return retryConversationDeliveryAfterArchiveRecovery({ custody }).kind === 'retryReady';
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

export type ConversationOutwardDeliveryReadyPreparation =
  | Readonly<{
    kind: 'ready';
    obligation: ConversationOutwardDeliveryObligation;
    outboundTextLimit: ConversationOutboundTextLimit;
    /**
     * The provider limit was read from the current route and proves that this
     * custody can never cross a provider boundary. It remains a custody fact,
     * rather than making the source caller keep retrying an invalid request.
     */
    knownNoEffect?: ConversationOutwardDeliveryKnownNoEffect;
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
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt';
  }>;

export type ConversationOutwardDeliveryReadyAcceptance =
  | Readonly<{
    kind: 'accepted';
    custodyId: string;
    custody: ConversationDeliveryCustody;
  }>
  | Readonly<{ kind: 'retired' }>
  | Extract<ConversationOutwardDeliveryReadyPreparation, Readonly<{ kind: 'suppressed' }>>
  | Extract<ConversationOutwardDeliveryReadyPreparation, Readonly<{ kind: 'invalid' }>>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt' | 'storageUnavailable';
  }>;

type ConversationOutwardDeliveryConnectionFacts = Readonly<{
  revision: number;
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'pendingStopReconciliation' | 'finalizingDelete';
  credentialRef: JsonValue | null;
  transportOrigin: PluginMachineExecutionOriginV1;
  routingIdentityKey: string;
  outboundTextLimit: ConversationOutboundTextLimit;
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
  authorityEpoch: number;
  enabled: boolean;
  deletionState: 'none' | 'finalizingDelete';
  endpoint: ConversationResolvedEndpointV1;
  target: JsonValue;
  linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1 | undefined;
}>;

/**
 * Projects the one canonical retained-connection reader for outward custody.
 * This consumer never accepts a partial row or downgrades missing provider
 * authority to an optional action: corrupt durable state is unavailable before
 * ready custody, identity derivation, or provider I/O can begin.
 */
function readConnectionFacts(input: Readonly<{
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
  const outboundTextLimit = payload.outboundTextLimit;
  const providerConnection = ConversationProviderConnectionInputV1Schema.safeParse({
    v: 1,
    connectionId: input.connectionId,
    providerConnectionKey: payload.providerConnectionKey,
    providerConfigVersion: payload.providerConfigVersion,
    providerConfig: payload.providerConfig,
    credentialRef: payload.credentialRef,
  });
  if (!isJsonRecord(outboundTextLimit)
    || typeof outboundTextLimit.maximum !== 'number'
    || !Number.isSafeInteger(outboundTextLimit.maximum)
    || outboundTextLimit.maximum < 1
    || typeof outboundTextLimit.unit !== 'string'
    || !CONVERSATION_OUTBOUND_TEXT_UNITS_V1.includes(
      outboundTextLimit.unit as ConversationOutboundTextUnitV1,
    )
    || !providerConnection.success
    || connection.providerPluginId !== connection.transportOrigin.materializationRef.pluginId) return null;
  return {
    revision: input.row.revision,
    authorityEpoch: connection.lifecycle.authorityEpoch,
    enabled: connection.lifecycle.enabled,
    deletionState: connection.lifecycle.deletionState,
    credentialRef: providerConnection.data.credentialRef,
    transportOrigin: connection.transportOrigin,
    routingIdentityKey: connection.routingIdentityKey,
    outboundTextLimit: {
      maximum: outboundTextLimit.maximum,
      unit: outboundTextLimit.unit as ConversationOutboundTextUnitV1,
    },
    providerAction: {
      providerPluginId: connection.providerPluginId,
      providerContributionSelection: connection.providerContributionSelection,
      providerConnectionKey: providerConnection.data.providerConnectionKey,
      providerConfigVersion: providerConnection.data.providerConfigVersion,
      providerConfig: providerConnection.data.providerConfig,
    },
  };
}

async function compactConversationOutwardDeliveryObligation(input: Readonly<{
  obligation: ConversationStoredOutwardDeliveryObligation;
  custody: ConversationDeliveryCustody;
  stateCollection: ChannelStateCollection;
  accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  signal: AbortSignal;
}>): Promise<ConversationStoredOutwardDeliveryObligation | undefined> {
  if (!shouldCompactConversationOutwardDeliveryContent(input.custody)) return input.obligation;
  if (!hasRetainedConversationOutwardDeliveryContent(input.obligation)) return input.obligation;
  let connection: StoredCollectionRow | null;
  try {
    connection = await input.stateCollection.get(
      input.obligation.connectionId,
      { signal: input.signal },
    ) as unknown as StoredCollectionRow | null;
  } catch {
    return undefined;
  }
  if (connection === null) return undefined;
  const facts = readConnectionFacts({
    accountLocalBindingPolicy: input.accountLocalBindingPolicy,
    row: connection,
    connectionId: input.obligation.connectionId,
  });
  if (facts === null) return undefined;
  const contentFingerprint = await deriveConversationOutwardDeliveryContentFingerprint({
    routingIdentityKey: facts.routingIdentityKey,
    content: input.obligation.content,
  });
  if (contentFingerprint === null) return undefined;
  return { ...input.obligation, content: null, contentFingerprint };
}

function readBindingFacts(input: Readonly<{
  collections: ConversationCollectionsModule;
  row: StoredCollectionRow;
  bindingId: string;
}>): ConversationOutwardDeliveryBindingFacts | null {
  const { collections, row, bindingId } = input;
  if (!isJsonRecord(row.value)
    || row.value[collections.CHANNEL_STATE_FIELD.recordKind]
      !== collections.CHANNEL_STATE_RECORD_KIND.binding
    || row.value[collections.CHANNEL_STATE_FIELD.id] !== bindingId
    || row.value[collections.CHANNEL_STATE_FIELD.bindingId] !== bindingId
    || typeof row.value[collections.CHANNEL_STATE_FIELD.connectionId] !== 'string'
    || !isJsonRecord(row.value.payload)) return null;
  const authorityEpoch = row.value.payload.authorityEpoch;
  const enabled = row.value.payload.enabled;
  const deletionState = row.value.payload.deletionState;
  const endpoint = ConversationResolvedEndpointV1Schema.safeParse(row.value.payload.endpoint);
  const linkPreviewPolicy = row.value.payload.linkPreviewPolicy;
  if (!isNonNegativeSafeInteger(authorityEpoch)
    || authorityEpoch < 1
    || typeof enabled !== 'boolean'
    || (deletionState !== 'none' && deletionState !== 'finalizingDelete')
    || !endpoint.success) return null;
  return {
    revision: row.revision,
    connectionId: row.value[collections.CHANNEL_STATE_FIELD.connectionId] as string,
    authorityEpoch,
    enabled,
    deletionState,
    endpoint: endpoint.data,
    target: row.value.payload.target,
    linkPreviewPolicy: linkPreviewPolicy === 'suppress' || linkPreviewPolicy === 'providerDefault'
      ? linkPreviewPolicy
      : undefined,
  };
}

type ConversationOutwardDeliveryRouteCurrentness =
  | Readonly<{
    kind: 'current';
    outboundTextLimit: ConversationOutboundTextLimit;
    connection: ConversationOutwardDeliveryConnectionFacts;
  }>
  | Readonly<{
    kind: 'suppressed';
    reason: ConversationOutwardDeliverySuppressionReason;
  }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt';
  }>;

function matchesAutomationTarget(input: Readonly<{
  current: JsonValue;
  expected: Extract<ConversationOutwardSourceV1, Readonly<{ kind: 'automationResult' }>>;
}>): boolean {
  const current = ConversationBindingTargetV1Schema.safeParse(input.current);
  if (!current.success
    || current.data.kind !== 'automation'
    || current.data.automationId !== input.expected.automationId
    || current.data.templateVersion !== input.expected.templateVersion
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
 * The one collection-currentness owner. Initial ready-custody admission also
 * checks the frozen row revision; re-drive deliberately does not, because a
 * display-only edit may change a Collection revision without changing the
 * endpoint, target, or semantic authority epochs.
 */
async function checkConversationOutwardDeliveryRouteCurrentness(input: Readonly<{
  stateCollection: ChannelStateCollection;
  signal: AbortSignal;
  obligation: ConversationOutwardDeliveryObligation;
  requireBindingRevision: boolean;
}>): Promise<ConversationOutwardDeliveryRouteCurrentness> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return { kind: 'unavailable', reason: 'stateUnavailable' };
  }
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
  // The current credential and host-stamped transport origin are deliberately
  // re-read from the canonical connection row here. They are not copied into
  // a custody obligation; a credential/origin change advances this authority
  // epoch, while an unavailable or malformed current value fails closed above.
  if (input.obligation.routeAuthority.connectionAuthorityEpoch !== connection.authorityEpoch) {
    return { kind: 'suppressed', reason: 'staleAuthority' };
  }
  if (input.obligation.bindingId === undefined) {
    return input.signal.aborted
      ? { kind: 'unavailable', reason: 'cancelled' }
      : {
        kind: 'current',
        outboundTextLimit: connection.outboundTextLimit,
        connection,
      };
  }

  const routeAuthority = input.obligation.routeAuthority;
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
  const binding = readBindingFacts({
    collections,
    row: bindingRow,
    bindingId: input.obligation.bindingId,
  });
  if (binding === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (!binding.enabled || binding.deletionState !== 'none') {
    return { kind: 'suppressed', reason: 'bindingDisabled' };
  }
  if (binding.connectionId !== input.obligation.connectionId
    || routeAuthority.bindingAuthorityEpoch !== binding.authorityEpoch
    || (input.requireBindingRevision && routeAuthority.bindingRevision !== binding.revision)) {
    return { kind: 'suppressed', reason: 'staleAuthority' };
  }
  if (!areConversationEndpointIdentitiesEqual(input.obligation.endpoint, binding.endpoint)) {
    return { kind: 'suppressed', reason: 'audienceChanged' };
  }
  if (binding.linkPreviewPolicy === undefined) {
    return { kind: 'unavailable', reason: 'stateCorrupt' };
  }
  if (input.obligation.linkPreviewPolicy !== binding.linkPreviewPolicy) {
    return { kind: 'suppressed', reason: 'staleAuthority' };
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
  return input.signal.aborted
    ? { kind: 'unavailable', reason: 'cancelled' }
    : {
      kind: 'current',
      outboundTextLimit: connection.outboundTextLimit,
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
  }>
  | Readonly<{ kind: 'notEligible' }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'cancelled' | 'stateUnavailable' | 'stateCorrupt';
  }>;

type CurrentConversationPermissionWaitMediationSource = Extract<
  ConversationPermissionWaitMediationSourceReadResult,
  Readonly<{ kind: 'ready' }>
> & Readonly<{
  bindingRevision: number;
  endpoint: ConversationResolvedEndpointV1;
  linkPreviewPolicy: ConversationDeliveryLinkPreviewPolicyV1;
  routingIdentityKey: string;
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
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return { kind: 'unavailable', reason: 'stateUnavailable' };
  }
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
  const binding = readBindingFacts({
    collections,
    row: bindingRow,
    bindingId: input.bindingId,
  });
  if (binding === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (!binding.enabled || binding.deletionState !== 'none') return { kind: 'notEligible' };
  if (binding.linkPreviewPolicy === undefined) {
    return { kind: 'unavailable', reason: 'stateCorrupt' };
  }
  const target = ConversationBindingTargetV1Schema.safeParse(binding.target);
  if (!target.success) return { kind: 'unavailable', reason: 'stateCorrupt' };
  if (target.data.kind !== 'session' || !hasConversationApprovalPolicyEnabled(target.data)) {
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
    source: {
      connectionId: binding.connectionId,
      bindingId: input.bindingId,
      sessionId: target.data.sessionId,
      sourceRef: `channels:binding:${input.bindingId}`,
      sourceRevisionOrEpoch: `${connection.authorityEpoch}:${binding.authorityEpoch}`,
      connectionAuthorityEpoch: connection.authorityEpoch,
      bindingAuthorityEpoch: binding.authorityEpoch,
    },
    bindingRevision: binding.revision,
    endpoint: binding.endpoint,
    linkPreviewPolicy: binding.linkPreviewPolicy,
    routingIdentityKey: connection.routingIdentityKey,
  };
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
    ? { kind: 'ready', source: current.source }
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
  if (request.kind === 'legacy_permission') {
    // The predecessor projection did not publish a semantic summary. Keep its
    // released, opaque permission wording rather than treating it as a
    // user-action or fabricating details Channels never received.
    return 'This Session is waiting for an approval in Happier. '
      + `Reply /allow ${request.requestId} or /deny ${request.requestId}.`;
  }
  if (request.kind === 'permission') {
    const summary = request.agentRequestSummary;
    return `${summary.title}\n${summary.detail}\n`
      + `Reply /allow ${request.requestId} or /deny ${request.requestId}.`;
  }

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
    routeAuthority: {
      connectionAuthorityEpoch: input.current.source.connectionAuthorityEpoch,
      bindingRevision: input.current.bindingRevision,
      bindingAuthorityEpoch: input.current.source.bindingAuthorityEpoch,
    },
    source: {
      kind: 'permissionWait',
      sessionId: input.current.source.sessionId,
      turnId: request.turnId,
      requestId: request.requestId,
    },
    endpoint: input.current.endpoint,
    content: renderConversationPendingPermissionRequest(request),
    // The existing custody HMAC is length-prefixed over the exact source
    // tuple. Reusing it makes the provider key bounded, opaque, and immune to
    // delimiter collisions in provider-native request identifiers.
    deliveryKey: 'channels:permission-wait:v1:pending',
    mentionPolicy: 'suppress',
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
  if (!isSameConversationPermissionWaitMediationSource(current.source, input.source)) {
    return { kind: 'notEligible' };
  }
  const obligation = await createConversationPermissionWaitOutwardDeliveryObligation({
    current,
    request: input.request,
  });
  if (obligation === null) return { kind: 'unavailable', reason: 'stateCorrupt' };
  return await acceptConversationOutwardDeliveryReady({
    store: input.store,
    prepared: await prepareConversationOutwardDeliveryReady({
      stateCollection: input.stateCollection,
      signal: input.signal,
      obligation,
    }),
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
    requireBindingRevision: true,
  });
  if (currentness.kind !== 'current') return currentness;
  const rejection = validateConversationOutwardDeliveryBeforeCustody({
    obligation: input.obligation,
    outboundTextLimit: currentness.outboundTextLimit,
  });
  if (rejection !== null && !isConversationOutwardDeliveryKnownNoEffect(rejection)) {
    return { kind: 'invalid', reason: rejection };
  }
  return {
    kind: 'ready',
    obligation: input.obligation,
    outboundTextLimit: currentness.outboundTextLimit,
    ...(rejection === null ? {} : { knownNoEffect: rejection }),
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
    if (input.prepared.knownNoEffect !== undefined) {
      const custody = settleConversationDeliveryKnownNoEffectBeforeProvider(ensured.record.custody);
      if (custody !== null) {
        const settled = await input.store.compareAndSwap({
          custodyId: ensured.record.custodyId,
          expectedRevision: ensured.record.revision,
          custody,
        });
        if (settled.kind === 'updated') {
          return {
            kind: 'accepted',
            custodyId: settled.record.custodyId,
            custody: settled.record.custody,
          };
        }
        if (settled.kind === 'invalid') return { kind: 'invalid', reason: settled.reason };
        if (settled.kind === 'unavailable') {
          return {
            kind: 'unavailable',
            reason: settled.reason === 'cancelled' ? 'cancelled' : 'storageUnavailable',
          };
        }
      }
    }
    return {
      kind: 'accepted',
      custodyId: ensured.record.custodyId,
      custody: ensured.record.custody,
    };
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'storageUnavailable',
    };
  }
}

const CONVERSATION_CONTROL_RESPONSE_KINDS = new Set<ConversationControlResponseKind>([
  'pairing',
  'newSession',
  'approval',
  'userAction',
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
  'staleAuthority',
  'targetChanged',
  'materializationChanged',
  'credentialUnavailable',
  'coreGenerationRetired',
  'providerGenerationRetired',
  'audienceChanged',
  'permissionNoLongerPending',
] as const;

export type ConversationOutwardDeliverySuppressionReason =
  (typeof CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASONS)[number];

/** Compatibility aliases for existing control-response callers. */
export const CONVERSATION_CONTROL_RESPONSE_SUPPRESSION_REASONS =
  CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASONS;
export type ConversationControlResponseSuppressionReason =
  ConversationOutwardDeliverySuppressionReason;

const CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASON_SET =
  new Set<string>(CONVERSATION_OUTWARD_DELIVERY_SUPPRESSION_REASONS);

export type ConversationOutwardDeliveryCurrentnessResult =
  | Readonly<{ kind: 'current' }>
  | Readonly<{
    kind: 'suppressed';
    reason: ConversationOutwardDeliverySuppressionReason;
  }>;

export type ConversationControlResponseCurrentnessResult =
  ConversationOutwardDeliveryCurrentnessResult;

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

export type ConversationControlResponseAuthority = ConversationOutwardDeliveryAuthority;

/**
 * Re-reads the canonical Account rows immediately before provider I/O. This
 * is the sole binding/connection currentness adapter for all outward sources.
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
        requireBindingRevision: false,
      });
      if (result.kind === 'current') return { kind: 'current' };
      if (result.kind === 'suppressed') return result;
      return {
        kind: 'suppressed',
        reason: result.reason === 'cancelled' ? 'cancelled' : 'currentnessUnavailable',
      };
    },
  };
}

function normalizeCurrentnessResult(value: unknown): ConversationOutwardDeliveryCurrentnessResult {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, unknown>>;
    if (record.kind === 'current') return { kind: 'current' };
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

export type ConversationOutwardDeliveryResult =
  | Readonly<{ kind: 'settled'; custody: ConversationDeliveryCustody }>
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
    suppressionReason?: ConversationOutwardDeliverySuppressionReason;
  }>
  | Readonly<{
    kind: 'notAttempted';
    reason:
      | 'obligationConflict'
      | 'attemptInProgress'
      | 'notDue'
      | 'attemptLimitReached'
      | 'custodyChangedBeforeAttempt'
      | 'cancelled'
      | 'connectionUnavailable'
      | 'connectionCorrupt'
      | 'custodyUnavailable'
      | ConversationOutwardDeliveryPreCustodyRejection
      | 'invalidRow'
      | 'rowTooLarge';
  }>;

export type ConversationControlResponseDeliveryResult = ConversationOutwardDeliveryResult;

export type ConversationOutwardDeliveryRecoveryResult =
  | Extract<ConversationOutwardDeliveryResult, Readonly<{ kind: 'settled' | 'settlementPending' }>>
  | Readonly<{
    kind: 'notAttempted';
    reason: 'cancelled' | 'attemptStillCurrent' | 'notAttempting' | 'custodyChangedBeforeRecovery' | 'custodyUnavailable' | 'invalidRow' | 'rowTooLarge';
  }>;

/** A host-proven pre-handler miss has no provider effect and can suppress custody. */
type ConversationOutwardDeliveryPreEffectSuppression = Readonly<{
  kind: 'suppressedBeforeProviderEffect';
  reason: ConversationOutwardDeliverySuppressionReason;
}>;

type ConversationOutwardDeliveryProviderInvocationResult =
  | ConversationDeliveryResultV1
  | ConversationOutwardDeliveryPreEffectSuppression;

function isConversationOutwardDeliveryPreEffectSuppression(
  value: ConversationOutwardDeliveryProviderInvocationResult,
): value is ConversationOutwardDeliveryPreEffectSuppression {
  return value.kind === 'suppressedBeforeProviderEffect';
}

async function persistConversationOutwardDeliverySuppression(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  attemptId: string;
  reason: ConversationOutwardDeliverySuppressionReason;
}>): Promise<ConversationOutwardDeliveryResult> {
  const suppressed = suppressConversationDeliveryAttempt({
    custody: input.record.custody,
    attemptId: input.attemptId,
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
  return {
    kind: 'suppressed',
    reason: input.reason,
    custody: persisted.record.custody,
  };
}

/**
 * The durable counterpart of a current provider-bound size rejection. It may
 * run only before an attempt exists, so a crash can never erase ambiguity
 * about an already-started provider effect.
 */
async function settleConversationOutwardDeliveryKnownNoEffectBeforeProvider(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult | null> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  const custody = settleConversationDeliveryKnownNoEffectBeforeProvider(input.record.custody);
  if (custody === null) return null;
  let persisted: Awaited<ReturnType<ConversationOutwardDeliveryStore['compareAndSwap']>>;
  try {
    persisted = await input.store.compareAndSwap({
      custodyId: input.record.custodyId,
      expectedRevision: input.record.revision,
      custody,
    });
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (persisted.kind === 'unavailable') {
    return {
      kind: 'notAttempted',
      reason: persisted.reason === 'storageUnavailable' ? 'custodyUnavailable' : persisted.reason,
    };
  }
  if (persisted.kind === 'conflict') {
    return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  }
  if (persisted.kind === 'invalid') {
    return { kind: 'notAttempted', reason: persisted.reason };
  }
  return { kind: 'settled', custody: persisted.record.custody };
}

/** The only outward delivery path: persist known no-effect or win custody, invoke, then settle. */
export async function deliverConversationOutwardDelivery(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  obligation: ConversationOutwardDeliveryObligation;
  /** Required for a new obligation; retained rows were already admitted through this bound. */
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
  let permanentPreProviderNoEffect = false;
  if (input.retainedRecord === undefined) {
    const preCustodyRejection = input.outboundTextLimit === undefined
      ? 'invalidOutboundTextLimit'
      : validateConversationOutwardDeliveryBeforeCustody({
        obligation: input.obligation,
        outboundTextLimit: input.outboundTextLimit,
      });
    if (preCustodyRejection !== null) {
      permanentPreProviderNoEffect = preCustodyRejection === 'contentUtf8LimitExceeded'
        || preCustodyRejection === 'providerChunkLimitExceeded';
      if (!permanentPreProviderNoEffect) {
        return { kind: 'notAttempted', reason: preCustodyRejection };
      }
    }
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

  if (permanentPreProviderNoEffect) {
    const settled = await settleConversationOutwardDeliveryKnownNoEffectBeforeProvider({
      store: input.store,
      record: ensured.record,
      signal: input.signal,
    });
    if (settled !== null) return settled;
    return {
      kind: 'notAttempted',
      reason: ensured.record.custody.state === 'attempting' ? 'attemptInProgress' : 'notDue',
    };
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

  let currentness: ConversationOutwardDeliveryCurrentnessResult;
  if (input.signal.aborted) {
    currentness = { kind: 'suppressed', reason: 'cancelled' };
  } else {
    try {
      currentness = normalizeCurrentnessResult(await input.authority.checkCurrentness({
        record: claimed.record,
        signal: input.signal,
      }));
    } catch {
      currentness = {
        kind: 'suppressed',
        reason: input.signal.aborted ? 'cancelled' : 'currentnessUnavailable',
      };
    }
    // Cancellation may win after the read but before the provider boundary.
    if (input.signal.aborted) currentness = { kind: 'suppressed', reason: 'cancelled' };
  }

  if (currentness.kind === 'suppressed') {
    return await persistConversationOutwardDeliverySuppression({
      store: input.store,
      record: claimed.record,
      attemptId: input.attemptId,
      reason: currentness.reason,
    });
  }

  let providerResult: ConversationDeliveryResultV1;
  try {
    const invocation = await input.deliver({
      obligation: claimed.record.obligation,
      signal: input.signal,
    });
    if (isConversationOutwardDeliveryPreEffectSuppression(invocation)) {
      return await persistConversationOutwardDeliverySuppression({
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
  const settled = settleConversationDeliveryAttempt({
    custody: claimed.record.custody,
    attemptId: input.attemptId,
    result: providerResult,
    now: input.now(),
  });
  if (settled.kind === 'staleAttempt') {
    return {
      kind: 'settlementPending',
      custody: claimed.record.custody,
      providerResult,
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
    };
  }
  return { kind: 'settled', custody: persisted.record.custody };
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

type ConversationOutwardDeliveryProviderActionInvocation = Readonly<{
  action: AdmittedTargetedOperationExecutionHandle<JsonValue, ConversationDeliveryResultV1>;
  input: ConversationDeliveryInputV1 | ConversationDeliveryReconcileInputV1;
  expectedExecutionOrigin: PluginMachineExecutionOriginV1;
}>;

type ConversationOutwardDeliveryProviderActionBoundary = Readonly<{
  authority: ConversationOutwardDeliveryAuthority;
  invoke(signal: AbortSignal): Promise<ConversationOutwardDeliveryProviderInvocationResult>;
}>;

/**
 * Builds the provider Action input from the same connection snapshot that just
 * passed canonical route currentness. The raw provider config remains opaque
 * to Channels but is admitted by the public provider Action schema before
 * dispatch. No provider callback can choose a target or origin itself.
 */
async function prepareConversationOutwardDeliveryProviderActionInvocation(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  record: ConversationOutwardDeliveryRecord;
  signal: AbortSignal;
  operation: 'deliver' | 'reconcile';
}>): Promise<
  | Readonly<{ kind: 'ready'; invocation: ConversationOutwardDeliveryProviderActionInvocation }>
  | ConversationOutwardDeliveryCurrentnessResult
> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  }
  const currentness = await checkConversationOutwardDeliveryRouteCurrentness({
    stateCollection: input.stateCollection,
    signal: input.signal,
    obligation: input.record.obligation,
    requireBindingRevision: false,
  });
  if (currentness.kind === 'suppressed') return currentness;
  if (currentness.kind === 'unavailable') {
    return {
      kind: 'suppressed',
      reason: currentness.reason === 'cancelled' ? 'cancelled' : 'currentnessUnavailable',
    };
  }
  const provider = currentness.connection.providerAction;
  const contribution = await readCurrentProviderContributionForPersistedSelection({
    context: {
      targetedContributions: input.targetedContributions,
      signal: input.signal,
    },
    providerPluginId: provider.providerPluginId,
    providerContributionSelection: provider.providerContributionSelection,
  });
  const action = input.operation === 'deliver'
    ? contribution.operations.messageDeliver
    : contribution.operations.deliveryReconcile;
  if (action === undefined) return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  const providerConnection = {
    v: 1,
    connectionId: input.record.obligation.connectionId,
    providerConnectionKey: provider.providerConnectionKey,
    providerConfigVersion: provider.providerConfigVersion,
    providerConfig: provider.providerConfig,
    credentialRef: currentness.connection.credentialRef,
  };
  const actionInput = input.operation === 'deliver'
    ? ConversationDeliveryInputV1Schema.safeParse({
      ...providerConnection,
      endpoint: input.record.obligation.endpoint,
      content: input.record.obligation.content,
      deliveryKey: input.record.obligation.deliveryKey,
      ...(input.record.obligation.replyContext === undefined
        ? {}
        : { replyContext: input.record.obligation.replyContext }),
      mentionPolicy: input.record.obligation.mentionPolicy,
      linkPreviewPolicy: input.record.obligation.linkPreviewPolicy,
    })
    : ConversationDeliveryReconcileInputV1Schema.safeParse({
      ...providerConnection,
      endpoint: input.record.obligation.endpoint,
      deliveryKey: input.record.obligation.deliveryKey,
    });
  if (!actionInput.success) return { kind: 'suppressed', reason: 'currentnessUnavailable' };
  return {
    kind: 'ready',
    invocation: {
      action,
      input: actionInput.data,
      expectedExecutionOrigin: currentness.connection.transportOrigin,
    },
  };
}

function createConversationOutwardDeliveryProviderActionBoundary(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  operation: 'deliver' | 'reconcile';
}>): ConversationOutwardDeliveryProviderActionBoundary {
  let invocation: ConversationOutwardDeliveryProviderActionInvocation | undefined;
  return {
    authority: {
      async checkCurrentness(check) {
        invocation = undefined;
        const prepared = await prepareConversationOutwardDeliveryProviderActionInvocation({
          stateCollection: input.stateCollection,
          targetedContributions: input.targetedContributions,
          record: check.record,
          signal: check.signal,
          operation: input.operation,
        });
        if (prepared.kind !== 'ready') return prepared;
        invocation = prepared.invocation;
        return { kind: 'current' };
      },
    },
    async invoke(signal) {
      const current = invocation;
      if (current === undefined) return { kind: 'outcomeUnknown' };
      let execution: Awaited<ReturnType<ActionsService['executeAdmittedTargetedOperationWithExecutionOrigin']>>;
      try {
        execution = await input.actions.executeAdmittedTargetedOperationWithExecutionOrigin(
          current.action,
          current.input,
          {
            signal,
            expectedExecutionOrigin: current.expectedExecutionOrigin,
          },
        );
      } catch (error) {
        if (isPluginActionHandlerInvocationKnownNotStarted(error)) {
          return { kind: 'notDelivered', retry: 'safe' };
        }
        throw error;
      }
      if (!arePluginMachineExecutionOriginsEqual(
        execution.executionOrigin,
        current.expectedExecutionOrigin,
      )) return { kind: 'outcomeUnknown' };
      const result = ConversationDeliveryResultV1Schema.safeParse(execution.result);
      return result.success ? result.data : { kind: 'outcomeUnknown' };
    },
  };
}

/**
 * Executes an already-admitted custody row through the one provider Action
 * boundary. It retains the exact persisted obligation and cannot synthesize a
 * delivery key, route, or fallback send on restart.
 */
export async function redriveConversationOutwardDeliveryThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (!hasRetainedConversationOutwardDeliveryContent(input.record.obligation)) {
    return isConversationDeliveryAutomaticTerminal(input.record.custody)
      ? { kind: 'settled', custody: input.record.custody }
      : { kind: 'notAttempted', reason: 'invalidRow' };
  }
  const currentness = await checkConversationOutwardDeliveryRouteCurrentness({
    stateCollection: input.stateCollection,
    signal: input.signal,
    obligation: input.record.obligation,
    requireBindingRevision: false,
  });
  if (currentness.kind === 'current') {
    const rejection = validateConversationOutwardDeliveryBeforeCustody({
      obligation: input.record.obligation,
      outboundTextLimit: currentness.outboundTextLimit,
    });
    if (rejection !== null && isConversationOutwardDeliveryKnownNoEffect(rejection)) {
      const settled = await settleConversationOutwardDeliveryKnownNoEffectBeforeProvider({
        store: input.store,
        record: input.record,
        signal: input.signal,
      });
      if (settled !== null) return settled;
    }
  }
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'deliver',
  });
  return await redriveConversationOutwardDelivery({
    store: input.store,
    record: input.record,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    deliver: async ({ signal }) => await boundary.invoke(signal),
  });
}

/** Fresh source producers share the exact provider Action/currentness boundary. */
export async function deliverConversationOutwardDeliveryThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  obligation: ConversationOutwardDeliveryObligation;
  outboundTextLimit: ConversationOutboundTextLimit;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'deliver',
  });
  return await deliverConversationOutwardDelivery({
    store: input.store,
    obligation: input.obligation,
    outboundTextLimit: input.outboundTextLimit,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    deliver: async ({ signal }) => await boundary.invoke(signal),
  });
}

/**
 * The Session projection source reaches custody only here. It re-reads the
 * current binding to construct the binding-scoped authority arm, derives the
 * bounded external delivery key from the incumbent opaque custody identity,
 * and then enters the same provider/currentness path as every other source.
 */
export async function deliverConversationSessionProjectionOutwardDelivery(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  binding: ConversationSessionProjectionBinding;
  source: ConversationSessionProjectionSource;
  content: string;
  attemptId: string;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryResult> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  let collections: ConversationCollectionsModule;
  try {
    collections = await loadConversationCollectionsModule();
  } catch {
    return { kind: 'notAttempted', reason: 'custodyUnavailable' };
  }
  let accountLocalBindingPolicy: ConversationAccountLocalBindingPolicyModule;
  try {
    accountLocalBindingPolicy = await loadConversationAccountLocalBindingPolicyModule();
  } catch {
    return { kind: 'notAttempted', reason: 'custodyUnavailable' };
  }
  let bindingRow: StoredCollectionRow | null;
  try {
    bindingRow = await input.stateCollection.get(input.binding.bindingId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (bindingRow === null) return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  const binding = readBindingFacts({
    collections,
    row: bindingRow,
    bindingId: input.binding.bindingId,
  });
  const target = binding === null
    ? { success: false as const }
    : ConversationBindingTargetV1Schema.safeParse(binding.target);
  if (binding === null
    || !target.success
    || target.data.kind !== 'session'
    || binding.revision !== input.binding.revision
    || binding.connectionId !== input.binding.connectionId
    || target.data.sessionId !== input.binding.target.sessionId
    || target.data.sessionId !== input.source.sessionId
    || target.data.policy.deliveryMode !== input.binding.target.deliveryMode
    || !binding.enabled
    || binding.deletionState !== 'none'
    || binding.linkPreviewPolicy === undefined) {
    return { kind: 'notAttempted', reason: 'custodyChangedBeforeAttempt' };
  }
  let connectionRow: StoredCollectionRow | null;
  try {
    connectionRow = await input.stateCollection.get(binding.connectionId, {
      signal: input.signal,
    }) as unknown as StoredCollectionRow | null;
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (connectionRow === null) return { kind: 'notAttempted', reason: 'connectionUnavailable' };
  const connection = readConnectionFacts({
    accountLocalBindingPolicy,
    row: connectionRow,
    connectionId: binding.connectionId,
  });
  if (connection === null) {
    return { kind: 'notAttempted', reason: 'connectionCorrupt' };
  }
  const provisional: ConversationOutwardDeliveryObligation = {
    connectionId: binding.connectionId,
    bindingId: input.binding.bindingId,
    routeAuthority: {
      connectionAuthorityEpoch: connection.authorityEpoch,
      bindingRevision: binding.revision,
      bindingAuthorityEpoch: binding.authorityEpoch,
    },
    source: input.source,
    endpoint: binding.endpoint,
    content: input.content,
    // The persistent identity deliberately excludes this derived public key.
    deliveryKey: 'channels:delivery:v1:pending',
    mentionPolicy: 'suppress',
    linkPreviewPolicy: binding.linkPreviewPolicy,
  };
  const custodyId = await deriveConversationOutwardDeliveryCustodyId({
    routingIdentityKey: connection.routingIdentityKey,
    obligation: provisional,
  });
  if (custodyId === null) return { kind: 'notAttempted', reason: 'connectionCorrupt' };
  return await deliverConversationOutwardDeliveryThroughProviderAction({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    store: input.store,
    obligation: {
      ...provisional,
      deliveryKey: `channels:delivery:v1:${custodyId}`,
    },
    outboundTextLimit: connection.outboundTextLimit,
    attemptId: input.attemptId,
    now: input.now,
    signal: input.signal,
  });
}

/**
 * Owns the one stale-attempt recovery transition. The initial recovery CAS
 * replaces the old attempt identity before any optional provider lookup, so a
 * restart race cannot issue two reconciliations and a late old sender cannot
 * settle the reclaimed row. Recovery intentionally has no delivery fallback:
 * unavailable currentness or an absent/failed reconciliation becomes honest
 * outcome-unknown rather than a resend.
 */
export async function reconcileConversationOutwardDeliveryAttempt(input: Readonly<{
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  recoveryAttemptId: string;
  staleAfterMs: number;
  now: () => number;
  signal: AbortSignal;
  authority: ConversationOutwardDeliveryAuthority;
  reconcile?: (input: Readonly<{
    obligation: ConversationOutwardDeliveryObligation;
    signal: AbortSignal;
  }>) => Promise<ConversationDeliveryResultV1>;
}>): Promise<ConversationOutwardDeliveryRecoveryResult> {
  if (input.signal.aborted) return { kind: 'notAttempted', reason: 'cancelled' };
  const claimedRecovery = claimStaleConversationDeliveryAttemptRecovery({
    custody: input.record.custody,
    recoveryAttemptId: input.recoveryAttemptId,
    recoveredAt: input.now(),
    staleAfterMs: input.staleAfterMs,
  });
  if (claimedRecovery.kind === 'notRecoverable') {
    return { kind: 'notAttempted', reason: claimedRecovery.reason };
  }
  let claimed: Awaited<ReturnType<ConversationOutwardDeliveryStore['compareAndSwap']>>;
  try {
    claimed = await input.store.compareAndSwap({
      custodyId: input.record.custodyId,
      expectedRevision: input.record.revision,
      custody: claimedRecovery.custody,
    });
  } catch {
    return {
      kind: 'notAttempted',
      reason: input.signal.aborted ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (claimed.kind === 'conflict') return { kind: 'notAttempted', reason: 'custodyChangedBeforeRecovery' };
  if (claimed.kind === 'invalid') return { kind: 'notAttempted', reason: claimed.reason };
  if (claimed.kind === 'unavailable') {
    return {
      kind: 'notAttempted',
      reason: claimed.reason === 'cancelled' ? 'cancelled' : 'custodyUnavailable',
    };
  }
  if (!hasRetainedConversationOutwardDeliveryContent(claimed.record.obligation)) {
    return { kind: 'notAttempted', reason: 'invalidRow' };
  }

  let currentness: ConversationOutwardDeliveryCurrentnessResult;
  if (input.signal.aborted) {
    currentness = { kind: 'suppressed', reason: 'cancelled' };
  } else {
    try {
      currentness = normalizeCurrentnessResult(await input.authority.checkCurrentness({
        record: claimed.record,
        signal: input.signal,
      }));
    } catch {
      currentness = {
        kind: 'suppressed',
        reason: input.signal.aborted ? 'cancelled' : 'currentnessUnavailable',
      };
    }
    if (input.signal.aborted) currentness = { kind: 'suppressed', reason: 'cancelled' };
  }

  let providerResult: ConversationDeliveryResultV1 = { kind: 'outcomeUnknown' };
  if (currentness.kind === 'current' && input.reconcile !== undefined) {
    try {
      providerResult = await input.reconcile({
        obligation: claimed.record.obligation,
        signal: input.signal,
      });
    } catch {
      providerResult = { kind: 'outcomeUnknown' };
    }
  }
  const settled = settleConversationDeliveryAttempt({
    custody: claimed.record.custody,
    attemptId: input.recoveryAttemptId,
    result: providerResult,
    now: input.now(),
  });
  if (settled.kind === 'staleAttempt') {
    return { kind: 'settlementPending', custody: claimed.record.custody, providerResult };
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
    return { kind: 'settlementPending', custody: settled.custody, providerResult };
  }
  return { kind: 'settled', custody: persisted.record.custody };
}

/**
 * Reconciles one retained attempt through its owning provider Action. Like
 * redrive, this has no provider-specific recovery path outside the canonical
 * custody state machine; an unavailable optional reconciliation settles as
 * outcome-unknown rather than issuing a second message delivery.
 */
export async function reconcileConversationOutwardDeliveryAttemptThroughProviderAction(input: Readonly<{
  stateCollection: ChannelStateCollection;
  targetedContributions: TargetedContributionsService;
  actions: ActionsService;
  store: ConversationOutwardDeliveryStore;
  record: ConversationOutwardDeliveryRecord;
  recoveryAttemptId: string;
  staleAfterMs: number;
  now: () => number;
  signal: AbortSignal;
}>): Promise<ConversationOutwardDeliveryRecoveryResult> {
  const boundary = createConversationOutwardDeliveryProviderActionBoundary({
    stateCollection: input.stateCollection,
    targetedContributions: input.targetedContributions,
    actions: input.actions,
    operation: 'reconcile',
  });
  return await reconcileConversationOutwardDeliveryAttempt({
    store: input.store,
    record: input.record,
    recoveryAttemptId: input.recoveryAttemptId,
    staleAfterMs: input.staleAfterMs,
    now: input.now,
    signal: input.signal,
    authority: boundary.authority,
    reconcile: async ({ signal }) => {
      const invocation = await boundary.invoke(signal);
      // Recovery follows an earlier attempting send. Even when this optional
      // reconciliation Action cannot start, that prior provider effect remains
      // ambiguous and must not be rewritten as a no-effect suppression.
      return isConversationOutwardDeliveryPreEffectSuppression(invocation)
        ? { kind: 'outcomeUnknown' }
        : invocation;
    },
  });
}

/** Compatibility alias; control responses use the same custody path. */
export const deliverConversationControlResponse = deliverConversationOutwardDelivery;

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

/** Compatibility wrapper; it does not create a second custody representation. */
export function createReadyConversationControlResponseRecord(input: Readonly<{
  custodyId: string;
  revision: number;
  createdAt: number;
  obligation: ConversationControlResponseObligation;
}>): ConversationOutwardDeliveryRecord {
  return createReadyConversationOutwardDeliveryRecord(input);
}
