import {
  WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1,
  WorkflowRunInvocationIndexV1Schema,
  type WorkflowInvocationLifecycleV1,
  type WorkflowRunInvocationIndexV1,
  type WorkflowRunOriginV1,
  type WorkflowRunStateV1,
  type WorkflowRunSummaryV1,
} from '@happier-dev/protocol/workflows/workflowProgressV1';

import type { WorkflowAccountRunActionDeps } from '@happier-dev/protocol';
import type { WorkflowRunRecipientCensusResponseV1 } from '@happier-dev/protocol/workflows';
import { WorkflowRunRecipientKeyEnvelopesV1Schema } from '@happier-dev/protocol/workflows';

/**
 * In-memory stand-in for the server's opaque Workflow Run storage owner.
 *
 * This is a **system boundary** fake: the real owner is reached over HTTP and
 * backed by PostgreSQL/SQLite. It stores sealed envelope bytes and public index
 * columns only, exactly as the server does, and never opens, interprets, or
 * recomputes Workflow content. It therefore lets a test destroy and rebuild the
 * daemon-side coordinator/store readers over the same durable bytes without
 * reimplementing any coordinator decision.
 *
 * It deliberately keeps the server's real concurrency contracts — parent
 * revision CAS, per-row lifecycle CAS, newest-attempt-per-member-slot parent
 * pages, and keyset paging — because those are what daemon reconstruction has
 * to survive.
 */

const TERMINAL_RUN_STATES = [
  'succeeded', 'failed', 'cancelled', 'expired', 'dispatch_failed', 'skipped', 'missed', 'outcome_uncertain',
] as const satisfies readonly WorkflowRunStateV1[];

/** Mirrors the server's indexed actionable-invocation attention predicate. */
const ATTENTION_LIFECYCLES = WORKFLOW_ATTENTION_INVOCATION_LIFECYCLES_V1;

