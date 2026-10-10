import { REMOTE_HOST_ACCOUNT_KV_KEY_V1, AccountEncryptionMigrateRemoteHostsResultV1Schema,
    type AccountEncryptionMigrateRemoteHostsDirectiveV1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { migrateReservedAccountScopedKvSingletonForAccountModeInTx,
    matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx } from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { remoteHostRowDomain, markRemoteHostCatalogRowChangedInTx } from './remoteHostRows';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateRemoteHostsDirectiveV1 }>;

/** The existing Account conversion transaction owns admission and rollback. */
export async function migrateRemoteHostCatalogForAccountModeInTx(tx: Tx, input: Params) {
    const result = await migrateReservedAccountScopedKvSingletonForAccountModeInTx(tx, { ...input,
        physicalKey: REMOTE_HOST_ACCOUNT_KV_KEY_V1, domain: remoteHostRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markRemoteHostCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    if (result.status !== 'applied') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateRemoteHostsResultV1Schema.parse(result.row) };
}

export async function matchRemoteHostCatalogAccountMigrationPostStateInTx(tx: Tx, input: Params) {
    const result = await matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx(tx, { ...input,
        physicalKey: REMOTE_HOST_ACCOUNT_KV_KEY_V1, domain: remoteHostRowDomain });
    if (result.status !== 'matched') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateRemoteHostsResultV1Schema.parse(result.row) };
}
