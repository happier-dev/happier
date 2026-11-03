import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';

type Collection = ReturnType<PluginAccountStorageScope['collection']>;
type Mutation = Parameters<Collection['batch']>[0][number];

/** Reuses deleted binding/artifact identities through Data's exact tombstone CAS. */
export async function persistConversationBindingCreation(input: Readonly<{
  collection: Pick<Collection, 'batch'>;
  guards: readonly Mutation[];
  rows: readonly Readonly<{ rowId: string; value: Readonly<Record<string, JsonValue>> }>[];
  signal: AbortSignal;
  assertNotAborted: () => void;
}>): Promise<Awaited<ReturnType<Collection['batch']>>> {
  const expectedRevisions = new Map<string, number | 'absent'>(input.rows.map(row => [row.rowId, 'absent']));
  for (;;) {
    input.assertNotAborted();
    const result = await input.collection.batch([
      ...input.guards,
      ...input.rows.map(row => ({ kind: 'put' as const, value: row.value, expectedRevision: expectedRevisions.get(row.rowId)! })),
    ], { signal: input.signal });
    input.assertNotAborted();
    if (result.status !== 'conflict') return result;
    // Reads hide tombstones. Only their exact conflict revisions authorize
    // resurrection; live rows and owner-guard conflicts stay with the caller.
    if (result.conflicts.length === 0 || result.conflicts.some(entry => !entry.deleted
      || entry.revision === null || !expectedRevisions.has(entry.rowId))) return result;
    for (const entry of result.conflicts) expectedRevisions.set(entry.rowId, entry.revision!);
  }
}
