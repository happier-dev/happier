import * as privacyKit from 'privacy-kit';
import type { AccountEncryptionMigrateTodosInventoryResponse } from '@happier-dev/protocol/account/encryptionMigrate';
import type { ResourceRecipientKeyEnvelopeInputV1 } from '@happier-dev/protocol/teams/resourceGrantAccessV1';
import { validateResourceAccountEncryptionMigrationKeys } from '@/app/teams/resourceGrantAccess';
import { classifyAccountJsonKvStoredContent } from '@/app/kv/accountJsonKvStoredContent';
import type { Tx } from '@/storage/inTx';
import { readTaskRecipientCensusInTx, taskRecipientEnvelopeStorageAdapter } from './taskAccessService';
import { publishTaskChangedInTx } from './taskChanges';

export interface TaskAccountEncryptionMigrationRow {
    id: string;
    key: string;
    value: Uint8Array;
    version: number;
    managed: boolean;
}

/** Complete owner census includes the private index, legacy bytes and malformed rows. */
export async function readTaskAccountEncryptionMigrationRowsInTx(tx: Tx, accountId: string): Promise<readonly TaskAccountEncryptionMigrationRow[]> {
    const rows = await tx.userKVStore.findMany({ where: { accountId, key: { startsWith: 'todo.' }, value: { not: null } },
        orderBy: { key: 'asc' }, select: { id: true, key: true, value: true, version: true,
            _count: { select: { grants: true, keyEnvelopes: true } } } });
    return rows.flatMap(row => {
        if (row.value === null) return [];
        const classification = classifyAccountJsonKvStoredContent({ key: row.key, value: row.value });
        if (classification.domain !== 'todo') return [];
        return [{ id: row.id, key: row.key, value: row.value, version: row.version,
            managed: classification.representation === 'current_resource_encrypted'
                || row._count.grants + row._count.keyEnvelopes > 0 }];
    });
}

/** This authenticated transition inventory does not widen ordinary KV admission. */
export async function readTaskAccountEncryptionInventoryInTx(tx: Tx, accountId: string): Promise<AccountEncryptionMigrateTodosInventoryResponse> {
    const items: AccountEncryptionMigrateTodosInventoryResponse['items'] = [];
    for (const row of await readTaskAccountEncryptionMigrationRowsInTx(tx, accountId)) {
        const item = { key: row.key, value: privacyKit.encodeBase64(new Uint8Array(row.value)), version: row.version };
        if (!row.managed) {
            items.push(item);
            continue;
        }
        const census = await readTaskRecipientCensusInTx(tx, { actorAccountId: accountId, ownerAccountId: accountId,
            taskId: row.key.slice('todo.'.length) });
        if (!census.ok) throw new Error(census.error);
        const { taskId: _taskId, ...resource } = census.value;
        items.push({ ...item, resource });
    }
    return { items };
}

/** The shared census decides live audience/readiness; first-key proof supplies the target owner's binding. */
export async function validateTaskAccountEncryptionMigrationKeysInTx(tx: Tx, input: Readonly<{
    accountId: string;
    row: TaskAccountEncryptionMigrationRow;
    toMode: 'plain' | 'e2ee';
    ownerContentPublicKeyFingerprint?: string | null;
    recipientKeyEnvelopes?: readonly ResourceRecipientKeyEnvelopeInputV1[];
}>): Promise<boolean> {
    const envelopes = input.recipientKeyEnvelopes;
    if (!envelopes) return false;
    const census = await readTaskRecipientCensusInTx(tx, { actorAccountId: input.accountId,
        ownerAccountId: input.accountId, taskId: input.row.key.slice('todo.'.length) });
    if (!census.ok) return false;
    return validateResourceAccountEncryptionMigrationKeys({ ownerAccountId: input.accountId, toMode: input.toMode,
        ownerContentPublicKeyFingerprint: input.ownerContentPublicKeyFingerprint, recipients: census.value.recipients,
        recipientKeyEnvelopes: envelopes });
}

/** The Account transaction replaces only key tuples after the incumbent row CAS. Grants and identities stay in place. */
export async function applyTaskAccountEncryptionMigrationKeysInTx(tx: Tx, row: TaskAccountEncryptionMigrationRow,
    envelopes: readonly ResourceRecipientKeyEnvelopeInputV1[]): Promise<void> {
    await tx.taskKeyEnvelope.deleteMany({ where: { taskId: row.id } });
    for (const envelope of envelopes) await taskRecipientEnvelopeStorageAdapter.writeRecipientEnvelopeInTx(tx, row.id, envelope);
    await publishTaskChangedInTx(tx, row.id);
}

/** Exact replay checks the complete committed key set without repairing it. */
export async function matchTaskAccountEncryptionMigrationKeysInTx(tx: Tx, row: TaskAccountEncryptionMigrationRow,
    envelopes: readonly ResourceRecipientKeyEnvelopeInputV1[]): Promise<boolean> {
    const current = await tx.taskKeyEnvelope.findMany({ where: { taskId: row.id } });
    const expected = new Map(envelopes.map(envelope => [envelope.recipientAccountId, envelope]));
    return expected.size === envelopes.length && current.length === expected.size && current.every(envelope => {
        const target = expected.get(envelope.recipientAccountId);
        return target?.encryptedDataKey === privacyKit.encodeBase64(envelope.encryptedDataKey)
            && target.recipientContentPublicKeyFingerprint === envelope.recipientContentPublicKeyFingerprint;
    });
}
