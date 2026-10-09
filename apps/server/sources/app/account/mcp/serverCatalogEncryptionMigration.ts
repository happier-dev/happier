import { MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
    parseMcpServerCatalogMigrationContentV1, type StoredMcpServerCatalogContentV1,
    type AccountEncryptionMigrateMcpServerCatalogDirectiveV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { Tx } from '@/storage/inTx';
import { migrateReservedAccountScopedKvRowsForAccountModeInTx,
    matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx,
    type ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';
import { readMcpServerCatalogRowInTx, markMcpServerCatalogRowChangedInTx, mcpServerCatalogRowDomain } from './serverRows';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateMcpServerCatalogDirectiveV1 }>;
const migrationRowDomain: ReservedAccountScopedKvRowDomain<StoredMcpServerCatalogContentV1> = {
    ...mcpServerCatalogRowDomain,
    parseStoredEnvelope: parseMcpServerCatalogMigrationContentV1,
    parseCandidateEnvelope: parseMcpServerCatalogMigrationContentV1,
};
function migrationParams(input: Params) {
    return { accountId: input.accountId, toMode: input.toMode,
        physicalPrefix: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1, physicalKey: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
        domain: migrationRowDomain, isPhysicalKey: (key: string) => key === MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
        items: input.directive?.content ? [{ physicalKey: MCP_SERVER_CATALOG_ACCOUNT_KEY_V1,
            revision: input.directive.expectedRevision, envelope: input.directive.content }] : [] };
}

/** The incumbent Account conversion supplies the all-domain fence and rollback boundary. */
export async function migrateMcpServerCatalogForAccountModeInTx(tx: Tx, input: Params) {
    const current = await readMcpServerCatalogRowInTx(tx, input);
    if (current.status !== 'present' && current.status !== 'deleted' && current.status !== 'absent') return { status: 'invalid_content' as const };
    if (current.status === 'absent') return input.directive
        ? { status: 'migration_incomplete' as const } : { status: 'applied' as const, row: null };
    if (!input.directive || current.revision !== input.directive.expectedRevision
        || (current.status === 'deleted') !== (input.directive.content === null)) return { status: 'migration_incomplete' as const };
    if (current.status === 'deleted') return { status: 'applied' as const, row: { revision: current.revision, content: null } };
    if (!parseMcpServerCatalogMigrationContentV1(current.content)) return { status: 'invalid_content' as const };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...migrationParams(input),
        markChanged: ({ tx: changeTx, revision }) => markMcpServerCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    if (result.status !== 'applied') return result;
    const row = result.rows[0];
    if (!row) return { status: 'migration_incomplete' as const };
    return { status: 'applied' as const, row: { revision: row.revision, content: row.envelope } };
}

export async function matchMcpServerCatalogAccountMigrationPostStateInTx(tx: Tx, input: Params) {
    const current = await readMcpServerCatalogRowInTx(tx, input);
    if (current.status === 'absent') return input.directive
        ? { status: 'mismatch' as const } : { status: 'matched' as const, row: null };
    if (current.status === 'deleted') return input.directive?.content === null && current.revision === input.directive.expectedRevision
        ? { status: 'matched' as const, row: { revision: current.revision, content: null } } : { status: 'mismatch' as const };
    if (current.status !== 'present' || !input.directive?.content
        || !parseMcpServerCatalogMigrationContentV1(current.content)
        || !pluginJsonValuesEqual(current.content, input.directive.content)) return { status: 'mismatch' as const };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(input));
    const row = result.status === 'matched' ? result.rows[0] : undefined;
    return row ? { status: 'matched' as const, row: { revision: row.revision, content: row.envelope } } : { status: 'mismatch' as const };
}
