import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION, CHANNEL_STATE_INDEX_ID, CHANNEL_DELIVERIES_INDEX_ID, CHANNEL_STATE_RECORD_KIND } from '../collections.js';
import { assertChannelsTestCollectionQueryLimit } from './collectionQueryBound.js';

export type StoredRow<TValue extends Record<string, unknown> = Record<string, unknown>> = Readonly<{
  rowId: string;
  revision: number;
  value: TValue;
  deleted?: boolean;
}>;

function compareCanonicalText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

/**
 * The exact `by-connection-binding-v2` sort key: `binding-id` with its stable
 * null sentinel first, then `record-kind`, then `attention`, then the row-ID
 * tiebreaker Data appends to every stored index key.
 */
function compareConnectionBindingRows(left: StoredRow, right: StoredRow): number {
  const leftBindingId = typeof left.value['binding-id'] === 'string'
    ? left.value['binding-id']
    : null;
  const rightBindingId = typeof right.value['binding-id'] === 'string'
    ? right.value['binding-id']
    : null;
  if (leftBindingId === null && rightBindingId !== null) return -1;
  if (leftBindingId !== null && rightBindingId === null) return 1;
  return (leftBindingId === null || rightBindingId === null
    ? 0
    : compareCanonicalText(leftBindingId, rightBindingId))
    || compareCanonicalText(String(left.value['record-kind']), String(right.value['record-kind']))
    || (Number(left.value.attention === true) - Number(right.value.attention === true))
    || compareCanonicalText(left.rowId, right.rowId);
}

/**
 * The loaded Account-storage adapter refuses a query naming an index the bound
 * contract does not declare. Mirroring that here is what makes a reader still
 * pointed at a retired index fail instead of quietly reading a fake's rows.
 */
function assertDeclaredCollectionIndex(index: string | undefined): void {
  if (index === undefined) return;
  const declared = [
    ...CHANNEL_STATE_COLLECTION.indexes,
    ...CHANNEL_DELIVERIES_COLLECTION.indexes,
  ].some((candidate) => candidate.id === index);
  if (!declared) {
    throw new Error(`Collection query names an undeclared index '${index}'.`);
  }
}

