import { createHash } from 'node:crypto';
import type { AccountEncryptionMigrateArtifactsDirective, ArtifactBlobStoredContentV1, ArtifactBlobAccountEncryptionStageV1 } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { artifactBlobCandidateStorageKey, artifactBlobConversionUploadPrefix, artifactBlobRejectedUploadReuseKey, completeArtifactBlobCandidateCustodyInTx, openArtifactBlobBytes, prepareArtifactBlobWrite, discardArtifactBlobCandidate, type ArtifactBlobRow, type PreparedArtifactBlobWrite } from './artifactBlobService';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';

const stagePrefix = artifactBlobConversionUploadPrefix;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const artifactConversionBlobKey = artifactBlobCandidateStorageKey;
export const artifactConversionBlobCustody = (row: ArtifactBlobRow) => `${stagePrefix}${row.artifactId}:${row.id}:${row.encryptionMode}:${row.storedSizeBytes}`;
export type PreparedArtifactAccountEncryptionConversionBlob = Readonly<{
    source: ArtifactBlobRow;
    expectedContentSha256: string;
    target: Readonly<Omit<PreparedArtifactBlobWrite, 'bytes'> & {
        contentSha256: string;
        sizeBytes: number;
    }>;
}>;
export type PreparedArtifactAccountEncryptionConversionBlobs = ReadonlyMap<string, PreparedArtifactAccountEncryptionConversionBlob>;

/** Upload custody is not a mode change. Only the signed Account transaction activates these bytes. */
export async function stageArtifactBlobAccountEncryptionConversion(input: Readonly<{
    accountId: string; artifactId: string; blobId: string; content: ArtifactBlobStoredContentV1;
}>): Promise<ArtifactBlobAccountEncryptionStageV1> {
    const source = await db.artifactBlob.findFirst({ where: { id: input.blobId, artifactId: input.artifactId,
        artifact: { accountId: input.accountId } }, include: { artifact: { select: { currentBlobId: true,
            account: { select: { encryptionMode: true } }, revisions: { select: { blobId: true } } } } } });
    const targetMode = input.content.t === 'plain' ? 'plain' : 'e2ee';
    if (!source || source.encryptionMode !== source.artifact.account.encryptionMode || source.encryptionMode === targetMode
        || (source.artifact.currentBlobId !== source.id && !source.artifact.revisions.some(row => row.blobId === source.id))) {
        throw new Error('Artifact conversion source is unavailable');
    }
    const candidate = await prepareArtifactBlobWrite({ ...input, blob: { blobId: input.blobId, content: input.content } });
    if (!candidate) throw new Error('Artifact conversion staging failed');
    try {
        await inTx(async tx => {
            const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
            if (fence.status !== 'ready' || fence.account.currentness.encryptionMode !== source.encryptionMode) {
                throw new Error('Artifact conversion Account changed');
            }
            await completeArtifactBlobCandidateCustodyInTx(tx, candidate, artifactConversionBlobCustody(candidate.row));
        });
    } catch (error) { await discardArtifactBlobCandidate(candidate); throw error; }
    return { t: input.content.t, uploadId: candidate.row.storageKey.split('/').at(-1)!, contentSha256: digest(candidate.bytes) };
}

