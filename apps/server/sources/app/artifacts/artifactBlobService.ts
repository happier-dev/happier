import { createHash, randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ArtifactBlobReferenceV1Schema, type ArtifactBlobStoredContentV1, type ArtifactBlobWriteV1 } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { db } from '@/storage/db';
import type { PrivateFileWrite } from '@/storage/privateFiles/privateFiles';
import { inTx, type Tx } from '@/storage/inTx';
import { captureReadSnapshot } from '@/storage/captureReadSnapshot';
import { deletePrivateFile } from '@/storage/blob/files';
import { normalizePrivateFileKey } from '@/storage/privateFiles/privateFileKeys';
import { preparePrivateBinaryContent, openPrivateBinaryContent, type PrivateBinaryContentInput } from '@/storage/privateFiles/privateBinaryContent';
import { readArtifactForCallerInTx } from './artifactAccessService';
import { artifactBlobRejectedUploadPrefix, artifactBlobWritingUploadPrefix,
    writeAccountPrivateFileCandidate, settleAccountPrivateFileUploadInTx,
    isAccountPrivateFileUploadActiveInTx, deleteAccountPrivateFileUpload, discardAccountPrivateFileCandidate } from '@/storage/privateFiles/accountPrivateFileCustody';
import { log } from '@/utils/logging/log';

export { artifactBlobConversionUploadPrefix, artifactBlobWritingUploadPrefix } from '@/storage/privateFiles/accountPrivateFileCustody';

export type ArtifactBlobRow = Readonly<{ id: string; artifactId: string; storageKey: string; encryptionMode: string; storedSizeBytes: bigint }>;
export type PreparedArtifactBlobWrite = Readonly<{
    accountId: string; row: ArtifactBlobRow; sizeBytes: number; contentSha256: string; candidate: boolean;
}>;
export type ArtifactBlobWriteInput = Omit<ArtifactBlobWriteV1, 'content'> & Readonly<{ content?: PrivateBinaryContentInput }>;
const rejectedUploadPrefix = artifactBlobRejectedUploadPrefix;
export const artifactBlobRejectedUploadReuseKey = (artifactId: string) => `${rejectedUploadPrefix}${artifactId}`;

const blobPath = (accountId: string, artifactId: string, blobId: string) => ['storage', 'artifact', accountId, artifactId, 'blob', blobId, 'v1'];
export const artifactBlobCandidateStorageKey = (artifactId: string, blobId: string, uploadId: string) =>
    normalizePrivateFileKey(`artifacts/${artifactId}/${blobId}/${uploadId}`);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function openArtifactBlobBytes(accountId: string, row: ArtifactBlobRow): Promise<Uint8Array> {
    return openPrivateBinaryContent(blobPath(accountId, row.artifactId, row.id), row);
}

type ArtifactBlobCandidate = Readonly<{ prepared: PreparedArtifactBlobWrite; stored: PrivateFileWrite }>;

/** Encode once so quota admission can use the stored size before private IO. */
export function prepareArtifactBlobCandidate(input: Readonly<{
    accountId: string; artifactId: string; blobId: string; content: PrivateBinaryContentInput;
}>): ArtifactBlobCandidate {
    const storageKey = artifactBlobCandidateStorageKey(input.artifactId, input.blobId, randomUUID());
    const { stored, sizeBytes, contentSha256 } = preparePrivateBinaryContent(blobPath(input.accountId, input.artifactId, input.blobId), input.content);
    const prepared: PreparedArtifactBlobWrite = { accountId: input.accountId,
        row: { id: input.blobId, artifactId: input.artifactId, storageKey,
        encryptionMode: input.content.t === 'plain' ? 'plain' : 'e2ee', storedSizeBytes: BigInt(stored.byteLength) },
        sizeBytes, contentSha256, candidate: true };
    return { prepared, stored };
}

/** Unique candidate paths prevent rejected/replayed uploads from overwriting retained bytes. */
export async function storeArtifactBlobCandidate({ prepared, stored }: ArtifactBlobCandidate): Promise<PreparedArtifactBlobWrite> {
    const { accountId, row } = prepared;
    // Capture every candidate before IO, not just conversion stages. The Account
    // fence orders admission against erasure even when another API replica owns it.
    await writeAccountPrivateFileCandidate({ accountId, path: row.storageKey, bytes: stored,
        writingReuseKey: `${artifactBlobWritingUploadPrefix}${row.artifactId}`,
        rejectedReuseKey: artifactBlobRejectedUploadReuseKey(row.artifactId) });
    return prepared;
}

