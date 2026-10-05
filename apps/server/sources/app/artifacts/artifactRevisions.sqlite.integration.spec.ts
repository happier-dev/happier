import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as privacyKit from "privacy-kit";
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from "@happier-dev/protocol";
import tweetnacl from "tweetnacl";
import { createHash } from "node:crypto";
import { request as requestHttp } from 'node:http';
import { readPrivateFile } from "@/storage/blob/files";
import * as privateFiles from '@/storage/blob/files';
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { withAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { artifactsRoutes } from "@/app/api/routes/artifacts/artifactsRoutes";
import { readArtifactRecipientCensusInTx } from "./artifactAccessService";
import { createArtifact } from './artifactWriteService';
import { deleteAccountForErasure } from "@/app/plugins/data/accountDataErase";

describe("Artifact revisions and storage budgets (real SQLite)", () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-artifact-history-", initEncrypt: true, initFiles: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: "server_sealed" } });
    }, 180_000);
    beforeEach(() => {
        harness.resetEnv();
        delete process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES;
        delete process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES;
        delete process.env.HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT;
    });
    afterAll(async () => { if (harness) await harness.close(); });

    const headers = (accountId: string) => ({ "x-test-user-id": accountId,
        "x-happier-account-stored-content-protocol": String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) });
    const body = (value: string) => encodePlainArtifactStoredContent({ body: value });

    it('rejects unsupported private keys for legacy Artifact ids before recording cleanup custody', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        // The authenticated socket create owner accepts non-UUID legacy ids.
        const id = `legacy:${crypto.randomUUID()}`;
        const created = await createArtifact({ actorUserId: owner.id, artifactId: id,
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ title: 'Legacy id' })),
            body: privacyKit.decodeBase64(body('Original')),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error('Legacy Artifact creation failed');
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 12);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const updated = await app.inject({ method: 'POST', url: `/v1/artifacts/${encodeURIComponent(id)}/content/binary`,
                headers: headers(owner.id), payload: {
                    body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length,
                        sha256: createHash('sha256').update(bytes).digest('hex') } }),
                    expectedBodyVersion: created.artifact.bodyVersion,
                    blob: { blobId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
                } });
            expect(updated.statusCode).toBe(500);
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            expect(await db.artifact.findUnique({ where: { id } })).toMatchObject({ bodyVersion: created.artifact.bodyVersion, currentBlobId: null });
            await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toMatchObject({ status: 'deleted' });
        });
    });

    it('retains Account custody while a private candidate write is pending and erases after its terminal discard', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 12);
        let releaseWrite!: () => void;
        let enteredWrite!: () => void;
        let storageKey = '';
        const paused = new Promise<void>(resolve => { releaseWrite = resolve; });
        const entered = new Promise<void>(resolve => { enteredWrite = resolve; });
        const write = privateFiles.writePrivateFile;
        const boundary = vi.spyOn(privateFiles, 'writePrivateFile').mockImplementationOnce(async (key, content) => {
            storageKey = key;
            enteredWrite();
            await paused;
            await write(key, content);
        });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const request = Promise.resolve(app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: 'Pending upload' }),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex') } }),
                blob: { blobId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
            } }));
            try {
                await entered;
                await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toEqual({
                    status: 'failed', code: 'account_erasure_blob_delete_failed',
                });
                expect(await db.account.findUnique({ where: { id: owner.id } })).toMatchObject({ status: 'active', tokenEpoch: owner.tokenEpoch });
                expect(await db.uploadedFile.count({ where: { accountId: owner.id, path: storageKey } })).toBe(1);
                releaseWrite();
                expect((await request).statusCode).toBe(200);
                await expect(readPrivateFile(storageKey)).resolves.toBeInstanceOf(Uint8Array);
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
                await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toMatchObject({ status: 'deleted' });
                await expect(readPrivateFile(storageKey)).rejects.toThrow();
            } finally {
                releaseWrite();
                await request;
                boundary.mockRestore();
            }
        });
    });

    it('uploads binary bytes beyond the JSON body boundary through authenticated finite chunks', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = new Uint8Array(1_100_000).fill(255);
        bytes[0] = 0;
        const payload = { kind: 'create' as const, artifactId: id, blobId, t: 'plain' as const,
            sizeBytes: bytes.length, header: encodePlainArtifactStoredContent({ title: 'Chunked file' }),
            body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex') } }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const upload = (content: Uint8Array) => app.inject({ method: 'POST', url: '/v1/artifacts/content/upload',
                headers: { ...headers(owner.id), 'content-type': 'application/vnd.happier.artifact-upload-v1' },
                payload: Buffer.concat([Buffer.from(`${JSON.stringify(payload)}\n`), content]),
            });
            const incomplete = await upload(bytes.subarray(0, 1));
            expect(incomplete.statusCode, incomplete.body).toBe(400);
            expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
            const complete = await upload(bytes);
            expect(complete.statusCode, complete.body).toBe(200);
            expect(complete.json()).toMatchObject({ id, bodyVersion: 1, encryptionMode: 'plain' });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(owner.id) })).json())
                .toEqual({ blobId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } });
        });
    });

    it('stages request-bound conversion bytes only for their owner and cancels finalized stage custody', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const source = Uint8Array.of(0, 255, 12);
        const target = Uint8Array.of(4, 0, 255, 17);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: 'Stage' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: source.length,
                    sha256: createHash('sha256').update(source).digest('hex') } }),
                blob: { blobId, content: { t: 'plain', v: privacyKit.encodeBase64(source) } },
            } })).statusCode).toBe(200);
            const metadata = { kind: 'encryption-conversion', artifactId: id, blobId, t: 'encrypted', sizeBytes: target.length };
            const upload = (accountId: string) => app.inject({ method: 'POST', url: '/v1/artifacts/content/upload',
                headers: { ...headers(accountId), 'content-type': 'application/vnd.happier.artifact-upload-v1' },
                payload: Buffer.concat([Buffer.from(`${JSON.stringify(metadata)}\n`), target]),
            });
            expect((await upload(other.id)).statusCode).toBe(404);
            const staged = await upload(owner.id);
            expect(staged.statusCode, staged.body).toBe(200);
            const stage = staged.json() as { uploadId: string; contentSha256: string; t: string };
            expect(stage).toMatchObject({ t: 'encrypted', contentSha256: createHash('sha256').update(target).digest('hex') });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(owner.id) })).json())
                .toEqual({ blobId, content: { t: 'plain', v: privacyKit.encodeBase64(source) } });
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(1);
            expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/content/uploads/${stage.uploadId}`, headers: headers(other.id) })).statusCode).toBe(200);
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(1);
            expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/content/uploads/${stage.uploadId}`, headers: headers(owner.id) })).statusCode).toBe(200);
            expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
        });
    });

    it('cancels an unacknowledged conversion stage when the HTTP connection closes during private finalization', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        let closed!: () => void;
        const socketClosed = new Promise<void>(resolve => { closed = resolve; });
        await withAuthenticatedTestApp(app => {
            app.addHook('onRequest', (request: { url: string }, reply: { raw: import('node:http').ServerResponse }, done: () => void) => {
                if (request.url === '/v1/artifacts/content/upload') reply.raw.once('close', () => {
                    if (!reply.raw.writableFinished) closed();
                });
                done();
            });
            artifactsRoutes(app);
        }, async app => {
            const source = Uint8Array.of(0, 255, 12);
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: 'Cancel stage' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: source.length,
                    sha256: createHash('sha256').update(source).digest('hex') } }), blob: { blobId, content: { t: 'plain', v: privacyKit.encodeBase64(source) } },
            } })).statusCode).toBe(200);
            let release!: () => void;
            let entered!: () => void;
            let storageKey = '';
            const paused = new Promise<void>(resolve => { release = resolve; });
            const writing = new Promise<void>(resolve => { entered = resolve; });
            const write = privateFiles.writePrivateFile;
            const boundary = vi.spyOn(privateFiles, 'writePrivateFile').mockImplementationOnce(async (key, content) => {
                storageKey = key;
                entered();
                await paused;
                await write(key, content);
            });
            const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
            const client = requestHttp(`${endpoint}/v1/artifacts/content/upload`, { method: 'POST',
                headers: { ...headers(owner.id), 'content-type': 'application/vnd.happier.artifact-upload-v1' },
            });
            client.on('error', () => { /* Destroyed transport is the exercised external boundary. */ });
            client.end(Buffer.concat([Buffer.from(`${JSON.stringify({ kind: 'encryption-conversion', artifactId: id, blobId,
                t: 'encrypted', sizeBytes: 3 })}\n`), Buffer.from([4, 0, 255])]));
            try {
                await writing;
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(1);
                client.destroy();
                await socketClosed;
                release();
                await vi.waitFor(async () => { expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0); });
                await expect(readPrivateFile(storageKey)).rejects.toThrow();
            } finally { release(); client.destroy(); boundary.mockRestore(); }
        });
    });

    it.each(['retry', 'erase'] as const)('keeps rejected upload custody without an Artifact parent until private deletion succeeds ($0)', async recovery => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 12);
        const header = encodePlainArtifactStoredContent({ title: 'Rejected upload' });
        const payload = { id, header, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex') } }),
            blob: { blobId, content: { t: 'plain' as const, v: privacyKit.encodeBase64(bytes) } } };
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = '1';
            const deletion = vi.spyOn(privateFiles, 'deletePrivateFile').mockRejectedValueOnce(new Error('Storage unavailable'));
            try {
                expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload })).statusCode).toBe(500);
                expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
                expect(await db.artifactBlob.findUnique({ where: { id: blobId } })).toBeNull();
                const custody = await db.uploadedFile.findMany({ where: { accountId: owner.id } });
                expect(custody).toHaveLength(1);
                await expect(readPrivateFile(custody[0]!.path)).resolves.toBeInstanceOf(Uint8Array);
                if (recovery === 'erase') {
                    await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toMatchObject({ status: 'deleted' });
                    await expect(readPrivateFile(custody[0]!.path)).rejects.toThrow();
                    expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
                    return;
                }
                delete process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES;
                expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload })).statusCode).toBe(200);
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
                await expect(readPrivateFile(custody[0]!.path)).rejects.toThrow();
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(owner.id) })).json())
                    .toEqual({ blobId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } });
            } finally { deletion.mockRestore(); }
        });
    });

    it('refuses the predecessor E2EE body-only mutation of a file, preserves header-only writes and allows explicit file-to-text replacement', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 12);
        const encoded = privacyKit.encodeBase64(bytes);
        const encryptedKey = privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: tweetnacl.randomBytes(32), recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes,
        })));
        const ciphertext = privacyKit.encodeBase64(Uint8Array.of(2, 0, 3));
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header: ciphertext, body: ciphertext, dataEncryptionKey: encryptedKey,
                blob: { blobId, content: { t: 'encrypted', c: encoded } },
            } })).statusCode).toBe(200);
            // The predecessor producer sends only these body/CAS fields. Ciphertext is intentionally opaque at this owner.
            const legacy = await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                payload: { body: ciphertext, expectedBodyVersion: 1 } });
            expect(legacy.statusCode).toBe(409);
            expect(legacy.json()).toEqual({ error: 'artifact_binary_content_requires_explicit_update' });
            expect(await db.artifact.findUnique({ where: { id } })).toMatchObject({ currentBlobId: blobId, bodyVersion: 1 });
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                payload: { header: ciphertext, expectedHeaderVersion: 1 } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id),
                payload: { body: ciphertext, expectedBodyVersion: 1, blob: null } })).statusCode).toBe(200);
            expect(await db.artifact.findUnique({ where: { id } })).toMatchObject({ currentBlobId: null, bodyVersion: 2 });
            expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(owner.id) })).json())
                .toEqual({ blobId, content: { t: 'encrypted', c: encoded } });
        });
    });

    it('admits same-size binary replacement at the retention-zero cap and retains failed cleanup bytes for a safe retry', async () => {
        process.env.HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT = '0';
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const firstId = crypto.randomUUID();
        const nextId = crypto.randomUUID();
        const bytes = Uint8Array.of(1, 0, 255, 0);
        const header = encodePlainArtifactStoredContent({ title: 'Quota replacement' });
        const binaryBody = (blobId: string) => encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream',
            sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header, body: binaryBody(firstId), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                blob: { blobId: firstId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
            } })).statusCode).toBe(200);
            const initial = await db.artifact.findUniqueOrThrow({ where: { id } });
            const originalBlob = await db.artifactBlob.findUniqueOrThrow({ where: { id: firstId } });
            const usage = () => app.inject({ method: 'GET', url: '/v1/artifacts/storage/usage', headers: headers(owner.id) });
            const initialBytes = (await usage()).json().usedBytes;
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = String(initialBytes);
            const deletion = vi.spyOn(privateFiles, 'deletePrivateFile').mockRejectedValueOnce(new Error('Storage unavailable'));
            try {
                // Admission must not demand steady-state old+new replacement headroom.
                expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id), payload: {
                    body: binaryBody(nextId), expectedBodyVersion: 1,
                    blob: { blobId: nextId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
                } })).statusCode).toBe(500);
                expect((await db.artifact.findUniqueOrThrow({ where: { id } })).currentBlobId).toBe(nextId);
                expect(await db.artifactBlob.findUnique({ where: { id: firstId } })).not.toBeNull();
                expect((await usage()).json().usedBytes).toBe(initialBytes + Number(originalBlob.storedSizeBytes));
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${firstId}`, headers: headers(owner.id) })).statusCode).toBe(404);
                // The next authorized mutation finishes existing cleanup before admission.
                expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id), payload: {
                    header, expectedHeaderVersion: initial.headerVersion,
                } })).statusCode).toBe(200);
                expect(await db.artifactBlob.findUnique({ where: { id: firstId } })).toBeNull();
                await expect(readPrivateFile(originalBlob.storageKey)).rejects.toThrow();
                expect((await usage()).json().usedBytes).toBe(initialBytes);
            } finally { deletion.mockRestore(); }
        });
    });

    it('reports byte counters outside the wire integer range as typed unavailable, never a rounded success', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        await db.artifact.create({ data: { id, accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        // The persistent metadata boundary can represent a remote object's size without allocating its bytes.
        await db.artifactBlob.create({ data: { id: crypto.randomUUID(), artifactId: id, storageKey: `artifacts/${id}/large`,
            encryptionMode: 'plain', storedSizeBytes: BigInt(Number.MAX_SAFE_INTEGER) + 1n } });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const response = await app.inject({ method: 'GET', url: '/v1/artifacts/storage/usage', headers: headers(owner.id) });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ error: 'storage_size_out_of_range' });
        });
    });

    it('hides a deleting artifact and retains private cleanup coordinates when deletion fails, then retries successfully', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 12);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: 'Delete retry' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream', sizeBytes: bytes.length,
                    sha256: createHash('sha256').update(bytes).digest('hex') } }),
                blob: { blobId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
            } })).statusCode).toBe(200);
            const original = await db.artifactBlob.findUniqueOrThrow({ where: { id: blobId } });
            const usage = () => app.inject({ method: 'GET', url: '/v1/artifacts/storage/usage', headers: headers(owner.id) });
            const originalBytes = (await usage()).json().usedBytes;
            const deletion = vi.spyOn(privateFiles, 'deletePrivateFile').mockRejectedValueOnce(new Error('Storage unavailable'));
            try {
                expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(500);
                expect(await db.artifactBlob.findUnique({ where: { id: blobId } })).toMatchObject({ storageKey: original.storageKey });
                expect((await usage()).json().usedBytes).toBe(originalBytes);
                expect((await app.inject({ method: 'GET', url: '/v1/artifacts', headers: headers(owner.id) })).json()).toEqual([]);
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(404);
                expect((await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(owner.id) })).statusCode).toBe(404);
                expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}`, headers: headers(owner.id), payload: {
                    body: body('resurrect'), expectedBodyVersion: 1,
                } })).statusCode).toBe(404);
                expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(200);
                expect(await db.artifact.findUnique({ where: { id } })).toBeNull();
                expect((await usage()).json().usedBytes).toBe(0);
                await expect(readPrivateFile(original.storageKey)).rejects.toThrow();
            } finally { deletion.mockRestore(); }
        });
    });

    it('charges only remaining physical bytes after partial retired-artifact cleanup and resumes the exact remaining objects', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const id = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 12);
        const referenceBody = (blobId: string) => encodePlainArtifactStoredContent({ body: { blobId,
            mime: 'application/octet-stream', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } });
        const firstId = crypto.randomUUID();
        const secondId = crypto.randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary', headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: 'Partial cleanup' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                body: referenceBody(firstId), blob: { blobId: firstId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: 'POST', url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id), payload: {
                body: referenceBody(secondId), expectedBodyVersion: 1,
                blob: { blobId: secondId, content: { t: 'plain', v: privacyKit.encodeBase64(bytes) } },
            } })).statusCode).toBe(200);
            const blobs = await db.artifactBlob.findMany({ where: { artifactId: id }, orderBy: { id: 'asc' } });
            expect(blobs).toHaveLength(2);
            const usage = () => app.inject({ method: 'GET', url: '/v1/artifacts/storage/usage', headers: headers(owner.id) });
            const initialBytes = (await usage()).json().usedBytes;
            const realDelete = privateFiles.deletePrivateFile;
            const deletion = vi.spyOn(privateFiles, 'deletePrivateFile')
                .mockImplementationOnce(realDelete).mockRejectedValueOnce(new Error('Storage unavailable'));
            try {
                expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(500);
                expect(await db.artifactBlob.findMany({ where: { artifactId: id }, select: { id: true } })).toEqual([{ id: blobs[1]!.id }]);
                expect((await usage()).json().usedBytes).toBe(initialBytes - Number(blobs[0]!.storedSizeBytes));
                await expect(readPrivateFile(blobs[0]!.storageKey)).rejects.toThrow();
                await expect(readPrivateFile(blobs[1]!.storageKey)).resolves.toBeInstanceOf(Uint8Array);
                expect((await app.inject({ method: 'DELETE', url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(200);
                await expect(readPrivateFile(blobs[1]!.storageKey)).rejects.toThrow();
                expect((await usage()).json().usedBytes).toBe(0);
            } finally { deletion.mockRestore(); }
        });
    });

    it("erases current and retained private artifact objects through physical Account erasure", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(1, 255, 0);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: "POST", url: "/v1/artifacts/content/binary", headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: "Erase" }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                body: encodePlainArtifactStoredContent({ body: { blobId, mime: "application/octet-stream", sizeBytes: bytes.length,
                    sha256: createHash("sha256").update(bytes).digest("hex") } }),
                blob: { blobId, content: { t: "plain", v: privacyKit.encodeBase64(bytes) } },
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id),
                payload: { body: body("text"), expectedBodyVersion: 1, blob: null } })).statusCode).toBe(200);
            const blob = await db.artifactBlob.findUniqueOrThrow({ where: { id: blobId } });
            await expect(readPrivateFile(blob.storageKey)).resolves.toBeInstanceOf(Uint8Array);
            await expect(deleteAccountForErasure({ accountId: owner.id })).resolves.toMatchObject({ status: "deleted" });
            expect(await db.artifactBlob.count({ where: { artifactId: id } })).toBe(0);
            await expect(readPrivateFile(blob.storageKey)).rejects.toThrow();
        });
    });

    it("rejects mode mismatches and counts each retained blob once under the document budget, then removes expired bytes", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(1, 0, 255, 0);
        const reference = { blobId, mime: "application/octet-stream", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        const binaryBody = encodePlainArtifactStoredContent({ body: reference });
        const header = encodePlainArtifactStoredContent({ title: "Budget" });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const create = (content: { t: "plain"; v: string } | { t: "encrypted"; c: string }) => app.inject({ method: "POST", url: "/v1/artifacts/content/binary",
                headers: headers(owner.id), payload: { id, header, body: binaryBody, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, blob: { blobId, content } } });
            expect((await create({ t: "encrypted", c: privacyKit.encodeBase64(bytes) })).statusCode).toBe(400);
            expect(await db.artifact.count({ where: { id } })).toBe(0);
            expect((await create({ t: "plain", v: privacyKit.encodeBase64(bytes) })).statusCode).toBe(200);
            const original = await db.artifact.findUniqueOrThrow({ where: { id } });
            const blob = await db.artifactBlob.findUniqueOrThrow({ where: { id: blobId } });
            const usage = () => app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) });
            const initialBytes = (await usage()).json().usedBytes;
            expect(initialBytes).toBe(original.header.byteLength + original.body.byteLength + Number(blob.storedSizeBytes));
            // Reusing a blob retains another body reference, never another physical byte charge.
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id), payload: {
                body: binaryBody, expectedBodyVersion: 1, blob: { blobId },
            } })).statusCode).toBe(200);
            expect((await usage()).json().usedBytes).toBe(initialBytes + original.body.byteLength);
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = String(initialBytes + original.body.byteLength);
            const deniedId = crypto.randomUUID();
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id), payload: {
                body: encodePlainArtifactStoredContent({ body: { ...reference, blobId: deniedId } }), expectedBodyVersion: 2,
                blob: { blobId: deniedId, content: { t: "plain", v: privacyKit.encodeBase64(bytes) } },
            } })).statusCode).toBe(413);
            expect(await db.artifactBlob.count({ where: { artifactId: id } })).toBe(1);
            expect((await db.artifact.findUniqueOrThrow({ where: { id } })).bodyVersion).toBe(2);
            delete process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES;
            process.env.HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT = "0";
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id), payload: {
                body: body("text"), expectedBodyVersion: 2, blob: null,
            } })).statusCode).toBe(200);
            expect(await db.artifactBlob.count({ where: { artifactId: id } })).toBe(0);
            await expect(readPrivateFile(blob.storageKey)).rejects.toThrow();
        });
    });

    it.each(["plain", "e2ee"] as const)("round trips private %s blobs with current grants, retains and restores bytes, and physically deletes them", async mode => {
        const owner = await db.account.create({ data: { encryptionMode: mode, ...(mode === "e2ee" ? createSignedAccountContentBinding() : {}) } });
        const stranger = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        const blobId = crypto.randomUUID();
        const bytes = Uint8Array.of(0, 255, 0, 12, 33);
        const encoded = privacyKit.encodeBase64(bytes);
        const content = mode === "plain" ? { t: "plain", v: encoded } : { t: "encrypted", c: encoded };
        const key = mode === "plain" ? ARTIFACT_PLAIN_DATA_KEY_MARKER : privacyKit.encodeBase64(new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey: tweetnacl.randomBytes(32), recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes,
        })));
        const reference = { blobId, mime: "application/octet-stream", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
        const header = mode === "plain" ? encodePlainArtifactStoredContent({ title: "File" }) : privacyKit.encodeBase64(Uint8Array.of(1));
        const binaryBody = mode === "plain" ? encodePlainArtifactStoredContent({ body: reference }) : privacyKit.encodeBase64(Uint8Array.of(2));
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const create = await app.inject({ method: "POST", url: "/v1/artifacts/content/binary", headers: headers(owner.id),
                payload: { id, header, body: binaryBody, dataEncryptionKey: key, blob: { blobId, content } } });
            expect(create.statusCode).toBe(200);
            const get = () => app.inject({ method: "GET", url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(owner.id) });
            expect((await get()).json()).toEqual({ blobId, content });
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${id}/blobs/${blobId}`, headers: headers(stranger.id) })).statusCode).toBe(404);
            const blob = await db.artifactBlob.findUniqueOrThrow({ where: { id: blobId } });
            const persisted = await readPrivateFile(blob.storageKey);
            if (mode === "plain") expect(new Uint8Array(persisted)).not.toEqual(bytes);
            else expect(new Uint8Array(persisted)).toEqual(bytes);
            const artifact = await db.artifact.findUniqueOrThrow({ where: { id } });
            const usedBytes = artifact.header.byteLength + artifact.body.byteLength + Number(blob.storedSizeBytes);
            expect((await app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) })).json().usedBytes).toBe(usedBytes);
            const replacementBody = mode === "plain" ? body("text") : privacyKit.encodeBase64(Uint8Array.of(3));
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id),
                payload: { body: replacementBody, expectedBodyVersion: 1, blob: null } })).statusCode).toBe(200);
            expect((await get()).json()).toEqual({ blobId, content });
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/1/restore`, headers: headers(owner.id),
                payload: { header, expectedHeaderVersion: 1, expectedBodyVersion: 2 } })).statusCode).toBe(200);
            expect((await db.artifact.findUniqueOrThrow({ where: { id } })).currentBlobId).toBe(blobId);
            // A reused id must never overwrite the object retained by a prior save.
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/content/binary`, headers: headers(owner.id), payload: {
                body: binaryBody, expectedBodyVersion: 3, blob: { blobId, content: mode === "plain" ? { t: "plain", v: "AA==" } : { t: "encrypted", c: "AA==" } },
            } })).statusCode).toBe(400);
            expect((await get()).json()).toEqual({ blobId, content });
            expect((await app.inject({ method: "DELETE", url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(200);
            expect(await db.artifactBlob.count({ where: { artifactId: id } })).toBe(0);
            await expect(readPrivateFile(blob.storageKey)).rejects.toThrow();
        });
    });

    it("retains ten prior stored bodies, rejects stale restores, and restores through the normal update", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const stranger = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: "POST", url: "/v1/artifacts", headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: "History" }), body: body("1"),
                dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            } })).statusCode).toBe(200);
            const original = await db.artifact.findUniqueOrThrow({ where: { id } });
            for (let version = 1; version <= 12; version++) {
                expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                    payload: { body: body(String(version + 1)), expectedBodyVersion: version } })).json())
                    .toEqual({ success: true, bodyVersion: version + 1 });
                if (version === 1) {
                    const revision = await db.artifactRevision.findUniqueOrThrow({ where: { artifactId_bodyVersion: { artifactId: id, bodyVersion: 1 } } });
                    expect(revision.body).toEqual(original.body);
                }
            }
            const list = await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(owner.id) });
            expect(list.statusCode).toBe(200);
            expect(list.json()).toMatchObject({ retentionCount: 10 });
            expect(list.json().revisions.slice(0, 2)).toMatchObject([
                { bodyVersion: 12, body: body("12") }, { bodyVersion: 11, body: body("11") },
            ]);
            expect(list.json().revisions.map((row: { bodyVersion: number }) => row.bodyVersion)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(stranger.id) })).statusCode).toBe(404);
            const restoredHeader = encodePlainArtifactStoredContent({ title: "History", revision: { headerVersion: 2, bodyVersion: 14 } });
            const stale = await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/3/restore`, headers: headers(owner.id),
                payload: { header: restoredHeader, expectedHeaderVersion: 1, expectedBodyVersion: 12 } });
            expect(stale.json()).toMatchObject({ success: false, error: "version-mismatch", currentBodyVersion: 13 });
            expect((await db.artifact.findUniqueOrThrow({ where: { id } })).bodyVersion).toBe(13);
            const staleHeader = await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/3/restore`, headers: headers(owner.id),
                payload: { header: restoredHeader, expectedHeaderVersion: 2, expectedBodyVersion: 13 } });
            expect(staleHeader.json()).toMatchObject({ success: false, error: "version-mismatch", currentHeaderVersion: 1 });
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/3/restore`, headers: headers(owner.id),
                payload: { header: restoredHeader, expectedHeaderVersion: 1, expectedBodyVersion: 13 } })).json()).toEqual({ success: true, headerVersion: 2, bodyVersion: 14 });
            const current = await app.inject({ method: "GET", url: `/v1/artifacts/${id}`, headers: headers(owner.id) });
            expect(current.json()).toMatchObject({ headerVersion: 2, header: restoredHeader, bodyVersion: 14, body: body("3") });
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/3/restore`, headers: headers(owner.id),
                payload: { expectedHeaderVersion: 2, expectedBodyVersion: 14 } })).statusCode).toBe(400);
            const restoredList = await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(owner.id) });
            expect(restoredList.json().revisions[0]).toMatchObject({ bodyVersion: 13, body: body("13") });
            expect(original.body).not.toEqual(privacyKit.decodeBase64(body("1")));
            expect(await db.accountChange.findFirst({ where: { accountId: owner.id, kind: "artifact", entityId: id } })).not.toBeNull();
        });
    });

    it("reports unlimited storage by default and enforces configured document and account budgets including history atomically", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const create = () => app.inject({ method: "POST", url: "/v1/artifacts", headers: headers(owner.id), payload: {
                id, header: encodePlainArtifactStoredContent({ title: "Budget" }), body: body("current"), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            } });
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = "1";
            expect((await create()).json()).toMatchObject({ error: "quota_exceeded", budget: "document", limitBytes: 1 });
            expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(0);
            delete process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES;
            expect((await create()).statusCode).toBe(200);
            const current = await db.artifact.findUniqueOrThrow({ where: { id } });
            const usedBytes = current.header.byteLength + current.body.byteLength;
            expect((await app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) })).json())
                .toEqual({ usedBytes, limitBytes: null, documentLimitBytes: null, revisionRetentionCount: 10 });
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = String(usedBytes);
            const deniedByHistory = await app.inject({ method: "POST", url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                payload: { body: body("current"), expectedBodyVersion: 1 } });
            expect(deniedByHistory.statusCode).toBe(413);
            expect(deniedByHistory.json()).toEqual({ error: "quota_exceeded", budget: "document", limitBytes: usedBytes,
                usedBytes: usedBytes + current.body.byteLength });
            expect((await db.artifact.findUniqueOrThrow({ where: { id } })).bodyVersion).toBe(1);
            expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(0);
            delete process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES;
            process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES = String(usedBytes);
            const denied = await app.inject({ method: "POST", url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                payload: { body: body("replacement"), expectedBodyVersion: 1 } });
            expect(denied.statusCode).toBe(413);
            expect(denied.json()).toMatchObject({ error: "quota_exceeded", budget: "account", limitBytes: usedBytes });
            expect((await db.artifact.findUniqueOrThrow({ where: { id } })).bodyVersion).toBe(1);
            delete process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES;
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                payload: { body: body("replacement"), expectedBodyVersion: 1 } })).statusCode).toBe(200);
            const updated = await db.artifact.findUniqueOrThrow({ where: { id } });
            const usage = await app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) });
            expect(usage.json().usedBytes).toBe(updated.header.byteLength + updated.body.byteLength + current.body.byteLength);
            const revisions = await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(owner.id) });
            expect(revisions.json().revisions).toHaveLength(1);
            const pluginId = crypto.randomUUID();
            await db.artifact.create({ data: { id: pluginId, accountId: owner.id, header: current.header, body: current.body,
                dataEncryptionKey: current.dataEncryptionKey } });
            await db.accountPluginRelease.create({ data: { accountId: owner.id, pluginId: "com.test.assets", version: "1.0.0",
                archiveDigestSha256: "0".repeat(64), normalizedManifest: {}, collectionContracts: {}, uiSlots: [], packageAssetArtifactId: pluginId } });
            expect((await app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) })).json().usedBytes)
                .toBe(usage.json().usedBytes);
            expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(1);
            expect((await app.inject({ method: "DELETE", url: `/v1/artifacts/${id}`, headers: headers(owner.id) })).statusCode).toBe(200);
            expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(0);
            expect((await app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) })).json().usedBytes).toBe(0);
        });
    });

    it("serializes concurrent Account budget admissions and releases usage when deleting history", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "plain" } });
        const id = crypto.randomUUID();
        process.env.HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST = "none";
        process.env.HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT = "1";
        const header = encodePlainArtifactStoredContent({ title: "Same size" });
        const content = body("same size");
        const oneDocumentBytes = privacyKit.decodeBase64(header).byteLength + privacyKit.decodeBase64(content).byteLength;
        process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES = String(oneDocumentBytes);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const create = (artifactId: string) => app.inject({ method: "POST", url: "/v1/artifacts", headers: headers(owner.id),
                payload: { id: artifactId, header, body: content, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER } });
            const results = await Promise.all([create(id), create(crypto.randomUUID())]);
            expect(results.map(response => response.statusCode).sort()).toEqual([200, 413]);
            const stored = await db.artifact.findFirstOrThrow({ where: { accountId: owner.id } });
            process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES = String(oneDocumentBytes + privacyKit.decodeBase64(content).byteLength);
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES;
            for (let version = 1; version <= 2; version++) {
                expect((await app.inject({ method: "POST", url: `/v1/artifacts/${stored.id}`, headers: headers(owner.id),
                    payload: { body: content, expectedBodyVersion: version } })).statusCode).toBe(200);
            }
            const revisions = await app.inject({ method: "GET", url: `/v1/artifacts/${stored.id}/revisions`, headers: headers(owner.id) });
            expect(revisions.json()).toMatchObject({ retentionCount: 1, revisions: [{ bodyVersion: 2 }] });
            expect(revisions.json().revisions).toHaveLength(1);
            process.env.HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT = "0";
            process.env.HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES = String(oneDocumentBytes);
            process.env.HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES = String(oneDocumentBytes);
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${stored.id}`, headers: headers(owner.id),
                payload: { body: content, expectedBodyVersion: 3 } })).statusCode).toBe(200);
            expect(await db.artifactRevision.count({ where: { artifactId: stored.id } })).toBe(0);
            expect((await app.inject({ method: "DELETE", url: `/v1/artifacts/${stored.id}`, headers: headers(owner.id) })).statusCode).toBe(200);
            expect(await db.artifactRevision.count({ where: { artifactId: stored.id } })).toBe(0);
            expect((await app.inject({ method: "GET", url: "/v1/artifacts/storage/usage", headers: headers(owner.id) })).json().usedBytes).toBe(0);
        });
    });

    it("keeps E2EE history opaque and requires a current recipient envelope and edit grant for restore", async () => {
        const owner = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const editor = await db.account.create({ data: { encryptionMode: "e2ee", ...createSignedAccountContentBinding() } });
        const id = crypto.randomUUID();
        const key = tweetnacl.randomBytes(32);
        const wrap = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes }));
        const original = new Uint8Array([1, 2, 3, 4]);
        const replacement = new Uint8Array([5, 6, 7, 8]);
        const restoredHeader = new Uint8Array([9, 10, 11, 12]);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            expect((await app.inject({ method: "POST", url: "/v1/artifacts", headers: headers(owner.id), payload: {
                id, header: privacyKit.encodeBase64(original), body: privacyKit.encodeBase64(original),
                dataEncryptionKey: privacyKit.encodeBase64(wrap(owner.contentPublicKey!)),
            } })).statusCode).toBe(200);
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}`, headers: headers(owner.id),
                payload: { body: privacyKit.encodeBase64(replacement), expectedBodyVersion: 1 } })).statusCode).toBe(200);
            await db.artifactAccountGrant.create({ data: { artifactId: id, accountId: editor.id, accessLevel: "edit", createdByAccountId: owner.id } });
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(editor.id) })).statusCode).toBe(503);
            const census = await inTx(tx => readArtifactRecipientCensusInTx(tx, { actorAccountId: owner.id, artifactId: id }));
            if (!census.ok) throw new Error(census.error);
            const fingerprint = census.value.recipients.find(row => row.recipientAccountId === editor.id)!.contentPublicKeyFingerprint!;
            await db.artifactKeyEnvelope.create({ data: { artifactId: id, recipientAccountId: editor.id,
                encryptedDataKey: wrap(editor.contentPublicKey!), recipientContentPublicKeyFingerprint: fingerprint } });
            const list = await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(editor.id) });
            expect(list.statusCode).toBe(200);
            expect(list.json().revisions[0]).toMatchObject({ bodyVersion: 1, body: privacyKit.encodeBase64(original), sizeBytes: 4 });
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/1/restore`, headers: headers(editor.id),
                payload: { header: privacyKit.encodeBase64(restoredHeader), expectedHeaderVersion: 1, expectedBodyVersion: 2 } })).json()).toEqual({ success: true, headerVersion: 2, bodyVersion: 3 });
            const restored = await db.artifact.findUniqueOrThrow({ where: { id } });
            expect(restored.body).toEqual(original);
            expect(restored.header).toEqual(restoredHeader);
            expect((await db.artifactRevision.findUniqueOrThrow({ where: { artifactId_bodyVersion: { artifactId: id, bodyVersion: 2 } } })).body).toEqual(replacement);
            await db.artifactAccountGrant.update({ where: { artifactId_accountId: { artifactId: id, accountId: editor.id } }, data: { accessLevel: "view" } });
            expect((await app.inject({ method: "POST", url: `/v1/artifacts/${id}/revisions/1/restore`, headers: headers(editor.id),
                payload: { header: privacyKit.encodeBase64(restoredHeader), expectedHeaderVersion: 2, expectedBodyVersion: 3 } })).statusCode).toBe(404);
            await db.account.update({ where: { id: editor.id }, data: createSignedAccountContentBinding() });
            expect((await app.inject({ method: "GET", url: `/v1/artifacts/${id}/revisions`, headers: headers(editor.id) })).statusCode).toBe(503);
        });
    });
});
