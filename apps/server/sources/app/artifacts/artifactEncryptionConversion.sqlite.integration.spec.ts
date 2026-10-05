import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, type AccountEncryptionMigrateArtifactsDirective } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import * as files from '@/storage/blob/files';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { deleteAccountForErasure } from '@/app/plugins/data/accountDataErase';
import { prepareArtifactBlobWrite, completeArtifactBlobCandidateCustodyInTx, readArtifactBlob, cleanupRejectedArtifactBlobUploads } from './artifactBlobService';
import { artifactConversionBlobKey, stageArtifactBlobAccountEncryptionConversion, prepareArtifactAccountEncryptionConversionBlobs, cancelArtifactBlobAccountEncryptionConversion } from './artifactEncryptionConversionBlobService';
import { migrateArtifactAccountEncryptionInTx, matchArtifactAccountEncryptionMigrationPostStateInTx, deleteArtifact } from './artifactWriteService';

describe('Artifact private-byte Account conversion (real SQLite and private storage)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-artifact-conversion-', initEncrypt: true, initFiles: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'server_sealed' } }); }, 180_000);
    beforeEach(() => harness.resetEnv());
    afterAll(async () => { if (harness) await harness.close(); });
    const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

    async function sourceFixture() {
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const artifactId = randomUUID();
        const blobs = [Uint8Array.of(0, 255, 12), Uint8Array.of(128, 0, 42)].map(bytes => ({ blobId: randomUUID(), bytes }));
        const artifact = await db.artifact.create({ data: { id: artifactId, accountId: owner.id, header: Uint8Array.of(2, 1),
            body: Uint8Array.of(2, 2), dataEncryptionKey: Uint8Array.of(3, 4), headerVersion: 1, bodyVersion: 2,
            currentBlobId: blobs[0]!.blobId, revisions: { create: { bodyVersion: 1, body: Uint8Array.of(2, 3), blobId: blobs[1]!.blobId } } },
            include: { revisions: true } });
        for (const blob of blobs) {
            const prepared = await prepareArtifactBlobWrite({ accountId: owner.id, artifactId,
                blob: { blobId: blob.blobId, content: { t: 'encrypted', c: Buffer.from(blob.bytes).toString('base64') } } });
            await inTx(async tx => {
                await tx.artifactBlob.create({ data: prepared!.row });
                await completeArtifactBlobCandidateCustodyInTx(tx, prepared!);
            });
        }
        return { owner, artifact, blobs };
    }

    it('keeps incomplete conversion unchanged, atomically converts every retained blob, binds exact replay, and cancels only unconsumed stages', async () => {
        const { owner, artifact, blobs } = await sourceFixture();
        const stages = await Promise.all(blobs.map(blob => stageArtifactBlobAccountEncryptionConversion({ accountId: owner.id,
            artifactId: artifact.id, blobId: blob.blobId, content: { t: 'plain', v: Buffer.from(blob.bytes).toString('base64') } })));
        const body = (index: number) => encodePlainArtifactStoredContent({ body: { blobId: blobs[index]!.blobId,
            mime: 'application/octet-stream', sizeBytes: blobs[index]!.bytes.length, sha256: hash(blobs[index]!.bytes) } });
        const item = { artifactId: artifact.id, expectedHeaderVersion: 1, expectedBodyVersion: 2,
            expectedDataEncryptionKey: Buffer.from(artifact.dataEncryptionKey).toString('base64'), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            header: encodePlainArtifactStoredContent({ title: 'Binary' }), body: body(0), recipientKeyEnvelopes: [],
            revisions: [{ bodyVersion: 1, expectedBody: Buffer.from(artifact.revisions[0]!.body).toString('base64'), body: body(1) }],
            blobs: blobs.map((blob, index) => ({ blobId: blob.blobId, expectedContentSha256: hash(blob.bytes), content: stages[index]! })) };
        const directive: AccountEncryptionMigrateArtifactsDirective = { action: 'migrate', items: [item] };
        // Equal payload hashes are not authority: another Account's upload id cannot authorize our source locator.
        const other = await sourceFixture();
        const otherBody = (index: number) => encodePlainArtifactStoredContent({ body: { blobId: other.blobs[index]!.blobId,
            mime: 'application/octet-stream', sizeBytes: other.blobs[index]!.bytes.length, sha256: hash(other.blobs[index]!.bytes) } });
        const substituted: AccountEncryptionMigrateArtifactsDirective = { action: 'migrate', items: [{ ...item,
            artifactId: other.artifact.id, expectedDataEncryptionKey: Buffer.from(other.artifact.dataEncryptionKey).toString('base64'),
            body: otherBody(0), revisions: [{ ...item.revisions[0]!, body: otherBody(1) }],
            blobs: item.blobs.map((blob, index) => ({ ...blob, blobId: other.blobs[index]!.blobId })) }] };
        const foreignStages = await prepareArtifactAccountEncryptionConversionBlobs({ accountId: other.owner.id, directive: substituted });
        await expect(inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: other.owner.id, fromMode: 'e2ee', toMode: 'plain',
            directive: substituted, preparedBlobs: foreignStages }))).resolves.toEqual({ status: 'migration_incomplete' });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: other.artifact.id } })).bodyVersion).toBe(2);
        const preparedBlobs = await prepareArtifactAccountEncryptionConversionBlobs({ accountId: owner.id, directive });
        const migrate = (directive: AccountEncryptionMigrateArtifactsDirective) => inTx(tx => migrateArtifactAccountEncryptionInTx({ tx,
            accountId: owner.id, fromMode: 'e2ee', toMode: 'plain', directive, preparedBlobs }));
        await expect(migrate({ action: 'migrate', items: [{ ...item, blobs: item.blobs.slice(0, 1) }] })).resolves.toEqual({ status: 'migration_incomplete' });
        expect((await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } })).bodyVersion).toBe(2);
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(2);
        await inTx(async tx => {
            expect(await migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: 'e2ee', toMode: 'plain', directive, preparedBlobs })).toEqual({ status: 'applied' });
            await tx.account.update({ where: { id: owner.id }, data: { encryptionMode: 'plain' } });
        });
        for (const [index, blob] of blobs.entries()) {
            await expect(readArtifactBlob({ actorAccountId: owner.id, artifactId: artifact.id, blobId: blob.blobId })).resolves.toMatchObject({ ok: true,
                value: { blobId: blob.blobId, content: { t: 'plain', v: Buffer.from(blob.bytes).toString('base64') } } });
            await cancelArtifactBlobAccountEncryptionConversion({ accountId: owner.id, uploadId: stages[index]!.uploadId });
            await expect(files.readPrivateFile(artifactConversionBlobKey(artifact.id, blob.blobId, stages[index]!.uploadId))).resolves.toBeInstanceOf(Uint8Array);
        }
        const replay = await prepareArtifactAccountEncryptionConversionBlobs({ accountId: owner.id, directive });
        await expect(inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id, toMode: 'plain', directive,
            preparedBlobs: replay }))).resolves.toEqual({ status: 'matched' });
        const tampered: AccountEncryptionMigrateArtifactsDirective = { action: 'migrate', items: [{ ...item,
            blobs: item.blobs.map(blob => ({ ...blob, content: { ...blob.content, contentSha256: '0'.repeat(64) } })) }] };
        const unverified = await prepareArtifactAccountEncryptionConversionBlobs({ accountId: owner.id, directive: tampered });
        await expect(inTx(tx => matchArtifactAccountEncryptionMigrationPostStateInTx({ tx, accountId: owner.id, toMode: 'plain', directive: tampered,
            preparedBlobs: unverified }))).resolves.toEqual({ status: 'mismatch' });
        await cleanupRejectedArtifactBlobUploads(owner.id);
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);

        // The same owner performs the reverse transition without requiring a plaintext Account data key.
        const ciphertexts = blobs.map(blob => Uint8Array.of(0, 255, 7, ...blob.bytes));
        const encryptedStages = await Promise.all(blobs.map((blob, index) => stageArtifactBlobAccountEncryptionConversion({ accountId: owner.id,
            artifactId: artifact.id, blobId: blob.blobId, content: { t: 'encrypted', c: Buffer.from(ciphertexts[index]!).toString('base64') } })));
        const reverse: AccountEncryptionMigrateArtifactsDirective = { action: 'migrate', items: [{ ...item,
            expectedHeaderVersion: 2, expectedBodyVersion: 3, expectedDataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            dataEncryptionKey: Buffer.from(artifact.dataEncryptionKey).toString('base64'),
            header: Buffer.from([2, 4]).toString('base64'), body: Buffer.from([2, 5]).toString('base64'),
            revisions: [{ bodyVersion: 1, expectedBody: body(1), body: Buffer.from([2, 6]).toString('base64') }],
            blobs: blobs.map((blob, index) => ({ blobId: blob.blobId, expectedContentSha256: hash(blob.bytes), content: encryptedStages[index]! })) }] };
        const reversePrepared = await prepareArtifactAccountEncryptionConversionBlobs({ accountId: owner.id, directive: reverse });
        await inTx(async tx => {
            expect(await migrateArtifactAccountEncryptionInTx({ tx, accountId: owner.id, fromMode: 'plain', toMode: 'e2ee', directive: reverse,
                preparedBlobs: reversePrepared })).toEqual({ status: 'applied' });
            await tx.account.update({ where: { id: owner.id }, data: { encryptionMode: 'e2ee' } });
        });
        for (const [index, blob] of blobs.entries()) await expect(readArtifactBlob({ actorAccountId: owner.id, artifactId: artifact.id,
            blobId: blob.blobId })).resolves.toMatchObject({ ok: true, value: { blobId: blob.blobId,
                content: { t: 'encrypted', c: Buffer.from(ciphertexts[index]!).toString('base64') } } });
    });

    it('erases live staged private bytes with the Account without treating them as public files', async () => {
        const { owner, artifact, blobs } = await sourceFixture();
        const blob = blobs[0]!;
        const stage = await stageArtifactBlobAccountEncryptionConversion({ accountId: owner.id, artifactId: artifact.id,
            blobId: blob.blobId, content: { t: 'plain', v: Buffer.from(blob.bytes).toString('base64') } });
        const key = artifactConversionBlobKey(artifact.id, blob.blobId, stage.uploadId);
        await expect(files.readPrivateFile(key)).resolves.toBeInstanceOf(Uint8Array);
        await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toMatchObject({ status: 'deleted' });
        await expect(files.readPrivateFile(key)).rejects.toThrow();
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('cancels a stage after its Artifact is deleted and retains failed private deletion for retry', async () => {
        const { owner, artifact, blobs } = await sourceFixture();
        const stage = await stageArtifactBlobAccountEncryptionConversion({ accountId: owner.id, artifactId: artifact.id,
            blobId: blobs[0]!.blobId, content: { t: 'plain', v: 'AP8M' } });
        const key = artifactConversionBlobKey(artifact.id, blobs[0]!.blobId, stage.uploadId);
        await expect(deleteArtifact({ actorUserId: owner.id, artifactId: artifact.id })).resolves.toMatchObject({ ok: true });
        expect(await db.artifact.findUnique({ where: { id: artifact.id } })).toBeNull();
        const deletion = vi.spyOn(files, 'deletePrivateFile').mockRejectedValueOnce(new Error('Deletion unavailable'));
        try { await expect(cancelArtifactBlobAccountEncryptionConversion({ accountId: owner.id, uploadId: stage.uploadId })).rejects.toThrow(); }
        finally { deletion.mockRestore(); }
        const custody = await db.uploadedFile.findMany({ where: { accountId: owner.id } });
        expect(custody).toHaveLength(1);
        expect(custody[0]!.reuseKey).toMatch(/^artifact-blob-rejected-v1:/);
        await cleanupRejectedArtifactBlobUploads(owner.id);
        await expect(files.readPrivateFile(key)).rejects.toThrow();
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('surrenders failed stage writes to rejected cleanup custody even when private deletion also fails', async () => {
        const { owner, artifact, blobs } = await sourceFixture();
        const write = files.writePrivateFile;
        const upload = vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(async (key, bytes) => { await write(key, bytes); throw new Error('Write acknowledgement lost'); });
        const deletion = vi.spyOn(files, 'deletePrivateFile').mockRejectedValueOnce(new Error('Deletion unavailable'));
        try {
            await expect(stageArtifactBlobAccountEncryptionConversion({ accountId: owner.id, artifactId: artifact.id,
                blobId: blobs[0]!.blobId, content: { t: 'plain', v: 'AP8M' } })).rejects.toThrow();
        } finally { upload.mockRestore(); deletion.mockRestore(); }
        const custody = await db.uploadedFile.findMany({ where: { accountId: owner.id } });
        expect(custody).toHaveLength(1);
        expect(custody[0]!.reuseKey).toMatch(/^artifact-blob-rejected-v1:/);
        await expect(files.readPrivateFile(custody[0]!.path)).resolves.toBeInstanceOf(Uint8Array);
        await cleanupRejectedArtifactBlobUploads(owner.id);
        await expect(files.readPrivateFile(custody[0]!.path)).rejects.toThrow();
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
    });

    it('keeps Account erasure fail-closed through a pending conversion write and finishes safely on retry', async () => {
        const { owner, artifact, blobs } = await sourceFixture();
        let releaseWrite!: () => void;
        let startedWrite!: () => void;
        const gate = new Promise<void>(resolve => { releaseWrite = resolve; });
        const started = new Promise<void>(resolve => { startedWrite = resolve; });
        const originalWrite = files.writePrivateFile;
        const pendingWrite = vi.spyOn(files, 'writePrivateFile').mockImplementationOnce(async (key, bytes) => {
            startedWrite(); await gate; await originalWrite(key, bytes);
        });
        const operation = stageArtifactBlobAccountEncryptionConversion({ accountId: owner.id, artifactId: artifact.id,
            blobId: blobs[0]!.blobId, content: { t: 'plain', v: 'AP8M' } });
        // Observe both terminal paths immediately; a failed erase must keep the writer's Account admission usable.
        const settled = operation.then(value => ({ value }), error => ({ error: error as unknown }));
        try {
            await started;
            const custody = await db.uploadedFile.findMany({ where: { accountId: owner.id } });
            expect(custody).toHaveLength(1);
            const erasure = await deleteAccountForErasure({ accountId: owner.id });
            expect(erasure.status).toBe('failed');
            expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ status: 'active', tokenEpoch: owner.tokenEpoch });
            releaseWrite();
            expect(await settled).toHaveProperty('value');
            await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toMatchObject({ status: 'deleted' });
            await expect(files.readPrivateFile(custody[0]!.path)).rejects.toThrow();
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
        } finally { releaseWrite(); await settled; pendingWrite.mockRestore(); }
    });
});
