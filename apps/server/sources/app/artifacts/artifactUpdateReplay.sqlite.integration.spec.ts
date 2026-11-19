import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, encodeArtifactUploadFrameV1, type ArtifactUploadDestinationV1 } from '@happier-dev/transfers';
import { encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createHash } from 'node:crypto';
import { createServer, request as requestHttp } from 'node:http';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import type { onSendHookHandler } from 'fastify';
import { initFilesLocalFromEnv, initFilesS3FromEnv, loadFiles, writePublicFile } from '@/storage/blob/files';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'artifact-update-replay-',
    initAuth: false, initEncrypt: true, initFiles: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'none' } }); }, 120_000);
afterAll(async () => await harness?.close());

it('refuses a binary upload with the missing private bucket reason while public S3 stays usable', async () => {
    const putObject = vi.fn();
    vi.doMock('minio', () => ({ Client: class {
        bucketExists = async () => true;
        putObject = putObject;
    } }));
    try {
        await initFilesS3FromEnv({ S3_HOST: 'example.com', S3_PUBLIC_URL: 'https://cdn.example.com',
            S3_BUCKET: 'public', S3_ACCESS_KEY: 'key', S3_SECRET_KEY: 'secret' });
        await loadFiles();
        await writePublicFile('avatars/example', Uint8Array.of(1));
        expect(putObject).toHaveBeenCalledWith('public', 'avatars/example', Buffer.from([1]));
        putObject.mockClear();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const artifactId = crypto.randomUUID();
        const dataEncryptionKey = sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes });
        const frame = encodeArtifactUploadFrameV1({ kind: 'create', artifactId, blobId: crypto.randomUUID(),
            header: 'AgAD', body: 'AgAE', dataEncryptionKey: encodeBase64(dataEncryptionKey) }, { t: 'encrypted', c: 'AQ==' });
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const expected = { error: 'private_storage_unavailable', reason: 's3_private_bucket_missing' };
            const response = await app.inject({ method: 'POST', url: ARTIFACT_UPLOAD_PATH_V1,
                headers: { 'x-test-user-id': owner.id, 'content-type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
                payload: Buffer.from(frame) });
            expect(response.statusCode, response.body).toBe(503);
            expect(response.json()).toEqual(expected);

            const jsonResponse = await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary',
                headers: { 'x-test-user-id': owner.id,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) },
                payload: { id: artifactId, header: 'AgAD', body: 'AgAE', dataEncryptionKey: encodeBase64(dataEncryptionKey),
                    blob: { blobId: crypto.randomUUID(), content: { t: 'encrypted', c: 'AQ==' } } } });
            expect(jsonResponse.statusCode, jsonResponse.body).toBe(503);
            expect(jsonResponse.json()).toEqual(expected);
        });
        expect(await db.artifact.findUnique({ where: { id: artifactId } })).toBeNull();
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
        expect(putObject).not.toHaveBeenCalled();
    } finally {
        vi.doUnmock('minio');
        initFilesLocalFromEnv();
        await loadFiles();
    }
});

it('returns typed storage unavailability when an under-cap private upload hits a full backend', async () => {
    const putObject = vi.fn().mockResolvedValue(undefined);
    vi.doMock('minio', () => ({ Client: class {
        bucketExists = async () => true;
        getBucketPolicy = async () => '{"Statement":[]}';
        putObject = putObject;
        removeObject = async () => {};
    } }));
    vi.stubEnv('HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES', '1024');
    vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '4096');
    try {
        await initFilesS3FromEnv({ S3_HOST: 'example.com', S3_PUBLIC_URL: 'https://cdn.example.com', S3_BUCKET: 'public',
            S3_PRIVATE_BUCKET: 'private', S3_ACCESS_KEY: 'key', S3_SECRET_KEY: 'secret' });
        await loadFiles();
        const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
        const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }));
        const content = { t: 'encrypted', c: 'AQ==' } as const;
        const destination = () => ({ kind: 'create', artifactId: crypto.randomUUID(), blobId: crypto.randomUUID(),
            header: 'AgAD', body: 'AgAE', dataEncryptionKey } satisfies ArtifactUploadDestinationV1);
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const upload = (target: ArtifactUploadDestinationV1) => app.inject({ method: 'POST', url: ARTIFACT_UPLOAD_PATH_V1,
                headers: { 'x-test-user-id': owner.id, 'content-type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
                payload: Buffer.from(encodeArtifactUploadFrameV1(target, content)) });
            const control = await upload(destination());
            expect(control.statusCode, control.body).toBe(200);
            putObject.mockRejectedValue(Object.assign(new Error('Storage is full'), { code: 'XMinioStorageFull' }));
            for (const framed of [true, false]) {
                const target = destination();
                const response = framed ? await upload(target) : await app.inject({ method: 'POST', url: '/v1/artifacts/content/binary',
                    headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) },
                    payload: { id: target.artifactId, header: target.header, body: target.body, dataEncryptionKey,
                        blob: { blobId: target.blobId, content } } });
                expect(response.statusCode, response.body).toBe(503);
                expect(response.json()).toEqual({ error: 'private_storage_unavailable', reason: 'backend_unavailable' });
                expect(await db.artifact.findUnique({ where: { id: target.artifactId } })).toBeNull();
            }
        });
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
    } finally {
        vi.unstubAllEnvs();
        vi.doUnmock('minio');
        initFilesLocalFromEnv();
        await loadFiles();
    }
});

