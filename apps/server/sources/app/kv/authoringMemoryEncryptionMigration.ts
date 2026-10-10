import {
    type AccountEncryptionMigrateAuthoringMemoryDirective,
    type AuthoringMemoryContentV1,
    type AuthoringMemoryRowV1,
} from "@happier-dev/protocol";
import type { Tx } from "@/storage/inTx";

import { AUTHORING_MEMORY_ACCOUNT_KV_PREFIX, buildAuthoringMemoryPhysicalKey, parseAuthoringMemoryPhysicalKey } from "./accountScopedKv";
import { authoringMemoryDomain, listAuthoringMemoryInTx, markAuthoringMemoryChangedInTx } from "./authoringMemoryStorage";
import { migrateReservedAccountScopedKvRowsForAccountModeInTx, matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx, type ReservedAccountScopedKvRowMigrationItem } from './reservedAccountScopedKvRow';

type Params = Readonly<{
    accountId: string;
    toMode: "plain" | "e2ee";
    directive?: AccountEncryptionMigrateAuthoringMemoryDirective;
}>;
export type AuthoringMemoryAccountMigrationResult =
    | Readonly<{ status: "applied"; rows: readonly AuthoringMemoryRowV1[] }>
    | Readonly<{ status: "migration_incomplete" | "invalid_content" }>;

function migrationParams(params: Params) {
    return {
        accountId: params.accountId, toMode: params.toMode, physicalPrefix: AUTHORING_MEMORY_ACCOUNT_KV_PREFIX,
        domain: authoringMemoryDomain,
        isPhysicalKey: (key: string) => parseAuthoringMemoryPhysicalKey(key) !== null,
        items: (params.directive?.items ?? []).map(item => ({ physicalKey: buildAuthoringMemoryPhysicalKey(item.key), revision: item.expectedRevision, envelope: item.content })),
    };
}
function migrationRows(rows: readonly ReservedAccountScopedKvRowMigrationItem<AuthoringMemoryContentV1>[]): AuthoringMemoryRowV1[] {
    return rows.map(row => {
        const key = parseAuthoringMemoryPhysicalKey(row.physicalKey);
        if (key === null) throw new Error('Invalid authoring memory migration physical key');
        return { key, revision: row.revision, content: row.envelope };
    });
}

/** The caller holds the Account transition fence and aborts on any rejection. */
export async function migrateAuthoringMemoryForAccountModeInTx(
    tx: Tx, params: Params,
): Promise<AuthoringMemoryAccountMigrationResult> {
    const census = await listAuthoringMemoryInTx(tx, { accountId: params.accountId });
    if (census.status !== 'listed') return { status: 'invalid_content' };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, {
        ...migrationParams(params), markChanged: ({ tx: changeTx, physicalKey, revision }) => {
            const key = parseAuthoringMemoryPhysicalKey(physicalKey);
            if (key === null) throw new Error('Invalid authoring memory migration physical key');
            return markAuthoringMemoryChangedInTx(changeTx, { accountId: params.accountId, key, revision });
        },
    });
    return result.status === 'applied' ? { status: 'applied', rows: migrationRows(result.rows) } : result;
}

/** Exact lost-response replay observes the committed rows and performs no writes. */
export async function matchAuthoringMemoryAccountMigrationPostStateInTx(tx: Tx, params: Params): Promise<
    | Readonly<{ status: "matched"; rows: readonly AuthoringMemoryRowV1[] }>
    | Readonly<{ status: "mismatch" }>
> {
    const census = await listAuthoringMemoryInTx(tx, { accountId: params.accountId });
    if (census.status !== 'listed') return { status: 'mismatch' };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(params));
    return result.status === 'matched' ? { status: 'matched', rows: migrationRows(result.rows) } : result;
}
