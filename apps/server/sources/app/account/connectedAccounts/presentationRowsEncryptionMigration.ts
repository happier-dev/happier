import { CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1,
    AccountEncryptionMigrateConnectedPresentationResultV1Schema, AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema,
    type AccountEncryptionMigrateConnectedPresentationDirectiveV1, type AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1,
} from '@happier-dev/protocol/connect/connectedAccountPresentationRowsV1';
import { migrateReservedAccountScopedKvSingletonForAccountModeInTx,
    matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx } from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { connectedPresentationRowDomain, connectedAcknowledgementsRowDomain,
    markConnectedPresentationRowChangedInTx, markConnectedAcknowledgementsRowChangedInTx } from './presentationRows';

type PresentationParams = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateConnectedPresentationDirectiveV1 }>;
type AcknowledgementsParams = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateConnectedAcknowledgementsDirectiveV1 }>;

/** The existing Account conversion transaction owns admission and rollback. */
export async function migrateConnectedPresentationForAccountModeInTx(tx: Tx, input: PresentationParams) {
    const result = await migrateReservedAccountScopedKvSingletonForAccountModeInTx(tx, { ...input,
        physicalKey: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, domain: connectedPresentationRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markConnectedPresentationRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    if (result.status !== 'applied') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateConnectedPresentationResultV1Schema.parse(result.row) };
}

export async function matchConnectedPresentationAccountMigrationPostStateInTx(tx: Tx, input: PresentationParams) {
    const result = await matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx(tx, { ...input,
        physicalKey: CONNECTED_PRESENTATION_ACCOUNT_KV_KEY_V1, domain: connectedPresentationRowDomain });
    if (result.status !== 'matched') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateConnectedPresentationResultV1Schema.parse(result.row) };
}

export async function migrateConnectedAcknowledgementsForAccountModeInTx(tx: Tx, input: AcknowledgementsParams) {
    const result = await migrateReservedAccountScopedKvSingletonForAccountModeInTx(tx, { ...input,
        physicalKey: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1, domain: connectedAcknowledgementsRowDomain,
        markChanged: ({ tx: changeTx, revision }) => markConnectedAcknowledgementsRowChangedInTx(changeTx, { accountId: input.accountId, revision }) });
    if (result.status !== 'applied') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema.parse(result.row) };
}

export async function matchConnectedAcknowledgementsAccountMigrationPostStateInTx(tx: Tx, input: AcknowledgementsParams) {
    const result = await matchReservedAccountScopedKvSingletonAccountMigrationPostStateInTx(tx, { ...input,
        physicalKey: CONNECTED_ACKNOWLEDGEMENTS_ACCOUNT_KV_KEY_V1, domain: connectedAcknowledgementsRowDomain });
    if (result.status !== 'matched') return result;
    return { status: result.status, row: result.row === null ? null : AccountEncryptionMigrateConnectedAcknowledgementsResultV1Schema.parse(result.row) };
}
