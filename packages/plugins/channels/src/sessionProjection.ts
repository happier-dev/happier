import type {
  ActionsService,
  PluginActionResultById,
} from '@happier-dev/plugin-sdk/actions';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountCollectionForDefinition } from '@happier-dev/plugin-sdk/collections';

import {
  CHANNEL_STATE_COLLECTION,
  CHANNEL_STATE_FIELD,
  CHANNEL_STATE_RECORD_KIND,
} from './collections.js';
import {
  asChannelStateRow as asStoredCollectionRow,
  readConversationBindingUpdateRow,
  type ChannelStateRow as StoredCollectionRow,
} from './accountLocalBindingPolicy.js';
import { isConversationDeliveryAutomaticTerminal } from './deliveryCustody.js';
import type {
  ConversationOutwardDeliveryResult,
  ConversationOutwardSourceV1,
} from './outwardDelivery.js';

const EXTERNAL_SHAREABLE_TRANSCRIPT_PAGE_LIMIT = 100;
const PROJECTION_FRONTIER_ROW_PREFIX = 'projection-frontier:';

type JsonRecord = Readonly<Record<string, JsonValue>>;
type ChannelStateCollection = Pick<
  PluginAccountCollectionForDefinition<typeof CHANNEL_STATE_COLLECTION>,
  'get' | 'batch'
>;

/** The narrow current binding facts that select one Session projection. */
export type ConversationSessionProjectionBinding = Readonly<{
  bindingId: string;
  revision: number;
  connectionId: string;
  target: Readonly<{
    sessionId: string;
    deliveryMode: 'repliesOnly' | 'mirrorSession';
  }>;
}>;

/**
 * The persisted opaque transcript frontier. `lastScannedSeq` is diagnostic
 * monotonic evidence only; it is never used to synthesize an Action cursor.
 */
export type ConversationSessionProjectionFrontier = Readonly<{
  targetSessionId: string;
  transcriptCursor: JsonValue;
  lastScannedSeq: number;
  revision: number;
}>;

export type ConversationSessionProjectionHistoryGapReason =
  | 'cursorRejected'
  | 'frontierCursorInvalid'
  | 'projectionRegression'
  | 'cursorUnavailable';

export type ConversationSessionProjectionHistoryGap = Readonly<{
  kind: 'historyGap';
  reason: ConversationSessionProjectionHistoryGapReason;
  reportedAt: number;
}>;

/**
 * The Channel-state owner supplies one current binding/frontier view and
 * guards the frontier write with that binding revision. Target rotation owns
 * baseline creation separately, in its same guarded state transition.
 */
export interface ConversationSessionProjectionStore {
  read(input: Readonly<{
    bindingId: string;
    signal: AbortSignal;
  }>): Promise<
    | Readonly<{
      kind: 'ready';
      binding: ConversationSessionProjectionBinding;
      frontier: ConversationSessionProjectionFrontier;
      frontierRowId: string;
      frontierRowRevision: number;
    }>
    | Readonly<{ kind: 'bindingUnavailable' | 'frontierUnavailable' }>
  >;
  compareAndSwap(input: Readonly<{
    bindingId: string;
    expectedBindingRevision: number;
    frontierRowId: string;
    expectedFrontierRowRevision: number;
    frontier: ConversationSessionProjectionFrontier;
  }>): Promise<Readonly<{ kind: 'updated' | 'conflict' }>>;
  recordHistoryGap(input: Readonly<{
    bindingId: string;
    expectedBindingRevision: number;
    frontierRowId: string;
    expectedFrontierRowRevision: number;
    frontier: ConversationSessionProjectionFrontier;
    reason: ConversationSessionProjectionHistoryGapReason;
    reportedAt: number;
  }>): Promise<Readonly<{ kind: 'recorded' | 'rejoined' | 'conflict' }>>;
}

export type ConversationSessionProjectionCollectionStoreInput = Readonly<{
  stateCollection: ChannelStateCollection;
  signal: AbortSignal;
}>;

type ExternalShareableTranscriptResult = PluginActionResultById['session.transcript.get'];
type ExternalShareableTranscriptItem = ExternalShareableTranscriptResult['items'][number];
export type ConversationSessionProjectionSource = Extract<
  ConversationOutwardSourceV1,
  Readonly<{ kind: 'sessionProjection' }>
