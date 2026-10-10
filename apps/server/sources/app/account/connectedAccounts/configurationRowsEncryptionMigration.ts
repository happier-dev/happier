import { CONNECTED_CONFIGURATION_ACCOUNT_ROW_PREFIX_V1, CONNECTED_PURPOSE_ACCOUNT_ROW_PREFIX_V1,
    buildConnectedAccountCatalogPhysicalKeyV1, parseConnectedAccountCatalogPhysicalKeyV1,
    parseConnectedAccountCatalogMigrationContentV1, assertConnectedAccountCatalogContentForModeV1,
    type ConnectedAccountCatalogKeyV1, type AccountEncryptionMigrateConnectedConfigurationsDirectiveV1,
    type StoredConnectedAccountCatalogContentV1,
} from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import type { Tx } from '@/storage/inTx';
import { listReservedAccountScopedKvRowsInTx, migrateReservedAccountScopedKvRowsForAccountModeInTx,
    matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx } from '@/app/kv/reservedAccountScopedKvRow';
import type { ReservedAccountScopedKvRowDomain } from '@/app/kv/reservedAccountScopedKvRow';
import { markConnectedAccountCatalogRowChangedInTx } from './configurationRows';

type Params = Readonly<{ accountId: string; key: ConnectedAccountCatalogKeyV1; toMode: 'plain' | 'e2ee';
    directive?: AccountEncryptionMigrateConnectedConfigurationsDirectiveV1 }>;
function migrationParams(input: Params) {
    const physicalKey = buildConnectedAccountCatalogPhysicalKeyV1(input.key);
    const domain: ReservedAccountScopedKvRowDomain<StoredConnectedAccountCatalogContentV1> = {
        label: `Connected Account ${input.key} conversion`,
        parseStoredEnvelope: value => parseConnectedAccountCatalogMigrationContentV1(value, input.key),
        parseCandidateEnvelope: value => parseConnectedAccountCatalogMigrationContentV1(value, input.key),
        assertEnvelopeForMode: (content, mode) => assertConnectedAccountCatalogContentForModeV1(content, mode, input.key),
    };
    return { accountId: input.accountId, toMode: input.toMode,
        physicalPrefix: input.key === 'configurations' ? CONNECTED_CONFIGURATION_ACCOUNT_ROW_PREFIX_V1 : CONNECTED_PURPOSE_ACCOUNT_ROW_PREFIX_V1,
        domain,
        isPhysicalKey: (key: string) => parseConnectedAccountCatalogPhysicalKeyV1(key) === input.key,
        items: input.directive?.content ? [{ physicalKey, revision: input.directive.expectedRevision, envelope: input.directive.content }] : [],
    };
}
/** The existing all-domain conversion transaction owns the fence and rollback. */
export async function migrateConnectedAccountCatalogForAccountModeInTx(tx: Tx, input: Params) {
    const params = migrationParams(input);
    const census = await listReservedAccountScopedKvRowsInTx(tx, params);
    if (census.status !== 'listed' || census.rows.length > 1 || census.rows.some(row => !params.isPhysicalKey(row.physicalKey))) {
        return { status: 'invalid_content' as const };
    }
    const source = census.rows[0];
    if (source?.envelope === null) {
        if (!input.directive || input.directive.content !== null || input.directive.expectedRevision !== source.revision) {
            return { status: 'migration_incomplete' as const };
        }
    } else if (input.directive?.content === null) return { status: 'migration_incomplete' as const };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...params,
        markChanged: ({ tx: changeTx, revision }) => markConnectedAccountCatalogRowChangedInTx(changeTx,
            { accountId: input.accountId, key: input.key, revision }) });
    if (result.status !== 'applied') return result;
    const row = result.rows[0];
    return { status: 'applied' as const, row: row ? { revision: row.revision, content: row.envelope }
        : source ? { revision: source.revision, content: null } : null };
}
export async function matchConnectedAccountCatalogAccountMigrationPostStateInTx(tx: Tx, input: Params) {
    const params = migrationParams(input);
    const census = await listReservedAccountScopedKvRowsInTx(tx, params);
    if (census.status !== 'listed' || census.rows.length > 1 || census.rows.some(row => !params.isPhysicalKey(row.physicalKey))) {
        return { status: 'mismatch' as const };
    }
    const row = census.rows[0];
    if (row?.envelope === null) return input.directive?.content === null && input.directive.expectedRevision === row.revision
        ? { status: 'matched' as const, row: { revision: row.revision, content: null } } : { status: 'mismatch' as const };
    if (input.directive?.content === null) return { status: 'mismatch' as const };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, params);
    if (result.status !== 'matched') return result;
    const current = result.rows[0];
    return { status: 'matched' as const, row: current ? { revision: current.revision, content: current.envelope } : null };
}
