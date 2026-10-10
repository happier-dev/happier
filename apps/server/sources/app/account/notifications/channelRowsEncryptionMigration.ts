import { NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, AccountEncryptionMigrateNotificationChannelsResultV1Schema,
    type AccountEncryptionMigrateNotificationChannelsDirectiveV1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { migrateReservedAccountScopedKvSingletonForAccountModeInTx,
    matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx } from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { notificationChannelCatalogRowDomain, markNotificationChannelCatalogRowChangedInTx } from './channelRows';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateNotificationChannelsDirectiveV1 }>;

/** The existing Account conversion transaction owns admission and rollback. */
export async function migrateNotificationChannelCatalogForAccountModeInTx(tx: Tx, input: Params) {
    const result = await migrateReservedAccountScopedKvSingletonForAccountModeInTx(tx, { ...input,
        physicalKey: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, domain: notificationChannelCatalogRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markNotificationChannelCatalogRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    if (result.status !== 'applied') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateNotificationChannelsResultV1Schema.parse(result.row) };
}

export async function matchNotificationChannelCatalogAccountMigrationPostStateInTx(tx: Tx, input: Params) {
    const result = await matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx(tx, { ...input,
        physicalKey: NOTIFICATION_CHANNELS_ACCOUNT_KV_KEY_V1, domain: notificationChannelCatalogRowDomain });
    if (result.status !== 'matched') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateNotificationChannelsResultV1Schema.parse(result.row) };
}