it('skips private IO for a full Artifact budget and removes the candidate that loses a concurrent quota check', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
        recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes }));
    const pendingBlobId = crypto.randomUUID();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const objects = new Set<string>();
    const writes: string[] = [];
    const deletes: string[] = [];
    const s3 = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.searchParams.has('location')) {
            response.end('<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>');
        } else if (url.searchParams.has('policy')) {
            response.end('{"Statement":[]}');
        } else if (request.method === 'HEAD') {
            response.end();
        } else if (request.method === 'PUT') {
            for await (const _chunk of request) { /* Drain the real object upload. */ }
            objects.add(url.pathname);
            writes.push(url.pathname);
            if (url.pathname.includes(pendingBlobId)) {
                started.resolve();
                await release.promise;
            }
            response.setHeader('ETag', '"test-etag"').end();
        } else if (request.method === 'DELETE') {
            objects.delete(url.pathname);
            deletes.push(url.pathname);
            response.writeHead(204).end();
        } else {
            response.writeHead(405).end();
        }
    });
    await new Promise<void>(resolve => s3.listen(0, '127.0.0.1', resolve));
    try {
        const address = s3.address();
        if (!address || typeof address === 'string') throw new Error('Missing S3 fixture port');
        await initFilesS3FromEnv({ S3_HOST: '127.0.0.1', S3_PORT: String(address.port), S3_USE_SSL: 'false',
            S3_PUBLIC_URL: 'https://cdn.example.com', S3_BUCKET: 'public', S3_PRIVATE_BUCKET: 'private',
            S3_ACCESS_KEY: 'key', S3_SECRET_KEY: 'secret' });
        await loadFiles();
        const makeCreate = (blobId = crypto.randomUUID()) => ({ kind: 'create', artifactId: crypto.randomUUID(), blobId,
            header: 'AgAD', body: 'AgAE', dataEncryptionKey } satisfies ArtifactUploadDestinationV1);
        const content = { t: 'encrypted', c: 'AQID' } as const;
        // These opaque values use three stored bytes each for the header, body, and object.
        vi.stubEnv('HAPPIER_ARTIFACT_ACCOUNT_LIMIT_BYTES', '9');
        vi.stubEnv('HAPPIER_ARTIFACT_REVISION_RETENTION_COUNT', '1');
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const upload = (destination: ArtifactUploadDestinationV1) => app.inject({ method: 'POST', url: ARTIFACT_UPLOAD_PATH_V1,
                headers: { 'x-test-user-id': owner.id, 'content-type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1,
                    'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) },
                payload: Buffer.from(encodeArtifactUploadFrameV1(destination, content)) });
            const pending = makeCreate(pendingBlobId);
            const losing = upload(pending);
            try {
                await Promise.race([started.promise, losing.then(result => { throw new Error(`Upload stopped before S3 PUT: ${result.body}`); })]);
                const winner = makeCreate();
                const accepted = await upload(winner);
                expect(accepted.statusCode, accepted.body).toBe(200);
                release.resolve();
                const refused = await losing;
                expect(refused.statusCode, refused.body).toBe(413);
                expect(refused.json()).toEqual({ error: 'quota_exceeded', budget: 'account', limitBytes: 9, usedBytes: 18 });
                expect(writes).toHaveLength(2);
                expect(deletes).toEqual([writes[0]]);
                expect([...objects]).toEqual([writes[1]]);

                const full = await upload(makeCreate());
                expect(full.statusCode, full.body).toBe(413);
                expect(full.json()).toEqual(refused.json());
                const update = await upload({ kind: 'update', artifactId: winner.artifactId, blobId: crypto.randomUUID(),
                    expectedBodyVersion: 1, body: 'AgAF' });
                expect(update.statusCode, update.body).toBe(413);
                expect(update.json()).toMatchObject({ error: 'quota_exceeded', budget: 'account', limitBytes: 9 });
                vi.stubEnv('HAPPIER_ARTIFACT_DOCUMENT_LIMIT_BYTES', '8');
                const oversized = await upload(makeCreate());
                expect(oversized.statusCode, oversized.body).toBe(413);
                expect(oversized.json()).toEqual({ error: 'quota_exceeded', budget: 'document', limitBytes: 8, usedBytes: 9 });
                expect(writes).toHaveLength(2);
                expect(deletes).toEqual([writes[0]]);
                expect([...objects]).toEqual([writes[1]]);
                expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(1);
                expect(await db.artifactBlob.count({ where: { artifactId: winner.artifactId } })).toBe(1);
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);

                const replay = await upload(winner);
                expect(replay.statusCode, replay.body).toBe(200);
                expect([...objects]).toEqual([writes[1]]);
                expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
            } finally {
                release.resolve();
                await losing;
            }
        });
    } finally {
        vi.unstubAllEnvs();
        initFilesLocalFromEnv();
        await loadFiles();
        await new Promise<void>((resolve, reject) => s3.close(error => error ? reject(error) : resolve()));
    }
});