/** IO happens one blob pair at a time before the Account transaction. Only validated digests and lengths are retained; the transaction rechecks exact source and stage custody. */
export async function prepareArtifactAccountEncryptionConversionBlobs(input: Readonly<{
    accountId: string; directive: AccountEncryptionMigrateArtifactsDirective;
}>): Promise<PreparedArtifactAccountEncryptionConversionBlobs> {
    const result = new Map<string, PreparedArtifactAccountEncryptionConversionBlob>();
    if (input.directive.action !== 'migrate') return result;
    for (const item of input.directive.items) for (const blob of item.blobs) {
        const source = await db.artifactBlob.findFirst({ where: { id: blob.blobId, artifactId: item.artifactId,
            artifact: { accountId: input.accountId } } });
        if (!source) continue; // The signed transaction reports the incomplete inventory without mutating it.
        const storageKey = artifactConversionBlobKey(item.artifactId, blob.blobId, blob.content.uploadId);
        if (source.storageKey === storageKey) {
            const bytes = await openArtifactBlobBytes(input.accountId, source);
            const contentSha256 = digest(bytes);
            if (contentSha256 === blob.content.contentSha256) result.set(`${item.artifactId}/${blob.blobId}`, {
                source, expectedContentSha256: blob.expectedContentSha256,
                target: { accountId: input.accountId, row: source, contentSha256, sizeBytes: bytes.byteLength, candidate: false },
            });
            continue; // The signed post-state owner additionally checks versions, mode and every retained reference.
        }
        const custody = await db.uploadedFile.findFirst({ where: { accountId: input.accountId, path: storageKey,
            reuseKey: { startsWith: `${stagePrefix}${item.artifactId}:${blob.blobId}:` } } });
        if (!custody) continue;
        const parts = custody.reuseKey!.split(':');
        const encryptionMode = parts[3];
        if (encryptionMode !== (blob.content.t === 'plain' ? 'plain' : 'e2ee') || !/^\d+$/.test(parts[4] ?? '')) continue;
        const row: ArtifactBlobRow = { id: blob.blobId, artifactId: item.artifactId, storageKey,
            encryptionMode, storedSizeBytes: BigInt(parts[4]!) };
        const [sourceBytes, targetBytes] = await Promise.all([openArtifactBlobBytes(input.accountId, source), openArtifactBlobBytes(input.accountId, row)]);
        const contentSha256 = digest(targetBytes);
        if (digest(sourceBytes) !== blob.expectedContentSha256 || contentSha256 !== blob.content.contentSha256) continue;
        result.set(`${item.artifactId}/${blob.blobId}`, { source, expectedContentSha256: blob.expectedContentSha256,
            target: { accountId: input.accountId, row, contentSha256, sizeBytes: targetBytes.byteLength, candidate: true } });
    }
    return result;
}

export async function cancelArtifactBlobAccountEncryptionConversion(input: Readonly<{ accountId: string; uploadId: string }>): Promise<void> {
    const candidates = await db.uploadedFile.findMany({ where: { accountId: input.accountId, path: { endsWith: `/${input.uploadId}` },
        reuseKey: { startsWith: stagePrefix } } });
    for (const candidate of candidates) {
        const parts = candidate.reuseKey!.split(':');
        const artifactId = parts[1]!;
        const blobId = parts[2]!;
        if (candidate.path !== artifactConversionBlobKey(artifactId, blobId, input.uploadId)) continue;
        // Acquire the same parent mutation fence as activation, so cancellation cannot delete an activated target.
        const prepared = await inTx(async tx => {
            const account = await acquireAccountEncryptionTransitionFenceInTx(tx, input.accountId);
            if (account.status === 'account_not_found') return null;
            // If the parent was deleted, activation is impossible; exact Account-owned stage custody remains cancellable.
            await tx.artifact.updateMany({ where: { id: artifactId, accountId: input.accountId }, data: { id: artifactId } });
            const current = await tx.uploadedFile.findFirst({ where: { id: candidate.id, accountId: input.accountId, path: candidate.path, reuseKey: candidate.reuseKey } });
            if (!current) return null;
            await tx.uploadedFile.update({ where: { id: current.id }, data: { reuseKey: artifactBlobRejectedUploadReuseKey(artifactId) } });
            return { accountId: input.accountId, row: { id: blobId, artifactId, storageKey: candidate.path,
                encryptionMode: parts[3]!, storedSizeBytes: BigInt(parts[4]!) }, bytes: new Uint8Array(), candidate: true };
        });
        if (prepared) await discardArtifactBlobCandidate(prepared);
    }
}