export async function prepareArtifactBlobWrite(input: Readonly<{ accountId: string; artifactId: string; blob: ArtifactBlobWriteInput }>): Promise<PreparedArtifactBlobWrite | null> {
    if (input.blob.content) {
        return storeArtifactBlobCandidate(prepareArtifactBlobCandidate({ ...input, blobId: input.blob.blobId, content: input.blob.content }));
    }
    const row = await db.artifactBlob.findFirst({ where: { id: input.blob.blobId, artifactId: input.artifactId } });
    if (!row) return null;
    const bytes = await openArtifactBlobBytes(input.accountId, row);
    return { accountId: input.accountId, row, sizeBytes: bytes.byteLength, contentSha256: sha256(bytes), candidate: false };
}

/** Settle pending custody atomically with admission, or transfer it to a live conversion stage. */
export async function completeArtifactBlobCandidateCustodyInTx(tx: Tx, prepared: PreparedArtifactBlobWrite, reuseKey?: string): Promise<void> {
    if (!prepared.candidate) return;
    const settled = await settleAccountPrivateFileUploadInTx(tx, { accountId: prepared.accountId,
        file: { path: prepared.row.storageKey }, writingReuseKey: `${artifactBlobWritingUploadPrefix}${prepared.row.artifactId}`,
        ...(reuseKey === undefined ? {} : { reuseKey }) });
    if (settled === 'account_unavailable') throw new Error('Artifact upload Account is unavailable');
    if (settled !== 'settled') throw new Error('Artifact upload custody is unavailable');
}

export async function admitArtifactBlobWriteInTx(tx: Tx, input: Readonly<{
    artifactId: string; mode: 'plain' | 'e2ee'; body: Uint8Array; blob?: ArtifactBlobWriteInput;
    prepared?: PreparedArtifactBlobWrite; currentBlobId?: string | null;
}>): Promise<boolean> {
    const decoded = input.mode === 'plain' ? decodePlainArtifactStoredContent(privacyKit.encodeBase64(new Uint8Array(input.body))) : null;
    const value = decoded && typeof decoded === 'object' && 'body' in decoded ? decoded.body : null;
    const reference = ArtifactBlobReferenceV1Schema.safeParse(value);
    if (!input.blob) return !reference.success;
    const prepared = input.prepared;
    if (!prepared || prepared.row.id !== input.blob.blobId || prepared.row.encryptionMode !== input.mode) return false;
    if (input.mode === 'plain' && (!reference.success || reference.data.blobId !== input.blob.blobId
        || reference.data.sizeBytes !== prepared.sizeBytes || reference.data.sha256 !== prepared.contentSha256)) return false;
    const existing = await tx.artifactBlob.findUnique({ where: { id: input.blob.blobId } });
    if (prepared.candidate) {
        return existing === null && await isAccountPrivateFileUploadActiveInTx(tx, prepared.accountId)
            && Boolean(await tx.uploadedFile.findFirst({ where: { accountId: prepared.accountId, path: prepared.row.storageKey,
                reuseKey: `${artifactBlobWritingUploadPrefix}${prepared.row.artifactId}` } }));
    }
    if (!existing || existing.artifactId !== input.artifactId || existing.storageKey !== prepared.row.storageKey || existing.encryptionMode !== input.mode) return false;
    return input.currentBlobId === existing.id || Boolean(await tx.artifactRevision.findFirst({ where: { artifactId: input.artifactId, blobId: existing.id }, select: { bodyVersion: true } }));
}

