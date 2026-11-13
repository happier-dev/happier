import { portableQueryChunks } from '@/storage/portableQueryChunks';
import type { Tx } from '@/storage/inTx';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { resourceGrantRelationsSelect, projectResourceGrantRows, resolveResourceGrantAudienceInTx,
    type ResourceGrantAccessFacts, type ResourceGrantStorageAdapter } from '@/app/teams/resourceGrantAccess';

export const taskRowsWhere = { key: { startsWith: 'todo.', not: 'todo.index' }, value: { not: null } } as const;

export function taskAccessFactsSelect(actorAccountId?: string) {
    return { id: true, accountId: true, account: { select: { encryptionMode: true } },
        ...resourceGrantRelationsSelect(actorAccountId) } as const;
}

async function readTaskAccessFactsBatchInTx(tx: Tx, resourceIds: readonly string[], actorAccountId?: string) {
    return tx.userKVStore.findMany({ where: { id: { in: [...resourceIds] }, ...taskRowsWhere }, select: taskAccessFactsSelect(actorAccountId) });
}

export type TaskAccessFacts = Awaited<ReturnType<typeof readTaskAccessFactsBatchInTx>>[number];

export function taskGrantFacts(row: TaskAccessFacts): ResourceGrantAccessFacts {
    const mode = resolveEffectiveAccountEncryptionModeFromAccountRow(row.account);
    return { ownerAccountId: row.accountId, encryptionMode: mode.status === 'ready' ? mode.mode : null,
        ...projectResourceGrantRows(row.grants) };
}

/** The task adapter supplies grant facts without loading task content or envelopes. */
export const taskGrantStorageAdapter: ResourceGrantStorageAdapter = {
    async readAccessFactsBatchInTx(tx, resourceIds, actorAccountId) {
        const facts = new Map<string, ResourceGrantAccessFacts>();
        for (const ids of portableQueryChunks({ values: [...new Set(resourceIds)], bindingsPerValue: 1,
            fixedBindings: 2 + (actorAccountId === undefined ? 0 : 3) })) {
            for (const row of await readTaskAccessFactsBatchInTx(tx, ids, actorAccountId)) facts.set(row.id, taskGrantFacts(row));
        }
        return facts;
    },
    async readAccessFactsInTx(tx, resourceId, actorAccountId) {
        return (await taskGrantStorageAdapter.readAccessFactsBatchInTx(tx, [resourceId], actorAccountId)).get(resourceId) ?? null;
    },
};

/** Conversion, publication and key preparation consume the same live grant policy. */
export async function resolveTaskAudienceInTx(tx: Tx, resourceId: string): Promise<string[]> {
    return resolveResourceGrantAudienceInTx(tx, taskGrantStorageAdapter, resourceId);
}
