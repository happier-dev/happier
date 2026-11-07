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
import { createOutwardBindingObservation } from './outwardBindingObservation.js';
import { createChannelsCollectionAccess } from './collectionUpdateRequired.js';
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
import { projectConversationDiscussionPage } from './discussionProjection.js';

const RECONCILIATION_INTERVAL_MS = 1_000;
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
  deliveryCursor?: string;
  retentionSweep?: ConversationOutwardRetentionSweepState;
  createAttemptId?: () => string;
  /** Omitted for structural discovery; delivery-only wakes supply an empty list. */
  bindingIds?: readonly string[];
  observeSession?: (sessionId: string, bindingId: string) => Promise<void>;
  observeDiscussion?: (discussionId: string, bindingId: string) => void;
}>;

export type ConversationOutwardDeliveryCycleResult = Readonly<{
  nextDeliveryCursor?: string;
  nextRetentionSweep?: ConversationOutwardRetentionSweepState;
  nextWakeAt?: number;
  nextBindingIds?: readonly string[] | 'all';
}>;

export type ConversationOutwardDeliverySupervisorOptions = Readonly<{
  clock?: Clock;
  reconciliationIntervalMs?: number;
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
      || (result.kind === 'notAttempted' && result.reason === 'notDue')
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
  return true;
}

