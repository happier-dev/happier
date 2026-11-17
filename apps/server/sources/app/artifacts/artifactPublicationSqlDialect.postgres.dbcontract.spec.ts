import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeBase64 } from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db, initDbPostgres, shutdownDbClient } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createArtifact } from './artifactWriteService';
import { acquireArtifactPublicationLocksInTx } from './artifactAccessService';

describe.skipIf(process.env.HAPPIER_DB_PROVIDER !== 'postgres')('Artifact publication PostgreSQL-compatible SQL dialects', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Requires the disposable PostgreSQL DB-contract harness');
        }
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY', 'optional');
        vi.stubEnv('HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST', 'none');
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); vi.unstubAllEnvs(); });

    it.each(['postgres', 'pglite'])('holds the Artifact parent publication lock for %s', async backend => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifactId = randomUUID();
        expect(await createArtifact({ actorUserId: account.id, artifactId,
            header: decodeBase64(encodePlainArtifactStoredContent({ title: 'Publication lock' })),
            body: decodeBase64(encodePlainArtifactStoredContent({ body: 'Artifact content' })),
            dataEncryptionKey: decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) })).toMatchObject({ ok: true });
        const previous = process.env.HAPPIER_DB_PROVIDER;
        try {
            // Keep the real PostgreSQL adapter while selecting PGlite's SQL dialect.
            process.env.HAPPIER_DB_PROVIDER = backend;
            await inTx(async tx => {
                await acquireArtifactPublicationLocksInTx(tx, artifactId);
                await expect(db.$transaction(peer => peer.$queryRawUnsafe(
                    'SELECT "id" FROM "Artifact" WHERE "id" = $1 FOR UPDATE NOWAIT', artifactId,
                ))).rejects.toThrow(/could not obtain lock on row/);
            });
        } finally {
            if (previous === undefined) delete process.env.HAPPIER_DB_PROVIDER;
            else process.env.HAPPIER_DB_PROVIDER = previous;
        }
        expect(await db.artifact.findUnique({ where: { id: artifactId }, select: { id: true } })).toEqual({ id: artifactId });
    });
});