>;

export type ConversationSessionProjectionResult =
  | Readonly<{ kind: 'advanced'; hasMore: boolean; deliveredItemCount: number }>
  | Readonly<{ kind: 'idle'; deliveredItemCount: number }>
  | Readonly<{
    kind: 'blocked';
    reason: 'deliveryPending' | 'frontierChanged' | 'publicationBarrier';
    semanticItemId?: string;
  }>
  | Readonly<{
    kind: 'historyGap';
    reason: ConversationSessionProjectionHistoryGapReason;
    disposition?: 'recorded' | 'rejoined' | 'conflict';
  }>
  | Readonly<{ kind: 'paused'; reason: 'historyGap' }>
  | Readonly<{
    kind: 'unavailable';
    reason: 'bindingUnavailable' | 'frontierUnavailable' | 'targetChanged' | 'transcriptUnavailable' | 'cancelled';
  }>;

/**
 * The only no-history baseline result. Callers may persist the ready cursor in
 * the same guarded target/frontier batch that makes a Session target live.
 * A page that says more exists but cannot advance remains retryable; it never
 * manufactures a cursor or exposes existing transcript history.
 */
export type ConversationSessionProjectionNoHistoryBaseline =
  | Readonly<{
    kind: 'ready';
    transcriptCursor: string | null;
    lastScannedSeq: number;
  }>
  | Readonly<{ kind: 'retry'; reason: 'publicationBarrier' }>
  | Readonly<{ kind: 'historyGap'; reason: 'cursorRejected' | 'projectionMismatch' }>
  | Readonly<{ kind: 'unavailable'; reason: 'cancelled' | 'transcriptUnavailable' }>;

function isTranscriptCursorRejected(error: unknown): boolean {
  return isPluginError(error) && error.code === 'invalid_cursor';
}

function isJsonRecord(value: JsonValue): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value >= 1;
}

export function readConversationSessionProjectionHistoryGap(
  value: JsonValue,
): ConversationSessionProjectionHistoryGap | null {
  if (!isJsonRecord(value)
    || value.kind !== 'historyGap'
    || (value.reason !== 'cursorRejected'
      && value.reason !== 'frontierCursorInvalid'
      && value.reason !== 'projectionRegression'
      && value.reason !== 'cursorUnavailable')
    || !isNonNegativeSafeInteger(value.reportedAt)
    || Object.keys(value).length !== 3) return null;
  return {
    kind: 'historyGap',
    reason: value.reason,
    reportedAt: value.reportedAt,
  };
}

/** One deterministic state-row identity per binding; no opaque delivery identity is reused here. */
export function createConversationSessionProjectionFrontierRowId(bindingId: string): string {
  return `${PROJECTION_FRONTIER_ROW_PREFIX}${bindingId}`;
}

/**
 * Serializes only the projection owner's declared state row. Binding creation and
 * target rotation place this exact row beside the binding in their existing
 * guarded batch; page projection later CASes only this row under that binding.
 */
export function createConversationSessionProjectionFrontierRow(input: Readonly<{
  bindingId: string;
  targetSessionId: string;
  transcriptCursor: JsonValue;
  lastScannedSeq: number;
  revision: number;
  now: number;
  createdAt?: number;
}>): JsonRecord & Readonly<{ id: string }> {
  const rowId = createConversationSessionProjectionFrontierRowId(input.bindingId);
  return {
    [CHANNEL_STATE_FIELD.id]: rowId,
    [CHANNEL_STATE_FIELD.recordKind]: CHANNEL_STATE_RECORD_KIND.projectionFrontier,
    [CHANNEL_STATE_FIELD.version]: 1,
    [CHANNEL_STATE_FIELD.bindingId]: input.bindingId,
    [CHANNEL_STATE_FIELD.createdAt]: input.createdAt ?? input.now,
    [CHANNEL_STATE_FIELD.updatedAt]: input.now,
    payload: {
      targetSessionId: input.targetSessionId,
      transcriptCursor: input.transcriptCursor,
      lastScannedSeq: input.lastScannedSeq,
      revision: input.revision,
    },
  } satisfies JsonRecord;
}

