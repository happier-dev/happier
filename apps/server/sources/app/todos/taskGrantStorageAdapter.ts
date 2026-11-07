import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resourceGrantRelationsSelect, resolveResourceGrantAudienceInTx,
    type ResourceGrantAccessFacts, type ResourceGrantStorageAdapter } from '@/app/teams/resourceGrantAccess';

export const taskRowsWhere = { key: { startsWith: 'todo.', not: 'todo.index' }, value: { not: null } } as const;

export function taskAccessFactsSelect(actorAccountId?: string) {
    return { accountId: true, account: { select: { encryptionMode: true } },
        ...resourceGrantRelationsSelect(actorAccountId) } as const;
}

async function readTaskAccessFactsInTx(tx: Tx, resourceId: string, actorAccountId?: string) {
    return tx.userKVStore.findFirst({ where: { id: resourceId, ...taskRowsWhere }, select: taskAccessFactsSelect(actorAccountId) });
}

export type TaskAccessFacts = NonNullable<Awaited<ReturnType<typeof readTaskAccessFactsInTx>>>;

export function taskGrantFacts(row: TaskAccessFacts): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    return { ownerAccountId: row.accountId, encryptionMode: mode.status === 'ready' ? mode.mode : null,
        accountGrants: row.accountGrants, teamGrants: row.teamGrants, groupGrants: row.groupGrants };
}

/** The task adapter supplies grant facts without loading task content or envelopes. */
export const taskGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsInTx(tx, resourceId, actorAccountId) {
        const row = await readTaskAccessFactsInTx(tx, resourceId, actorAccountId);
        return row ? taskGrantFacts(row) : null;
    },
};

/** Conversion, publication and key preparation consume the same live grant policy. */
export async function resolveTaskAudienceInTx(tx: Tx, resourceId: string): Promise<string[]> {
    return resolveResourceGrantAudienceInTx(tx, taskGrantStorageAdapter, resourceId);
}
