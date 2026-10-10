import { buildPromptLibraryPhysicalKeyV1, parsePromptLibraryPhysicalKeyV1, PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1,
  type PromptLibraryContentV1, type AccountEncryptionMigratePromptLibraryDirectiveV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import type { Tx } from '@/storage/inTx';
import { migrateReservedAccountScopedKvRowsForAccountModeInTx, matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx,
  type ReservedAccountScopedKvRowMigrationItem } from '@/app/kv/reservedAccountScopedKvRow';
import { listPromptLibraryRowsInTx, markPromptLibraryRowChangedInTx, promptLibraryRowDomain } from './promptLibraryRows';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigratePromptLibraryDirectiveV1 }>;
function migrationParams(input: Params) {
  return { accountId: input.accountId, toMode: input.toMode, physicalPrefix: PROMPT_LIBRARY_ACCOUNT_ROW_PREFIX_V1,
    domain: promptLibraryRowDomain, isPhysicalKey: (key: string) => parsePromptLibraryPhysicalKeyV1(key) !== null,
    items: (input.directive?.items ?? []).map(item => ({ physicalKey: buildPromptLibraryPhysicalKeyV1(item.key), revision: item.expectedRevision, envelope: item.content })) };
}
function projectRows(rows: readonly ReservedAccountScopedKvRowMigrationItem<PromptLibraryContentV1>[]) {
  return rows.map(row => {
    const key = parsePromptLibraryPhysicalKeyV1(row.physicalKey);
    if (key === null) throw new Error('Invalid prompt library catalog migration address');
    return { key, revision: row.revision, content: row.envelope };
  });
}
/** The existing Account conversion owns the fence and all-domain transaction. */
export async function migratePromptLibraryForAccountModeInTx(tx: Tx, input: Params) {
  const census = await listPromptLibraryRowsInTx(tx, { accountId: input.accountId });
  if (census.status !== 'listed') return { status: 'invalid_content' as const };
  const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...migrationParams(input),
    markChanged: ({ tx: changeTx, physicalKey, revision }) => {
      const key = parsePromptLibraryPhysicalKeyV1(physicalKey);
      if (key === null) throw new Error('Invalid prompt library catalog migration address');
      return markPromptLibraryRowChangedInTx(changeTx, { accountId: input.accountId, key, revision });
    } });
  return result.status === 'applied' ? { status: 'applied' as const, rows: projectRows(result.rows) } : result;
}
export async function matchPromptLibraryAccountMigrationPostStateInTx(tx: Tx, input: Params) {
  const census = await listPromptLibraryRowsInTx(tx, { accountId: input.accountId });
  if (census.status !== 'listed') return { status: 'mismatch' as const };
  const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(input));
  return result.status === 'matched' ? { status: 'matched' as const, rows: projectRows(result.rows) } : result;
}