function readProjectionBinding(input: Readonly<{
  row: StoredCollectionRow;
  bindingId: string;
}>): ConversationSessionProjectionBinding | null {
  if (!isPositiveSafeInteger(input.row.revision)) return null;
  let binding: ReturnType<typeof readConversationBindingUpdateRow>['binding'];
  try {
    binding = readConversationBindingUpdateRow(input).binding;
  } catch {
    return null;
  }
  if (binding.enabled !== true || binding.deletionState !== 'none' || binding.target.kind !== 'session') return null;
  return {
    bindingId: input.bindingId,
    revision: input.row.revision,
    connectionId: binding.connectionId,
    target: {
      sessionId: binding.target.sessionId,
      deliveryMode: binding.target.policy.deliveryMode,
    },
  };
}

function readProjectionFrontier(input: Readonly<{
  row: StoredCollectionRow;
  bindingId: string;
}>): Readonly<{
  frontier: ConversationSessionProjectionFrontier;
  createdAt: number;
}> | null {
  const rowId = createConversationSessionProjectionFrontierRowId(input.bindingId);
  const { row } = input;
  const createdAt = isJsonRecord(row.value)
    ? row.value[CHANNEL_STATE_FIELD.createdAt]
    : undefined;
  if (!isJsonRecord(row.value)
    || row.rowId !== rowId
    || row.value[CHANNEL_STATE_FIELD.id] !== rowId
    || row.value[CHANNEL_STATE_FIELD.recordKind] !== CHANNEL_STATE_RECORD_KIND.projectionFrontier
    || row.value[CHANNEL_STATE_FIELD.bindingId] !== input.bindingId
    || !isPositiveSafeInteger(row.revision)
    || !isNonNegativeSafeInteger(createdAt)
    || !isJsonRecord(row.value.payload)) return null;
  const { payload } = row.value;
  if (typeof payload.targetSessionId !== 'string' || payload.targetSessionId.length === 0
    || !isNonNegativeSafeInteger(payload.lastScannedSeq)
    || !isPositiveSafeInteger(payload.revision)) return null;
  return {
    frontier: {
      targetSessionId: payload.targetSessionId,
      transcriptCursor: payload.transcriptCursor,
      lastScannedSeq: payload.lastScannedSeq,
      revision: payload.revision,
    },
    createdAt,
  };
}

/**
 * The sole Collection adapter for projection progress. It reads the binding
 * target and its deterministic frontier together, then uses the incumbent
 * Collection batch to fence frontier movement by the binding revision.
 */