it.each(['plain', 'e2ee'] as const)('recovers the accepted %s CAS operation without accepting a competing operation or changed payload', async mode => {
    const owner = await db.account.create({ data: { encryptionMode: mode,
        ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
    const id = crypto.randomUUID();
    // E2EE content is opaque to the server; the signed recipient and sealed key use the real envelope owner.
    const header = mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'CAS replay' }) : encodeBase64(Uint8Array.of(2, 0, 3));
    const body = mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'before' }) : encodeBase64(Uint8Array.of(2, 0, 4));
    const acceptedBody = mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'accepted effect' }) : encodeBase64(Uint8Array.of(2, 0, 5));
    const dataEncryptionKey = mode === 'plain' ? Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64')
        : sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes });
    await db.artifact.create({ data: { id, accountId: owner.id, header: Buffer.from(header, 'base64'),
        body: Buffer.from(body, 'base64'), dataEncryptionKey,
        headerVersion: 1, bodyVersion: 1 } });
    await withAuthenticatedTestApp(artifactsRoutes, async app => {
        const send = (payload: object) => app.inject({ method: 'POST', url: `/v1/artifacts/${id}`,
            headers: { 'x-test-user-id': owner.id,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION) }, payload });
        // Known-good control uses the same real HTTP, admission and database path.
        expect((await send({ header, body, expectedHeaderVersion: 1, expectedBodyVersion: 1 })).json())
            .toEqual({ success: true, headerVersion: 2, bodyVersion: 2 });
        const operation = { updateOperationId: crypto.randomUUID(), header,
            body: acceptedBody, expectedHeaderVersion: 2, expectedBodyVersion: 2 };
        const accepted = await send(operation);
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(accepted.json()).toEqual({ success: true, headerVersion: 3, bodyVersion: 3 });
        // Ignore the first acknowledgement, then replay its exact operation.
        expect((await send(operation)).json()).toEqual(accepted.json());
        expect((await send({ ...operation, updateOperationId: crypto.randomUUID() })).json())
            .toMatchObject({ success: false, error: 'version-mismatch' });
        expect((await send({ ...operation, body })).json()).toMatchObject({ success: false, error: 'version-mismatch' });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } })).toMatchObject({ headerVersion: 3, bodyVersion: 3 });
        expect((await send({ header, body, expectedHeaderVersion: 3, expectedBodyVersion: 3 })).json())
            .toEqual({ success: true, headerVersion: 4, bodyVersion: 4 });
        expect((await send(operation)).json()).toMatchObject({ success: false, error: 'version-mismatch' });
    });
});

