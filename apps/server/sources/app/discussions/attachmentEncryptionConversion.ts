import type { BinaryBlobStoredContentV1, BinaryBlobAccountEncryptionStageV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import type { AccountEncryptionMigrateDiscussionsDirectiveV1 } from '@happier-dev/protocol/discussions/accountEncryptionMigration';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { discussionAttachmentConversionUploadPrefix } from '@/storage/privateFiles/accountPrivateFileCustody';
import { preparePrivateBinaryConversion, type PreparedPrivateBinaryConversion } from '@/storage/privateFiles/privateBinaryConversion';
import { prepareDiscussionAttachmentWrite, openDiscussionAttachmentBytes, completeDiscussionAttachmentCandidateCustodyInTx,
    discardDiscussionAttachmentCandidate, discussionAttachmentCandidateStorageKey, discussionAttachmentRejectedUploadReuseKey,
    type DiscussionAttachmentRow } from './attachmentService';

export const discussionConversionAttachmentCustody = (row: Omit<DiscussionAttachmentRow, 'messageId'>) =>
    `${discussionAttachmentConversionUploadPrefix}${row.blobId}:${row.encryptionMode}:${row.storedSizeBytes}`;
export type PreparedDiscussionAttachmentConversion = PreparedPrivateBinaryConversion<DiscussionAttachmentRow>;
export type PreparedDiscussionAttachmentConversions = ReadonlyMap<string, PreparedDiscussionAttachmentConversion>;
export const discussionConversionAttachmentKey = (messageId: string, blobId: string) => `${messageId}/${blobId}`;

/** Staging never changes the binding or mode; the signed Account transaction activates it. */
export async function stageDiscussionAttachmentAccountEncryptionConversion(input: Readonly<{
    accountId: string; discussionId: string; messageId: string; blobId: string; content: BinaryBlobStoredContentV1;
}>): Promise<BinaryBlobAccountEncryptionStageV1> {
    const source = await db.discussionAttachment.findFirst({ where: { blobId: input.blobId, messageId: input.messageId, removedByAccountId: null,
        message: { discussionId: input.discussionId, discussion: { ownerAccountId: input.accountId } } },
        include: { message: { select: { discussion: { select: { encryptionMode: true, ownerAccount: { select: { encryptionMode: true } } } } } } } });
    const targetMode = input.content.t === 'plain' ? 'plain' : 'e2ee';
    if (!source || source.encryptionMode !== source.message.discussion.encryptionMode
        || source.encryptionMode !== source.message.discussion.ownerAccount.encryptionMode || source.encryptionMode === targetMode) {
        throw new Error('Discussion conversion source unavailable');
    }
    const candidate = await prepareDiscussionAttachmentWrite(input);
    try {
        await inTx(async tx => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, 'content');
            const current = await tx.discussionAttachment.findFirst({ where: { blobId: input.blobId, messageId: input.messageId, removedByAccountId: null,
                storageKey: source.storageKey, encryptionMode: source.encryptionMode, storedSizeBytes: source.storedSizeBytes,
                message: { discussionId: input.discussionId, discussion: { ownerAccountId: input.accountId, encryptionMode: source.encryptionMode } } } });
            if (fence.status !== 'ready' || fence.account.currentness.encryptionMode !== source.encryptionMode || !current) {
                throw new Error('Discussion conversion source changed');
            }
            await completeDiscussionAttachmentCandidateCustodyInTx(tx, candidate, discussionConversionAttachmentCustody(candidate.row));
        });
    } catch (error) { await discardDiscussionAttachmentCandidate(candidate); throw error; }
    return { t: input.content.t, uploadId: candidate.row.storageKey.split('/').at(-1)!, contentSha256: candidate.contentSha256 };
}

/** Shared byte verification runs before the Account lock, one source/target pair at a time. */
export async function prepareDiscussionAttachmentAccountEncryptionConversions(input: Readonly<{
    accountId: string; directive?: AccountEncryptionMigrateDiscussionsDirectiveV1;
}>): Promise<PreparedDiscussionAttachmentConversions> {
    const result = new Map<string, PreparedDiscussionAttachmentConversion>();
    for (const item of input.directive?.items ?? []) for (const message of item.messages) for (const attachment of message.attachments ?? []) {
        const source = await db.discussionAttachment.findFirst({ where: { blobId: attachment.blobId, messageId: message.id, removedByAccountId: null,
            message: { discussionId: item.discussionId, discussion: { ownerAccountId: input.accountId } } } });
        if (!source) continue;
        const storageKey = discussionAttachmentCandidateStorageKey(attachment.blobId, attachment.content.uploadId);
        let target = source;
        if (source.storageKey !== storageKey) {
            const prefix = `${discussionAttachmentConversionUploadPrefix}${attachment.blobId}:`;
            const custody = await db.uploadedFile.findFirst({ where: { accountId: input.accountId, path: storageKey, reuseKey: { startsWith: prefix } } });
            if (!custody) continue;
            const [mode, size] = custody.reuseKey!.slice(prefix.length).split(':');
            if ((mode !== 'plain' && mode !== 'e2ee') || !/^\d+$/.test(size ?? '')) continue;
            target = { ...source, storageKey, encryptionMode: mode, storedSizeBytes: BigInt(size!) };
        }
        const prepared = await preparePrivateBinaryConversion({ accountId: input.accountId, source, target,
            stage: attachment.content, expectedContentSha256: attachment.expectedContentSha256, open: openDiscussionAttachmentBytes });
        if (prepared) result.set(discussionConversionAttachmentKey(message.id, attachment.blobId), prepared);
    }
    return result;
}

/** The existing Account fence serializes cancellation with activation and Account erasure. */
export async function cancelDiscussionAttachmentAccountEncryptionConversion(input: Readonly<{ accountId: string; uploadId: string }>): Promise<void> {
    const candidates = await db.uploadedFile.findMany({ where: { accountId: input.accountId,
        path: { endsWith: `/${input.uploadId}` }, reuseKey: { startsWith: discussionAttachmentConversionUploadPrefix } } });
    for (const candidate of candidates) {
        const [blobId, encryptionMode, size] = candidate.reuseKey!.slice(discussionAttachmentConversionUploadPrefix.length).split(':');
        if (!blobId || (encryptionMode !== 'plain' && encryptionMode !== 'e2ee') || !/^\d+$/.test(size ?? '')
            || candidate.path !== discussionAttachmentCandidateStorageKey(blobId, input.uploadId)) continue;
        const prepared = await inTx(async tx => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId, 'content');
            if (fence.status === 'account_not_found') return null;
            const current = await tx.uploadedFile.findFirst({ where: { id: candidate.id, accountId: input.accountId,
                path: candidate.path, reuseKey: candidate.reuseKey } });
            if (!current) return null;
            await tx.uploadedFile.update({ where: { id: current.id }, data: { reuseKey: discussionAttachmentRejectedUploadReuseKey(blobId) } });
            return { accountId: input.accountId, row: { blobId, storageKey: current.path, encryptionMode, storedSizeBytes: BigInt(size!) } };
        });
        if (prepared) await discardDiscussionAttachmentCandidate(prepared);
    }
}