export function createConversationSessionProjectionCollectionStore(
  input: ConversationSessionProjectionCollectionStoreInput,
): ConversationSessionProjectionStore {
  return {
    async read(readInput) {
      if (readInput.signal.aborted || input.signal.aborted) return { kind: 'bindingUnavailable' };
      let bindingRow: StoredCollectionRow | undefined;
      try {
        bindingRow = asStoredCollectionRow(
          await input.stateCollection.get(readInput.bindingId, { signal: readInput.signal }),
        );
      } catch {
        return { kind: 'bindingUnavailable' };
      }
      if (bindingRow === undefined) return { kind: 'bindingUnavailable' };
      const binding = readProjectionBinding({ row: bindingRow, bindingId: readInput.bindingId });
      if (binding === null) return { kind: 'bindingUnavailable' };
      const frontierRowId = createConversationSessionProjectionFrontierRowId(readInput.bindingId);
      let frontierRow: StoredCollectionRow | undefined;
      try {
        frontierRow = asStoredCollectionRow(
          await input.stateCollection.get(frontierRowId, { signal: readInput.signal }),
        );
      } catch {
        return { kind: 'frontierUnavailable' };
      }
      if (frontierRow === undefined) return { kind: 'frontierUnavailable' };
      const parsed = readProjectionFrontier({ row: frontierRow, bindingId: readInput.bindingId });
      if (parsed === null) return { kind: 'frontierUnavailable' };
      return {
        kind: 'ready',
        binding,
        frontier: parsed.frontier,
        frontierRowId,
        frontierRowRevision: frontierRow.revision,
      };
    },
    async compareAndSwap(cas) {
      if (input.signal.aborted) return { kind: 'conflict' };
      let current: StoredCollectionRow | undefined;
      try {
        current = asStoredCollectionRow(
          await input.stateCollection.get(cas.frontierRowId, { signal: input.signal }),
        );
      } catch {
        return { kind: 'conflict' };
      }
      if (current === undefined || current.revision !== cas.expectedFrontierRowRevision) {
        return { kind: 'conflict' };
      }
      const persisted = readProjectionFrontier({ row: current, bindingId: cas.bindingId });
      if (persisted === null || cas.frontierRowId !== createConversationSessionProjectionFrontierRowId(cas.bindingId)
        || !isNonNegativeSafeInteger(cas.frontier.lastScannedSeq)
        || !isPositiveSafeInteger(cas.frontier.revision)
        || typeof cas.frontier.targetSessionId !== 'string' || cas.frontier.targetSessionId.length === 0) {
        return { kind: 'conflict' };
      }
      try {
        const result = await input.stateCollection.batch([
          {
            kind: 'assert',
            rowId: cas.bindingId,
            expectedRevision: cas.expectedBindingRevision,
          },
          {
            kind: 'put',
            value: createConversationSessionProjectionFrontierRow({
              bindingId: cas.bindingId,
              targetSessionId: cas.frontier.targetSessionId,
              transcriptCursor: cas.frontier.transcriptCursor,
              lastScannedSeq: cas.frontier.lastScannedSeq,
              revision: cas.frontier.revision,
              createdAt: persisted.createdAt,
              now: Date.now(),
            }),
            expectedRevision: cas.expectedFrontierRowRevision,
          },
        ], { signal: input.signal });
        return result.status === 'updated' ? { kind: 'updated' } : { kind: 'conflict' };
      } catch {
        return { kind: 'conflict' };
      }
    },
    async recordHistoryGap(gap) {
      if (input.signal.aborted) return { kind: 'conflict' };
      let current: StoredCollectionRow | undefined;
      try {
        current = asStoredCollectionRow(
          await input.stateCollection.get(gap.frontierRowId, { signal: input.signal }),
        );
      } catch {
        return { kind: 'conflict' };
      }
      if (current === undefined) return { kind: 'conflict' };
      const persisted = readProjectionFrontier({ row: current, bindingId: gap.bindingId });
      if (persisted === null) return { kind: 'conflict' };
      if (readConversationSessionProjectionHistoryGap(persisted.frontier.transcriptCursor) !== null) {
        return { kind: 'rejoined' };
      }
      if (current.revision !== gap.expectedFrontierRowRevision
        || persisted.frontier.revision !== gap.frontier.revision
        || persisted.frontier.targetSessionId !== gap.frontier.targetSessionId) {
        return { kind: 'conflict' };
      }
      try {
        const result = await input.stateCollection.batch([
          { kind: 'assert', rowId: gap.bindingId, expectedRevision: gap.expectedBindingRevision },
          {
            kind: 'put',
            value: createConversationSessionProjectionFrontierRow({
              bindingId: gap.bindingId,
              targetSessionId: persisted.frontier.targetSessionId,
              transcriptCursor: {
                kind: 'historyGap',
                reason: gap.reason,
                reportedAt: gap.reportedAt,
              },
              lastScannedSeq: persisted.frontier.lastScannedSeq,
              revision: persisted.frontier.revision + 1,
              createdAt: persisted.createdAt,
              now: gap.reportedAt,
            }),
            expectedRevision: gap.expectedFrontierRowRevision,
          },
        ], { signal: input.signal });
        return result.status === 'updated' ? { kind: 'recorded' } : { kind: 'conflict' };
      } catch {
        return { kind: 'conflict' };
      }
    },
  };
}

/**
 * Replaces one durably paused transcript frontier with the current no-history
 * tail. The exact binding and frontier revisions are asserted in the same
 * Collection batch, so this never clears a gap after the owner changed the
 * target or another recovery already settled it.
 */
