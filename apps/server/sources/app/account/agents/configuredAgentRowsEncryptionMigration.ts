import { ACP_CATALOG_ACCOUNT_ROW_KEY_V1, AcpCatalogMigrationContentV1Schema, parseAcpCatalogMigrationContentV1,
    type AccountEncryptionMigrateAcpCatalogDirectiveV1 } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { Tx } from '@/storage/inTx';
import { migrateReservedAccountScopedKvRowsForAccountModeInTx,
    matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx } from '@/app/kv/reservedAccountScopedKvRow';
import { configuredAgentCatalogRowDomain, readConfiguredAgentCatalogRowInTx, markConfiguredAgentCatalogRowChangedInTx } from './configuredAgentRows';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateAcpCatalogDirectiveV1 }>;
const migrationDomain = { ...configuredAgentCatalogRowDomain,
    parseStoredEnvelope: parseAcpCatalogMigrationContentV1,
    parseMigrationStoredEnvelope: parseAcpCatalogMigrationContentV1,
    parseCandidateEnvelope: parseAcpCatalogMigrationContentV1 };
function migrationParams(input: Params) {
    return { accountId: input.accountId, toMode: input.toMode,
        physicalPrefix: ACP_CATALOG_ACCOUNT_ROW_KEY_V1, physicalKey: ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
        domain: migrationDomain, isPhysicalKey: (key: string) => key === ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
        items: input.directive?.content ? [{ physicalKey: ACP_CATALOG_ACCOUNT_ROW_KEY_V1,
            revision: input.directive.expectedRevision, envelope: input.directive.content }] : [] };
}

/** The Account coordinator owns the fence and rollback; this adapter owns complete singleton coverage. */
export async function migrateConfiguredAgentCatalogForAccountModeInTx(tx: Tx, input: Params) {
    const current = await readConfiguredAgentCatalogRowInTx(tx, input);
    if (current.status !== 'present' && current.status !== 'deleted' && current.status !== 'absent') return { status: 'invalid_content' as const };
    if (current.status === 'absent') return input.directive
        ? { status: 'migration_incomplete' as const } : { status: 'applied' as const, row: null };
    if (!input.directive || current.revision !== input.directive.expectedRevision
        || (current.status === 'deleted') !== (input.directive.content === null)) return { status: 'migration_incomplete' as const };
    if (current.status === 'deleted') return { status: 'applied' as const, row: { revision: current.revision, content: null } };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...migrationParams(input),
        markChanged: ({ tx: changeTx, revision }) => markConfiguredAgentCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    if (result.status !== 'applied') return result;
    const row = result.rows[0];
    return row ? { status: 'applied' as const, row: { revision: row.revision, content: AcpCatalogMigrationContentV1Schema.parse(row.envelope) } }
        : { status: 'migration_incomplete' as const };
}

export async function matchConfiguredAgentCatalogAccountMigrationPostStateInTx(tx: Tx, input: Params) {
    const current = await readConfiguredAgentCatalogRowInTx(tx, input);
    if (current.status === 'absent') return input.directive
        ? { status: 'mismatch' as const } : { status: 'matched' as const, row: null };
    if (current.status === 'deleted') return input.directive?.content === null && current.revision === input.directive.expectedRevision
        ? { status: 'matched' as const, row: { revision: current.revision, content: null } } : { status: 'mismatch' as const };
    if (current.status !== 'present' || !input.directive?.content) return { status: 'mismatch' as const };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(input));
    const row = result.status === 'matched' ? result.rows[0] : undefined;
    return row ? { status: 'matched' as const, row: { revision: row.revision, content: AcpCatalogMigrationContentV1Schema.parse(row.envelope) } }
        : { status: 'mismatch' as const };
}
