import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { assertPrivateStorageAvailable, deletePrivateFile, writePrivateFile } from '@/storage/blob/files';

// Existing Artifact prefix bytes are retained: they already identify physical
// UploadedFile custody independently of an Artifact's content/encryption mode.
export const artifactBlobWritingUploadPrefix = 'artifact-blob-writing-v1:';
export const artifactBlobRejectedUploadPrefix = 'artifact-blob-rejected-v1:';
export const artifactBlobConversionUploadPrefix = 'artifact-blob-conversion-v1:';
export const discussionAttachmentWritingUploadPrefix = 'discussion-attachment-writing-v1:';
export const discussionAttachmentRejectedUploadPrefix = 'discussion-attachment-rejected-v1:';
export const discussionAttachmentConversionUploadPrefix = 'discussion-attachment-conversion-v1:';
export const publicProfilePictureWritingReuseKey = 'public-profile-picture-writing-v1:';
export const publicProfilePictureRejectedReuseKey = 'public-profile-picture-rejected-v1:';
export const publicProfilePictureAppliedReuseKey = 'public-profile-picture-applied-v1:';

const pendingPrefixes = [artifactBlobWritingUploadPrefix, discussionAttachmentWritingUploadPrefix, publicProfilePictureWritingReuseKey];
const privatePrefixes = [...pendingPrefixes, artifactBlobRejectedUploadPrefix, artifactBlobConversionUploadPrefix,
    discussionAttachmentRejectedUploadPrefix, discussionAttachmentConversionUploadPrefix,
    publicProfilePictureRejectedReuseKey, publicProfilePictureAppliedReuseKey];

/** Physical erasure routing has one owner; domain envelopes never choose a file backend. */
export function isAccountPrivateFileUpload(row: Readonly<{ reuseKey: string | null }>): boolean {
    const reuseKey = row.reuseKey;
    return reuseKey !== null && privatePrefixes.some(prefix => reuseKey.startsWith(prefix));
}

/** A durable writing locator orders external IO against Account erasure across API replicas. */
export async function hasPendingAccountPrivateFileUploadInTx(tx: Tx, accountId: string): Promise<boolean> {
    return Boolean(await tx.uploadedFile.findFirst({ where: { accountId,
        OR: pendingPrefixes.map(prefix => ({ reuseKey: { startsWith: prefix } })),
    }, select: { id: true } }));
}

export async function isAccountPrivateFileUploadActiveInTx(tx: Tx, accountId: string): Promise<boolean> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId, 'content');
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { status: true } });
    return fence.status === 'ready' && account?.status === 'active';
}

/** Capture the exact private locator before IO, under the existing Account fence. */
export async function captureAccountPrivateFileUploadInTx(tx: Tx, input: Readonly<{
    accountId: string; path: string; reuseKey: string;
    metadata?: Readonly<{ width: number; height: number; thumbhash: string; storedSizeBytes?: bigint }>;
}>): Promise<Readonly<{ id: string }> | null> {
    if (!await isAccountPrivateFileUploadActiveInTx(tx, input.accountId)) return null;
    return await tx.uploadedFile.create({ data: { accountId: input.accountId, path: input.path,
        reuseKey: input.reuseKey, ...input.metadata }, select: { id: true } });
}

/** Domain owners settle writing custody atomically with their own authoritative binding. */
export async function settleAccountPrivateFileUploadInTx(tx: Tx, input: Readonly<{
    accountId: string; file: Readonly<{ path: string }> | Readonly<{ id: string }>;
    writingReuseKey: string; reuseKey?: string;
}>): Promise<'settled' | 'account_unavailable' | 'custody_unavailable'> {
    if (!await isAccountPrivateFileUploadActiveInTx(tx, input.accountId)) return 'account_unavailable';
    const where = { accountId: input.accountId, ...input.file, reuseKey: input.writingReuseKey };
    const settled = input.reuseKey === undefined
        ? await tx.uploadedFile.deleteMany({ where })
        : await tx.uploadedFile.updateMany({ where, data: { reuseKey: input.reuseKey } });
    return settled.count === 1 ? 'settled' : 'custody_unavailable';
}

/** Failed physical deletion leaves its exact Account-owned locator available for retry. */
export async function deleteAccountPrivateFileUpload(input: Readonly<{
    accountId: string; id: string; path: string; reuseKey?: string | null;
}>): Promise<void> {
    await deletePrivateFile(input.path);
    await db.uploadedFile.deleteMany({ where: input });
}

/** Retain an exact rejected candidate locator before attempting private deletion. */
export async function discardAccountPrivateFileCandidate(input: Readonly<{
    accountId: string; path: string; rejectedReuseKey: string;
}>): Promise<void> {
    const custody = await db.uploadedFile.upsert({
        where: { accountId_path: { accountId: input.accountId, path: input.path } },
        create: { accountId: input.accountId, path: input.path, reuseKey: input.rejectedReuseKey },
        update: { reuseKey: input.rejectedReuseKey },
    });
    await deleteAccountPrivateFileUpload({ id: custody.id, accountId: input.accountId, path: custody.path });
}

/** Capture before external IO; a failed write retains exact private cleanup custody. */
export async function writeAccountPrivateFileCandidate(input: Readonly<{
    accountId: string; path: string; writingReuseKey: string; rejectedReuseKey: string; bytes: Uint8Array;
}>): Promise<void> {
    assertPrivateStorageAvailable();
    const captured = await inTx(tx => captureAccountPrivateFileUploadInTx(tx, {
        accountId: input.accountId, path: input.path, reuseKey: input.writingReuseKey,
    }));
    if (!captured) throw new Error('Private upload Account is unavailable');
    try { await writePrivateFile(input.path, input.bytes); }
    catch (error) { await discardAccountPrivateFileCandidate(input); throw error; }
}
