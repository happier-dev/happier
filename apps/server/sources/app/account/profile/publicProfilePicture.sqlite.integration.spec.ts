import sharp from 'sharp';
import * as privacyKit from 'privacy-kit';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PublicProfilePreparedAtmosphereV1Schema } from '@happier-dev/protocol/account/publicProfileAtmosphere';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import * as files from '@/storage/blob/files';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { deleteAccountForErasure } from '@/app/plugins/data/accountDataErase';
import {
    preparePublicProfilePicture, completePublicProfilePictureInTx, discardPublicProfilePicture,
    readPublicProfilePicture, retirePublicProfilePictureInTx, cleanupPublicProfilePictures,
} from './publicProfilePicture';

async function picture(format: 'png' | 'webp' = 'png') {
    const image = sharp({ create: { width: 96, height: 48, channels: 3, background: { r: 17, g: 83, b: 137 } } });
    const bytes = await (format === 'png' ? image.png() : image.webp({ lossless: true })).toBuffer();
    return { bytes, atmosphere: PublicProfilePreparedAtmosphereV1Schema.parse({ source: 'picture', picture: {
        layout: 'horizon', descriptor: { kind: 'photo', title: 'Reviewed picture', credit: null, horizon: {}, focus: {},
            hour: 12, grades: { light: 1, dusk: 1, night: 1 }, dark: 'night', adaptiveHaze: false,
            look: { effect: 'original', params: {}, strength: 1, dissolve: { style: 'gradient', from: 0.58, to: 1 } } },
        content: { mimeType: format === 'png' ? 'image/png' : 'image/webp', base64: privacyKit.encodeBase64(bytes) },
    } }) };
}

async function account(mode: 'plain' | 'e2ee' = 'plain') {
    if (mode === 'plain') return db.account.create({ data: { encryptionMode: 'plain', publicKey: null } });
    return db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
}