export class MemoryCollection<TValue extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows = new Map<string, StoredRow<TValue>>();
  private conflictNextDelete: boolean;
  private conflictNextBatch: boolean;
  private forgetCount = 0;

  watch() { return { dispose() {} }; }

  constructor(private readonly options: Readonly<{
    /** Mirrors the host Collection request invariant for this boundary test. */
    enforceUniqueBatchRows?: boolean;
    conflictNextDelete?: boolean;
    conflictNextBatch?: boolean;
    failForgetAt?: number;
    maxBatchRows?: number;
  }> = {}) {
    this.conflictNextDelete = options.conflictNextDelete === true;
    this.conflictNextBatch = options.conflictNextBatch === true;
  }

  async get(rowId: string): Promise<StoredRow<TValue> | null> {
    const row = this.rows.get(rowId);
    return row?.deleted === true ? null : row ?? null;
  }

  async put(value: TValue, input: Readonly<{
    expectedRevision: number | 'absent';
  }>): Promise<StoredRow<TValue>> {
    const rowId = value.id;
    if (typeof rowId !== 'string') throw new Error('row id is required');
    const current = this.rows.get(rowId);
    if ((input.expectedRevision === 'absent' && current !== undefined)
      || (typeof input.expectedRevision === 'number'
        && current?.revision !== input.expectedRevision)) {
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    const row = { rowId, revision: (current?.revision ?? 0) + 1, value, deleted: false };
    this.rows.set(rowId, row);
    return row;
  }

  async delete(rowId: string, input: Readonly<{ expectedRevision: number }>) {
    const current = this.rows.get(rowId);
    if (this.conflictNextDelete) {
      this.conflictNextDelete = false;
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    if (current === undefined
      || current.deleted === true
      || current.revision !== input.expectedRevision) {
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    const row = { ...current, revision: current.revision + 1, deleted: true as const };
    this.rows.set(rowId, row);
    return { rowId, revision: row.revision, deleted: true as const };
  }

  async forget(rowId: string, input: Readonly<{ expectedRevision: number }>) {
    this.forgetCount += 1;
    if (this.options.failForgetAt === this.forgetCount) {
      throw new Error('simulated process loss during direct retention forget');
    }
    const current = this.rows.get(rowId);
    if (current === undefined) return { rowId, forgotten: true as const };
    if (current.revision !== input.expectedRevision) {
      throw Object.assign(new Error('compare-and-swap conflict'), {
        code: 'plugin_collection_conflict',
      });
    }
    this.rows.delete(rowId);
    return { rowId, forgotten: true as const };
  }

  async limits() {
    return {
      maxRowEncodedBytes: 1_000_000,
      maxBatchBytes: 1_000_000,
      maxBatchRows: this.options.maxBatchRows ?? 100,
      maxAccountRows: 10_000,
      maxAccountBytes: 10_000_000,
      basis: 'deployment' as const,
    };
  }

  async measureBatch(operations: readonly Readonly<Record<string, unknown>>[]) {
    return { overheadEncodedBytes: Buffer.byteLength(JSON.stringify({ operations: [] })),
      operationEncodedBytes: operations.map(operation => 1 + Buffer.byteLength(JSON.stringify(operation))) };
  }

  async batch(operations: readonly Readonly<Record<string, unknown>>[]) {
    if (this.conflictNextBatch) {
      this.conflictNextBatch = false;
      const first = operations[0];
      return {
        status: 'conflict' as const,
        conflicts: [{
          rowId: typeof first?.rowId === 'string' ? first.rowId : 'invalid-row',
          revision: null,
          deleted: false,
        }],
      };
    }
    if (this.options.enforceUniqueBatchRows === true) {
      const rowIds = operations.map((operation) => (
        operation.kind === 'put' && operation.value !== null && typeof operation.value === 'object'
          ? (operation.value as Record<string, unknown>).id
          : operation.rowId
      ));
      if (new Set(rowIds).size !== rowIds.length) {
        throw new Error('A collection mutation batch may contain each row at most once.');
      }
    }
    const next = new Map(this.rows);
    const results: Array<Readonly<{ rowId: string; revision: number; deleted: boolean }>> = [];
    for (const operation of operations) {
      const rowId = operation.kind === 'put' && operation.value !== null && typeof operation.value === 'object'
        ? (operation.value as Record<string, unknown>).id
        : operation.rowId;
      const expectedRevision = operation.expectedRevision;
      const current = typeof rowId === 'string' ? next.get(rowId) : undefined;
      const matches = typeof rowId === 'string'
        && (expectedRevision === 'absent'
          ? current === undefined
          : current !== undefined
            && current.revision === expectedRevision
            && (operation.kind === 'put' || current.deleted !== true));
      if (!matches) {
        return {
          status: 'conflict' as const,
          conflicts: [{
            rowId: typeof rowId === 'string' ? rowId : 'invalid-row',
            revision: current?.revision ?? null,
            deleted: current?.deleted === true,
          }],
        };
      }
      if (operation.kind === 'assert') continue;
      if (operation.kind === 'put') {
        const value = operation.value as TValue;
        const row = { rowId, revision: (current?.revision ?? 0) + 1, value, deleted: false };
        next.set(rowId, row);
        results.push({ rowId, revision: row.revision, deleted: false });
        continue;
      }
      if (current === undefined) throw new Error('delete requires a current row');
      const row = { ...current, revision: current.revision + 1, deleted: true };
      next.set(rowId, row);
      results.push({ rowId, revision: row.revision, deleted: true });
    }
    this.rows.clear();
    for (const [rowId, row] of next) this.rows.set(rowId, row);
    return { status: 'updated' as const, results };
  }

  async query(input: Readonly<{
    index?: string;
    prefix?: readonly unknown[];
    cursor?: string;
    order?: 'asc' | 'desc';
    range?: Readonly<{ lower?: number; upper?: number }>;
    limit: number;
  }>) {
    assertChannelsTestCollectionQueryLimit(input.limit);
    assertDeclaredCollectionIndex(input.index);
    const prefix = input.prefix?.[0];
    const bindingPrefix = input.prefix?.[1];
    const compareRows = (left: StoredRow, right: StoredRow): number => {
      const comparison = input.index === CHANNEL_STATE_INDEX_ID.byConnectionBindingV2
        ? compareConnectionBindingRows(left, right)
        : input.index === CHANNEL_STATE_INDEX_ID.byConnectionKindV1
          ? compareCanonicalText(String(left.value['connection-id'] ?? ''), String(right.value['connection-id'] ?? ''))
            || compareCanonicalText(String(left.value['record-kind']), String(right.value['record-kind']))
            || compareCanonicalText(left.rowId, right.rowId)
        : input.index === CHANNEL_STATE_INDEX_ID.byIngressDue
          ? compareCanonicalText(String(left.value['record-kind']), String(right.value['record-kind']))
            || Number(left.value['due-at'] ?? -1) - Number(right.value['due-at'] ?? -1)
            || compareCanonicalText(left.rowId, right.rowId)
        : input.index === CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1
          ? compareCanonicalText(String(left.value['session-id'] ?? ''), String(right.value['session-id'] ?? ''))
            || compareCanonicalText(String(left.value['binding-id'] ?? ''), String(right.value['binding-id'] ?? ''))
            || compareCanonicalText(left.rowId, right.rowId)
        : input.index === CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1
          ? compareCanonicalText(String(left.value['session-id'] ?? ''), String(right.value['session-id'] ?? ''))
            || compareCanonicalText(String(left.value['record-kind']), String(right.value['record-kind']))
            || compareCanonicalText(String(left.value['binding-id'] ?? ''), String(right.value['binding-id'] ?? ''))
            || Number(right.value['pr-update-at'] ?? -1) - Number(left.value['pr-update-at'] ?? -1)
            || compareCanonicalText(left.rowId, right.rowId)
        : left.rowId.localeCompare(right.rowId);
      return input.order === 'desc' ? -comparison : comparison;
    };
    const all = [...this.rows.values()]
      .filter((row) => {
        if (row.deleted === true) return false;
        if (input.index === CHANNEL_STATE_INDEX_ID.byKind) {
          return row.value['record-kind'] === prefix;
        }
        if (input.index === CHANNEL_STATE_INDEX_ID.byIngressDue) {
          const dueAt = row.value['due-at'];
          return row.value['record-kind'] === prefix
            && (input.range?.lower === undefined || (typeof dueAt === 'number' && dueAt >= input.range.lower))
            && (input.range?.upper === undefined || (typeof dueAt === 'number' && dueAt <= input.range.upper));
        }
        if (input.index === CHANNEL_STATE_INDEX_ID.byConnectionKindV1) {
          return row.value['connection-id'] === prefix
            && row.value['record-kind'] === input.prefix?.[1];
        }
        if (input.index === CHANNEL_STATE_INDEX_ID.byPullRequestSessionBindingV1) {
          return row.value['record-kind'] === prefix && row.value['pr-binding'] === input.prefix?.[1]
            && (input.prefix?.[2] === undefined || row.value['session-id'] === input.prefix[2]);
        }
        if (input.index === CHANNEL_STATE_INDEX_ID.bySessionKindBindingUpdateV1) {
          return (row.value['session-id'] ?? null) === prefix
            && (input.prefix?.[1] === undefined || row.value['record-kind'] === input.prefix[1])
            && (input.prefix?.[2] === undefined || (row.value['binding-id'] ?? null) === input.prefix[2]);
        }
        if (input.index === CHANNEL_STATE_INDEX_ID.byConnectionBindingV2
          || input.index === CHANNEL_DELIVERIES_INDEX_ID.byOwnerAttention) {
          const matchesOwner = row.value['connection-id'] === prefix
            && (bindingPrefix === undefined || (row.value['binding-id'] ?? null) === bindingPrefix);
          if (input.index !== CHANNEL_STATE_INDEX_ID.byConnectionBindingV2) return matchesOwner;
          return matchesOwner
            && (input.prefix?.[2] === undefined || row.value['record-kind'] === input.prefix[2])
            && (input.prefix?.[3] === undefined || row.value.attention === input.prefix[3]);
        }
        if (input.index === CHANNEL_DELIVERIES_INDEX_ID.byRetryDue) {
          return row.value.terminal === prefix;
        }
        if (prefix === CHANNEL_STATE_RECORD_KIND.binding) {
          return row.value['record-kind'] === CHANNEL_STATE_RECORD_KIND.binding;
        }
        return true;
      })
      .sort(compareRows);
    // A retained keyset anchor can have been deleted by the preceding page.
    // Its stored index key still defines the continuation, just as the real
    // Collection cursor does; absence from the live result is not page one.
    const cursorRow = input.cursor === undefined ? undefined : this.rows.get(input.cursor);
    const afterCursor = cursorRow === undefined ? undefined : all.findIndex(row => compareRows(row, cursorRow) > 0);
    const cursorIndex = afterCursor === undefined
      ? input.cursor === undefined ? 0 : Math.max(0, all.findIndex(row => row.rowId === input.cursor) + 1)
      : afterCursor < 0 ? all.length : afterCursor;
    const rows = all.slice(cursorIndex, cursorIndex + input.limit);
    const final = rows.at(-1);
    return {
      rows,
      changeCursor: 1,
      ...(final !== undefined && cursorIndex + rows.length < all.length ? { nextCursor: final.rowId } : {}),
    };
  }
}

