import {
  PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, PROVIDER_CONNECTIONS_ACCOUNT_ROW_PREFIX_V1,
  ProviderConnectionsMigrationContentV1Schema, parseProviderConnectionsMigrationContentV1,
  type ProviderConnectionsMigrationContentV1,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import type { AccountEncryptionMigrateProviderConnectionsDirectiveV1 } from '@happier-dev/protocol/account/encryptionMigrate';
import type { Tx } from '@/storage/inTx';
import { migrateReservedAccountScopedKvRowsForAccountModeInTx, matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx } from '@/app/kv/reservedAccountScopedKvRow';
import { providerConnectionsRowDomain, readProviderConnectionsRowInTx, markProviderConnectionsRowChangedInTx } from './connectionRows';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateProviderConnectionsDirectiveV1 }>;
type CapturedRow = Readonly<{ revision: number; content: ProviderConnectionsMigrationContentV1 | null }> | null;
const migrationDomain = { ...providerConnectionsRowDomain,
  parseStoredEnvelope: parseProviderConnectionsMigrationContentV1,
  parseCandidateEnvelope: parseProviderConnectionsMigrationContentV1 };
function migrationParams(input: Params) {
  const directive = input.directive;
  return { accountId: input.accountId, toMode: input.toMode, physicalPrefix: PROVIDER_CONNECTIONS_ACCOUNT_ROW_PREFIX_V1,
    domain: migrationDomain, isPhysicalKey: (key: string) => key === PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1,
    items: directive?.content ? [{ physicalKey: PROVIDER_CONNECTIONS_ACCOUNT_KV_KEY_V1, revision: directive.expectedRevision, envelope: directive.content }] : [] };
}
/** A deletion is retained Account state, not an empty catalog to recreate or discard. */
async function captureSource(tx: Tx, input: Params): Promise<Readonly<{ status: 'captured'; retained: CapturedRow }> | Readonly<{ status: 'migration_incomplete' | 'invalid_content' }>> {
  const row = await readProviderConnectionsRowInTx(tx, { accountId: input.accountId });
  if (row.status === 'absent') return input.directive === undefined ? { status: 'captured', retained: null } : { status: 'migration_incomplete' };
  if (row.status === 'deleted') {
    return input.directive?.content === null && input.directive.expectedRevision === row.revision
      ? { status: 'captured', retained: { revision: row.revision, content: null } } : { status: 'migration_incomplete' };
  }
  if (row.status !== 'present') return { status: 'invalid_content' };
  if (!parseProviderConnectionsMigrationContentV1(row.content)) return { status: 'invalid_content' };
  return input.directive?.content ? { status: 'captured', retained: null } : { status: 'migration_incomplete' };
}
export async function migrateProviderConnectionsForAccountModeInTx(tx: Tx, input: Params) {
  const source = await captureSource(tx, input);
  if (source.status !== 'captured') return source;
  const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...migrationParams(input),
    markChanged: ({ tx: changeTx, revision }) => markProviderConnectionsRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
  if (result.status !== 'applied') return result;
  const row = result.rows[0];
  return { status: 'applied' as const, row: row
    ? { revision: row.revision, content: ProviderConnectionsMigrationContentV1Schema.parse(row.envelope) } : source.retained };
}
export async function matchProviderConnectionsAccountMigrationPostStateInTx(tx: Tx, input: Params) {
  const source = await captureSource(tx, input);
  if (source.status !== 'captured') return { status: 'mismatch' as const };
  const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(input));
  if (result.status !== 'matched') return result;
  const row = result.rows[0];
  return { status: 'matched' as const, row: row
    ? { revision: row.revision, content: ProviderConnectionsMigrationContentV1Schema.parse(row.envelope) } : source.retained };
}
