import type { Tx } from '@/storage/inTx';

export type AccountScopedKvMutation = Readonly<{
    key: string;
    value: Uint8Array<ArrayBuffer> | null;
    expectedVersion: number;
}>;

export type AccountScopedKvRow = Readonly<{
    key: string;
    value: Uint8Array<ArrayBuffer> | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}>;

export type AccountScopedKvMutationResult =
    | Readonly<{ status: 'updated'; rows: readonly AccountScopedKvRow[] }>
    | Readonly<{ status: 'conflict'; rows: readonly AccountScopedKvRow[] }>;

const ACCOUNT_SCOPED_KV_ROW_SELECT = {
    key: true,
    value: true,
    version: true,
    createdAt: true,
    updatedAt: true,
} as const;

/**
 * Canonical UserKVStore CAS primitive. Callers own domain validation and change publication.
 * Every requested row is checked before the first write, so the batch is all-or-nothing.
 */
export async function mutateAccountScopedKvRowsInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        mutations: readonly AccountScopedKvMutation[];
    }>,
): Promise<AccountScopedKvMutationResult> {
    const currentRows: AccountScopedKvRow[] = [];
    let hasConflict = false;

    for (const mutation of params.mutations) {
        const current = await tx.userKVStore.findUnique({
            where: { accountId_key: { accountId: params.accountId, key: mutation.key } },
            select: ACCOUNT_SCOPED_KV_ROW_SELECT,
        });
        if (current) currentRows.push(current);
        if ((current?.version ?? -1) !== mutation.expectedVersion) hasConflict = true;
    }

    if (hasConflict) return { status: 'conflict', rows: currentRows };

    const updatedRows: AccountScopedKvRow[] = [];
    for (const mutation of params.mutations) {
        const row = mutation.expectedVersion === -1
            ? await tx.userKVStore.create({
                data: {
                    accountId: params.accountId,
                    key: mutation.key,
                    value: mutation.value,
                    version: 0,
                },
                select: ACCOUNT_SCOPED_KV_ROW_SELECT,
            })
            : await tx.userKVStore.update({
                where: { accountId_key: { accountId: params.accountId, key: mutation.key } },
                data: {
                    value: mutation.value,
                    version: mutation.expectedVersion + 1,
                },
                select: ACCOUNT_SCOPED_KV_ROW_SELECT,
            });
        updatedRows.push(row);
    }

    return { status: 'updated', rows: updatedRows };
}
