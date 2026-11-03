import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import { createSupervisorWake } from './supervisorWake.js';
import { hasCurrentConversationExecutionPlacement, isConversationConnectionPlacedForInvocation } from './reconciliation.js';
import { asChannelStateRow, readConversationConnectionUpdateRow } from './accountLocalBindingPolicy.js';
import {
  classifySupervisorFailure,
  isInactiveSupervisorCollectionFailure,
} from './supervisorFailure.js';
import {
  acceptConversationPermissionWaitOutwardDelivery,
  createConversationOutwardDeliveryCollectionScanner,
  createConversationOutwardDeliveryCollectionStore,
  readConversationPermissionWaitMediationSource,
  redriveConversationOutwardDelivery,
  type ConversationOutwardDeliveryRecord,
  type ConversationOutwardDeliveryResult,
  type ConversationOutwardDeliveryRecoveryResult,
  type ConversationPermissionWaitMediationSource,
} from './outwardDelivery.js';
import {
  deliverConversationSessionProjectionOutwardDelivery,
  redriveConversationOutwardDeliveryThroughProviderAction,
  reconcileConversationOutwardDeliveryAttemptThroughProviderAction,
} from './outwardDeliveryProviderActions.js';
import { finalizeConversationConnectionDeletesForInvocation } from './management.js';
import { finishStartedConversationBinding } from './conversationStart.js';
import { readConversationSessionInputReplyRelations, markConversationSessionInputRepliesProjected } from './ingress.js';
import { hasPendingConversationThreadBinding, isConversationDeliveryAutomaticTerminal, type ConversationDeliveryCustody } from './deliveryCustody.js';
import {
  readConversationPendingPermissions,
  type ConversationPendingPermissionProjection,
} from './permissionMediation.js';
import {
  createConversationSessionProjectionCollectionStore,
  type ConversationSessionProjectionSkippedAssistantItem,
  hasConversationInputOriginFromBinding,
  projectConversationSessionTranscriptPage,
} from './sessionProjection.js';

const RECONCILIATION_INTERVAL_MS = 1_000;
const STALE_ATTEMPT_AFTER_MS = 30_000;
const OUTWARD_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/**
 * One outward wake reads exactly one Account Collection page of durable work.
 *
 * The query page bound is the real ceiling here, not the binding quota: a wake
 * budget above it produces a page size the canonical Collection wire rejects,
 * which silently turned every recovery and retention scan into
 * `storageUnavailable`. The existing generation-local cursor carries whatever
 * this page did not cover into the next wake, so no second scan loop, worker,
 * or queue is needed to drain a backlog.
 */
const MAX_DELIVERIES_PER_WAKE = PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1;

type Clock = Readonly<{
  now(): number;
  sleep(delayMs: number, signal: AbortSignal): Promise<void>;
}>;

type JsonRecord = Readonly<Record<string, JsonValue>>;

type PermissionWaitMediationSnapshot = Readonly<{
  source: ConversationPermissionWaitMediationSource;
  pendingRequestKeys: ReadonlySet<string>;
  truncated: boolean;
}>;


/**
 * The one generation-local retention pass, carried between wakes.
 *
 * `updatedAt` is not part of the terminal custody index, so a pass has to walk
 * every terminal row to find the ones past the window. That is fine while a
 * pass is running — `cursor` carries it — but an exhausted pass used to be
 * restarted by the very next one-second wake, so an Account with a long
 * delivery history paged its whole terminal index over the network forever to
 * keep discovering that nothing had aged yet.
 *
 * `notBefore` is the exact wall clock at which that answer can first change:
 * the earliest terminal-entry `updatedAt` the finished pass retained plus the
 * retention window. An empty pass parks until a Collection invalidation;
 * failed retirement instead uses the existing recovery interval. No deadline
 * is invented for storage that contains nothing eligible to age.
 */
export type ConversationOutwardRetentionSweepState = Readonly<{
  cursor?: string;
  notBefore?: number;
  earliestRetainedAt?: number;
}>;

export type ConversationOutwardDeliveryCycleOptions = Readonly<{
  context: BackgroundServiceContext;
  now?: () => number;
  staleAttemptAfterMs?: number;
  deliveryCursor?: string;
  retentionSweep?: ConversationOutwardRetentionSweepState;
  createAttemptId?: () => string;
  observeSession?: (sessionId: string) => Promise<void>;
  /** Generation-local terminal reads, invalidated by binding/Session changes. */
  unavailablePermissionBindings?: Set<string>;
}>;

export type ConversationOutwardDeliveryCycleResult = Readonly<{
  nextDeliveryCursor?: string;
  nextRetentionSweep?: ConversationOutwardRetentionSweepState;
  nextWakeAt?: number;
}>;

export type ConversationOutwardDeliverySupervisorOptions = Readonly<{
  clock?: Clock;
  reconciliationIntervalMs?: number;
  staleAttemptAfterMs?: number;
  runCycle?: (
    input: ConversationOutwardDeliveryCycleOptions,
  ) => Promise<ConversationOutwardDeliveryCycleResult>;
}>;