export async function acceptConversationSessionProjectionBaseline(input: Readonly<{
  actions: ActionsService;
  stateCollection: ChannelStateCollection;
  bindingId: string;
  expectedBindingRevision: number;
  expectedFrontierRevision: number;
  signal: AbortSignal;
  now: number;
}>): Promise<Readonly<{
  bindingRevision: number;
  frontierRevision: number;
}>> {
  let bindingRow: StoredCollectionRow | undefined;
  let frontierRow: StoredCollectionRow | undefined;
  const frontierRowId = createConversationSessionProjectionFrontierRowId(input.bindingId);
  try {
    [bindingRow, frontierRow] = await Promise.all([
      input.stateCollection.get(input.bindingId, { signal: input.signal }).then(asStoredCollectionRow),
      input.stateCollection.get(frontierRowId, { signal: input.signal }).then(asStoredCollectionRow),
    ]);
  } catch (cause) {
    throw new PluginError({
      code: 'channels_session_projection_baseline_unavailable',
      message: 'The saved Session projection frontier is unavailable.',
      retryable: true,
    }, { cause });
  }
  const binding = bindingRow === undefined ? null : readProjectionBinding({ row: bindingRow, bindingId: input.bindingId });
  const persisted = frontierRow === undefined ? null : readProjectionFrontier({ row: frontierRow, bindingId: input.bindingId });
  if (binding === null || persisted === null
    || bindingRow?.revision !== input.expectedBindingRevision
    || frontierRow?.revision !== input.expectedFrontierRevision
    || persisted.frontier.targetSessionId !== binding.target.sessionId
    || readConversationSessionProjectionHistoryGap(persisted.frontier.transcriptCursor) === null) {
    throw new PluginError({
      code: 'channels_session_projection_baseline_stale',
      message: 'The saved Session projection frontier changed before its baseline could be accepted.',
    });
  }
  const baseline = await readConversationSessionProjectionNoHistoryBaseline({
    actions: input.actions,
    sessionId: binding.target.sessionId,
    signal: input.signal,
  });
  if (baseline.kind !== 'ready') {
    throw new PluginError({
      code: 'channels_session_projection_baseline_unavailable',
      message: 'The current Session transcript tail is unavailable.',
      retryable: baseline.kind === 'retry' || baseline.kind === 'unavailable',
    });
  }
  const nextFrontierRevision = persisted.frontier.revision + 1;
  const result = await input.stateCollection.batch([
    { kind: 'assert', rowId: input.bindingId, expectedRevision: input.expectedBindingRevision },
    {
      kind: 'put',
      value: createConversationSessionProjectionFrontierRow({
        bindingId: input.bindingId,
        targetSessionId: binding.target.sessionId,
        transcriptCursor: baseline.transcriptCursor,
        lastScannedSeq: baseline.lastScannedSeq,
        revision: nextFrontierRevision,
        createdAt: persisted.createdAt,
        now: input.now,
      }),
      expectedRevision: input.expectedFrontierRevision,
    },
  ], { signal: input.signal });
  if (result.status !== 'updated') {
    throw new PluginError({
      code: 'channels_session_projection_baseline_stale',
      message: 'The saved Session projection frontier changed before its baseline could be accepted.',
    });
  }
  const persistedFrontierRevision = result.results.find((entry) => (
    entry.rowId === frontierRowId && !entry.deleted
  ))?.revision;
  if (persistedFrontierRevision === undefined) {
    throw new PluginError({
      code: 'channels_session_projection_baseline_unavailable',
      message: 'The accepted Session projection frontier was not returned by storage.',
      retryable: true,
    });
  }
  return {
    bindingRevision: input.expectedBindingRevision,
    frontierRevision: persistedFrontierRevision,
  };
}

function hasOriginFromBinding(
  origin: Readonly<{
    sourceAuthority?: Readonly<{ mediatorPluginId: string; sourceRef: string }>;
  }>,
  bindingId: string,
): boolean {
  return origin.sourceAuthority?.mediatorPluginId === 'happier.channels'
    && origin.sourceAuthority.sourceRef === `channels:binding:${bindingId}`;
}

function shouldProjectItem(input: Readonly<{
  binding: ConversationSessionProjectionBinding;
  item: ExternalShareableTranscriptItem;
}>): boolean {
  const { binding, item } = input;
  if (binding.target.deliveryMode === 'repliesOnly') {
    return item.kind === 'assistantText'
      && item.consumedInputs.some(({ origin }) => hasOriginFromBinding(origin, binding.bindingId));
  }
  if (item.kind === 'userText') {
    return !hasOriginFromBinding(item.origin, binding.bindingId);
  }
  return !item.consumedInputs.some(({ origin }) => hasOriginFromBinding(origin, binding.bindingId));
}

