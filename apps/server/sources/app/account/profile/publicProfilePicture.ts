import { randomUUID } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ATMOSPHERE_PICTURE_MAX_EDGE } from '@happier-dev/brand/atmosphere';
import { PublicProfilePreparedAtmosphereV1Schema, type PublicProfileAtmosphereV1,
    type PublicProfilePreparedAtmosphereV1 } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { readPrivateFile, writePrivateFile } from '@/storage/blob/files';
import { tryProcessImage } from '@/storage/blob/processImage';
import { normalizePrivateFileKey } from '@/storage/privateFiles/privateFileKeys';
import { log } from '@/utils/logging/log';
import { captureAccountPrivateFileUploadInTx, settleAccountPrivateFileUploadInTx, deleteAccountPrivateFileUpload,
    publicProfilePictureWritingReuseKey, publicProfilePictureRejectedReuseKey,
    publicProfilePictureAppliedReuseKey } from '@/storage/privateFiles/accountPrivateFileCustody';

export interface PreparedPublicProfilePicture {
    readonly accountId: string;
    readonly atmosphere: PublicProfileAtmosphereV1;
    readonly uploadId: string | null;
}

/** Normalize the reviewed copy and capture private-file custody before any external write. */
export async function preparePublicProfilePicture(input: Readonly<{ accountId: string; atmosphere: PublicProfilePreparedAtmosphereV1 }>): Promise<
    { ok: true; prepared: PreparedPublicProfilePicture } | { ok: false; reason: 'invalid_picture' | 'account_unavailable' | 'storage_unavailable' }
> {
    const parsed = PublicProfilePreparedAtmosphereV1Schema.safeParse(input.atmosphere);
    if (!parsed.success) return { ok: false, reason: 'invalid_picture' };
    const atmosphere = parsed.data;
    if (atmosphere.source !== 'picture') {
        return { ok: true, prepared: { accountId: input.accountId, atmosphere, uploadId: null } };
    }
    const { content, ...picture } = atmosphere.picture;
    const processed = await tryProcessImage(Buffer.from(privacyKit.decodeBase64(content.base64)), {
        allowedSourceMimeTypes: ['image/png', 'image/webp'], expectedSourceMimeType: content.mimeType,
        outputFormat: 'png', maxEdge: ATMOSPHERE_PICTURE_MAX_EDGE,
    });
    if (!processed.ok) return { ok: false, reason: 'invalid_picture' };
    const path = normalizePrivateFileKey(`public-profile/${input.accountId}/${randomUUID()}.png`);
    const custody = await inTx(tx => captureAccountPrivateFileUploadInTx(tx, {
        accountId: input.accountId, path, reuseKey: publicProfilePictureWritingReuseKey,
        metadata: { width: processed.image.width, height: processed.image.height, thumbhash: processed.image.thumbhash,
            storedSizeBytes: BigInt(processed.image.bytes.byteLength) },
    }));
    if (!custody) return { ok: false, reason: 'account_unavailable' };
    const prepared: PreparedPublicProfilePicture = { accountId: input.accountId, uploadId: custody.id,
        atmosphere: { source: 'picture', picture: { ...picture, ref: { kind: 'publication', id: custody.id } } } };
    try {
        // The reviewed copy is deliberate public plaintext in either Account
        // mode. Private physical custody provides revocable access, not E2EE.
        await writePrivateFile(path, processed.image.bytes);
    } catch {
        // A failed acknowledgement may still have written bytes. Retain the
        // rejected locator if its physical deletion is unavailable as well.
        await discardPublicProfilePicture(prepared).catch(() => undefined);
        return { ok: false, reason: 'storage_unavailable' };
    }
    return { ok: true, prepared };
}

/** The publication owner calls this inside the same admitted transaction as its applied binding. */
export async function completePublicProfilePictureInTx(tx: Tx, prepared: PreparedPublicProfilePicture): Promise<
    { ok: true } | { ok: false; reason: 'account_unavailable' | 'custody_unavailable' }
> {
    if (!prepared.uploadId) return { ok: true };
    const settled = await settleAccountPrivateFileUploadInTx(tx, { accountId: prepared.accountId,
        file: { id: prepared.uploadId }, writingReuseKey: publicProfilePictureWritingReuseKey,
        reuseKey: publicProfilePictureAppliedReuseKey });
    return settled === 'settled' ? { ok: true } : { ok: false, reason: settled };
}

/** Rejected Apply cannot delete an already committed image, even if its discard arrives late. */
export async function discardPublicProfilePicture(prepared: PreparedPublicProfilePicture): Promise<void> {
    if (!prepared.uploadId) return;
    const identity = { id: prepared.uploadId, accountId: prepared.accountId };
    await db.uploadedFile.updateMany({ where: { ...identity, reuseKey: publicProfilePictureWritingReuseKey },
        data: { reuseKey: publicProfilePictureRejectedReuseKey } });
    const row = await db.uploadedFile.findFirst({ where: { ...identity, reuseKey: publicProfilePictureRejectedReuseKey } });
    if (row) await deleteAccountPrivateFileUpload({ ...identity, path: row.path, reuseKey: row.reuseKey });
}

/** Retire only the displaced binding, atomically with replacement/unpublish at the publication owner. */
export async function retirePublicProfilePictureInTx(tx: Tx, accountId: string, pictureId: string): Promise<void> {
    await tx.uploadedFile.updateMany({ where: { id: pictureId, accountId, reuseKey: publicProfilePictureAppliedReuseKey },
        data: { reuseKey: publicProfilePictureRejectedReuseKey } });
}

/** Cleanup never sweeps writing or applied images; failed deletes retain their exact locator. */
export async function cleanupPublicProfilePictures(accountId: string): Promise<void> {
    const rows = await db.uploadedFile.findMany({ where: { accountId, reuseKey: publicProfilePictureRejectedReuseKey } });
    for (const row of rows) await deleteAccountPrivateFileUpload({ accountId, id: row.id, path: row.path, reuseKey: row.reuseKey });
}

/** A cleanup outage cannot undo an acknowledged publication; rejected custody remains retryable. */
export async function cleanupPublicProfilePicturesAfterCommit(accountId: string): Promise<void> {
    try { await cleanupPublicProfilePictures(accountId); }
    catch { log({ module: 'api', level: 'warn', accountId }, 'Public-profile picture cleanup failed after the publication transaction'); }
}

/** Physical lookup only. Public route admission and exact current-ref binding remain with the publication owner. */
export async function readPublicProfilePicture(input: Readonly<{ accountId: string; pictureId: string }>): Promise<
    { ok: true; bytes: Uint8Array; mimeType: 'image/png'; width: number; height: number; thumbhash: string } |
    { ok: false; reason: 'not_found' | 'storage_unavailable' }
> {
    const row = await db.uploadedFile.findFirst({ where: { id: input.pictureId, accountId: input.accountId,
        reuseKey: publicProfilePictureAppliedReuseKey } });
    if (!row) return { ok: false, reason: 'not_found' };
    if (!row.width || !row.height || !row.thumbhash) return { ok: false, reason: 'storage_unavailable' };
    try {
        return { ok: true, bytes: await readPrivateFile(row.path), mimeType: 'image/png',
            width: row.width, height: row.height, thumbhash: row.thumbhash };
    } catch { return { ok: false, reason: 'storage_unavailable' }; }
}
