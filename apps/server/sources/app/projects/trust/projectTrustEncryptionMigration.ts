import type { AccountEncryptionMigrateProjectTrustDirective } from '@happier-dev/protocol/account/encryptionMigrate';
import type { ProjectTrustContentV1, ProjectTrustRowV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { PROJECT_TRUST_ACCOUNT_KV_PREFIX, buildProjectTrustPhysicalKey, parseProjectTrustPhysicalKey } from '@/app/kv/accountScopedKv';
import {
    migrateReservedAccountScopedKvRowsForAccountModeInTx, matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx,
    type ReservedAccountScopedKvRowMigrationItem,
} from '@/app/kv/reservedAccountScopedKvRow';
import type { Tx } from '@/storage/inTx';
import { isProjectTrustContentBoundToProject, listProjectTrustInTx, markProjectTrustChangedInTx, projectTrustDomain } from './projectTrustRowService';

type Params = Readonly<{ accountId: string; toMode: 'plain' | 'e2ee'; directive?: AccountEncryptionMigrateProjectTrustDirective }>;
function migrationParams(params: Params) {
    return { accountId: params.accountId, toMode: params.toMode, physicalPrefix: PROJECT_TRUST_ACCOUNT_KV_PREFIX,
        domain: projectTrustDomain, isPhysicalKey: (key: string) => parseProjectTrustPhysicalKey(key) !== null,
        items: (params.directive?.items ?? []).map(item => ({ physicalKey: buildProjectTrustPhysicalKey(item.project), revision: item.expectedRevision, envelope: item.content })),
    };
}
function rows(items: readonly ReservedAccountScopedKvRowMigrationItem<ProjectTrustContentV1>[]): ProjectTrustRowV1[] {
    return items.map(item => {
        const project = parseProjectTrustPhysicalKey(item.physicalKey);
        if (!project) throw new Error('Invalid Project Trust migration physical key');
        return { project, revision: item.revision, content: item.envelope };
    });
}
function candidateBindingsMatch(params: Params): boolean {
    return (params.directive?.items ?? []).every(item => isProjectTrustContentBoundToProject(item.content, item.project));
}

/** Existing Account transition fence, CAS/tombstones and complete-inventory owner remain authoritative. */
export async function migrateProjectTrustForAccountModeInTx(tx: Tx, params: Params): Promise<
    Readonly<{ status: 'applied'; rows: readonly ProjectTrustRowV1[] }> | Readonly<{ status: 'migration_incomplete' | 'invalid_content' }>
> {
    const source = await listProjectTrustInTx(tx, { accountId: params.accountId });
    if (source.status !== 'listed' || !candidateBindingsMatch(params)) return { status: 'invalid_content' };
    const result = await migrateReservedAccountScopedKvRowsForAccountModeInTx(tx, { ...migrationParams(params),
        markChanged: ({ tx: changeTx, physicalKey, revision }) => {
            const project = parseProjectTrustPhysicalKey(physicalKey);
            if (!project) throw new Error('Invalid Project Trust migration physical key');
            return markProjectTrustChangedInTx(changeTx, { accountId: params.accountId, project, revision });
        },
    });
    return result.status === 'applied' ? { status: 'applied', rows: rows(result.rows) } : result;
}

export async function matchProjectTrustAccountMigrationPostStateInTx(tx: Tx, params: Params): Promise<
    Readonly<{ status: 'matched'; rows: readonly ProjectTrustRowV1[] }> | Readonly<{ status: 'mismatch' }>
> {
    const state = await listProjectTrustInTx(tx, { accountId: params.accountId });
    if (state.status !== 'listed' || !candidateBindingsMatch(params)) return { status: 'mismatch' };
    const result = await matchReservedAccountScopedKvRowsAccountMigrationPostStateInTx(tx, migrationParams(params));
    return result.status === 'matched' ? { status: 'matched', rows: rows(result.rows) } : result;
}