function isProjectionDeliveryTerminal(result: ConversationOutwardDeliveryResult): boolean {
  if (result.kind === 'retired') return true;
  return (result.kind === 'settled' || result.kind === 'suppressed')
    && isConversationDeliveryAutomaticTerminal(result.custody);
}

/**
 * Walks the public, closed external-shareable projection to its stable tail.
 * It deliberately does not persist interim progress: until the final page is
 * observed, the binding has not changed target and the old frontier remains
 * authoritative. This is the no-history boundary used by binding creation,
 * rotation, and the C3 `/new` owner.
 */
export async function readConversationSessionProjectionNoHistoryBaseline(input: Readonly<{
  actions: ActionsService;
  sessionId: string;
  signal: AbortSignal;
}>): Promise<ConversationSessionProjectionNoHistoryBaseline> {
  let cursor: string | null = null;
  let lastScannedSeq = 0;
  while (!input.signal.aborted) {
    let transcript: ExternalShareableTranscriptResult;
    try {
      transcript = await input.actions.execute(
        'session.transcript.get',
        {
          sessionId: input.sessionId,
          projection: 'externalShareableV1',
          cursor,
          limit: EXTERNAL_SHAREABLE_TRANSCRIPT_PAGE_LIMIT,
        },
        { signal: input.signal },
      );
    } catch (error) {
      if (!input.signal.aborted && isTranscriptCursorRejected(error)) {
        return { kind: 'historyGap', reason: 'cursorRejected' };
      }
      return {
        kind: 'unavailable',
        reason: input.signal.aborted ? 'cancelled' : 'transcriptUnavailable',
      };
    }
    if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
    if (transcript.sessionId !== input.sessionId) {
      return { kind: 'historyGap', reason: 'projectionMismatch' };
    }
    if (!Number.isSafeInteger(transcript.scannedThroughSeq) || transcript.scannedThroughSeq < 0) {
      return { kind: 'historyGap', reason: 'projectionMismatch' };
    }
    if (transcript.scannedThroughSeq < lastScannedSeq) {
      return { kind: 'historyGap', reason: 'projectionMismatch' };
    }
    if (!transcript.hasMore) {
      return {
        kind: 'ready',
        transcriptCursor: transcript.nextCursor ?? cursor,
        lastScannedSeq: transcript.scannedThroughSeq,
      };
    }
    if (transcript.nextCursor === undefined
      || transcript.nextCursor === cursor
      || transcript.scannedThroughSeq <= lastScannedSeq) {
      return { kind: 'retry', reason: 'publicationBarrier' };
    }
    cursor = transcript.nextCursor;
    lastScannedSeq = transcript.scannedThroughSeq;
  }
  return { kind: 'unavailable', reason: 'cancelled' };
}

/**
 * Processes exactly one canonical external-shareable transcript page. This is
 * intentionally not a scheduler: its caller owns re-drive timing, while this
 * owner preserves per-binding order and advances only after durable custody.
 */
