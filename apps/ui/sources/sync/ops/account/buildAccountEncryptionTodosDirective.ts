import type { AccountEncryptionMigrateTodosDirective, AccountEncryptionMigrateTodosInventoryResponse } from '@happier-dev/protocol/account/encryptionMigrate';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { prepareResourceRecipientKeyEnvelopesV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';
import { TaskResourceContentV1Schema, type TaskResourceV1 } from '@happier-dev/protocol/actions/internalTaskActions';
import { openTaskResourceContentV1, sealTaskResourceContentV1 } from '@happier-dev/protocol/todos/todoActionOperationsV1';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { decodeTodoStoredContent, encodeTodoStoredContent } from '@/sync/domains/todos/todoStoredContent';
import { assertAccountEncryptionMigrationScopeCurrent, type AccountEncryptionMigrationScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { createResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { createUiTaskResourceCrypto } from '@/sync/encryption/taskResourceCrypto';
import type { Encryption } from '@/sync/encryption/encryption';

export type TaskDiscussionMigrationDataKeys = Readonly<{ source: Uint8Array | null; target: Uint8Array | null }>;

/** The Account transition retains the Todo census and consumes the task owner's codec. */
export async function buildAccountEncryptionTodosDirective(input: Readonly<{
    fromMode: 'plain' | 'e2ee';
    toMode: 'plain' | 'e2ee';
    rows: readonly AccountEncryptionMigrateTodosInventoryResponse['items'][number][];
    sourceEncryption: Encryption | null;
    targetEncryption: Encryption | null;
    scope: AccountEncryptionMigrationScope;
    withTaskDataKeys?: (key: string, keys: TaskDiscussionMigrationDataKeys) => void;
}>): Promise<AccountEncryptionMigrateTodosDirective> {
    if (input.rows.length === 0) return { action: 'assert_empty' };
    const items: Extract<AccountEncryptionMigrateTodosDirective, { action: 'migrate' }>['items'] = [];
    const requireCurrent = () => assertAccountEncryptionMigrationScopeCurrent(input.scope);
    const sourceCrypto = createUiTaskResourceCrypto(input.sourceEncryption, input.scope.scope);
    const targetCrypto = createUiTaskResourceCrypto(input.targetEncryption, input.scope.scope);
    for (const row of input.rows) {
        requireCurrent();
        if (!row.resource) {
            const content = await decodeTodoStoredContent({ key: row.key, encoded: row.value,
                expectedMode: input.fromMode, encryption: input.sourceEncryption });
            items.push({ key: row.key, expectedVersion: row.version,
                value: await encodeTodoStoredContent({ key: row.key, mode: input.toMode,
                    value: content.value, encryption: input.targetEncryption }) });
            continue;
        }
        if (row.key === 'todo.index' || !row.key.startsWith('todo.')
            || row.resource.ownerAccountId !== input.scope.scope.accountId || row.resource.access !== 'owner'
            || row.resource.encryptionMode !== input.fromMode) throw new Error('Task migration source authority changed');
        const resource: TaskResourceV1 = { ownerAccountId: row.resource.ownerAccountId, taskId: row.key.slice('todo.'.length),
            version: row.version, access: 'owner', encryptionMode: input.fromMode,
            content: TaskResourceContentV1Schema.parse(JSON.parse(new TextDecoder().decode(decodeBase64(row.value, 'base64')))),
            encryptedDataKey: row.resource.callerDataEncryptionKey };
        const opened = await openTaskResourceContentV1(resource, { accountId: input.scope.scope.accountId, requireCurrent, crypto: sourceCrypto });
        let targetDataKey: Uint8Array | null = null;
        try {
            const targetKey = await createResourceDataKey({ mode: input.toMode,
                encryptDataEncryptionKey: dataKey => input.targetEncryption?.encryptEncryptionKey(dataKey) ?? Promise.resolve(null) });
            if (!targetKey) throw new Error('Task migration target key unavailable');
            targetDataKey = targetKey.dataKey;
            const content = await sealTaskResourceContentV1({ resource: { ...resource, encryptionMode: input.toMode,
                encryptedDataKey: targetKey.dataEncryptionKey }, dataKey: targetKey.dataKey }, opened.todo, targetCrypto);
            requireCurrent();
            const recipientKeyEnvelopes = targetKey.mode === 'plain' ? [] : [
                { recipientAccountId: resource.ownerAccountId, encryptedDataKey: targetKey.dataEncryptionKey,
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(input.targetEncryption!.contentDataKey) },
                ...prepareResourceRecipientKeyEnvelopesV1({ dataKey: targetKey.dataKey,
                    recipients: row.resource.recipients.filter(recipient => recipient.recipientAccountId !== resource.ownerAccountId),
                    randomBytes: getRandomBytes, replaceExisting: true }),
            ];
            items.push({ key: row.key, expectedVersion: row.version,
                value: encodeBase64(new TextEncoder().encode(JSON.stringify(content)), 'base64'), recipientKeyEnvelopes });
            input.withTaskDataKeys?.(row.key, { source: opened.dataKey, target: targetDataKey });
        } finally {
            opened.dataKey?.fill(0);
            targetDataKey?.fill(0);
        }
    }
    requireCurrent();
    return { action: 'migrate', items };
}
