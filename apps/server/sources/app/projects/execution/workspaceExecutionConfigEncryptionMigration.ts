import {
    WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1,
    buildWorkspaceExecutionConfigPhysicalKeyV1,
    parseWorkspaceExecutionConfigPhysicalKeyV1,
    type WorkspaceExecutionConfigRowV1,
    type WorkspaceExecutionConfigContentV1,
} from '@happier-dev/protocol/workspaces/workspaceExecutionConfigRowV1';
import type { AccountEncryptionMigrateWorkspaceExecutionConfigDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import {
    migrateReservedAccountScopedKvRowsForAccountModeInTx,
    matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx,
    type ReservedAccountScopedKvRowMigrationItem,
} from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { markWorkspaceExecutionConfigChangedInTx, workspaceExecutionConfigRowDomain } from './workspaceExecutionConfigRowService';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateWorkspaceExecutionConfigDirective }>;
function migrationParams(params: Params) {
    return {
        accountId: params.accountId, toMode: params.toMode, physicalPrefix: WORKSPACE_EXECUTION_CONFIG_KV_PREFIX_V1,
        domain: workspaceExecutionConfigRowDomain,
        isPhysicalKey: (key: string) => parseWorkspaceExecutionConfigPhysicalKeyV1(key) !== null,
        items: (params.directive?.items ?? []).map(item => ({ physicalKey: buildWorkspaceExecutionConfigPhysicalKeyV1(item.rowId), revision: item.expectedRevision, envelope: item.content })),
    };
}
function migrationRows(rows: readonly ReservedAccountScopedKvRowMigrationItem<WorkspaceExecutionConfigContentV1>[]): WorkspaceExecutionConfigRowV1[] {
    return rows.map(row => {
        const rowId = parseWorkspaceExecutionConfigPhysicalKeyV1(row.physicalKey);
        if (rowId === null) throw new Error('Invalid workspace execution config migration physical key');
        return { rowId, revision: row.revision, content: row.envelope };
    });
}
/** Conversion stays part of the fenced atomic Account transition. */
export async function migrateWorkspaceExecutionConfigForAccountModeInTx(tx: Tx, params: Params) {
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, {
        ...migrationParams(params), markChanged: ({ tx: changeTx, physicalKey, revision }) => {
            const rowId = parseWorkspaceExecutionConfigPhysicalKeyV1(physicalKey);
            if (rowId === null) throw new Error('Invalid workspace execution config migration physical key');
            return markWorkspaceExecutionConfigChangedInTx(changeTx, { accountId: params.accountId, rowId, revision });
        },
    });
    return result.status === 'applied' ? { status: 'applied' as const, rows: migrationRows(result.rows) } : result;
}
export async function matchWorkspaceExecutionConfigAccountMigrationPostStateInTx(tx: Tx, params: Params) {
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(params));
    return result.status === 'matched' ? { status: 'matched' as const, rows: migrationRows(result.rows) } : result;
}