describe('reviewed public-profile picture custody', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-profile-picture-', initFiles: true }); }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(async () => { vi.restoreAllMocks(); await db.uploadedFile.deleteMany(); await db.account.deleteMany(); });

    it.each([
        { mode: 'plain', format: 'png' }, { mode: 'e2ee', format: 'png' }, { mode: 'plain', format: 'webp' },
    ] as const)('publishes exact normalized $format pixels through Account-scoped custody without changing $mode keys', async ({ mode, format }) => {
        const owner = await account(mode);
        const fixture = await picture(format);
        const result = await preparePublicProfilePicture({ accountId: owner.id, atmosphere: fixture.atmosphere });
        expect(result.ok).toBe(true);
        if (!result.ok || !result.prepared.uploadId) throw new Error('Expected picture preparation');
        const { prepared } = result;
        const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: prepared.uploadId! } });
        expect(row).toMatchObject({ accountId: owner.id, width: 96, height: 48 });
        expect(row.path.startsWith('public/')).toBe(false);
        expect(prepared.atmosphere).toMatchObject({ source: 'picture', picture: {
            ref: { kind: 'publication', id: row.id }, descriptor: fixture.atmosphere.source === 'picture' ? fixture.atmosphere.picture.descriptor : {},
        } });
        expect(JSON.stringify(prepared.atmosphere)).not.toContain('base64');
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: row.id })).toEqual({ ok: false, reason: 'not_found' });
        expect(await inTx(tx => completePublicProfilePictureInTx(tx, prepared))).toEqual({ ok: true });
        const read = await readPublicProfilePicture({ accountId: owner.id, pictureId: row.id });
        expect(read.ok).toBe(true);
        if (!read.ok) throw new Error('Expected applied picture');
        expect(row.storedSizeBytes).toBe(BigInt(read.bytes.byteLength));
        expect(read).toMatchObject({ mimeType: 'image/png', width: 96, height: 48 });
        const actual = await sharp(read.bytes).raw().toBuffer();
        const reviewed = await sharp(fixture.bytes).raw().toBuffer();
        expect(actual.equals(reviewed)).toBe(true);
        expect(await readPublicProfilePicture({ accountId: 'other-account', pictureId: row.id })).toEqual({ ok: false, reason: 'not_found' });
        expect(await inTx(tx => completePublicProfilePictureInTx(tx, prepared)))
            .toEqual({ ok: false, reason: 'custody_unavailable' });
        await discardPublicProfilePicture(prepared);
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: row.id })).ok).toBe(true);
        const after = await db.account.findUniqueOrThrow({ where: { id: owner.id } });
        expect(after).toMatchObject({ encryptionMode: owner.encryptionMode, publicKey: owner.publicKey,
            contentPublicKey: owner.contentPublicKey, contentPublicKeySig: owner.contentPublicKeySig });
    });

    it('retires only the exact displaced picture and never sweeps a newer applied picture', async () => {
        const owner = await account();
        const fixture = await picture();
        const first = await preparePublicProfilePicture({ accountId: owner.id, atmosphere: fixture.atmosphere });
        const second = await preparePublicProfilePicture({ accountId: owner.id, atmosphere: fixture.atmosphere });
        if (!first.ok || !second.ok || !first.prepared.uploadId || !second.prepared.uploadId) throw new Error('Expected preparations');
        const oldRow = await db.uploadedFile.findUniqueOrThrow({ where: { id: first.prepared.uploadId } });
        await inTx(tx => completePublicProfilePictureInTx(tx, first.prepared));
        await expect(inTx(async tx => {
            expect(await completePublicProfilePictureInTx(tx, second.prepared)).toEqual({ ok: true });
            await retirePublicProfilePictureInTx(tx, owner.id, first.prepared.uploadId!);
            throw new Error('Apply lost publication admission');
        })).rejects.toThrow('Apply lost publication admission');
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: first.prepared.uploadId })).ok).toBe(true);
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: second.prepared.uploadId }))
            .toEqual({ ok: false, reason: 'not_found' });
        await inTx(async tx => {
            expect(await completePublicProfilePictureInTx(tx, second.prepared)).toEqual({ ok: true });
            await retirePublicProfilePictureInTx(tx, owner.id, first.prepared.uploadId!);
        });
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: first.prepared.uploadId })).toEqual({ ok: false, reason: 'not_found' });
        await cleanupPublicProfilePictures(owner.id);
        await expect(files.readPrivateFile(oldRow.path)).rejects.toThrow();
        expect(await db.uploadedFile.findUnique({ where: { id: oldRow.id } })).toBeNull();
        expect((await readPublicProfilePicture({ accountId: owner.id, pictureId: second.prepared.uploadId })).ok).toBe(true);
    });

    it('retains exact rejected custody when partial physical writes and deletion fail, then retries cleanup', async () => {
        const owner = await account();
        const fixture = await picture();
        const realWrite = files.writePrivateFile;
        vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(async (path, bytes) => {
            await realWrite(path, bytes);
            throw new Error('storage acknowledgement failed');
        });
        vi.spyOn(files, 'deletePrivateFile').mockRejectedValueOnce(new Error('storage unavailable'));
        expect(await preparePublicProfilePicture({ accountId: owner.id, atmosphere: fixture.atmosphere }))
            .toEqual({ ok: false, reason: 'storage_unavailable' });
        const row = await db.uploadedFile.findFirstOrThrow({ where: { accountId: owner.id } });
        expect((await files.readPrivateFile(row.path)).length).toBeGreaterThan(0);
        expect(await readPublicProfilePicture({ accountId: owner.id, pictureId: row.id })).toEqual({ ok: false, reason: 'not_found' });
        await cleanupPublicProfilePictures(owner.id);
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
        await expect(files.readPrivateFile(row.path)).rejects.toThrow();
    });

    it('rejects unavailable Accounts and MIME-mismatched image bytes before creating custody', async () => {
        const fixture = await picture();
        const disabled = await account();
        await db.account.update({ where: { id: disabled.id }, data: { status: 'disabled' } });
        const inconsistent = await db.account.create({ data: { encryptionMode: 'malformed', publicKey: null } });
        for (const accountId of [disabled.id, inconsistent.id, 'missing-account']) {
            expect(await preparePublicProfilePicture({ accountId, atmosphere: fixture.atmosphere }))
                .toEqual({ ok: false, reason: 'account_unavailable' });
        }
        const owner = await account();
        if (fixture.atmosphere.source !== 'picture') throw new Error('Expected picture fixture');
        const jpeg = await sharp(fixture.bytes).jpeg().toBuffer();
        const mismatch = { ...fixture.atmosphere, picture: { ...fixture.atmosphere.picture,
            content: { mimeType: 'image/png' as const, base64: privacyKit.encodeBase64(jpeg) } } };
        expect(await preparePublicProfilePicture({ accountId: owner.id, atmosphere: mismatch }))
            .toEqual({ ok: false, reason: 'invalid_picture' });
        expect(await db.uploadedFile.count()).toBe(0);
    });

    it('orders Account erasure against pending private IO and removes applied files through private storage', async () => {
        const owner = await account();
        const fixture = await picture();
        let entered!: () => void;
        let release!: () => void;
        const enteredWrite = new Promise<void>(resolve => { entered = resolve; });
        const releaseWrite = new Promise<void>(resolve => { release = resolve; });
        const realWrite = files.writePrivateFile;
        vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(async (path, bytes) => {
            entered();
            await releaseWrite;
            await realWrite(path, bytes);
        });
        const preparing = preparePublicProfilePicture({ accountId: owner.id, atmosphere: fixture.atmosphere });
        await enteredWrite;
        let erasure: Awaited<ReturnType<typeof deleteAccountForErasure>> | undefined;
        let duringStatus: string | undefined;
        try {
            erasure = await deleteAccountForErasure({ accountId: owner.id });
            duringStatus = (await db.account.findUnique({ where: { id: owner.id }, select: { status: true } }))?.status;
        } finally { release(); }
        const result = await preparing;
        expect(erasure).toEqual({ status: 'failed', code: 'account_erasure_blob_delete_failed' });
        expect(duringStatus).toBe('active');
        if (!result.ok || !result.prepared.uploadId) throw new Error('Expected completed preparation');
        const row = await db.uploadedFile.findUniqueOrThrow({ where: { id: result.prepared.uploadId } });
        await inTx(tx => completePublicProfilePictureInTx(tx, result.prepared));
        expect(await deleteAccountForErasure({ accountId: owner.id })).toEqual({ status: 'deleted' });
        await expect(files.readPrivateFile(row.path)).rejects.toThrow();
        expect(await db.account.findUnique({ where: { id: owner.id } })).toBeNull();
    });
});