it.each(['plain', 'e2ee'] as const)('replays a framed %s HTTP upload after a lost ACK without another version or orphan upload', async mode => {
    const owner = await db.account.create({ data: { encryptionMode: mode,
        ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
    const id = crypto.randomUUID();
    const header = mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'Binary replay' }) : encodeBase64(Uint8Array.of(2, 0, 3));
    const body = mode === 'plain' ? encodePlainArtifactStoredContent({ body: 'before' }) : encodeBase64(Uint8Array.of(2, 0, 4));
    const dataEncryptionKey = mode === 'plain' ? Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64')
        : sealEncryptedDataKeyEnvelopeV1({ dataKey: tweetnacl.randomBytes(32),
            recipientPublicKey: owner.contentPublicKey!, randomBytes: tweetnacl.randomBytes });
    await db.artifact.create({ data: { id, accountId: owner.id,
        header: Buffer.from(header, 'base64'), body: Buffer.from(body, 'base64'),
        dataEncryptionKey, headerVersion: 1, bodyVersion: 1 } });
    const bytes = Buffer.from([0, 255, 42]);
    const blobId = crypto.randomUUID();
    const destination = { kind: 'update', artifactId: id, blobId,
        updateOperationId: crypto.randomUUID(), expectedHeaderVersion: 1, expectedBodyVersion: 1,
        header: mode === 'plain' ? encodePlainArtifactStoredContent({ title: 'Binary replay accepted' }) : encodeBase64(Uint8Array.of(2, 0, 5)),
        body: mode === 'plain' ? encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream',
            sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }) : encodeBase64(Uint8Array.of(2, 0, 6)) } satisfies ArtifactUploadDestinationV1;
    const content = mode === 'plain' ? { t: 'plain' as const, v: encodeBase64(bytes) }
        : { t: 'encrypted' as const, c: encodeBase64(bytes) };
    const frame = encodeArtifactUploadFrameV1(destination, content);
    let loseAck = true;
    // Drop only the network acknowledgement, after the real handler has committed its effect.
    const dropAck: onSendHookHandler = async (request, reply, payload) => {
        if (request.url === ARTIFACT_UPLOAD_PATH_V1 && loseAck) {
            loseAck = false;
            expect(reply.statusCode).toBe(200);
            reply.hijack();
            reply.raw.destroy();
        }
        return payload;
    };
    await withAuthenticatedTestApp(app => {
        app.addHook('onSend', dropAck);
        artifactsRoutes(app);
    }, async app => {
        const origin = await app.listen({ host: '127.0.0.1', port: 0 });
        const send = () => new Promise<{ statusCode: number | undefined; body: string }>((resolve, reject) => {
            const request = requestHttp(`${origin}${ARTIFACT_UPLOAD_PATH_V1}`, { method: 'POST', headers: {
                'x-test-user-id': owner.id, 'content-type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1,
                'x-happier-account-stored-content-protocol': String(CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION),
            } }, response => {
                const chunks: Buffer[] = [];
                response.on('data', chunk => chunks.push(Buffer.from(chunk)));
                response.on('error', reject);
                response.on('end', () => resolve({ statusCode: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            });
            request.on('error', reject);
            request.end(frame);
        });
        await expect(send()).rejects.toMatchObject({ code: 'ECONNRESET' });
        expect(loseAck).toBe(false);
        expect(await db.artifact.findUniqueOrThrow({ where: { id } }))
            .toMatchObject({ headerVersion: 2, bodyVersion: 2, currentBlobId: blobId });
        const replay = await send();
        expect(replay.statusCode, replay.body).toBe(200);
        expect(JSON.parse(replay.body)).toEqual({ success: true, headerVersion: 2, bodyVersion: 2 });
        expect(await db.artifact.findUniqueOrThrow({ where: { id } }))
            .toMatchObject({ headerVersion: 2, bodyVersion: 2, currentBlobId: blobId });
        expect(await db.artifactRevision.count({ where: { artifactId: id } })).toBe(1);
        expect(await db.artifactBlob.count({ where: { artifactId: id } })).toBe(1);
        expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
        const blob = await app.inject({ method: 'GET', url: `/v1/artifacts/${id}/blobs/${blobId}`,
            headers: { 'x-test-user-id': owner.id } });
        expect(blob.statusCode, blob.body).toBe(200);
        expect(blob.json()).toEqual({ blobId, content });
    });
});
