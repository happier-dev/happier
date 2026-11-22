import { DiscussionAccountEncryptionInventoryV1Schema, AccountEncryptionMigrateDiscussionsDirectiveV1Schema,
    type DiscussionAccountEncryptionInventoryV1, type AccountEncryptionMigrateDiscussionsDirectiveV1 } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { prepareResourceRecipientKeyEnvelopesV1 } from '@happier-dev/protocol/teams/resourceRecipientKeyPreparationV1';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { openSessionStoredContent, sealSessionStoredContent } from '@happier-dev/sync-client';
import { createResourceDataKey, openResourceDataKey } from '@/sync/encryption/resourceDataKey';
import { resourceStoredContentContext } from '@/sync/encryption/resourceStoredContent';
import type { Encryption } from '@/sync/encryption/encryption';
import { getRandomBytes } from '@/platform/cryptoRandom';
import type { ServerFetch } from '@/sync/http/client';
import { assertAccountEncryptionMigrationScopeCurrent, type AccountEncryptionMigrationScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { DiscussionMessageContentV1StoredSchema, readDiscussionAttachmentReferencesV1 } from '@happier-dev/protocol/discussions/content';
import { BinaryBlobAccountEncryptionStageV1Schema, type BinaryBlobAccountEncryptionStageV1, type BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { createBinaryContentEncryption, hashBinaryContent, openBinaryContent, sealBinaryContent } from '@/sync/encryption/binaryContent';
import { decodeBase64 } from '@/encryption/base64';
import type { DiscussionAttachmentReadResponseV1 } from '@happier-dev/protocol/discussions/attachments';

export type DiscussionMigrationAttachmentTransport = Readonly<{
    readAttachment?: (discussionId: string, messageId: string, blobId: string) => Promise<DiscussionAttachmentReadResponseV1>;
    stageAttachment?: (discussionId: string, messageId: string, blobId: string, content: BinaryBlobStoredContentV1) => Promise<BinaryBlobAccountEncryptionStageV1>;
}>;

export async function fetchAccountEncryptionMigrationDiscussionInventory(input: Readonly<{
    request: ServerFetch; token: string; scope: AccountEncryptionMigrationScope;
}>): Promise<DiscussionAccountEncryptionInventoryV1> {
    assertAccountEncryptionMigrationScopeCurrent(input.scope);
    const response = await input.request('/v1/account/encryption/migrate/discussions/inventory', {
        method: 'GET', headers: { Authorization: `Bearer ${input.token}` },
    });
    assertAccountEncryptionMigrationScopeCurrent(input.scope);
    if (!response.ok) throw new Error('Account Discussion migration inventory is unavailable');
    const inventory = DiscussionAccountEncryptionInventoryV1Schema.parse(await response.json());
    assertAccountEncryptionMigrationScopeCurrent(input.scope);
    if (inventory.items.some(item => item.recipients.ownerAccountId !== input.scope.scope.accountId)) {
        throw new Error('Account Discussion migration authority changed');
    }
    return inventory;
}

/** Resource DEKs, shared recipient preparation and the explicit content codec remain authoritative. */
export async function buildAccountEncryptionDiscussionsDirective(input: Readonly<{
    inventory: DiscussionAccountEncryptionInventoryV1; fromMode: 'plain' | 'e2ee'; toMode: 'plain' | 'e2ee';
    sourceEncryption: Encryption | null; targetEncryption: Encryption | null; scope: AccountEncryptionMigrationScope;
}> & DiscussionMigrationAttachmentTransport): Promise<AccountEncryptionMigrateDiscussionsDirectiveV1> {
    const items: AccountEncryptionMigrateDiscussionsDirectiveV1['items'] = [];
    for (const row of input.inventory.items) {
        assertAccountEncryptionMigrationScopeCurrent(input.scope);
        if (row.recipients.ownerAccountId !== input.scope.scope.accountId || row.recipients.discussionId !== row.discussionId
            || row.recipients.encryptionMode !== input.fromMode) throw new Error('Discussion migration source authority changed');
        const sourceKey = await openResourceDataKey({ mode: input.fromMode,
            dataEncryptionKey: input.fromMode === 'plain' && row.dataEncryptionKey === ARTIFACT_PLAIN_DATA_KEY_MARKER ? null : row.dataEncryptionKey,
            decryptDataEncryptionKey: value => input.sourceEncryption?.decryptEncryptionKey(value, input.scope.scope) ?? Promise.resolve(null) });
        const targetKey = await createResourceDataKey({ mode: input.toMode,
            encryptDataEncryptionKey: value => input.targetEncryption?.encryptEncryptionKey(value) ?? Promise.resolve(null) });
        const source = resourceStoredContentContext(sourceKey);
        const target = resourceStoredContentContext(targetKey);
        if (!source || !target || !targetKey) throw new Error('Discussion migration key unavailable');
        const convert = async (content: typeof row.titleContent) => {
            const opened = await openSessionStoredContent(source, content);
            if (opened.status !== 'ready') throw new Error('Discussion migration content unavailable');
            const sealed = await sealSessionStoredContent(target, StrictJsonValueSchema.parse(opened.value));
            if (sealed.status !== 'ready') throw new Error('Discussion migration target key unavailable');
            return sealed.content;
        };
        const messages = [];
        for (const message of row.messages) {
            const opened = await openSessionStoredContent(source, message.content);
            if (opened.status !== 'ready') throw new Error('Discussion migration content unavailable');
            const content = DiscussionMessageContentV1StoredSchema.parse(opened.value);
            const references = readDiscussionAttachmentReferencesV1(content);
            const byBlobId = new Map(references.map(reference => [reference.blobId, reference]));
            const bindings = message.attachments ?? [];
            const expectedIds = [...bindings.map(binding => binding.blobId), ...(message.removedAttachmentBlobIds ?? [])];
            if (references.some(reference => {
                const canonical = byBlobId.get(reference.blobId)!;
                return reference.sizeBytes !== canonical.sizeBytes || reference.sha256 !== canonical.sha256 || reference.mime !== canonical.mime;
            }) || byBlobId.size !== expectedIds.length || new Set(expectedIds).size !== expectedIds.length
                || expectedIds.some(id => !byBlobId.has(id)) || bindings.some(binding => binding.encryptionMode !== input.fromMode)) {
                throw new Error('Discussion migration attachment census changed');
            }
            const attachments = [];
            // Open and stage one leaf at a time; folder directories have no physical bytes.
            for (const binding of bindings) {
                assertAccountEncryptionMigrationScopeCurrent(input.scope);
                if (!input.readAttachment || !input.stageAttachment) throw new Error('Discussion migration attachment transport unavailable');
                const stored = await input.readAttachment(row.discussionId, message.id, binding.blobId);
                assertAccountEncryptionMigrationScopeCurrent(input.scope);
                if (stored.blobId !== binding.blobId || !('content' in stored)) throw new Error('Discussion migration attachment identity changed');
                const bytes = await openBinaryContent({ reference: byBlobId.get(binding.blobId)!, content: stored.content,
                    mode: input.fromMode, encryption: sourceKey?.mode === 'e2ee' ? createBinaryContentEncryption(sourceKey.dataKey) : null });
                const expectedContentSha256 = hashBinaryContent(decodeBase64(stored.content.t === 'plain' ? stored.content.v : stored.content.c));
                const targetContent = await sealBinaryContent(bytes, input.toMode,
                    targetKey.mode === 'e2ee' ? createBinaryContentEncryption(targetKey.dataKey) : null);
                assertAccountEncryptionMigrationScopeCurrent(input.scope);
                const staged = BinaryBlobAccountEncryptionStageV1Schema.parse(await input.stageAttachment(row.discussionId, message.id, binding.blobId, targetContent));
                assertAccountEncryptionMigrationScopeCurrent(input.scope);
                if (staged.t !== targetContent.t || staged.contentSha256 !== hashBinaryContent(decodeBase64(
                    targetContent.t === 'plain' ? targetContent.v : targetContent.c))) throw new Error('Discussion migration attachment upload integrity changed');
                attachments.push({ blobId: binding.blobId, expectedContentSha256, content: staged });
            }
            const sealed = await sealSessionStoredContent(target, StrictJsonValueSchema.parse(content));
            if (sealed.status !== 'ready') throw new Error('Discussion migration target key unavailable');
            messages.push({ id: message.id, expectedContent: message.content, content: sealed.content, attachments });
        }
        items.push({ discussionId: row.discussionId, expectedDataEncryptionKey: row.dataEncryptionKey,
            dataEncryptionKey: targetKey.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
            expectedTitleContent: row.titleContent, titleContent: await convert(row.titleContent), messages,
            recipientKeyEnvelopes: targetKey.mode === 'plain' ? [] : prepareResourceRecipientKeyEnvelopesV1({
                dataKey: targetKey.dataKey, recipients: row.recipients.recipients.filter(recipient => recipient.recipientAccountId !== input.scope.scope.accountId),
                randomBytes: getRandomBytes, replaceExisting: true,
            }) });
    }
    assertAccountEncryptionMigrationScopeCurrent(input.scope);
    return AccountEncryptionMigrateDiscussionsDirectiveV1Schema.parse({ items });
}