const CANCELLABLE_LIFECYCLES = [
  'pending', 'waiting_for_capacity', 'admitting', 'running', 'waiting_for_approval', 'needs_attention', 'waiting_for_review',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

/**
 * The server refuses to move a settled row back to an active lifecycle and
 * only reconciles its sealed bytes. Reproducing that here is what makes a
 * fresh-process reconstruction test honest.
 */
const TERMINAL_INVOCATION_LIFECYCLES = [
  'completed', 'failed', 'skipped', 'cancelled', 'outcome_uncertain', 'superseded',
] as const satisfies readonly WorkflowInvocationLifecycleV1[];

type StoredRow = {
  index: WorkflowRunInvocationIndexV1;
  contentEnvelope: string;
};

/** Mirrors the canonical Account Action owner's storage boundary; unknown operations still fail below. */
export type WorkflowRunStorageTestkitOperation = Parameters<WorkflowAccountRunActionDeps['storage']['execute']>[0];

export type WorkflowRunStorageTestkit = Readonly<{
  execute: (operation: WorkflowRunStorageTestkitOperation, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
  observeChanges: (runId: string, onChange: () => void, onError: (error: unknown) => void) => Readonly<{ dispose(): Promise<void> }>;
  /** Every operation the daemon or Action host sent, in order. */
  calls: readonly WorkflowRunStorageTestkitOperation[];
  operations: () => readonly string[];
  run: () => WorkflowRunSummaryV1;
  rows: () => readonly StoredRow[];
  rowById: (invocationId: string) => StoredRow | undefined;
  acceptedEnvelope: () => string | null;
  checkpointEnvelope: () => string | null;
  resultEnvelope: () => string | null;
  /** Applies an out-of-band control exactly as an authorized Action caller would. */
  requestControl: (state: Extract<WorkflowRunStateV1, 'pause_requested' | 'cancelled'> | 'cancel_requested') => void;
}>;

function storageError(code: string): Error {
  return Object.assign(new Error(code), { response: { status: 409, data: { error: code } } });
}

function notFound(): Error {
  return Object.assign(new Error('not_found'), { response: { status: 404, data: { error: 'run_not_found' } } });
}

function encodeCursor(after: string): string {
  return Buffer.from(JSON.stringify({ after }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: unknown): string | null {
  if (typeof cursor !== 'string') return null;
  const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  const after = (parsed as { after?: unknown }).after;
  return typeof after === 'string' ? after : null;
}

export function createPlainWorkflowRunKeyCensusFixture(params: Readonly<{
  runId: string;
  accountId?: string;
}>): WorkflowRunRecipientCensusResponseV1 {
  return {
    runId: params.runId, ownerAccountId: params.accountId ?? 'account-1',
    ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null },
    encryptionMode: 'plain', access: 'owner', visibleTeamId: null,
    dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [],
  };
}

export function createWorkflowRunStorageTestkit(params: Readonly<{
  runId: string;
  machineId: string;
  origin: WorkflowRunOriginV1;
  accountId?: string;
  keyCensus?: WorkflowRunRecipientCensusResponseV1;
  acceptedEnvelope?: string;
  state?: WorkflowRunStateV1;
  originDeliveryAckRevision?: WorkflowRunSummaryV1['originDeliveryAckRevision'];
  /** Bounded page size so paged discovery of off-page rows is actually exercised. */
  invocationPageSize?: number;
  /** Lets a test advance out-of-band state between `wait` observations. */
  onBeforeWait?: (attempt: number) => void | Promise<void>;
  now?: string;
}>): WorkflowRunStorageTestkit {
  const now = params.now ?? '2026-01-01T00:00:00.000Z';
  const pageSize = params.invocationPageSize ?? Number.MAX_SAFE_INTEGER;
  const calls: WorkflowRunStorageTestkitOperation[] = [];
  const rows = new Map<string, StoredRow>();
  const changeObservers = new Set<() => void>();
  const publishChange = () => { for (const observer of changeObservers) observer(); };

  let acceptedEnvelope: string | null = params.acceptedEnvelope ?? null;
  let checkpointEnvelope: string | null = null;
  let resultEnvelope: string | null = null;
  let state: WorkflowRunStateV1 = params.state ?? 'queued';
  let revision = 0;
  let custodyState: WorkflowRunSummaryV1['workflowCustodyState'] = 'pending';
  let originDeliveryAckRevision = params.originDeliveryAckRevision ?? null;
  let waitAttempts = 0;
  let keyCensus = params.keyCensus ?? createPlainWorkflowRunKeyCensusFixture(params);

  const requiresAttention = () => state === 'interrupted'
    || (TERMINAL_RUN_STATES.some(value => value === state) && custodyState === 'pending')
    || [...rows.values()].some(value => ATTENTION_LIFECYCLES.some(lifecycle => lifecycle === value.index.lifecycle));

  const summary = (): WorkflowRunSummaryV1 => ({ sourceArtifactId: null, ownerAccountId: keyCensus.ownerAccountId, visibleTeamId: keyCensus.visibleTeamId,
    id: params.runId,
    origin: params.origin,
    state,
    revision,
    machineId: params.machineId,
    workflowCustodyState: custodyState,
    originDeliveryAckRevision,
    availability: {
      pause: true, resumeBoundary: false,
       restoreWorkspace: false, cancel: true, inspectExecution: true, disabledReasons: [],
    },
    createdAt: now,
    updatedAt: now,
  });

  const ordered = (): StoredRow[] => [...rows.values()]
    .sort((left, right) => (BigInt(left.index.sequence) < BigInt(right.index.sequence) ? -1 : 1));

  /** Newest attempt per member slot, exactly as the server resolves a parent page. */
  const newestPerMemberSlot = (parentRecordId: string): StoredRow[] => {
    const newest = new Map<string, StoredRow>();
    for (const row of rows.values()) {
      if (row.index.runId !== params.runId || row.index.parentRecordId !== parentRecordId) continue;
      const current = newest.get(row.index.memberOrdinal);
      if (!current || BigInt(row.index.attempt) > BigInt(current.index.attempt)
        || (row.index.attempt === current.index.attempt && row.index.id > current.index.id)) {
        newest.set(row.index.memberOrdinal, row);
      }
    }
    return [...newest.values()]
      .sort((left, right) => (BigInt(left.index.memberOrdinal) < BigInt(right.index.memberOrdinal) ? -1 : 1));
  };

  const admitRow = (input: Readonly<{
    id: string; sequence: string; parentRecordId: string | null; memberOrdinal: string;
    lifecycle: WorkflowInvocationLifecycleV1; contentEnvelope: string;
    attempt?: string;
  }>): WorkflowRunInvocationIndexV1 => {
    const index = WorkflowRunInvocationIndexV1Schema.parse({
      id: input.id, runId: params.runId, sequence: input.sequence, parentRecordId: input.parentRecordId,
      memberOrdinal: input.memberOrdinal, attempt: input.attempt ?? '0', contentRevision: '0', lifecycle: input.lifecycle, createdAt: now, updatedAt: now,
    });
    rows.set(index.id, { index, contentEnvelope: input.contentEnvelope });
    return index;
  };

  const execute = async (operation: WorkflowRunStorageTestkitOperation): Promise<unknown> => {
    calls.push(operation);
    const kind = String(operation.operation);
    const expectRevision = () => {
      if (operation.expectedRevision !== revision) throw storageError('currentness_conflict');
    };
    const expectInputAdmissionOpen = () => {
      const cancelledRoot = [...rows.values()].some((row) => row.index.parentRecordId === null
        && (row.index.lifecycle === 'cancel_requested' || row.index.lifecycle === 'cancelled'));
      if ((state !== 'claimed' && state !== 'running') || cancelledRoot) throw storageError('currentness_conflict');
    };
    switch (kind) {
      case 'run-key.census':
        return keyCensus;
      case 'admit': {
        if (acceptedEnvelope === null) {
          acceptedEnvelope = String(operation.acceptedEnvelope);
          if (operation.resultDelivery !== undefined) originDeliveryAckRevision = 0;
          return { kind: 'created', run: summary() };
        }
        return { kind: 'existing', run: summary() };
      }
      case 'accepted-snapshot.resolve': {
        if (operation.expectedRevision !== revision) throw storageError('currentness_conflict');
        const disposition = acceptedEnvelope === null ? 'created' : 'existing';
        if (acceptedEnvelope === null) {
          acceptedEnvelope = String(operation.acceptedEnvelope);
          const ownerKey = WorkflowRunRecipientKeyEnvelopesV1Schema.parse(operation.recipientKeyEnvelopes ?? [])
            .find((item) => item.recipientAccountId === keyCensus.ownerAccountId);
          if (ownerKey) keyCensus = { ...keyCensus, dataEncryptionKey: ownerKey.encryptedDataKey,
            callerDataEncryptionKey: ownerKey.encryptedDataKey };
          revision += 1;
        }
        return { disposition, acceptedEnvelope, run: summary() };
      }
      case 'get': {
        if (acceptedEnvelope === null) throw notFound();
        return { run: summary(), acceptedEnvelope, checkpointEnvelope, resultEnvelope, keyCensus };
      }
      case 'initialize': {
        expectRevision();
        if (checkpointEnvelope !== null) return { initialization: 'existing', run: summary() };
        revision += 1;
        state = 'running';
        checkpointEnvelope = String(operation.checkpointEnvelope);
        const root = operation.rootInvocation as Readonly<{ id: string; contentEnvelope: string }>;
        admitRow({
          id: root.id, sequence: '0', parentRecordId: null, memberOrdinal: '0',
          lifecycle: 'pending', contentEnvelope: root.contentEnvelope,
        });
        return { initialization: 'created', run: summary() };
      }
      case 'invocations.admit': {
        const requests = operation.invocations as ReadonlyArray<Readonly<Record<string, unknown>>>;
        if (requests.every((item) => rows.has(String(item.id)))) {
          return { disposition: 'existing', parentRevision: revision, invocations: requests.map((item) => rows.get(String(item.id))!.index) };
        }
        expectRevision();
        expectInputAdmissionOpen();
        for (const item of requests) {
          const replaces = item.replaces as Readonly<{ id: string; attempt: string; contentRevision: string }> | undefined;
          if (!replaces) continue;
          const prior = rows.get(replaces.id);
          if (!prior || prior.index.lifecycle !== 'waiting_for_review' || prior.index.attempt !== replaces.attempt
            || prior.index.contentRevision !== replaces.contentRevision) throw storageError('currentness_conflict');
        }
        revision += 1;
        checkpointEnvelope = String(operation.checkpointEnvelope);
        const invocations = requests.map((item) => {
          const existing = rows.get(String(item.id));
          if (existing) return existing.index;
          const replaces = item.replaces as Readonly<{ id: string }> | undefined;
          const prior = replaces ? rows.get(replaces.id) : undefined;
          if (prior) rows.set(prior.index.id, { ...prior, index: { ...prior.index, lifecycle: 'superseded',
            contentRevision: (BigInt(prior.index.contentRevision) + 1n).toString() } });
          return admitRow({
            id: String(item.id),
            sequence: String(item.sequence),
            parentRecordId: String(item.parentRecordId),
            memberOrdinal: String(item.memberOrdinal),
            lifecycle: (item.lifecycle as WorkflowInvocationLifecycleV1 | undefined) ?? 'pending',
            ...(prior ? { attempt: (BigInt(prior.index.attempt) + 1n).toString() } : {}),
            contentEnvelope: String(item.contentEnvelope),
          });
        });
        return { disposition: 'created', parentRevision: revision, invocations };
      }
      case 'invocations.get': {
        const row = rows.get(String(operation.invocationId));
        if (!row) throw notFound();
        return { invocation: { index: row.index, contentEnvelope: row.contentEnvelope, parentRevision: revision } };
      }
      case 'invocations.current': {
        if (operation.runId !== params.runId) throw notFound();
        const row = newestPerMemberSlot(String(operation.parentRecordId))
          .find((candidate) => candidate.index.memberOrdinal === operation.memberOrdinal);
        return {
          invocation: row ? { index: row.index, contentEnvelope: row.contentEnvelope } : null,
          parentRevision: revision,
        };
      }
      case 'invocations.list': {
        const lifecycles = Array.isArray(operation.lifecycles)
          ? (operation.lifecycles as readonly WorkflowInvocationLifecycleV1[])
          : undefined;
        const parentRecordId = operation.parentRecordId === undefined ? undefined : String(operation.parentRecordId);
        const scanned = parentRecordId === undefined ? ordered() : newestPerMemberSlot(parentRecordId);
        const positionOf = (row: StoredRow) => (parentRecordId === undefined ? row.index.sequence : row.index.memberOrdinal);
        const after = decodeCursor(operation.cursor);
        const remaining = scanned.filter((row) => after === null || BigInt(positionOf(row)) > BigInt(after));
        const matching = remaining.filter((row) => !lifecycles || lifecycles.includes(row.index.lifecycle));
        // Paging is keyed on the scanned slot, not the filtered result: the
        // server advances past inspected slots even when they are filtered out,
        // so an attention row can legitimately sit beyond the first page.
        const limit = Math.min(pageSize, typeof operation.limit === 'number' ? operation.limit : Number.MAX_SAFE_INTEGER);
        const inspected = remaining.slice(0, limit);
        const page = matching.filter((row) => inspected.includes(row));
        const lastInspected = inspected.at(-1);
        const hasMore = remaining.length > inspected.length;
        return {
          invocations: page.map((row) => row.index),
          parentRevision: revision,
          ...(hasMore && lastInspected ? { nextCursor: encodeCursor(positionOf(lastInspected)) } : {}),
        };
      }
      case 'invocations.fact': {
        const attentionBefore = requiresAttention();
        const row = rows.get(String(operation.invocationId));
        if (!row) throw notFound();
        if (operation.expectedRevision !== undefined) {
          expectRevision();
          if (operation.parentAttempt !== undefined || state !== 'interrupted') throw storageError('currentness_conflict');
          if (operation.resolution === 'root_list_progress') {
            if (row.index.parentRecordId !== null || row.index.sequence !== '0' || row.index.memberOrdinal !== '0'
              || row.index.attempt !== '0' || operation.lifecycle !== operation.expectedLifecycle) throw storageError('invalid_input');
          } else if (operation.resolution !== 'observed_terminal_execution'
            || !['completed', 'failed', 'cancelled', 'needs_attention'].includes(String(operation.lifecycle))) throw storageError('invalid_input');
        } else if (operation.resolution === 'root_list_progress') throw storageError('invalid_input');
        if (row.index.lifecycle !== operation.expectedLifecycle) throw storageError('currentness_conflict');
        if (row.index.attempt !== operation.invocationAttempt) throw storageError('currentness_conflict');
        if (row.index.contentRevision !== operation.expectedContentRevision) throw storageError('currentness_conflict');
        if (operation.lifecycle === 'admitting') expectInputAdmissionOpen();
        const contentEnvelope = String(operation.contentEnvelope);
        if (row.index.lifecycle === operation.lifecycle && row.contentEnvelope === contentEnvelope) return { ...row.index, parentRevision: revision };
        if (TERMINAL_INVOCATION_LIFECYCLES.some((candidate) => candidate === row.index.lifecycle)
          && operation.lifecycle !== row.index.lifecycle) {
          throw storageError('currentness_conflict');
        }
        const index = WorkflowRunInvocationIndexV1Schema.parse({
          ...row.index,
          lifecycle: operation.lifecycle as WorkflowInvocationLifecycleV1,
          contentRevision: (BigInt(row.index.contentRevision) + 1n).toString(),
        });
        rows.set(index.id, { index, contentEnvelope });
        if (attentionBefore !== requiresAttention()) revision += 1;
        return { ...index, parentRevision: revision };
      }
      case 'invocations.complete_review': {
        const row = rows.get(String(operation.invocationId));
        if (!row) throw notFound();
        if (row.index.lifecycle !== 'waiting_for_review' || row.index.attempt !== operation.invocationAttempt
          || row.index.contentRevision !== operation.expectedContentRevision || custodyState !== 'pending') {
          throw storageError('currentness_conflict');
        }
        revision += 1;
        if (state === 'waiting_for_review') state = 'queued';
        const updated = { index: { ...row.index,
          lifecycle: operation.mode === 'use_result' ? 'completed' as const : 'waiting_for_review' as const,
          contentRevision: (BigInt(row.index.contentRevision) + 1n).toString() },
          contentEnvelope: String(operation.contentEnvelope) };
        rows.set(row.index.id, updated);
        return { run: summary(), invocation: updated,
          disposition: operation.mode === 'use_result' ? 'completed' : 'generation_requested' };
      }
      case 'transition': {
        expectRevision();
        for (const item of (operation.invocationTransitions ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>) {
          const row = rows.get(String(item.id));
          if (!row) throw notFound();
          if (row.index.lifecycle !== item.expectedLifecycle) throw storageError('currentness_conflict');
          if (row.index.contentRevision !== item.expectedContentRevision) throw storageError('currentness_conflict');
        }
        revision += 1;
        state = operation.state as WorkflowRunStateV1;
        checkpointEnvelope = String(operation.checkpointEnvelope);
        if (typeof operation.resultEnvelope === 'string') resultEnvelope = operation.resultEnvelope;
        if (operation.custodyState === 'settled') custodyState = 'settled';
        for (const item of (operation.invocationTransitions ?? []) as ReadonlyArray<Readonly<Record<string, unknown>>>) {
          const row = rows.get(String(item.id))!;
          if (row.index.lifecycle === item.lifecycle) continue;
          rows.set(row.index.id, {
            ...row,
            index: { ...row.index, lifecycle: item.lifecycle as WorkflowInvocationLifecycleV1,
              contentRevision: (BigInt(row.index.contentRevision) + 1n).toString() },
          });
        }
        return summary();
      }
      case 'pause':
      case 'resume':
      case 'cancel': {
        expectRevision();
        revision += 1;
        if (kind === 'pause') state = 'pause_requested';
        if (kind === 'resume') state = 'running';
        if (kind === 'cancel') {
          state = 'cancelled';
          for (const row of [...rows.values()]) {
            if (!CANCELLABLE_LIFECYCLES.some((candidate) => candidate === row.index.lifecycle)) continue;
            rows.set(row.index.id, { ...row, index: { ...row.index, lifecycle: 'cancelled',
              contentRevision: (BigInt(row.index.contentRevision) + 1n).toString() } });
          }
        }
        return { run: summary(), intent: kind === 'cancel' ? 'cancelled' : kind };
      }
      case 'wait': {
        // Faithful projection of the server's observation contract: terminal,
        // paused, parent-level attention, any indexed actionable invocation,
        // then revision change, then deadline. No polling delay is simulated.
        for (;;) {
          waitAttempts += 1;
          await params.onBeforeWait?.(waitAttempts);
          if (TERMINAL_RUN_STATES.some((candidate) => candidate === state)) {
            return { observation: 'terminal', matchedCondition: 'terminal', run: summary(), ...(resultEnvelope ? { resultEnvelope } : {}) };
          }
          if (state === 'paused') return { observation: 'paused', matchedCondition: 'paused', run: summary() };
          if (state === 'interrupted') {
            return { observation: 'needs_attention', matchedCondition: 'attention', run: summary() };
          }
          if ([...rows.values()].some((row) => ATTENTION_LIFECYCLES.some((candidate) => candidate === row.index.lifecycle))) {
            return { observation: 'needs_attention', matchedCondition: 'attention', run: summary() };
          }
          if (operation.afterRevision !== undefined && revision !== operation.afterRevision) {
            return { observation: 'changed', matchedCondition: 'change', run: summary() };
          }
          if (params.onBeforeWait === undefined) return { observation: 'timeout', run: summary() };
        }
      }
      default:
        throw new Error(`workflow_run_storage_testkit_unsupported_operation:${kind}`);
    }
  };

  return {
    execute: async (operation) => {
      const result = await execute(operation);
      if (!['get', 'run-key.census', 'invocations.list', 'invocations.current', 'invocations.get', 'wait', 'delivery.pull'].includes(String(operation.operation))) publishChange();
      return result;
    },
    observeChanges: (observedRunId, onChange) => {
      if (observedRunId !== params.runId) throw notFound();
      changeObservers.add(onChange);
      return { dispose: async () => { changeObservers.delete(onChange); } };
    },
    calls,
    operations: () => calls.map((call) => String(call.operation)),
    run: summary,
    rows: () => ordered(),
    rowById: (invocationId) => rows.get(invocationId),
    acceptedEnvelope: () => acceptedEnvelope,
    checkpointEnvelope: () => checkpointEnvelope,
    resultEnvelope: () => resultEnvelope,
    requestControl: (next) => {
      revision += 1;
      if (next !== 'cancel_requested') state = next;
      if (next !== 'cancelled' && next !== 'cancel_requested') { publishChange(); return; }
      for (const row of [...rows.values()]) {
        if (!CANCELLABLE_LIFECYCLES.some((candidate) => candidate === row.index.lifecycle)) continue;
        rows.set(row.index.id, { ...row, index: { ...row.index,
          lifecycle: row.index.lifecycle === 'waiting_for_review' ? 'cancelled' : 'cancel_requested',
          contentRevision: (BigInt(row.index.contentRevision) + 1n).toString() } });
      }
      publishChange();
    },
  };
}