export async function projectConversationSessionTranscriptPage(input: Readonly<{
  actions: ActionsService;
  store: ConversationSessionProjectionStore;
  bindingId: string;
  signal: AbortSignal;
  now?: () => number;
  deliver: (input: Readonly<{
    binding: ConversationSessionProjectionBinding;
    item: ExternalShareableTranscriptItem;
    source: ConversationSessionProjectionSource;
  }>) => Promise<ConversationOutwardDeliveryResult>;
}>): Promise<ConversationSessionProjectionResult> {
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };

  let current: Awaited<ReturnType<ConversationSessionProjectionStore['read']>>;
  try {
    current = await input.store.read({ bindingId: input.bindingId, signal: input.signal });
  } catch {
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'frontierUnavailable',
    };
  }
  if (current.kind !== 'ready') {
    return { kind: 'unavailable', reason: current.kind };
  }
  const {
    binding,
    frontier,
    frontierRowId,
    frontierRowRevision,
  } = current;
  if (binding.bindingId !== input.bindingId || frontier.targetSessionId !== binding.target.sessionId) {
    return { kind: 'unavailable', reason: 'targetChanged' };
  }
  if (readConversationSessionProjectionHistoryGap(frontier.transcriptCursor) !== null) {
    return { kind: 'paused', reason: 'historyGap' };
  }
  const pauseForHistoryGap = async (
    reason: ConversationSessionProjectionHistoryGapReason,
  ): Promise<Extract<ConversationSessionProjectionResult, Readonly<{ kind: 'historyGap' }>>> => {
    const disposition = await input.store.recordHistoryGap({
      bindingId: binding.bindingId,
      expectedBindingRevision: binding.revision,
      frontierRowId,
      expectedFrontierRowRevision: frontierRowRevision,
      frontier,
      reason,
      reportedAt: input.now?.() ?? Date.now(),
    });
    return { kind: 'historyGap', reason, disposition: disposition.kind };
  };
  if (frontier.transcriptCursor !== null && typeof frontier.transcriptCursor !== 'string') {
    return await pauseForHistoryGap('frontierCursorInvalid');
  }
  if (!Number.isSafeInteger(frontier.lastScannedSeq) || frontier.lastScannedSeq < 0
    || !Number.isSafeInteger(frontier.revision) || frontier.revision < 1
    || !Number.isSafeInteger(frontierRowRevision) || frontierRowRevision < 1) {
    return await pauseForHistoryGap('projectionRegression');
  }

  let transcript: ExternalShareableTranscriptResult;
  try {
    transcript = await input.actions.execute(
      'session.transcript.get',
      {
        sessionId: binding.target.sessionId,
        projection: 'externalShareableV1',
        cursor: frontier.transcriptCursor,
        limit: EXTERNAL_SHAREABLE_TRANSCRIPT_PAGE_LIMIT,
      },
      { signal: input.signal },
    );
  } catch (error) {
    if (!input.signal.aborted && isTranscriptCursorRejected(error)) {
      return await pauseForHistoryGap('cursorRejected');
    }
    return {
      kind: 'unavailable',
      reason: input.signal.aborted ? 'cancelled' : 'transcriptUnavailable',
    };
  }
  if (input.signal.aborted) return { kind: 'unavailable', reason: 'cancelled' };
  if (transcript.sessionId !== binding.target.sessionId
    || transcript.scannedThroughSeq < frontier.lastScannedSeq) {
    return await pauseForHistoryGap('projectionRegression');
  }

  let previousItemSeq = frontier.lastScannedSeq;
  let deliveredItemCount = 0;
  for (const item of transcript.items) {
    if (item.sessionId !== binding.target.sessionId
      || item.seq <= previousItemSeq
      || item.seq > transcript.scannedThroughSeq) {
      return await pauseForHistoryGap('projectionRegression');
    }
    previousItemSeq = item.seq;
    if (!shouldProjectItem({ binding, item })) continue;

    const delivery = await input.deliver({
      binding,
      item,
      source: {
        kind: 'sessionProjection',
        sessionId: item.sessionId,
        semanticItemId: item.itemId,
      },
    });
    if (!isProjectionDeliveryTerminal(delivery)) {
      return { kind: 'blocked', reason: 'deliveryPending', semanticItemId: item.itemId };
    }
    deliveredItemCount += 1;
  }

  if (transcript.scannedThroughSeq === frontier.lastScannedSeq) {
    return transcript.hasMore
      ? { kind: 'blocked', reason: 'publicationBarrier' }
      : { kind: 'idle', deliveredItemCount };
  }
  if (transcript.nextCursor === undefined || frontier.revision >= Number.MAX_SAFE_INTEGER) {
    return await pauseForHistoryGap('cursorUnavailable');
  }

  const updated = await input.store.compareAndSwap({
    bindingId: binding.bindingId,
    expectedBindingRevision: binding.revision,
    frontierRowId,
    expectedFrontierRowRevision: frontierRowRevision,
    frontier: {
      targetSessionId: binding.target.sessionId,
      transcriptCursor: transcript.nextCursor,
      lastScannedSeq: transcript.scannedThroughSeq,
      revision: frontier.revision + 1,
    },
  });
  if (updated.kind !== 'updated') return { kind: 'blocked', reason: 'frontierChanged' };
  return { kind: 'advanced', hasMore: transcript.hasMore, deliveredItemCount };
}
