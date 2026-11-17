import { afterAll, beforeAll, expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createHash } from 'node:crypto';
import { updateArtifactHttpMutation } from './artifactMutationHttpResponse';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'artifact-update-replay-',
    initAuth: false, initEncrypt: true, initFiles: true,
    env: { HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST: 'none' } }); }, 120_000);
afterAll(async () => await harness?.close());

it('recovers the accepted CAS operation without accepting a competing operation or changed payload', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const id = crypto.randomUUID();
    const header = encodePlainArtifactStoredContent({ title: 'CAS replay' });
    const body = encodePlainArtifactStoredContent({ body: 'before' });
    await db.artifact.create({ data: { id, accountId: owner.id, header: Buffer.from(header, 'base64'),
        body: Buffer.from(body, 'base64'), dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'),
        headerVersion: 1, bodyVersion: 1 } });
    await withAuthenticatedTestApp(artifactsRoutes, async app => {
        const send = (payload: object) => app.inject({ method: 'POST', url: `/v1/artifacts/${id}`,
            headers: { 'x-test-user-id': owner.id }, payload });
        // Known-good control uses the same real HTTP, admission and database path.
        expect((await send({ header, body, expectedHeaderVersion: 1, expectedBodyVersion: 1 })).json())
            .toEqual({ success: true, headerVersion: 2, bodyVersion: 2 });
        const operation = { updateOperationId: crypto.randomUUID(), header,
            body: encodePlainArtifactStoredContent({ body: 'accepted effect' }), expectedHeaderVersion: 2, expectedBodyVersion: 2 };
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

it('discards the unused binary upload when acknowledging the accepted operation', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const id = crypto.randomUUID();
    await db.artifact.create({ data: { id, accountId: owner.id,
        header: Buffer.from(encodePlainArtifactStoredContent({ title: 'Binary replay' }), 'base64'),
        body: Buffer.from(encodePlainArtifactStoredContent({ body: 'before' }), 'base64'),
        dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'), headerVersion: 1, bodyVersion: 1 } });
    const bytes = Buffer.from([0, 255, 42]);
    const blobId = crypto.randomUUID();
    const operation = { updateOperationId: crypto.randomUUID(), expectedBodyVersion: 1,
        body: encodePlainArtifactStoredContent({ body: { blobId, mime: 'application/octet-stream',
            sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }),
        blob: { blobId, content: { t: 'plain' as const, v: bytes.toString('base64') } } };
    const accepted = await updateArtifactHttpMutation(owner.id, id, operation);
    expect(accepted).toMatchObject({ statusCode: 200, body: { success: true, bodyVersion: 2 } });
    expect(await updateArtifactHttpMutation(owner.id, id, operation)).toEqual(accepted);
    expect(await db.artifactBlob.count({ where: { artifactId: id } })).toBe(1);
    expect(await db.uploadedFile.count({ where: { accountId: owner.id } })).toBe(0);
});
