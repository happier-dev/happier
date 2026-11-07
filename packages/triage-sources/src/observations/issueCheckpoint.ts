import { PluginError, computeCanonicalDomainSeparatedDigest } from '@happier-dev/plugin-sdk';
import {
  defineAccountCollection, PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1,
  type PluginAccountCollectionForDefinition, type PluginCollectionPutMutation,
} from '@happier-dev/plugin-sdk/collections';
import {
  defineProtocolLiteral, defineProtocolNumber, defineProtocolObject,
  defineProtocolString, defineProtocolUnion,
} from '@happier-dev/plugin-sdk/protocol';

const checkpointFields = {
  v: defineProtocolLiteral(1), signature: defineProtocolString(),
  ordinal: defineProtocolNumber({ integer: true, minimum: 0 }),
  state: defineProtocolUnion([defineProtocolLiteral('active'), defineProtocolLiteral('resolved')]),
};
const pendingSchema = defineProtocolObject({
  signature: checkpointFields.signature, ordinal: checkpointFields.ordinal, state: checkpointFields.state,
  occurredAt: defineProtocolNumber({ integer: true, minimum: 0 }),
  phase: defineProtocolUnion([defineProtocolLiteral('open'), defineProtocolLiteral('updated'), defineProtocolLiteral('resolved')]),
}, { policy: 'closed' });

// Pending is durable first-observation custody, never the effective cursor.
const recordSchema = defineProtocolUnion([
  defineProtocolObject({ ...checkpointFields, pending: pendingSchema.optional() }, { policy: 'closed' }),
  defineProtocolObject({ v: defineProtocolLiteral(1), pending: pendingSchema }, { policy: 'closed' }),
]);
export type IssueCheckpointRecord = ReturnType<typeof recordSchema.parse>;
export type IssueCheckpoint = Omit<Extract<IssueCheckpointRecord, { signature: string }>, 'pending'>;

/** Declared by each source plugin; only opaque identities are server-readable. */
export const TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1 = defineAccountCollection({
  id: 'issue-observer-checkpoints', schemaVersion: 1,
  schema: defineProtocolObject({
    id: defineProtocolString(), sourceInstanceId: defineProtocolString(), checkpoint: recordSchema,
  }, { policy: 'closed' }),
  rowIdField: 'id', serverReadable: ['sourceInstanceId', 'id'], identityFields: [],
  indexes: [{ id: 'by-source', fields: [
    { field: 'sourceInstanceId', direction: 'asc' }, { field: 'id', direction: 'asc' },
  ] }],
});
type Collection = PluginAccountCollectionForDefinition<typeof TRIAGE_ISSUE_CHECKPOINT_COLLECTION_V1>;
type Row = NonNullable<Awaited<ReturnType<Collection['get']>>>;
export type IssueCheckpointPut = PluginCollectionPutMutation<Row['value']>;

export function issueCheckpointRowId(sourceInstanceId: string, issueFingerprint: string): string {
  return computeCanonicalDomainSeparatedDigest('happier.triage.issue-checkpoint.v1', [sourceInstanceId, issueFingerprint]);
}

/** Select only this scan's demanded issue identities, never a retained inventory. */
export async function readIssueCheckpoints(collection: Collection, sourceInstanceId: string,
  rowIds: readonly string[], signal: AbortSignal): Promise<Map<string, Row>> {
  const rows = new Map<string, Row>();
  if (rowIds.length === 0) return rows;
  // Each exact prefix selects at most one row. Fit the requested set to one
  // protocol page rather than resending the entire scan's ids on every page.
  for (let offset = 0; offset < rowIds.length; offset += PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1) {
    const prefixes = rowIds.slice(offset, offset + PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1).map(id => [sourceInstanceId, id]);
    let cursor: string | undefined;
    do {
      const page = await collection.query({ index: 'by-source', prefixes, order: 'asc',
        limit: PLUGIN_COLLECTION_QUERY_MAX_ROWS_V1, ...(cursor === undefined ? {} : { cursor }) }, { signal });
      signal.throwIfAborted();
      for (const row of page.rows) rows.set(row.rowId, row);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return rows;
}

/** Use the existing Collection owner's row/encoded-byte budgets for each atomic set. */
export async function writeIssueCheckpoints(collection: Collection, operations: readonly IssueCheckpointPut[],
  signal: AbortSignal): Promise<Map<string, number>> {
  const revisions = new Map<string, number>();
  if (operations.length === 0) return revisions;
  const limits = await collection.limits({ signal });
  const measurement = await collection.measureBatch(operations, { signal });
  let offset = 0;
  while (offset < operations.length) {
    let end = offset;
    let bytes = measurement.overheadEncodedBytes;
    while (end < operations.length && end - offset < limits.maxBatchRows
      && bytes + measurement.operationEncodedBytes[end]! <= limits.maxBatchBytes) {
      bytes += measurement.operationEncodedBytes[end]!;
      end++;
    }
    if (end === offset) throw new PluginError({ code: 'triage_issue_checkpoint_unavailable',
      message: 'The issue checkpoint exceeds the Account Collection deployment limits.' });
    signal.throwIfAborted();
    const result = await collection.batch(operations.slice(offset, end), { signal });
    signal.throwIfAborted();
    if (result.status === 'conflict') throw new PluginError({ code: 'triage_issue_checkpoint_conflict',
      message: 'The issue checkpoints changed during this scan.' });
    for (const row of result.results) revisions.set(row.rowId, row.revision);
    offset = end;
  }
  return revisions;
}
