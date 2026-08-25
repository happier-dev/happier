import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1 } from '@happier-dev/plugin-sdk/collections';
import {
  MAX_CONVERSATION_BINDINGS_PER_ACCOUNT,
} from '@happier-dev/channels-protocol/v1';

import {
  CHANNEL_DELIVERIES_COLLECTION,
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_INDEX_ID,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';
import {
  classifySupervisorFailure,
  isInactiveSupervisorCollectionFailure,
} from './supervisorFailure.js';
import {
  acceptConversationPermissionWaitOutwardDelivery,
  createConversationOutwardDeliveryCollectionScanner,
  createConversationOutwardDeliveryCollectionStore,
  deliverConversationSessionProjectionOutwardDelivery,
  readConversationPermissionWaitMediationSource,
  redriveConversationOutwardDelivery,
  redriveConversationOutwardDeliveryThroughProviderAction,
  reconcileConversationOutwardDeliveryAttemptThroughProviderAction,
  type ConversationOutwardDeliveryRecord,
  type ConversationPermissionWaitMediationSource,
} from './outwardDelivery.js';
import { finalizeConversationConnectionDeletesForInvocation } from './management.js';
import {
  readConversationPendingPermissions,
  type ConversationPendingPermissionProjection,
} from './permissionMediation.js';
import {
  createConversationSessionProjectionCollectionStore,
  projectConversationSessionTranscriptPage,
  type ConversationSessionProjectionResult,
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
 * recovery window, or one whole window from now when it retained nothing,
 * because a row that terminalizes after the pass cannot become eligible sooner
 * than that. It is a derived deadline rather than a polling interval, so it
 * delays no reclamation and needs no chosen number.
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
}>;

export type ConversationOutwardDeliveryCycleResult = Readonly<{
  nextDeliveryCursor?: string;
  nextRetentionSweep?: ConversationOutwardRetentionSweepState;
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
  retentionAt: number;
}>): ConversationOutwardRetentionSweepState {
  if (input.scanned.nextCursor !== undefined) {
    return {
      cursor: input.scanned.nextCursor,
      ...(input.earliestRetainedAt === undefined ? {} : { earliestRetainedAt: input.earliestRetainedAt }),
    };
  }
  return {
    notBefore: (input.earliestRetainedAt ?? input.retentionAt) + OUTWARD_DELIVERY_RETENTION_MS,
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
  identifiers?: Readonly<{ connectionId?: string; bindingId?: string; error?: unknown }>,
): void {
  if (context.signal.aborted) return;
  if (isInactiveSupervisorCollectionFailure(identifiers?.error)) return;
  context.services.logger.warn('[Channels] outward delivery supervisor work failed', {
    boundary,
    ...(classifySupervisorFailure(identifiers?.error) ?? {}),
    ...(identifiers?.connectionId === undefined ? {} : { connectionId: identifiers.connectionId }),
    ...(identifiers?.bindingId === undefined ? {} : { bindingId: identifiers.bindingId }),
  });
}

/**
 * A history gap is a typed result, not a thrown error: projection returns it
 * and leaves the frontier unchanged, so the next wake repeats the same rejected
 * or unusable cursor forever. Discarding that value hid a permanently stuck
 * binding behind a healthy-looking cycle. The reason is a closed literal, so
 * this carries no session, endpoint, or transcript content.
 */
function logConversationSessionProjectionHistoryGap(
  context: BackgroundServiceContext,
  input: Readonly<{
    bindingId: string;
    reason: Extract<ConversationSessionProjectionResult, Readonly<{ kind: 'historyGap' }>>['reason'];
  }>,
): void {
  if (context.signal.aborted) return;
  context.services.logger.warn('[Channels] Session projection cannot advance its transcript frontier', {
    boundary: 'transcript-projection',
    bindingId: input.bindingId,
    reason: input.reason,
  });
}

function isProjectionConnectionCurrent(value: JsonValue, connectionId: string): boolean {
  if (!isJsonRecord(value)
    || value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.connection
    || value[CHANNEL_STATE_FIELD.id] !== connectionId
    || value[CHANNEL_STATE_FIELD.connectionId] !== connectionId
    || !isJsonRecord(value.payload)) return false;
  return value.payload.enabled === true && value.payload.deletionState === 'none';
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

async function readCurrentBindingIds(context: BackgroundServiceContext): Promise<readonly string[]> {
  const collection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const bindingIds: string[] = [];
  // Connection currentness is a per-connection fact, and the Account holds at
  // most 32 connections against 256 bindings. Reading it once per binding cost
  // up to 256 serial gets for the same ≤32 answers, on the wake that also owns
  // permission-wait redrive. The enumeration is one consistent read anyway: a
  // connection that changes mid-enumeration is re-read at every effect, which
  // is where currentness is actually enforced.
  const connectionCurrentness = new Map<string, boolean>();
  let cursor: string | undefined;
  do {
    const page = await collection.query({
      index: CHANNEL_STATE_INDEX_ID.byKind,
      prefix: [CHANNEL_STATE_RECORD_KIND.binding],
      order: 'asc',
      limit: Math.min(MAX_CONVERSATION_BINDINGS_PER_ACCOUNT - bindingIds.length, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1),
      ...(cursor === undefined ? {} : { cursor }),
    }, { signal: context.signal });
    for (const row of page.rows) {
      const bindingId = bindingIdFromRow(row.value, row.rowId);
      const connectionId = bindingConnectionIdFromRow(row.value, row.rowId);
      if (bindingId === undefined || connectionId === undefined) continue;
      let current = connectionCurrentness.get(connectionId);
      if (current === undefined) {
        const connection = await collection.get(connectionId, { signal: context.signal });
        current = connection !== null && isProjectionConnectionCurrent(connection.value, connectionId);
        connectionCurrentness.set(connectionId, current);
      }
      if (current) bindingIds.push(bindingId);
    }
    if (bindingIds.length >= MAX_CONVERSATION_BINDINGS_PER_ACCOUNT) return bindingIds;
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
  const stateCollection = requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION);
  const deliveriesCollection = requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION);
  try {
    // Delete custody is settled before generic redrive so a retained ready row
    // cannot race into a provider effect after connection authority is gone.
    await finalizeConversationConnectionDeletesForInvocation(context);
  } catch (error) {
    // The retained finalizing row remains the recovery source for the next wake.
    logOutwardDeliverySupervisorWorkFailure(context, 'delete-finalization', { error });
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
    if (record.custody.state === 'attempting') {
      await reconcileConversationOutwardDeliveryAttemptThroughProviderAction({
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
      return;
    }
    await redriveConversationOutwardDeliveryThroughProviderAction({
      stateCollection,
      targetedContributions: context.services.targetedContributions,
      actions: context.services.actions,
      store: deliveryStore,
      record,
      attemptId: createAttemptId(),
      now,
      signal: context.signal,
    });
  };

  let nextDeliveryCursor = input.deliveryCursor;
  let nextRetentionSweep = input.retentionSweep;
  const cycleResult = (): ConversationOutwardDeliveryCycleResult => ({
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
        logOutwardDeliverySupervisorWorkFailure(context, 'delivery-scan');
      }
    } else {
      nextDeliveryCursor = scanned.nextCursor;
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
          logOutwardDeliverySupervisorWorkFailure(context, 'delivery-operation', {
            error,
            connectionId: record.obligation.connectionId,
            ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
          });
        }
      }
    }
  } catch (error) {
    // Storage/action availability is re-evaluated next wake from durable rows.
    logOutwardDeliverySupervisorWorkFailure(context, 'delivery-scan', { error });
  }

  if (context.signal.aborted) return cycleResult();

  let bindingIds: readonly string[];
  try {
    bindingIds = await readCurrentBindingIds(context);
  } catch (error) {
    logOutwardDeliverySupervisorWorkFailure(context, 'binding-discovery', { error });
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
        logOutwardDeliverySupervisorWorkFailure(context, 'permission-mediation', { bindingId });
      }
      continue;
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
      if (!context.signal.aborted) {
        logOutwardDeliverySupervisorWorkFailure(context, 'permission-mediation', { error, bindingId });
      }
      continue;
    }
    const pendingRequestKeys = new Set<string>();
    for (const request of pending.requests) {
      if (context.signal.aborted) break;
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
        logOutwardDeliverySupervisorWorkFailure(context, 'permission-mediation', { bindingId });
      }
    }
    permissionMediationsByBindingId.set(bindingId, {
      source: source.source,
      pendingRequestKeys,
      truncated: pending.truncated,
    });
  }

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
        logOutwardDeliverySupervisorWorkFailure(context, 'delivery-operation', {
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
    if (mediation.truncated || !isUnattemptedPermissionWait(record)) continue;
    try {
      await redriveConversationOutwardDelivery({
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
    } catch (error) {
      logOutwardDeliverySupervisorWorkFailure(context, 'permission-mediation', {
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
    try {
      const projected = await projectConversationSessionTranscriptPage({
        actions: context.services.actions,
        store: projectionStore,
        bindingId,
        signal: context.signal,
        deliver: async ({ binding, item, source }) => await deliverConversationSessionProjectionOutwardDelivery({
          stateCollection,
          targetedContributions: context.services.targetedContributions,
          actions: context.services.actions,
          store: deliveryStore,
          binding,
          source,
          content: item.text,
          attemptId: createAttemptId(),
          now,
          signal: context.signal,
        }),
      });
      if (projected.kind === 'historyGap') {
        logConversationSessionProjectionHistoryGap(context, { bindingId, reason: projected.reason });
      }
    } catch (error) {
      // Projection never receives a local replacement owner; its unchanged
      // frontier causes the canonical page to be re-read on the next wake.
      logOutwardDeliverySupervisorWorkFailure(context, 'transcript-projection', { error, bindingId });
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
        logOutwardDeliverySupervisorWorkFailure(context, 'delivery-retention');
      }
    } else {
      let earliestRetainedAt = earliestRetentionDeadlineAnchor(
        input.retentionSweep?.earliestRetainedAt,
        scanned.earliestRetainedUpdatedAt,
      );
      for (const record of scanned.records) {
        if (context.signal.aborted) {
          nextRetentionSweep = advanceRetentionSweep({ scanned, earliestRetainedAt, retentionAt });
          return cycleResult();
        }
        const retired = await deliveryStore.retire({
          custodyId: record.custodyId,
          expectedRevision: record.revision,
        });
        if (retired.kind === 'unavailable' && retired.reason !== 'cancelled') {
          logOutwardDeliverySupervisorWorkFailure(context, 'delivery-retention', {
            connectionId: record.obligation.connectionId,
            ...(record.obligation.bindingId === undefined ? {} : { bindingId: record.obligation.bindingId }),
          });
        }
        if (retired.kind !== 'retired') {
          // A row this pass selected but did not retire — lost CAS or refused
          // storage — is already past the window, so the pass is not exhausted.
          // Anchoring at the cutoff resolves the deadline to this wake, and the
          // next one rescans exactly as it did before a pass carried one.
          earliestRetainedAt = earliestRetentionDeadlineAnchor(
            earliestRetainedAt,
            retentionAt - OUTWARD_DELIVERY_RETENTION_MS,
          );
        }
      }
      nextRetentionSweep = advanceRetentionSweep({ scanned, earliestRetainedAt, retentionAt });
    }
  } catch (error) {
    logOutwardDeliverySupervisorWorkFailure(context, 'delivery-retention', { error });
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
    let retentionSweep: ConversationOutwardRetentionSweepState | undefined;
    running = (async () => {
      try {
        while (!supervisorController.signal.aborted) {
          const workerContext = {
            ...context,
            signal: supervisorController.signal,
          } satisfies BackgroundServiceContext;
          try {
            const cycle = await runCycle({
              context: workerContext,
              now: clock.now,
              staleAttemptAfterMs,
              ...(deliveryCursor === undefined ? {} : { deliveryCursor }),
              ...(retentionSweep === undefined ? {} : { retentionSweep }),
            });
            deliveryCursor = cycle.nextDeliveryCursor;
            retentionSweep = cycle.nextRetentionSweep;
          } catch (error) {
            // Leave the cursor unchanged so a transient failure cannot skip
            // a durable row. The next wake repeats canonical discovery.
            if (!supervisorController.signal.aborted) {
              logOutwardDeliverySupervisorCycleFailure(workerContext, error);
            }
          }
          if (supervisorController.signal.aborted) break;
          try {
            await clock.sleep(reconciliationIntervalMs, supervisorController.signal);
          } catch {
            if (!supervisorController.signal.aborted) {
              throw new Error('Outward delivery supervisor wait failed.');
            }
          }
        }
      } finally {
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