export type ConversationOutwardDeliverySupervisor = Readonly<{
  run(context: BackgroundServiceContext): Promise<void>;
  dispose(): Promise<void>;
}>;

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('Outward delivery supervisor was cancelled.'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      globalThis.clearTimeout(timer);
      reject(signal.reason ?? new Error('Outward delivery supervisor was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

const DEFAULT_CLOCK: Clock = Object.freeze({
  now: () => Date.now(),
  sleep: defaultSleep,
});

function positiveDelay(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return resolved;
}

function earliestRetentionDeadlineAnchor(
  carried: number | undefined,
  candidate: number | undefined,
): number | undefined {
  if (candidate === undefined) return carried;
  return carried === undefined ? candidate : Math.min(carried, candidate);
}

/**
 * A page that carried the pass to its end turns the earliest anchor it saw
 * into the wall clock at which the next page could first reclaim anything;
 * any other page just carries its keyset position and that anchor forward.
 */
function advanceRetentionSweep(input: Readonly<{
  scanned: Readonly<{ nextCursor?: string }>;
  earliestRetainedAt: number | undefined;
}>): ConversationOutwardRetentionSweepState {
  if (input.scanned.nextCursor !== undefined) {
    return {
      cursor: input.scanned.nextCursor,
      ...(input.earliestRetainedAt === undefined ? {} : { earliestRetainedAt: input.earliestRetainedAt }),
    };
  }
  if (input.earliestRetainedAt === undefined) return {};
  return {
    notBefore: input.earliestRetainedAt + OUTWARD_DELIVERY_RETENTION_MS,
  };
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function bindingIdFromRow(value: JsonValue, rowId: string): string | undefined {
  if (!isJsonRecord(value) || !isJsonRecord(value.payload)) return undefined;
  return value[CHANNEL_STATE_FIELD.recordKind] === CHANNEL_STATE_RECORD_KIND.binding
    && value[CHANNEL_STATE_FIELD.id] === rowId
    && value[CHANNEL_STATE_FIELD.bindingId] === rowId
    && value.payload.enabled === true
    && value.payload.deletionState === 'none'
    ? rowId
    : undefined;
}

function bindingConnectionIdFromRow(value: JsonValue, rowId: string): string | undefined {
  if (bindingIdFromRow(value, rowId) === undefined || !isJsonRecord(value)) return undefined;
  const connectionId = value[CHANNEL_STATE_FIELD.connectionId];
  return typeof connectionId === 'string' ? connectionId : undefined;
}

function logOutwardDeliverySupervisorCycleFailure(
  context: BackgroundServiceContext,
  error: unknown,
): void {
  if (isInactiveSupervisorCollectionFailure(error)) return;
  context.services.logger.warn('[Channels] outward delivery supervisor cycle failed', {
    boundary: 'cycle',
    ...(classifySupervisorFailure(error) ?? {}),
  });
}

type OutwardDeliveryWorkFailureBoundary =
  | 'delete-finalization'
  | 'delivery-scan'
  | 'delivery-retention'
  | 'delivery-operation'
  | 'binding-discovery'
  | 'permission-mediation'
  | 'transcript-projection';

function logOutwardDeliverySupervisorWorkFailure(
  context: BackgroundServiceContext,
  boundary: OutwardDeliveryWorkFailureBoundary,
  identifiers?: Readonly<{
    connectionId?: string;
    bindingId?: string;
    error?: unknown;
    outcome?: Readonly<{ code: string; retryable: boolean; informational: boolean }>;
    attemptSettlement?: JsonRecord;
    skippedAssistantItem?: ConversationSessionProjectionSkippedAssistantItem;
  }>,
): void {
  // Cancellation cannot erase a provider result that already crossed the boundary.
  if (context.signal.aborted && identifiers?.attemptSettlement === undefined) return;
  if (isInactiveSupervisorCollectionFailure(identifiers?.error)) return;
  const informational = identifiers?.outcome?.informational === true;
  context.services.logger[informational ? 'info' : 'warn'](
    informational ? '[Channels] outward delivery supervisor work completed' : '[Channels] outward delivery supervisor work failed',
    {
      boundary,
      ...(classifySupervisorFailure(identifiers?.error) ?? {}),
      ...(identifiers?.outcome === undefined ? {} : {
        code: identifiers.outcome.code,
        retryable: identifiers.outcome.retryable,
      }),
      ...(identifiers?.connectionId === undefined ? {} : { connectionId: identifiers.connectionId }),
      ...(identifiers?.bindingId === undefined ? {} : { bindingId: identifiers.bindingId }),
      ...identifiers?.skippedAssistantItem,
      ...identifiers?.attemptSettlement,
    },
  );
}

function logOutwardDeliverySupervisorDeliveryOutcome(
  context: BackgroundServiceContext,
  boundary: 'delivery-operation' | 'transcript-projection',
  identifiers: Readonly<{ connectionId?: string; bindingId?: string }>,
  result: ConversationOutwardDeliveryResult | ConversationOutwardDeliveryRecoveryResult,
  retryable: boolean,
): boolean {
  if (result.kind === 'settled' && result.attemptSettlement === undefined) return false;
  const settlement = 'attemptSettlement' in result ? result.attemptSettlement : undefined;
  const providerResult = settlement?.providerResult;
  const prefix = boundary === 'transcript-projection' ? 'channels_projection_' : 'channels_delivery_';
  const code = `${prefix}${'reason' in result ? result.reason
    : 'custody' in result ? result.custody.state : result.kind}`;
  logOutwardDeliverySupervisorWorkFailure(context, boundary, {
    ...identifiers,
    outcome: { code, retryable, informational: result.kind === 'retired'
      || (result.kind === 'settled' && result.custody.state === 'delivered') },
    ...(settlement === undefined || providerResult === undefined || !('custody' in result) ? {} : {
      attemptSettlement: {
        custodyId: settlement.custodyId,
        attemptCount: result.custody.attemptCount,
        settledState: result.custody.state,
        settlementStatus: result.kind,
        providerOperation: settlement.operation,
        providerResultKind: providerResult.kind,
        ...(providerResult.kind === 'notReady' ? { providerResultCode: providerResult.reason } : {}),
        ...((providerResult.kind === 'notDelivered' || providerResult.kind === 'outcomeUnknown') && providerResult.code !== undefined
          ? { providerResultCode: providerResult.code } : {}),
        ...(providerResult.kind === 'notDelivered' ? { providerRetry: providerResult.retry } : {}),
        ...(providerResult.kind === 'endpointArchived' ? { providerRecovery: providerResult.recovery } : {}),
        ...(result.custody.retryNotBefore === undefined ? {} : { retryNotBefore: result.custody.retryNotBefore }),
      },
    }),
  });
  return true;
}

function defaultAttemptId(): string {
  return `channels:outward-attempt:v1:${globalThis.crypto.randomUUID()}`;
}

function permissionWaitRequestIdentityKey(input: Readonly<{
  sessionId: string;
  turnId: string;
  requestId: string;
}>): string {
  // This is generation-local lookup state only. JSON arrays preserve the
  // complete tuple without giving a delimiter any identity semantics.
  return JSON.stringify([input.sessionId, input.turnId, input.requestId]);
}

function matchesPermissionWaitMediationSource(
  record: ConversationOutwardDeliveryRecord,
  source: ConversationPermissionWaitMediationSource,
): boolean {
  if (record.obligation.source.kind !== 'permissionWait'
    || record.obligation.bindingId === undefined
    || record.obligation.connectionId !== source.connectionId
    || record.obligation.bindingId !== source.bindingId
    || record.obligation.source.sessionId !== source.sessionId) return false;
  const routeAuthority = record.obligation.routeAuthority;
  return 'bindingAuthorityEpoch' in routeAuthority
    && routeAuthority.connectionAuthorityEpoch === source.connectionAuthorityEpoch
    && routeAuthority.bindingAuthorityEpoch === source.bindingAuthorityEpoch;
}

function isUnattemptedPermissionWait(record: ConversationOutwardDeliveryRecord): boolean {
  return record.custody.state === 'ready' && record.custody.attemptCount === 0;
}

/**
 * Session and Automation sources are not forgotten until their canonical
 * owners can prove the deterministic occurrence unreachable. Of the remaining
 * repeatable sources, a pending permission producer needs the same complete
 * current projection that mediation already reads during this wake before
 * retention can remove its terminal notification.
 *
 * A binding that is no longer current cannot recreate its former custody. A
 * current binding whose mediation read was unavailable or incomplete remains
 * fail-closed: absence from that partial view is not absence from the source.
 */
function canPhysicallyForgetOutwardCustody(input: Readonly<{
  record: ConversationOutwardDeliveryRecord;
  currentBindingIds: ReadonlySet<string>;
  mediationsByBindingId: ReadonlyMap<string, PermissionWaitMediationSnapshot>;
  unreachableControlSourceIds: ReadonlySet<string>;
}>): boolean {
  const source = input.record.obligation.source;
  // Session and Automation producers can revisit the same deterministic
  // occurrence while their own frontier/handoff remains behind. Their
  // content-free terminal custody is therefore the dedupe proof until those
  // owners expose affirmative unreachability.
  if (source.kind === 'sessionProjection' || source.kind === 'automationResult' || source.kind === 'conversationStart') return false;
  // A control response is not a one-shot effect either: its identity is the
  // durable ingress row that produced it, and that row stays addressable until
  // ingress retention proves the occurrence past its replay horizon. Only that
  // owner's own proof — the row's absence — may retire the dedupe evidence.
  if (source.kind === 'controlResponse') {
    return input.unreachableControlSourceIds.has(source.controlId);
  }
  const bindingId = input.record.obligation.bindingId;
  if (bindingId === undefined) return false;
  if (!input.currentBindingIds.has(bindingId)) return true;
  const mediation = input.mediationsByBindingId.get(bindingId);
  if (mediation === undefined || !matchesPermissionWaitMediationSource(input.record, mediation.source)) {
    return false;
  }
  return !mediation.truncated
    && !mediation.pendingRequestKeys.has(permissionWaitRequestIdentityKey(source));
}

/**
 * Reads the one affirmative unreachability proof a control response has: the
 * absence of the ingress census/obligation row whose id is its control id.
 * Ingress owns that row's replay horizon and physically forgets it only after
 * the occurrence can never be observed again, so this consults the existing
 * proof instead of introducing a second horizon. Only the ids this retention
 * page actually selected are read, and an unreadable row stays fail-closed.
 */
async function readUnreachableControlSourceIds(input: Readonly<{
  context: BackgroundServiceContext;
  records: readonly ConversationOutwardDeliveryRecord[];
}>): Promise<ReadonlySet<string>> {
  const controlIds = new Set(input.records.flatMap((record) => (
    record.obligation.source.kind === 'controlResponse'
      ? [record.obligation.source.controlId]
      : []
  )));
  const unreachable = new Set<string>();
  if (controlIds.size === 0) return unreachable;
  const collection = requireChannelsAccountStorage(input.context).collection(CHANNEL_STATE_COLLECTION);
  for (const controlId of controlIds) {
    if (input.context.signal.aborted) return new Set();
    try {
      const row = await collection.get(controlId, { signal: input.context.signal });
      if (row === null) unreachable.add(controlId);
    } catch {
      // An unreadable ingress row is not an absent one; leave the logical
      // tombstone in place and let the next wake re-decide.
    }
  }
  return unreachable;
}

async function readCurrentBindingIds(context: BackgroundServiceContext): Promise<readonly string[]> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const bindingIds: string[] = [];
  // Select this runtime's work before expanding a connection into its bindings.
  // Shared-Account changes can concern another Machine's whole binding set.
  // This existing pass-local observation is discovery only: every effect still
  // re-reads its connection and placement at the canonical final check.
  const connectionCurrentness = new Map<string, boolean>();
  let cursor: string | undefined;
  do {
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
      limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: context.signal });
    for (const row of page.rows) {
      const bindingId = bindingIdFromRow(row.value, row.rowId);
      const connectionId = bindingConnectionIdFromRow(row.value, row.rowId);
      if (bindingId === undefined || connectionId === undefined) continue;
      let current = connectionCurrentness.get(connectionId);
      if (current === undefined) {
        const row = asChannelStateRow(await collection.get(connectionId, { signal: context.signal }));
        if (row === undefined) current = false;
        else {
          const connection = readConversationConnectionUpdateRow({ row, connectionId });
          current = connection.lifecycle.enabled && connection.lifecycle.deletionState === 'none'
            && await hasCurrentConversationExecutionPlacement(context, connection.transportOrigin);
        }
        connectionCurrentness.set(connectionId, current);
      }
      if (current) bindingIds.push(bindingId);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && !context.signal.aborted);
  return bindingIds;
}

/**
 * Runs one bounded, durable-only outward wake. The sole cursor is generation
 * local fairness state for the existing `channelDeliveries` index; binding and
 * delivery authority are reread at their canonical owners before every effect.
 */
export async function runConversationOutwardDeliveryCycle(
  input: ConversationOutwardDeliveryCycleOptions,
): Promise<ConversationOutwardDeliveryCycleResult> {
  const now = input.now ?? Date.now;
  const staleAttemptAfterMs = positiveDelay(
    input.staleAttemptAfterMs,
    STALE_ATTEMPT_AFTER_MS,
    'Outward delivery stale-attempt interval',
  );
  const createAttemptId = input.createAttemptId ?? defaultAttemptId;
  const { context } = input;
  if (context.signal.aborted) return {};
  let nextWakeAt: number | undefined;
  const noteDeadline = (at: number | undefined) => {
    if (at !== undefined) nextWakeAt = Math.min(nextWakeAt ?? Infinity, at);
  };
  const noteCustody = (custody: ConversationDeliveryCustody) => {
    if (hasPendingConversationThreadBinding(custody)) noteDeadline(now());
    if (custody.state === 'retryDue') noteDeadline(custody.retryNotBefore ?? now());
    if (custody.state === 'attempting' && custody.startedAt !== undefined) noteDeadline(custody.startedAt + staleAttemptAfterMs);
  };
  // Retained redrive and first projection share the same recovery decision.
  // A failed pre-custody read has no durable row to wake it later.
  const noteDeliveryResult = (result: ConversationOutwardDeliveryResult): boolean => {
    if ('custody' in result) noteCustody(result.custody);
    if (result.kind === 'settlementPending' || (result.kind === 'notAttempted'
      && ['custodyUnavailable', 'connectionUnavailable', 'custodyChangedBeforeAttempt'].includes(result.reason))) {
      noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
      return true;
    }
    return 'custody' in result && result.custody.state === 'retryDue';
  };
  const workFailed = (boundary: OutwardDeliveryWorkFailureBoundary, detail: Parameters<typeof logOutwardDeliverySupervisorWorkFailure>[2] = {}) => {
    noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
    logOutwardDeliverySupervisorWorkFailure(context, boundary, detail);
  };
  const stateCollection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const deliveriesCollection = requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION);
  try {
    // Delete custody is settled before generic redrive so a retained ready row
    // cannot race into a provider effect after connection authority is gone.
    await finalizeConversationConnectionDeletesForInvocation(context);
  } catch (error) {
    // The retained finalizing row remains the recovery source for the next wake.
    workFailed('delete-finalization', { error });
  }
  if (context.signal.aborted) return {};
  const deliveryStore = createConversationOutwardDeliveryCollectionStore({
    stateCollection,
    deliveriesCollection,
    signal: context.signal,
    now,
  });
  const scanner = createConversationOutwardDeliveryCollectionScanner({
    deliveriesCollection,
    signal: context.signal,
  });

  const redriveRetainedDelivery = async (
    record: ConversationOutwardDeliveryRecord,
  ): Promise<void> => {
    if (!await isConversationConnectionPlacedForInvocation(context, record.obligation.connectionId)) return;
    if (hasPendingConversationThreadBinding(record.custody)) {
      if (!await finishStartedConversationBinding({ record, store: deliveryStore, context })) {
        noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
      }
      return;
    }
    if (record.custody.state === 'attempting') {
      const result = await reconcileConversationOutwardDeliveryAttemptThroughProviderAction({
        stateCollection,
        targetedContributions: context.services.targetedContributions,
        actions: context.services.actions,
        store: deliveryStore,
        record,
        recoveryAttemptId: createAttemptId(),
        staleAfterMs: staleAttemptAfterMs,
        now,
        signal: context.signal,
      });
      if ('custody' in result) noteCustody(result.custody);
      if (result.kind === 'notAttempted' && result.reason === 'attemptStillCurrent') noteCustody(record.custody);
      const recoveryPending = result.kind === 'settlementPending' || (result.kind === 'notAttempted' && result.reason === 'custodyUnavailable');
      if (recoveryPending) noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
      const retryable = recoveryPending || ('custody' in result && result.custody.state === 'retryDue');
      logOutwardDeliverySupervisorDeliveryOutcome(context, 'delivery-operation', {
        connectionId: record.obligation.connectionId, bindingId: record.obligation.bindingId,
      }, result, retryable);
      return;
    }
    const result = await redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection,
      targetedContributions: context.services.targetedContributions,
      actions: context.services.actions,
      store: deliveryStore,
      record,
      attemptId: createAttemptId(),
      now,
      signal: context.signal,
    });
    const retryable = noteDeliveryResult(result);
    logOutwardDeliverySupervisorDeliveryOutcome(context, 'delivery-operation', {
      connectionId: record.obligation.connectionId, bindingId: record.obligation.bindingId,
    }, result, retryable);
  };

  let nextDeliveryCursor = input.deliveryCursor;
  let nextRetentionSweep = input.retentionSweep;
  const cycleResult = (): ConversationOutwardDeliveryCycleResult => ({
    ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
    ...(nextDeliveryCursor === undefined ? {} : { nextDeliveryCursor }),
    ...(nextRetentionSweep === undefined ? {} : { nextRetentionSweep }),
  });
  const retainedPermissionWaits: ConversationOutwardDeliveryRecord[] = [];
  try {
    const scanned = await scanner.scan({
      now: now(),
      limit: MAX_DELIVERIES_PER_WAKE,
      ...(input.deliveryCursor === undefined ? {} : { cursor: input.deliveryCursor }),
    });
    if (scanned.kind === 'unavailable') {
      if (scanned.reason !== 'cancelled') {
        workFailed('delivery-scan');
      }
    } else {
      nextDeliveryCursor = scanned.nextCursor;
      noteDeadline(scanned.nextRetryAt);
      for (const record of scanned.records) {
        if (context.signal.aborted) return cycleResult();
        if (record.obligation.source.kind === 'permissionWait') {
          // A permission-wait can be redriven only after the generic Permission
          // owner confirms its exact source tuple on this wake.
          retainedPermissionWaits.push(record);
          continue;
        }
        try {
          await redriveRetainedDelivery(record);
        } catch (error) {
          // The durable row stays eligible for a later wake. A failed owner
          // operation never authorizes a synthetic resend or cursor advance.
          workFailed('delivery-operation', {
            error,
            connectionId: record.obligation.connectionId,
            ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
          });
        }
      }
    }
  } catch (error) {
    // Storage/action availability is re-evaluated next wake from durable rows.
    workFailed('delivery-scan', { error });
  }

  if (context.signal.aborted) return cycleResult();

  let bindingIds: readonly string[];
  try {
    bindingIds = await readCurrentBindingIds(context);
  } catch (error) {
    workFailed('binding-discovery', { error });
    return cycleResult();
  }

  const permissionMediationsByBindingId = new Map<string, PermissionWaitMediationSnapshot>();
  for (const bindingId of bindingIds) {
    if (context.signal.aborted) break;
    const source = await readConversationPermissionWaitMediationSource({
      stateCollection,
      bindingId,
      signal: context.signal,
    });
    if (source.kind === 'notEligible') continue;
    if (source.kind === 'unavailable') {
      if (source.reason !== 'cancelled') {
        workFailed('permission-mediation', { bindingId });
      }
      continue;
    }
    if (!await isConversationConnectionPlacedForInvocation(context, source.source.connectionId)) continue;
    try {
      await input.observeSession?.(source.source.sessionId);
    } catch (error) {
      workFailed('transcript-projection', { error, bindingId });
    }
    if (input.unavailablePermissionBindings?.has(bindingId)) continue;
    let pending: ConversationPendingPermissionProjection;
    try {
      // The complete projection, not its first bounded page: a permission wait
      // beyond that page is still pending, and suppressing its custody as
      // absent would retract a prompt the person still has to answer.
      pending = await readConversationPendingPermissions({
        actions: context.services.actions,
        source: {
          sessionId: source.source.sessionId,
          sourceRef: source.source.sourceRef,
          sourceRevisionOrEpoch: source.source.sourceRevisionOrEpoch,
        },
        signal: context.signal,
      });
    } catch (error) {
      if (!context.signal.aborted) {
        const failure = classifySupervisorFailure(error);
        if (failure?.code === 'ownerMachineUnavailable' && !failure.retryable) {
          // No exact live Session owner can answer. Keep custody and its
          // existing Session watch; a delivery deadline cannot change this
          // fact. Binding or Session invalidation admits the next read.
          input.unavailablePermissionBindings?.add(bindingId);
          logOutwardDeliverySupervisorWorkFailure(context, 'permission-mediation', { error, bindingId });
        } else {
          workFailed('permission-mediation', { error, bindingId });
        }
      }
      continue;
    }
    const pendingRequestKeys = new Set<string>();
    for (const request of pending.requests) {
      if (context.signal.aborted) break;
      // AskUserQuestion is a canonical user action, not a permission grant.
      // Permission requests retain the binding's explicit approval policy.
      if (request.kind !== 'user_action' && !source.permissionApprovalsEnabled) continue;
      pendingRequestKeys.add(permissionWaitRequestIdentityKey({
        sessionId: source.source.sessionId,
        turnId: request.turnId,
        requestId: request.requestId,
      }));
      const accepted = await acceptConversationPermissionWaitOutwardDelivery({
        stateCollection,
        store: deliveryStore,
        source: source.source,
        request,
        signal: context.signal,
      });
      if ((accepted.kind === 'unavailable' || accepted.kind === 'invalid')
        && !context.signal.aborted) {
        workFailed('permission-mediation', { bindingId });
      }
      if (accepted.kind === 'accepted' && accepted.custody.state === 'ready') noteDeadline(now());
    }
    permissionMediationsByBindingId.set(bindingId, {
      source: source.source,
      pendingRequestKeys,
      truncated: pending.truncated,
    });
  }

  const currentBindingIds = new Set(bindingIds);
  for (const record of retainedPermissionWaits) {
    if (context.signal.aborted) break;
    const bindingId = record.obligation.bindingId;
    const mediation = bindingId === undefined
      ? undefined
      : permissionMediationsByBindingId.get(bindingId);
    if (mediation === undefined || !matchesPermissionWaitMediationSource(record, mediation.source)) {
      continue;
    }
    const source = record.obligation.source;
    if (source.kind !== 'permissionWait') continue;
    const stillPending = mediation.pendingRequestKeys.has(permissionWaitRequestIdentityKey(source));
    if (stillPending) {
      try {
        await redriveRetainedDelivery(record);
      } catch (error) {
        workFailed('delivery-operation', {
          error,
          connectionId: record.obligation.connectionId,
          ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
        });
      }
      continue;
    }
    // A truncated source list cannot prove absence. Only an untouched custody
    // row can be suppressed after a complete exact-source negative read;
    // attempted or ambiguous effects retain their ordinary custody truth.
    if (mediation.truncated || !isUnattemptedPermissionWait(record)
      || !await isConversationConnectionPlacedForInvocation(context, record.obligation.connectionId)) continue;
    try {
      const result = await redriveConversationOutwardDelivery({
        store: deliveryStore,
        record,
        attemptId: createAttemptId(),
        now,
        signal: context.signal,
        authority: {
          async checkCurrentness() {
            return { kind: 'suppressed', reason: 'permissionNoLongerPending' };
          },
        },
        deliver: async () => {
          throw new Error('A non-pending permission wait must not reach provider delivery.');
        },
      });
      logOutwardDeliverySupervisorDeliveryOutcome(context, 'delivery-operation', {
        connectionId: record.obligation.connectionId, bindingId: record.obligation.bindingId,
      }, result, noteDeliveryResult(result));
    } catch (error) {
      workFailed('permission-mediation', {
        error,
        connectionId: record.obligation.connectionId,
        ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
      });
    }
  }

  if (context.signal.aborted) return cycleResult();
  const projectionStore = createConversationSessionProjectionCollectionStore({
    stateCollection,
    signal: context.signal,
  });
  for (const bindingId of bindingIds) {
    if (context.signal.aborted) break;
    let observedDeliveryOutcome = false;
    try {
      const bindingRow = await stateCollection.get(bindingId, { signal: context.signal });
      const connectionId = bindingRow === null ? undefined : bindingConnectionIdFromRow(bindingRow.value, bindingId);
      if (connectionId === undefined || !await isConversationConnectionPlacedForInvocation(context, connectionId)) continue;
      const projected = await projectConversationSessionTranscriptPage({
        actions: context.services.actions,
        store: projectionStore,
        bindingId,
        signal: context.signal,
        now,
        onSkippedAssistantItem: skippedAssistantItem => logOutwardDeliverySupervisorWorkFailure(context, 'transcript-projection', {
          bindingId, skippedAssistantItem,
          outcome: { code: 'channels_projection_repliesOnlyInputNotConsumed', retryable: false, informational: true },
        }),
        deliver: async ({ binding, frontierRowRevision, item, source }) => {
          // Transcript reads can outlive a placement change. Recheck before
          // this callback can materialize or claim the final's custody.
          if (!await isConversationConnectionPlacedForInvocation(context, binding.connectionId)) {
            return { kind: 'notAttempted', reason: 'connectionUnavailable' };
          }
          const relations = await readConversationSessionInputReplyRelations({
            stateCollection, bindingId: binding.bindingId, connectionId: binding.connectionId,
            sessionId: source.sessionId, signal: context.signal,
            consumedLocalIds: item.kind === 'assistantText'
              ? item.consumedInputs.filter(({ origin }) => hasConversationInputOriginFromBinding(origin, binding.bindingId))
                .map(({ localId }) => localId)
              : [],
          });
          const replyContext = relations.at(-1)?.replyContext;
          const result = await deliverConversationSessionProjectionOutwardDelivery({
            stateCollection,
            targetedContributions: context.services.targetedContributions,
            actions: context.services.actions,
            store: deliveryStore,
            binding,
            frontierRowRevision,
            source,
            content: item.text,
            ...(replyContext === undefined ? {} : { replyContext }),
            attemptId: createAttemptId(),
            now,
            signal: context.signal,
          });
          const retryable = noteDeliveryResult(result);
          observedDeliveryOutcome = logOutwardDeliverySupervisorDeliveryOutcome(context,
            'transcript-projection', { bindingId }, result, retryable) || observedDeliveryOutcome;
          if (result.kind === 'retired' || ((result.kind === 'settled' || result.kind === 'suppressed')
            && isConversationDeliveryAutomaticTerminal(result.custody))) {
            await markConversationSessionInputRepliesProjected({ stateCollection, relations, seq: item.seq, signal: context.signal });
          }
          return result;
        },
      });
      if (projected.kind === 'advanced' && projected.hasMore) noteDeadline(now());
      // Publication can recover without another transcript invalidation.
      // Re-read the preserved frontier on the existing recovery cadence.
      if (projected.kind === 'blocked' && projected.reason === 'publicationBarrier') {
        noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
      }
      // Typed outcomes used to disappear here, leaving no way to distinguish
      // a parked frontier, a deferred Action and a page with no eligible reply.
      // Emit one content-free result through the same work record as thrown
      // failures. An approval deferral must not create a timed approval loop.
      if (!(projected.kind === 'unavailable' && projected.reason === 'cancelled')
        && !((projected.kind === 'advanced' || projected.kind === 'idle') && projected.deliveredItemCount > 0)
        && !(observedDeliveryOutcome && projected.kind === 'blocked' && projected.reason === 'deliveryPending')) {
        const retryable = projected.kind === 'blocked'
          || (projected.kind === 'unavailable' && projected.reason === 'frontierUnavailable');
        const informational = projected.kind === 'advanced' || projected.kind === 'idle';
        const code = `channels_projection_${'reason' in projected ? projected.reason : projected.kind}`;
        if (projected.kind === 'unavailable' && retryable) {
          noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
        }
        logOutwardDeliverySupervisorWorkFailure(context, 'transcript-projection', {
          bindingId, outcome: { code, retryable, informational },
        });
      }
    } catch (error) {
      // Projection never receives a local replacement owner; its unchanged
      // frontier causes the canonical page to be re-read on the next wake.
      workFailed('transcript-projection', { error, bindingId });
    }
  }

  if (context.signal.aborted) return cycleResult();

  // Coarse retention runs last in the wake, behind every live obligation.
  // Redrive, permission-wait mediation, and transcript projection are what a
  // person is waiting on; a retention page is a whole page of storage calls
  // that only reclaims rows already past their thirty-day window, so nothing it
  // does is worth delaying an approval prompt by. Its own keyset cursor carries
  // the remainder to the next wake either way.
  // Cutoff validity belongs to the scanner, which already answers a cutoff
  // before the epoch with an empty page. Repeating that decision here compared
  // an absolute wall-clock reading against a thirty-day DURATION, so the branch
  // was true for every wake after 1970-01-31 and could not refuse anything.
  const retentionAt = now();
  if (input.retentionSweep?.notBefore !== undefined && retentionAt < input.retentionSweep.notBefore) {
    return cycleResult();
  }
  try {
    const scanned = await scanner.scanRetention({
      cutoff: retentionAt - OUTWARD_DELIVERY_RETENTION_MS,
      limit: MAX_DELIVERIES_PER_WAKE,
      ...(input.retentionSweep?.cursor === undefined ? {} : { cursor: input.retentionSweep.cursor }),
    });
    if (scanned.kind === 'unavailable') {
      if (scanned.reason !== 'cancelled') {
        workFailed('delivery-retention');
      }
    } else {
      let earliestRetainedAt = earliestRetentionDeadlineAnchor(
        input.retentionSweep?.earliestRetainedAt,
        scanned.earliestRetainedUpdatedAt,
      );
      if (context.signal.aborted) {
        nextRetentionSweep = advanceRetentionSweep({ scanned, earliestRetainedAt });
        return cycleResult();
      }
      if (scanned.records.length > 0) {
        const retirementRecords: ConversationOutwardDeliveryRecord[] = [];
        for (const record of scanned.records) {
          const connection = await stateCollection.get(record.obligation.connectionId, { signal: context.signal });
          // The scanner has already proved terminal eligibility and the
          // thirty-day cutoff. Deleted connections leave that retention duty
          // here; live connections still require their current placement.
          if (connection === null || await isConversationConnectionPlacedForInvocation(context, record.obligation.connectionId)) {
            retirementRecords.push(record);
          }
        }
        const unreachableControlSourceIds = await readUnreachableControlSourceIds({
          context,
          records: retirementRecords,
        });
        const retired = await deliveryStore.retireSelected({
          records: retirementRecords.map((record) => ({
            custodyId: record.custodyId,
            expectedRevision: record.revision,
            physicallyForget: canPhysicallyForgetOutwardCustody({
              record,
              currentBindingIds,
              mediationsByBindingId: permissionMediationsByBindingId,
              unreachableControlSourceIds,
            }),
          })),
        });
        if (retired.kind === 'unavailable' && retired.reason !== 'cancelled') {
          workFailed('delivery-retention');
        }
        if (retired.kind !== 'retired') {
          // A row this pass selected but did not retire — lost CAS or refused
          // storage — is already past the window, so the pass is not exhausted.
          // Carry the existing recovery interval instead of parking for the
          // retention horizon or repeatedly retrying at this same instant.
          earliestRetainedAt = earliestRetentionDeadlineAnchor(
            earliestRetainedAt,
            retentionAt + RECONCILIATION_INTERVAL_MS - OUTWARD_DELIVERY_RETENTION_MS,
          );
        }
      }
      nextRetentionSweep = advanceRetentionSweep({ scanned, earliestRetainedAt });
    }
  } catch (error) {
    workFailed('delivery-retention', { error });
  }
  return cycleResult();
}