export async function readArtifactBlob(input: Readonly<{ actorAccountId: string; artifactId: string; blobId: string }>) {
    const admitted = await captureReadSnapshot({ capture: async tx => {
        const read = await readArtifactForCallerInTx(tx, input);
        if (!read.ok) return read;
        const row = await tx.artifactBlob.findFirst({ where: { id: input.blobId, artifactId: input.artifactId } });
        const head = await tx.artifact.findUnique({ where: { id: input.artifactId }, select: { currentBlobId: true } });
        if (!row || (head?.currentBlobId !== row.id && !await tx.artifactRevision.findFirst({ where: { artifactId: input.artifactId, blobId: row.id } }))) {
            return { ok: false as const, error: 'artifact_not_found' as const };
        }
        if (row.encryptionMode !== read.artifact.encryptionMode) return { ok: false as const, error: 'artifact_content_unavailable' as const };
        return { ok: true as const, row, ownerAccountId: read.artifact.ownerAccountId };
    }, materialize: async captured => {
        if (!captured.ok) return captured;
        // Private IO may be large/remote and must finish outside the database lock.
        const bytes = privacyKit.encodeBase64(new Uint8Array(await openArtifactBlobBytes(captured.ownerAccountId, captured.row)));
        const content: ArtifactBlobStoredContentV1 = captured.row.encryptionMode === 'plain' ? { t: 'plain', v: bytes } : { t: 'encrypted', c: bytes };
        return { ...captured, value: { blobId: captured.row.id, content } };
    } });
    if (!admitted.ok) return admitted;
    return { ok: true as const, value: admitted.value };
}

export async function discardArtifactBlobCandidate(prepared: PreparedArtifactBlobWrite | undefined): Promise<void> {
    if (!prepared?.candidate) return;
    // Capture before deletion: failed candidates may have no Artifact parent,
    // and a storage outage must not lose the only exact private locator.
    await discardAccountPrivateFileCandidate({ accountId: prepared.accountId, path: prepared.row.storageKey,
        rejectedReuseKey: artifactBlobRejectedUploadReuseKey(prepared.row.artifactId) });
}

/** Retry rejected private deletion at the next upload; Account erasure also consumes this custody. */
export async function cleanupRejectedArtifactBlobUploads(accountId: string): Promise<void> {
    const candidates = await db.uploadedFile.findMany({ where: { accountId, reuseKey: { startsWith: rejectedUploadPrefix } } });
    for (const candidate of candidates) {
        await deleteAccountPrivateFileUpload({ id: candidate.id, accountId, path: candidate.path, reuseKey: candidate.reuseKey });
    }
}

/** Unreferenced rows retain exact cleanup custody until idempotent storage deletion succeeds. */
export async function cleanupArtifactOrphanBlobs(artifactId: string): Promise<bigint> {
    const obsolete = await inTx(async tx => {
        const head = await tx.artifact.findUnique({ where: { id: artifactId }, select: { currentBlobId: true } });
        const revisions = await tx.artifactRevision.findMany({ where: { artifactId }, select: { blobId: true } });
        const retainedIds = new Set([head?.currentBlobId, ...revisions.map(row => row.blobId)].filter((id): id is string => Boolean(id)));
        return (await tx.artifactBlob.findMany({ where: { artifactId } })).filter(row => !retainedIds.has(row.id));
    }, { /* Head, retained revisions and orphan blobs must share one snapshot before private-file deletion. */ isolationLevel: "Serializable", readOnly: true });
    let freedBytes = 0n;
    for (const row of obsolete) {
        await deletePrivateFile(row.storageKey);
        const removed = await inTx(async tx => {
            const head = await tx.artifact.findUnique({ where: { id: artifactId }, select: { currentBlobId: true } });
            if (head?.currentBlobId === row.id || await tx.artifactRevision.findFirst({ where: { artifactId, blobId: row.id } })) {
                throw new Error('Artifact blob cleanup lost its unreferenced precondition');
            }
            return tx.artifactBlob.deleteMany({ where: { id: row.id, artifactId, storageKey: row.storageKey } });
        });
        if (removed.count === 1) freedBytes += row.storedSizeBytes;
    }
    return freedBytes;
}

/** A committed update keeps its receipt while blob rows retain cleanup custody. */
export async function cleanupArtifactOrphanBlobsAfterCommit(artifactId: string): Promise<void> {
    try {
        await cleanupArtifactOrphanBlobs(artifactId);
    } catch {
        // The next operation or Account erasure can resume cleanup from the retained rows.
        log({ module: 'api', level: 'warn', artifactId }, 'Artifact update committed but orphan blob cleanup failed');
    }
}
