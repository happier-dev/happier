import { createHash, randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import type { BinaryBlobStoredContentV1, BinaryBlobReferenceV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import type { DiscussionAttachmentReadInputV1, DiscussionAttachmentReadResponseV1 } from '@happier-dev/protocol/discussions/attachments';
import type { DiscussionPostRequestV1 } from '@happier-dev/protocol/discussions/api';
import { db } from '@/storage/db';
import type { Tx } from '@/storage/inTx';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';
import { normalizePrivateFileKey } from '@/storage/privateFiles/privateFileKeys';
import { storePrivateBinaryContent, openPrivateBinaryContent } from '@/storage/privateFiles/privateBinaryContent';
import { writeAccountPrivateFileCandidate, settleAccountPrivateFileUploadInTx, discardAccountPrivateFileCandidate,
    deleteAccountPrivateFileUpload, discussionAttachmentWritingUploadPrefix, discussionAttachmentRejectedUploadPrefix } from '@/storage/privateFiles/accountPrivateFileCustody';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { readDiscussionMessageWithContextInTx } from './queries';
import { discussionFailure, discussionSuccess, type DiscussionResult } from './serviceTypes';

export type DiscussionAttachmentRow = Readonly<{
    blobId: string; messageId: string; storageKey: string; encryptionMode: string; storedSizeBytes: bigint;
}>;
export type PreparedDiscussionAttachmentWrite = Readonly<{
    accountId: string; row: Omit<DiscussionAttachmentRow, 'messageId'>;
    sizeBytes: number; contentSha256: string;
}>;
const binaryPath = (blobId: string) => ['storage', 'discussion-attachment', blobId, 'v1'];
export const discussionAttachmentCandidateStorageKey = (blobId: string, uploadId: string) =>
    normalizePrivateFileKey(`discussions/${blobId}/${uploadId}`);
export const discussionAttachmentRejectedUploadReuseKey = (blobId: string) => `${discussionAttachmentRejectedUploadPrefix}${blobId}`;

export async function openDiscussionAttachmentBytes(row: Pick<DiscussionAttachmentRow, 'blobId' | 'storageKey' | 'encryptionMode'>): Promise<Uint8Array> {
    return openPrivateBinaryContent(binaryPath(row.blobId), row);
}

/** A unique, Account-captured candidate cannot overwrite any committed message's bytes. */
export async function prepareDiscussionAttachmentWrite(input: Readonly<{
    accountId: string; blobId: string; content: BinaryBlobStoredContentV1;
}>): Promise<PreparedDiscussionAttachmentWrite> {
    const storageKey = discussionAttachmentCandidateStorageKey(input.blobId, randomUUID());
    const stored = storePrivateBinaryContent(binaryPath(input.blobId), input.content);
    const bytes = new Uint8Array(privacyKit.decodeBase64(input.content.t === 'plain' ? input.content.v : input.content.c));
    const prepared: PreparedDiscussionAttachmentWrite = { accountId: input.accountId,
        row: { blobId: input.blobId, storageKey, encryptionMode: input.content.t === 'plain' ? 'plain' : 'e2ee',
            storedSizeBytes: BigInt(stored.byteLength) },
        sizeBytes: bytes.byteLength, contentSha256: createHash('sha256').update(bytes).digest('hex') };
    await writeAccountPrivateFileCandidate({ accountId: input.accountId, path: storageKey, bytes: stored,
        writingReuseKey: `${discussionAttachmentWritingUploadPrefix}${input.blobId}`,
        rejectedReuseKey: discussionAttachmentRejectedUploadReuseKey(input.blobId) });
    return prepared;
}

export async function completeDiscussionAttachmentCandidateCustodyInTx(tx: Tx, prepared: Pick<PreparedDiscussionAttachmentWrite, 'accountId' | 'row'>, reuseKey?: string): Promise<void> {
    const settled = await settleAccountPrivateFileUploadInTx(tx, { accountId: prepared.accountId, file: { path: prepared.row.storageKey },
        writingReuseKey: `${discussionAttachmentWritingUploadPrefix}${prepared.row.blobId}`, ...(reuseKey === undefined ? {} : { reuseKey }) });
    if (settled !== 'settled') throw new Error('Discussion upload custody is unavailable');
}

export async function discardDiscussionAttachmentCandidate(prepared: Pick<PreparedDiscussionAttachmentWrite, 'accountId' | 'row'> | undefined): Promise<void> {
    if (!prepared) return;
    // A response-loss retry may retain candidates after the original committed.
    // Only the exact committed locator protects bytes; a shared blob id does not.
    if (await db.discussionAttachment.findFirst({ where: { storageKey: prepared.row.storageKey }, select: { blobId: true } })) return;
    await discardAccountPrivateFileCandidate({ accountId: prepared.accountId, path: prepared.row.storageKey,
        rejectedReuseKey: discussionAttachmentRejectedUploadReuseKey(prepared.row.blobId) });
}

export async function cleanupRejectedDiscussionAttachmentUploads(accountId: string): Promise<void> {
    const candidates = await db.uploadedFile.findMany({ where: { accountId, reuseKey: { startsWith: discussionAttachmentRejectedUploadPrefix } } });
    for (const candidate of candidates) await deleteAccountPrivateFileUpload({ id: candidate.id, accountId,
        path: candidate.path, reuseKey: candidate.reuseKey });
}

/** The message writer owns admission and calls this before allocating any sequence. */
export async function admitDiscussionAttachmentsInTx(tx: Tx, input: Readonly<{
    ownerAccountId: string; mode: 'plain' | 'e2ee'; request: DiscussionPostRequestV1;
    plainReferences: readonly BinaryBlobReferenceV1[] | null;
    prepared?: readonly PreparedDiscussionAttachmentWrite[]; existingMessageId?: string;
}>): Promise<boolean> {
    const bindings = input.request.attachments ?? [];
    const bindingIds = new Set(bindings.map(binding => binding.blobId));
    const expectedKind = input.mode === 'plain' ? 'plain' : 'encrypted';
    if (bindings.some(binding => binding.t !== expectedKind)) return false;
    if (input.existingMessageId) {
        const retained = await tx.discussionAttachment.findMany({ where: { messageId: input.existingMessageId },
            select: { blobId: true, encryptionMode: true } });
        return retained.length === bindings.length && retained.every(row => row.encryptionMode === input.mode && bindingIds.has(row.blobId));
    }
    const prepared = input.prepared ?? [];
    const byBlobId = new Map(prepared.map(item => [item.row.blobId, item]));
    if (prepared.length !== bindings.length || byBlobId.size !== prepared.length) return false;
    if (input.plainReferences !== null) {
        const references = input.plainReferences;
        if (new Set(references.map(reference => reference.blobId)).size !== bindings.length) return false;
        for (const reference of references) {
            const candidate = byBlobId.get(reference.blobId);
            if (!candidate || reference.sizeBytes !== candidate.sizeBytes || reference.sha256 !== candidate.contentSha256) return false;
        }
    }
    for (const binding of bindings) {
        const candidate = byBlobId.get(binding.blobId);
        if (!candidate || candidate.accountId !== input.ownerAccountId || candidate.row.encryptionMode !== input.mode
            || await tx.discussionAttachment.findUnique({ where: { blobId: binding.blobId }, select: { blobId: true } })
            || !await tx.uploadedFile.findFirst({ where: { accountId: candidate.accountId, path: candidate.row.storageKey,
                reuseKey: `${discussionAttachmentWritingUploadPrefix}${binding.blobId}` }, select: { id: true } })) return false;
    }
    return true;
}

/** Bind and settle custody in the existing post/create transaction, never in a second writer. */
export async function bindDiscussionAttachmentsInTx(tx: Tx, messageId: string, prepared: readonly PreparedDiscussionAttachmentWrite[] = []): Promise<void> {
    for (const candidate of prepared) {
        await tx.discussionAttachment.create({ data: { ...candidate.row, messageId } });
        await completeDiscussionAttachmentCandidateCustodyInTx(tx, candidate);
    }
}

type Reader = DiscussionAttachmentReadInputV1 & Readonly<{ actorAccountId: string; authentication: SessionAccessAuthentication }>;
async function captureAttachmentInTx(tx: Tx, input: Reader) {
    const read = await readDiscussionMessageWithContextInTx(tx, input);
    if (!read.ok) return read;
    const { message, context } = read.value;
    if (!message || input.throughSeq !== undefined && message.seq > input.throughSeq) return discussionFailure('discussion_not_found');
    if (!context.keyReadiness) return discussionFailure('discussion_content_unavailable');
    const row = await tx.discussionAttachment.findFirst({ where: { blobId: input.blobId, messageId: input.messageId,
        message: { discussionId: input.discussionId } } });
    if (!row) return discussionFailure('discussion_not_found');
    if (row.encryptionMode !== context.storageMode) return discussionFailure('discussion_encryption_mode_mismatch');
    return discussionSuccess({ row, mode: context.storageMode, dataEncryptionKey: context.dataEncryptionKey, ownerAccountId: context.ownerAccountId });
}

/** Capture authorized message, mode, key and immutable locator before slow private IO. */
export async function readDiscussionAttachment(input: Reader): Promise<DiscussionResult<DiscussionAttachmentReadResponseV1>> {
    const result = await captureReadSnapshot({ capture: tx => captureAttachmentInTx(tx, input), materialize: async captured => {
        if (!captured.ok) return captured;
        try {
            const bytes = privacyKit.encodeBase64(new Uint8Array(await openDiscussionAttachmentBytes(captured.value.row)));
            const content: BinaryBlobStoredContentV1 = captured.value.mode === 'plain' ? { t: 'plain', v: bytes } : { t: 'encrypted', c: bytes };
            return discussionSuccess({ ...captured.value, content });
        } catch { return discussionFailure('discussion_content_unavailable'); }
    } });
    return result.ok ? discussionSuccess({ blobId: input.blobId, content: result.value.content }) : result;
}