/**
 * One activation-owned runner drives projection and retained custody. It owns
 * no Account cache or durable queue: restart simply starts from Collection
 * state, while a transient keyset cursor prevents one hot row from starving a
 * later retained row during this generation.
 */
export function createConversationOutwardDeliverySupervisor(
  options: ConversationOutwardDeliverySupervisorOptions = {},
): ConversationOutwardDeliverySupervisor {
  const clock = options.clock ?? DEFAULT_CLOCK;
  const reconciliationIntervalMs = positiveDelay(
    options.reconciliationIntervalMs,
    RECONCILIATION_INTERVAL_MS,
    'Outward delivery reconciliation interval',
  );
  const staleAttemptAfterMs = positiveDelay(
    options.staleAttemptAfterMs,
    STALE_ATTEMPT_AFTER_MS,
    'Outward delivery stale-attempt interval',
  );
  const runCycle = options.runCycle ?? runConversationOutwardDeliveryCycle;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Outward delivery supervisor is disposed.');
    if (running !== null) throw new Error('Outward delivery supervisor is already running.');
    const supervisorController = new AbortController();
    controller = supervisorController;
    const abortFromContext = (): void => supervisorController.abort(context.signal.reason);
    if (context.signal.aborted) abortFromContext();
    else context.signal.addEventListener('abort', abortFromContext, { once: true });
    let deliveryCursor: string | undefined;
    let deliveryDeadline: number | undefined;
    let retentionSweep: ConversationOutwardRetentionSweepState | undefined;
    const wake = createSupervisorWake(supervisorController.signal);
    const observations: Array<{ dispose(): void }> = [];
    const sessions = new Map<string, { dispose(): void }>();
    const unavailablePermissionBindings = new Set<string>();
    let permissionSourcesInvalidated = false;
    let discoveryInvalidated = false;
    const invalidate = () => {
      discoveryInvalidated = true;
      wake.wake();
    };
    const invalidatePermissionSources = () => {
      permissionSourcesInvalidated = true;
      unavailablePermissionBindings.clear();
      invalidate();
    };
    running = (async () => {
      try {
        const account = requireChannelsAccountStorage(context);
        for (const definition of [CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION]) {
          observations.push(account.collection(definition).watch({ kind: 'collection' },
            definition === CHANNEL_STATE_COLLECTION ? invalidatePermissionSources : invalidate));
        }
        while (!supervisorController.signal.aborted) {
          // Retirement and delivery writes emit the same hints as foreign
          // changes. Finish the current keyset pass before replaying them,
          // otherwise each written page restarts discovery at the same prefix.
          // The fresh pass still discovers changes behind either cursor.
          if (discoveryInvalidated && deliveryCursor === undefined && retentionSweep?.cursor === undefined) {
            discoveryInvalidated = false;
            deliveryDeadline = undefined;
            retentionSweep = undefined;
          }
          wake.reset();
          permissionSourcesInvalidated = false;
          const observedSessions = new Set<string>();
          let nextWakeAt: number | undefined;
          let continuationStalled = false;
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          try {
            if (deliveryCursor === undefined) deliveryDeadline = undefined;
            const cycle = await runCycle({
              context: workerContext,
              now: clock.now,
              staleAttemptAfterMs,
              unavailablePermissionBindings,
              observeSession: async sessionId => {
                observedSessions.add(sessionId);
                if (sessions.has(sessionId)) return;
                const session = await context.services.sessions.get(sessionId, { signal: supervisorController.signal });
                if (session !== null) sessions.set(sessionId, session.watch(invalidatePermissionSources));
              },
              ...(deliveryCursor === undefined ? {} : { deliveryCursor }),
              ...(retentionSweep === undefined ? {} : { retentionSweep }),
            });
            const advancedContinuation = (cycle.nextDeliveryCursor !== undefined && cycle.nextDeliveryCursor !== deliveryCursor)
              || (cycle.nextRetentionSweep?.cursor !== undefined && cycle.nextRetentionSweep.cursor !== retentionSweep?.cursor);
            continuationStalled = (cycle.nextDeliveryCursor !== undefined && cycle.nextDeliveryCursor === deliveryCursor)
              || (cycle.nextRetentionSweep?.cursor !== undefined && cycle.nextRetentionSweep.cursor === retentionSweep?.cursor);
            deliveryCursor = cycle.nextDeliveryCursor;
            retentionSweep = cycle.nextRetentionSweep;
            // An invalidation during the pending read must not be overwritten
            // by that read's later terminal failure.
            if (permissionSourcesInvalidated) unavailablePermissionBindings.clear();
            nextWakeAt = cycle.nextWakeAt;
            if (nextWakeAt !== undefined) deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, nextWakeAt);
            nextWakeAt = deliveryDeadline;
            if (advancedContinuation || (discoveryInvalidated && !continuationStalled)) nextWakeAt = clock.now();
            else if (retentionSweep?.notBefore !== undefined) {
              nextWakeAt = Math.min(nextWakeAt ?? Infinity, retentionSweep.notBefore);
            }
            for (const [id, observation] of sessions) {
              if (!observedSessions.has(id)) { observation.dispose(); sessions.delete(id); }
            }
          } catch (error) {
            // Leave the cursor unchanged so a transient failure cannot skip
            // a durable row. The next wake repeats canonical discovery.
            if (!supervisorController.signal.aborted) {
              logOutwardDeliverySupervisorCycleFailure(workerContext, error);
              nextWakeAt = clock.now() + reconciliationIntervalMs;
              continuationStalled = true;
            }
          }
          if (supervisorController.signal.aborted) break;
          try {
            // The pending hint is retained above. Do not let its wake bit
            // bypass a failed page's recovery. Healthy exhausted scans still
            // replay hints immediately, independently of unrelated deadlines.
            if (continuationStalled && discoveryInvalidated && nextWakeAt !== undefined && nextWakeAt > clock.now()) wake.reset();
            await wake.wait(clock, nextWakeAt);
          } catch {
            if (!supervisorController.signal.aborted) {
              throw new Error('Outward delivery supervisor wait failed.');
            }
          }
        }
      } finally {
        for (const observation of [...observations, ...sessions.values()]) observation.dispose();
        wake.dispose();
        context.signal.removeEventListener('abort', abortFromContext);
        controller = null;
      }
    })();
    try {
      await running;
    } finally {
      running = null;
    }
  };

  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    controller?.abort(new Error('Outward delivery supervisor was disposed.'));
    await running;
  };

  return Object.freeze({ run, dispose });
}
