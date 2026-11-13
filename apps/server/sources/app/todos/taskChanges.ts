import { buildTaskResourceChangeEntityIdV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import type { Tx } from '@/storage/inTx';
import { markAccountsChanged } from '@/app/changes/markAccountChanged';
import { classifyAccountJsonKvKey } from '@happier-dev/protocol/account/accountJsonKv';
import { portableQueryChunks } from '@/storage/portableQueryChunks';
import { resolveResourceGrantAudienceFromFacts } from '@/app/teams/resourceGrantAccess';
import { taskAccessFactsSelect, taskGrantFacts, type TaskAccessFacts } from './taskGrantStorageAdapter';

type TaskPublicationRow = TaskAccessFacts & Readonly<{ id: string; key: string }>;

async function publishTaskRowChangedInTx(tx: Tx, row: TaskPublicationRow, additionalAccountIds: readonly string[] = []): Promise<void> {
    const audience = resolveResourceGrantAudienceFromFacts(taskGrantFacts(row));
    await markAccountsChanged(tx, { kind: 'kv', accountIds: [...new Set([...audience, ...additionalAccountIds])],
        entityId: buildTaskResourceChangeEntityIdV1({ ownerAccountId: row.accountId, taskId: row.key.slice('todo.'.length) }) });
}

/** Publish only the qualified identity to current and just-revoked recipients, never task content. */
export async function publishTaskChangedInTx(tx: Tx, resourceId: string, additionalAccountIds: readonly string[] = []): Promise<void> {
    const row = await tx.userKVStore.findUnique({ where: { id: resourceId }, select: { ...taskAccessFactsSelect(), id: true, key: true } });
    if (!row) return;
    await publishTaskRowChangedInTx(tx, row, additionalAccountIds);
}

/** Read only touched shared task metadata. Tombstones retain their removal audience. */
async function readTaskKvMutationPublicationRowsInTx(tx: Tx, ownerAccountId: string, keys: readonly string[]): Promise<TaskPublicationRow[]> {
    const taskKeys = [...new Set(keys.filter(key => classifyAccountJsonKvKey(key) === 'todo' && key !== 'todo.index'))];
    const rows: TaskPublicationRow[] = [];
    for (const chunk of portableQueryChunks({ values: taskKeys, bindingsPerValue: 1, fixedBindings: 2 })) {
        rows.push(...await tx.userKVStore.findMany({ where: { accountId: ownerAccountId, key: { in: [...chunk] },
            grants: { some: {} } },
            select: { ...taskAccessFactsSelect(), id: true, key: true } }));
    }
    return rows;
}

/** The first Account admission includes the whole prospective publication cohort. */
export async function readTaskKvMutationAudienceInTx(tx: Tx, ownerAccountId: string, keys: readonly string[]): Promise<string[]> {
    const rows = await readTaskKvMutationPublicationRowsInTx(tx, ownerAccountId, keys);
    return [...new Set(rows.flatMap(row => resolveResourceGrantAudienceFromFacts(taskGrantFacts(row))))];
}

/** Raw Plain task writes share the task publisher; only the owner receives the KV body. */
export async function publishTaskKvMutationChangesInTx(tx: Tx, ownerAccountId: string, keys: readonly string[]): Promise<void> {
    for (const row of await readTaskKvMutationPublicationRowsInTx(tx, ownerAccountId, keys)) {
        await publishTaskRowChangedInTx(tx, row);
    }
}
