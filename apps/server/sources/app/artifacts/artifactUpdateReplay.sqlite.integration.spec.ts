import { afterAll, beforeAll, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION, encodePlainArtifactStoredContent, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, encodeArtifactUploadFrameV1, type ArtifactUploadDestinationV1 } from '@happier-dev/transfers';
import { encodeBase64 } from 'privacy-kit';
import tweetnacl from 'tweetnacl';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createHash } from 'node:crypto';
import { request as requestHttp } from 'node:http';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import type { onSendHookHandler } from 'fastify';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'artifact-update-replay-',
    initAuth: false, initEncrypt: true, initFiles: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'none' } }); }, 120_000);
afterAll(async () => await harness?.close());

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