function isUnattemptedPermissionWait(record: ConversationOutwardDeliveryRecord): boolean {
  return record.custody.state === 'ready' && record.custody.attemptCount === 0;
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
  const createAttemptId = input.createAttemptId ?? defaultAttemptId;
  const { context } = input;
  if (context.signal.aborted) return {};
  let nextWakeAt: number | undefined;
  const nextBindingIds = new Set<string>();
  let bindingDiscoveryFailed = false;
  const noteDeadline = (at: number | undefined) => {
    if (at !== undefined) nextWakeAt = Math.min(nextWakeAt ?? Infinity, at);
  };
  const noteCustody = (custody: ConversationDeliveryCustody) => {
    if (hasPendingConversationThreadBinding(custody)) noteDeadline(now());
    if (custody.state === 'retryDue') noteDeadline(custody.retryNotBefore ?? now());
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
    if (detail.bindingId !== undefined) nextBindingIds.add(detail.bindingId);
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
        now,
        signal: context.signal,
      });
      if ('custody' in result) noteCustody(result.custody);
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
    ...(bindingDiscoveryFailed ? { nextBindingIds: 'all' as const }
      : nextBindingIds.size === 0 ? {} : { nextBindingIds: [...nextBindingIds] }),
    ...(nextWakeAt === undefined ? {} : { nextWakeAt }),
    ...(nextDeliveryCursor === undefined ? {} : { nextDeliveryCursor }),
    ...(nextRetentionSweep === undefined ? {} : { nextRetentionSweep }),
  });
  const retainedPermissionWaits = new Map<string, ConversationOutwardDeliveryRecord>();
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
          retainedPermissionWaits.set(record.custodyId, record);
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
    bindingIds = input.bindingIds ?? await readCurrentBindingIds(context);
  } catch (error) {
    bindingDiscoveryFailed = true;
    workFailed('binding-discovery', { error });
    return cycleResult();
  }

  const permissionMediationsByBindingId = new Map<string, PermissionWaitMediationSnapshot>();
  const mediateBinding = async (bindingId: string): Promise<void> => {
    if (context.signal.aborted) return;
    const source = await readConversationPermissionWaitMediationSource({
      stateCollection,
      bindingId,
      signal: context.signal,
    });
    if (source.kind === 'notEligible') return;
    if (source.kind === 'unavailable') {
      if (source.reason === 'bindingUnavailable') {
        logOutwardDeliverySupervisorWorkFailure(context, 'permission-mediation', {
          bindingId, outcome: { code: 'channels_binding_target_unavailable', retryable: false, informational: false },
        });
      } else if (source.reason !== 'cancelled') {
        workFailed('permission-mediation', { bindingId });
      }
      return;
    }
    if (!await isConversationConnectionPlacedForInvocation(context, source.source.connectionId)) return;
    try {
      await input.observeSession?.(source.source.sessionId, bindingId);
    } catch (error) {
      workFailed('transcript-projection', { error, bindingId });
    }
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
      if (!context.signal.aborted) workFailed('permission-mediation', { error, bindingId });
      return;
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
      if (accepted.kind === 'accepted' && !isConversationDeliveryAutomaticTerminal(accepted.custody)) {
        // Admission already supplied the exact durable record. Send through
        // the canonical claim/currentness owner now, before transcript
        // publication or another binding's unavailable Session can delay it.
        retainedPermissionWaits.delete(accepted.custodyId);
        try {
          await redriveRetainedDelivery(accepted.record);
        } catch (error) {
          workFailed('delivery-operation', { error, bindingId, connectionId: source.source.connectionId });
        }
      }
    }
    // Only the canonical reader's complete projection proves absence. Positive
    // requests above remain usable even when another page is unavailable.
    if (pending.truncated) return;
    permissionMediationsByBindingId.set(bindingId, {
      source: source.source,
      pendingRequestKeys,
    });
  };
  // Bindings have independent Session owners. A slow or unavailable owner
  // must not serialize another binding's pending-request notification.
  const mediationBindingIds = new Set(bindingIds);
  for (const record of retainedPermissionWaits.values()) {
    if (record.obligation.bindingId !== undefined) mediationBindingIds.add(record.obligation.bindingId);
  }
  await Promise.all([...mediationBindingIds].map(async bindingId => {
    try {
      await mediateBinding(bindingId);
    } catch (error) {
      workFailed('permission-mediation', { error, bindingId });
    }
  }));

  for (const record of retainedPermissionWaits.values()) {
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
      // A changed summary can conflict with frozen admission content. The
      // exact positive request still authorizes recovery of its original
      // custody; records already driven above were removed from this map.
      try {
        await redriveRetainedDelivery(record);
      } catch (error) {
        workFailed('delivery-operation', { error, connectionId: record.obligation.connectionId,
          ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }) });
      }
      continue;
    }
    // Snapshot admission already proved a complete exact-source read. Attempted
    // or ambiguous effects retain their ordinary custody truth.
    if (!isUnattemptedPermissionWait(record)
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
      const bindingRow = asChannelStateRow(await stateCollection.get(bindingId, { signal: context.signal }));
      const connectionId = bindingRow === undefined ? undefined : bindingConnectionIdFromRow(bindingRow.value, bindingId);
      if (bindingRow === undefined || connectionId === undefined || !await isConversationConnectionPlacedForInvocation(context, connectionId)) continue;
      const deliverProjection = async (projection: Pick<Parameters<typeof deliverConversationSessionProjectionOutwardDelivery>[0],
        'binding' | 'frontierRowRevision' | 'source' | 'content' | 'replyContext'>): Promise<ConversationOutwardDeliveryResult> => {
        // A content read can outlive placement changes. Both projection kinds
        // enter the same custody claim after this natural-boundary check.
        if (!await isConversationConnectionPlacedForInvocation(context, projection.binding.connectionId)) {
          return { kind: 'notAttempted', reason: 'connectionUnavailable' };
        }
        const result = await deliverConversationSessionProjectionOutwardDelivery({ stateCollection,
          targetedContributions: context.services.targetedContributions, actions: context.services.actions,
          store: deliveryStore, ...projection, attemptId: createAttemptId(), now, signal: context.signal });
        const retryable = noteDeliveryResult(result);
        observedDeliveryOutcome = logOutwardDeliverySupervisorDeliveryOutcome(context,
          'transcript-projection', { bindingId }, result, retryable) || observedDeliveryOutcome;
        return result;
      };
      const target = isJsonRecord(bindingRow.value) && isJsonRecord(bindingRow.value.payload)
        ? bindingRow.value.payload.target : undefined;
      const projected = target !== undefined && isJsonRecord(target) && target.kind === 'discussion'
        ? await projectConversationDiscussionPage({
          actions: context.services.actions, stateCollection,
          bindingRow, bindingId, signal: context.signal, now,
          observeDiscussion: input.observeDiscussion,
          deliver: deliverProjection,
        })
        : await projectConversationSessionTranscriptPage({
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
          const relations = await readConversationSessionInputReplyRelations({
            stateCollection, bindingId: binding.bindingId, connectionId: binding.connectionId,
            sessionId: source.sessionId, signal: context.signal,
            consumedLocalIds: item.kind === 'assistantText'
              ? item.consumedInputs.filter(({ origin }) => hasConversationInputOriginFromBinding(origin, binding.bindingId))
                .map(({ localId }) => localId)
              : [],
          });
          const replyContext = relations.at(-1)?.replyContext;
          const result = await deliverProjection({
            binding,
            frontierRowRevision,
            source,
            content: item.text,
            ...(replyContext === undefined ? {} : { replyContext }),
          });
          if (result.kind === 'retired' || ((result.kind === 'settled' || result.kind === 'suppressed')
            && isConversationDeliveryAutomaticTerminal(result.custody))) {
            await markConversationSessionInputRepliesProjected({ stateCollection, relations, seq: item.seq, signal: context.signal });
          }
          return result;
        },
      });
      if (projected.kind === 'advanced' && projected.hasMore) {
        nextBindingIds.add(bindingId);
        noteDeadline(now());
      }
      // Publication can recover without another transcript invalidation.
      // Re-read the preserved frontier on the existing recovery cadence.
      if (projected.kind === 'blocked' && projected.reason === 'publicationBarrier') {
        nextBindingIds.add(bindingId);
        noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
      }
      if (projected.kind === 'blocked' && projected.reason === 'deliveryPending') nextBindingIds.add(bindingId);
      // Typed outcomes used to disappear here, leaving no way to distinguish
      // a parked frontier, a deferred Action and a page with no eligible reply.
      // Emit one content-free result through the same work record as thrown
      // failures. An approval deferral must not create a timed approval loop.
      if (!(projected.kind === 'unavailable' && projected.reason === 'cancelled')
        && !((projected.kind === 'advanced' || projected.kind === 'idle') && projected.deliveredItemCount > 0)
        && !(observedDeliveryOutcome && projected.kind === 'blocked' && projected.reason === 'deliveryPending')) {
        const retryable = projected.kind === 'blocked'
          || (projected.kind === 'unavailable' && (projected.reason === 'frontierUnavailable' || projected.retryable === true));
        const informational = projected.kind === 'advanced' || projected.kind === 'idle';
        const code = (projected.kind === 'unavailable' ? projected.actionErrorCode : undefined)
          ?? `channels_projection_${'reason' in projected ? projected.reason : projected.kind}`;
        if (projected.kind === 'unavailable' && retryable) {
          nextBindingIds.add(bindingId);
          noteDeadline(now() + RECONCILIATION_INTERVAL_MS);
        }
        logOutwardDeliverySupervisorWorkFailure(context, 'transcript-projection', {
          bindingId, outcome: { code, retryable, informational },
        });
        if (projected.kind === 'blocked' && retryable) nextBindingIds.add(bindingId);
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
        const retired = await deliveryStore.retireSelected({
          records: retirementRecords.map((record) => ({
            custodyId: record.custodyId,
            expectedRevision: record.revision,
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
  const runCycle = options.runCycle ?? runConversationOutwardDeliveryCycle;
  let controller: AbortController | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  let updateRequired = false;

  const run = async (context: BackgroundServiceContext): Promise<void> => {
    if (disposed) throw new Error('Outward delivery supervisor is disposed.');
    if (running !== null) throw new Error('Outward delivery supervisor is already running.');
    if (updateRequired) return;
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
    let discoverBindings = true;
    const changedBindingIds = new Set<string>();
    const retryBindingIds = new Set<string>();
    const sessions = createOutwardBindingObservation({ ...context, signal: supervisorController.signal }, bindingIds => {
      for (const bindingId of bindingIds) changedBindingIds.add(bindingId);
      wake.wake();
    });
    let discoveryInvalidated = false;
    const invalidate = () => {
      discoveryInvalidated = true;
      wake.wake();
    };
    running = (async () => {
      try {
        const access = createChannelsCollectionAccess(requireChannelsAccountStorage(context), (status, error) => {
          updateRequired = true;
          context.services.logger.warn('[Channels] Account Collection requires an update', status);
          supervisorController.abort(error);
        });
        context = { ...context, services: { ...context.services, storage: {
          ...context.services.storage, account: access.storage,
        } } };
        const account = access.storage;
        // Only structural changes require binding discovery. Input publication
        // uses its Session selector; projection-frontier writes are our output.
        observations.push(account.collection(CHANNEL_STATE_COLLECTION).watch({
          index: CHANNEL_STATE_INDEX_ID.byKind,
          prefixes: [CHANNEL_STATE_RECORD_KIND.connection, CHANNEL_STATE_RECORD_KIND.binding].map(kind => [kind]),
          order: 'asc',
        }, () => { discoverBindings = true; invalidate(); }));
        observations.push(account.collection(CHANNEL_DELIVERIES_COLLECTION).watch({ kind: 'collection' }, invalidate));
        while (!supervisorController.signal.aborted) {
          // Retirement and delivery writes emit the same hints as foreign
          // changes. Finish the current keyset pass before replaying them,
          // otherwise each written page restarts discovery at the same prefix.
          // The fresh pass still discovers changes behind either cursor.
          if (discoveryInvalidated && deliveryCursor === undefined && retentionSweep?.cursor === undefined) {
            discoveryInvalidated = false;
            if (retryBindingIds.size === 0) deliveryDeadline = undefined;
            retentionSweep = undefined;
          }
          const fullBindingDiscovery = discoverBindings;
          discoverBindings = false;
          const bindingIds = new Set(changedBindingIds);
          changedBindingIds.clear();
          if (deliveryDeadline !== undefined && deliveryDeadline <= clock.now()) {
            for (const bindingId of retryBindingIds) bindingIds.add(bindingId);
            retryBindingIds.clear();
            deliveryDeadline = undefined;
          }
          wake.reset();
          const observedBindings = new Map<string, string>();
          const observedDiscussions = new Map<string, string>();
          let nextWakeAt: number | undefined;
          let continuationStalled = false;
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          try {
            if (deliveryCursor === undefined && retryBindingIds.size === 0) deliveryDeadline = undefined;
            const cycle = await runCycle({
              context: workerContext,
              now: clock.now,
              ...(fullBindingDiscovery ? {} : { bindingIds: [...bindingIds] }),
              observeSession: async (sessionId, bindingId) => {
                observedBindings.set(bindingId, sessionId);
                await sessions.observe(sessionId, bindingId);
              },
              observeDiscussion: (discussionId, bindingId) => {
                observedDiscussions.set(bindingId, discussionId);
                sessions.observeDiscussion(discussionId, bindingId);
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
            nextWakeAt = cycle.nextWakeAt;
            if (cycle.nextBindingIds === 'all') discoverBindings = true;
            else for (const bindingId of cycle.nextBindingIds ?? []) retryBindingIds.add(bindingId);
            if (nextWakeAt !== undefined) deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, nextWakeAt);
            nextWakeAt = deliveryDeadline;
            if (advancedContinuation || (discoveryInvalidated && !continuationStalled)) nextWakeAt = clock.now();
            else if (retentionSweep?.notBefore !== undefined) {
              nextWakeAt = Math.min(nextWakeAt ?? Infinity, retentionSweep.notBefore);
            }
            if (fullBindingDiscovery && cycle.nextBindingIds !== 'all') sessions.reconcile(observedBindings, observedDiscussions);
          } catch (error) {
            // Leave the cursor unchanged so a transient failure cannot skip
            // a durable row. The next wake repeats canonical discovery.
            if (!supervisorController.signal.aborted) {
              logOutwardDeliverySupervisorCycleFailure(workerContext, error);
              if (fullBindingDiscovery) discoverBindings = true;
              else for (const bindingId of bindingIds) retryBindingIds.add(bindingId);
              nextWakeAt = clock.now() + reconciliationIntervalMs;
              deliveryDeadline = Math.min(deliveryDeadline ?? Infinity, nextWakeAt);
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
        for (const observation of observations) observation.dispose();
        sessions.dispose();
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
