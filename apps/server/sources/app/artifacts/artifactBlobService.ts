import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as privacyKit from 'privacy-kit';
import { ArtifactBlobReferenceV1Schema, decodePlainArtifactStoredContent, type ArtifactBlobStoredContentV1, type ArtifactBlobWriteV1 } from '@happier-dev/protocol';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { deletePrivateFile, readPrivateFile, writePrivateFile } from '@/storage/blob/files';
import { normalizePrivateFileKey } from '@/storage/privateFiles/privateFileKeys';
import { encryptBytes, decryptBytes } from '@/modules/encrypt';
import { readEncryptionFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { readArtifactForCallerInTx } from './artifactAccessService';
import { acquireAccountEncryptionTransitionFenceInTx } from '@/app/encryption/accountEncryptionTransition';

const PlainBlobFileSchema = createStoredReadSchema(z.discriminatedUnion('t', [
    z.object({ t: z.literal('plain'), v: z.string() }).strict(),
    z.object({ t: z.literal('sealed_v1'), c: z.string() }).strict(),
]));
export type ArtifactBlobRow = Readonly<{ id: string; artifactId: string; storageKey: string; encryptionMode: string; storedSizeBytes: bigint }>;
export type PreparedArtifactBlobWrite = Readonly<{
    accountId: string; row: ArtifactBlobRow; bytes: Uint8Array; candidate: boolean;
}>;
const rejectedUploadPrefix = 'artifact-blob-rejected-v1:';
export const artifactBlobConversionUploadPrefix = 'artifact-blob-conversion-v1:';
export const artifactBlobWritingUploadPrefix = 'artifact-blob-writing-v1:';
export const artifactBlobRejectedUploadReuseKey = (artifactId: string) => `${rejectedUploadPrefix}${artifactId}`;

/** UploadedFile is Account-owned physical file custody, including rejected private uploads. */
export function isRejectedArtifactBlobUpload(row: Readonly<{ reuseKey: string | null }>): boolean {
    return row.reuseKey?.startsWith(rejectedUploadPrefix) === true;
}

export function isPendingArtifactBlobUpload(row: Readonly<{ reuseKey: string | null }>): boolean {
    return row.reuseKey?.startsWith(artifactBlobWritingUploadPrefix) === true;
}

export async function hasPendingArtifactBlobUploadInTx(tx: Tx, accountId: string): Promise<boolean> {
    return Boolean(await tx.uploadedFile.findFirst({ where: { accountId,
        reuseKey: { startsWith: artifactBlobWritingUploadPrefix } }, select: { id: true } }));
}

/** Account erasure must retain both rejected and actively staged private-byte custody. */
export function isPrivateArtifactBlobUpload(row: Readonly<{ reuseKey: string | null }>): boolean {
    return isPendingArtifactBlobUpload(row) || isRejectedArtifactBlobUpload(row)
        || row.reuseKey?.startsWith(artifactBlobConversionUploadPrefix) === true;
}
const blobPath = (accountId: string, artifactId: string, blobId: string) => ['storage', 'artifact', accountId, artifactId, 'blob', blobId, 'v1'];
export const artifactBlobCandidateStorageKey = (artifactId: string, blobId: string, uploadId: string) =>
    normalizePrivateFileKey(`artifacts/${artifactId}/${blobId}/${uploadId}`);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function storeBlobBytes(accountId: string, artifactId: string, blobId: string, content: ArtifactBlobStoredContentV1): Uint8Array {
    const bytes = new Uint8Array(privacyKit.decodeBase64(content.t === 'plain' ? content.v : content.c));
    if (content.t === 'encrypted') return bytes;
    const wrapper = readEncryptionFeatureEnv(process.env).plainAccountArtifactsAtRest === 'none'
        ? content : { t: 'sealed_v1', c: privacyKit.encodeBase64(encryptBytes(blobPath(accountId, artifactId, blobId), bytes)) };
    return new TextEncoder().encode(JSON.stringify(wrapper));
}

export async function openArtifactBlobBytes(accountId: string, row: ArtifactBlobRow): Promise<Uint8Array> {
    const stored = await readPrivateFile(row.storageKey);
    if (row.encryptionMode === 'e2ee') return stored;
    if (row.encryptionMode !== 'plain') throw new Error('Artifact blob mode is unavailable');
    const parsed = PlainBlobFileSchema.parse(JSON.parse(new TextDecoder().decode(stored)));
    return parsed.t === 'plain' ? new Uint8Array(privacyKit.decodeBase64(parsed.v))
        : new Uint8Array(decryptBytes(blobPath(accountId, row.artifactId, row.id), privacyKit.decodeBase64(parsed.c)));
}

async function isArtifactUploadAccountActiveInTx(tx: Tx, accountId: string): Promise<boolean> {
    const fence = await acquireAccountEncryptionTransitionFenceInTx(tx, accountId);
    const account = await tx.account.findUnique({ where: { id: accountId }, select: { status: true } });
    return fence.status === 'ready' && account?.status === 'active';
}

/** Unique candidate paths prevent rejected/replayed uploads from overwriting retained bytes. */
export async function prepareArtifactBlobWrite(input: Readonly<{ accountId: string; artifactId: string; blob: ArtifactBlobWriteV1 }>): Promise<PreparedArtifactBlobWrite | null> {
    if (!input.blob.content) {
        const row = await db.artifactBlob.findFirst({ where: { id: input.blob.blobId, artifactId: input.artifactId } });
        return row ? { accountId: input.accountId, row, bytes: await openArtifactBlobBytes(input.accountId, row), candidate: false } : null;
    }
    const storageKey = artifactBlobCandidateStorageKey(input.artifactId, input.blob.blobId, randomUUID());
    const stored = storeBlobBytes(input.accountId, input.artifactId, input.blob.blobId, input.blob.content);
    const prepared: PreparedArtifactBlobWrite = { accountId: input.accountId,
        row: { id: input.blob.blobId, artifactId: input.artifactId, storageKey,
        encryptionMode: input.blob.content.t === 'plain' ? 'plain' : 'e2ee', storedSizeBytes: BigInt(stored.byteLength) },
        bytes: new Uint8Array(privacyKit.decodeBase64(input.blob.content.t === 'plain' ? input.blob.content.v : input.blob.content.c)), candidate: true };
    // Capture every candidate before IO, not just conversion stages. The Account
    // fence orders admission against erasure even when another API replica owns it.
    await inTx(async tx => {
        if (!await isArtifactUploadAccountActiveInTx(tx, input.accountId)) throw new Error('Artifact upload Account is unavailable');
        await tx.uploadedFile.create({ data: { accountId: input.accountId, path: storageKey,
            reuseKey: `${artifactBlobWritingUploadPrefix}${input.artifactId}` } });
    });
    try { await writePrivateFile(storageKey, stored); }
    catch (error) { await discardArtifactBlobCandidate(prepared); throw error; }
    return prepared;
}

/** Settle pending custody atomically with admission, or transfer it to a live conversion stage. */
export async function completeArtifactBlobCandidateCustodyInTx(tx: Tx, prepared: PreparedArtifactBlobWrite, reuseKey?: string): Promise<void> {
    if (!prepared.candidate) return;
    if (!await isArtifactUploadAccountActiveInTx(tx, prepared.accountId)) throw new Error('Artifact upload Account is unavailable');
    const where = { accountId: prepared.accountId, path: prepared.row.storageKey,
        reuseKey: `${artifactBlobWritingUploadPrefix}${prepared.row.artifactId}` };
    const settled = reuseKey === undefined
        ? await tx.uploadedFile.deleteMany({ where })
        : await tx.uploadedFile.updateMany({ where, data: { reuseKey } });
    if (settled.count !== 1) throw new Error('Artifact upload custody is unavailable');
}

export async function admitArtifactBlobWriteInTx(tx: Tx, input: Readonly<{
    artifactId: string; mode: 'plain' | 'e2ee'; body: Uint8Array; blob?: ArtifactBlobWriteV1;
    prepared?: PreparedArtifactBlobWrite; currentBlobId?: string | null;
}>): Promise<boolean> {
    const decoded = input.mode === 'plain' ? decodePlainArtifactStoredContent(privacyKit.encodeBase64(new Uint8Array(input.body))) : null;
    const value = decoded && typeof decoded === 'object' && 'body' in decoded ? decoded.body : null;
    const reference = ArtifactBlobReferenceV1Schema.safeParse(value);
    if (!input.blob) return !reference.success;
    const prepared = input.prepared;
    if (!prepared || prepared.row.id !== input.blob.blobId || prepared.row.encryptionMode !== input.mode) return false;
    if (input.mode === 'plain' && (!reference.success || reference.data.blobId !== input.blob.blobId
        || reference.data.sizeBytes !== prepared.bytes.byteLength || reference.data.sha256 !== sha256(prepared.bytes))) return false;
    const existing = await tx.artifactBlob.findUnique({ where: { id: input.blob.blobId } });
    if (prepared.candidate) {
        return existing === null && await isArtifactUploadAccountActiveInTx(tx, prepared.accountId)
            && Boolean(await tx.uploadedFile.findFirst({ where: { accountId: prepared.accountId, path: prepared.row.storageKey,
                reuseKey: `${artifactBlobWritingUploadPrefix}${prepared.row.artifactId}` } }));
    }
    if (!existing || existing.artifactId !== input.artifactId || existing.storageKey !== prepared.row.storageKey || existing.encryptionMode !== input.mode) return false;
    return input.currentBlobId === existing.id || Boolean(await tx.artifactRevision.findFirst({ where: { artifactId: input.artifactId, blobId: existing.id }, select: { bodyVersion: true } }));
}

export async function readArtifactBlob(input: Readonly<{ actorAccountId: string; artifactId: string; blobId: string }>) {
    const admitted = await inTx(async tx => {
        const read = await readArtifactForCallerInTx(tx, input);
        if (!read.ok) return read;
        const row = await tx.artifactBlob.findFirst({ where: { id: input.blobId, artifactId: input.artifactId } });
        const head = await tx.artifact.findUnique({ where: { id: input.artifactId }, select: { currentBlobId: true } });
        if (!row || (head?.currentBlobId !== row.id && !await tx.artifactRevision.findFirst({ where: { artifactId: input.artifactId, blobId: row.id } }))) {
            return { ok: false as const, error: 'artifact_not_found' as const };
        }
        if (row.encryptionMode !== read.artifact.encryptionMode) return { ok: false as const, error: 'artifact_content_unavailable' as const };
        return { ok: true as const, row, ownerAccountId: read.artifact.ownerAccountId };
    }, { readOnly: true });
    if (!admitted.ok) return admitted;
    // Private IO can be large/remote; authorization captures immutable custody without holding the database lock.
    const bytes = privacyKit.encodeBase64(new Uint8Array(await openArtifactBlobBytes(admitted.ownerAccountId, admitted.row)));
    const content: ArtifactBlobStoredContentV1 = admitted.row.encryptionMode === 'plain' ? { t: 'plain', v: bytes } : { t: 'encrypted', c: bytes };
    return { ok: true as const, value: { blobId: admitted.row.id, content } };
}

export async function discardArtifactBlobCandidate(prepared: PreparedArtifactBlobWrite | undefined): Promise<void> {
    if (!prepared?.candidate) return;
    // Capture before deletion: failed candidates may have no Artifact parent,
    // and a storage outage must not lose the only exact private locator.
    const custody = await db.uploadedFile.upsert({
        where: { accountId_path: { accountId: prepared.accountId, path: prepared.row.storageKey } },
        create: { accountId: prepared.accountId, path: prepared.row.storageKey,
            reuseKey: artifactBlobRejectedUploadReuseKey(prepared.row.artifactId) },
        update: { reuseKey: artifactBlobRejectedUploadReuseKey(prepared.row.artifactId) },
    });
    await deletePrivateFile(custody.path);
    await db.uploadedFile.deleteMany({ where: { id: custody.id, accountId: prepared.accountId, path: custody.path } });
}

/** Retry rejected private deletion at the next upload; Account erasure also consumes this custody. */
export async function cleanupRejectedArtifactBlobUploads(accountId: string): Promise<void> {
    const candidates = await db.uploadedFile.findMany({ where: { accountId, reuseKey: { startsWith: rejectedUploadPrefix } } });
    for (const candidate of candidates) {
        await deletePrivateFile(candidate.path);
        await db.uploadedFile.deleteMany({ where: { id: candidate.id, accountId, path: candidate.path, reuseKey: candidate.reuseKey } });
    }
}

/** Unreferenced rows retain exact cleanup custody until idempotent storage deletion succeeds. */
export async function cleanupArtifactOrphanBlobs(artifactId: string): Promise<void> {
    const obsolete = await inTx(async tx => {
        const head = await tx.artifact.findUnique({ where: { id: artifactId }, select: { currentBlobId: true } });
        const revisions = await tx.artifactRevision.findMany({ where: { artifactId }, select: { blobId: true } });
        const retainedIds = new Set([head?.currentBlobId, ...revisions.map(row => row.blobId)].filter((id): id is string => Boolean(id)));
        return (await tx.artifactBlob.findMany({ where: { artifactId } })).filter(row => !retainedIds.has(row.id));
    });
    for (const row of obsolete) {
        await deletePrivateFile(row.storageKey);
        await inTx(async tx => {
            const head = await tx.artifact.findUnique({ where: { id: artifactId }, select: { currentBlobId: true } });
            if (head?.currentBlobId === row.id || await tx.artifactRevision.findFirst({ where: { artifactId, blobId: row.id } })) {
                throw new Error('Artifact blob cleanup lost its unreferenced precondition');
            }
            await tx.artifactBlob.deleteMany({ where: { id: row.id, artifactId, storageKey: row.storageKey } });
        });
    }
}
