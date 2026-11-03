import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { artifactsRoutes } from '@/app/api/routes/artifacts/artifactsRoutes';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { listArtifactHeadersForCallerInTx } from './artifactAccessService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Template audience inspection (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('collects the complete selected audience only for owners and leaves recipient content readable', async () => {
        const account = () => db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'e2ee' } });
        const owner = await account();
        const recipient = await account();
        const peer = await account();
        const dataKey = tweetnacl.randomBytes(32);
        const seal = (publicKey: Uint8Array) => new Uint8Array(sealEncryptedDataKeyEnvelopeV1({
            dataKey, recipientPublicKey: publicKey, randomBytes: tweetnacl.randomBytes,
        }));
        const artifact = await db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }), header: new TextEncoder().encode('encrypted header'),
            body: new TextEncoder().encode('encrypted release'), dataEncryptionKey: seal(owner.contentPublicKey!),
            headerVersion: 1, bodyVersion: 1 } });
        await db.artifactAccountGrant.createMany({ data: [recipient, peer].map(person => ({ artifactId: artifact.id,
            accountId: person.id, accessLevel: 'view' as const, createdByAccountId: owner.id })) });
        await db.artifactKeyEnvelope.createMany({ data: [recipient, peer].map(person => ({ artifactId: artifact.id,
            recipientAccountId: person.id, encryptedDataKey: seal(person.contentPublicKey!),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(person.contentPublicKey!),
        })) });
        await db.artifact.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
            id: randomUUID(), accountId: recipient.id, kind: index % 2 ? null : deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
            header: new TextEncoder().encode('owned draft'), body: new TextEncoder().encode('private body'),
            dataEncryptionKey: seal(recipient.contentPublicKey!), headerVersion: 1, bodyVersion: 1,
            updatedAt: new Date(Date.now() + index + 1),
        })) });
        // A real provider client emits its actual statements; no domain owner is mocked.
        const { PrismaClient } = createRequire(import.meta.url)('@prisma/client') as typeof import('@prisma/client');
        const measuredClient = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        const statements: Prisma.QueryEvent[] = [];
        measuredClient.$on('query', event => { statements.push(event); });
        const observed = await (async () => {
            try {
                const captured = await measuredClient.$transaction(async tx => {
                    const query = observePrismaReads(tx, ['artifact']);
                    const result = await listArtifactHeadersForCallerInTx(query.tx, { actorAccountId: recipient.id,
                        audience: 'received', kinds: ['bot_template.v1'], limit: 1, cursor: null });
                    return { result, reads: query.rows };
                });
                const selectedStatement = statements.find(statement => /FROM "public"\."Artifact"/u.test(statement.query)
                    && /LIMIT/u.test(statement.query));
                expect(selectedStatement).toBeDefined();
                if (selectedStatement) {
                    expect(selectedStatement.query).not.toMatch(/"body"/u);
                    const parameters: unknown = JSON.parse(selectedStatement.params);
                    if (!Array.isArray(parameters)) throw new Error('Expected real PostgreSQL query parameters');
                    const plan = await measuredClient.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selectedStatement.query}`, ...parameters);
                    console.info('received-template-query-plan', JSON.stringify({ statements: statements.length,
                        artifactRowsTransferred: captured.reads.filter(row => row.model === 'artifact').map(row => row.count), plan }));
                }
                return captured;
            } finally { await measuredClient.$disconnect(); }
        })();
        expect(observed.result.map(row => row.id)).toEqual([artifact.id]);
        expect(observed.reads.filter(row => row.model === 'artifact').map(row => row.count)).toEqual([1]);
        expect(observed.result[0]).not.toHaveProperty('body');
        await withAuthenticatedTestApp(artifactsRoutes, async app => {
            const received = await app.inject({ method: 'GET',
                url: '/v1/artifacts?audience=received&kinds=%5B%22bot_template.v1%22%5D&limit=1',
                headers: { 'x-test-user-id': recipient.id } });
            expect(received.statusCode, received.body).toBe(200);
            expect(received.json()).toMatchObject({ items: [{ id: artifact.id }],
                coverage: { status: 'complete', unclassifiedCount: 0 } });
            for (const [actor, expected] of [[owner, [owner.id, recipient.id, peer.id]], [recipient, [recipient.id]]] as const) {
                const headers = { 'x-test-user-id': actor.id };
                const batch = await app.inject({ method: 'POST', url: '/v1/artifacts/read', headers, payload: { artifactIds: [artifact.id] } });
                expect(batch.statusCode, batch.body).toBe(200);
                const item = batch.json().items[0];
                expect(item).toMatchObject({ ok: true, artifact: { id: artifact.id } });
                expect(item.recipientCensus.recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId).sort())
                    .toEqual([...expected].sort());
                const census = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/access/recipients`, headers });
                expect(census.statusCode, census.body).toBe(200);
                expect(census.json().recipients.map((row: { recipientAccountId: string }) => row.recipientAccountId).sort())
                    .toEqual([...expected].sort());
                const grants = await app.inject({ method: 'GET', url: `/v1/artifacts/${artifact.id}/access/grants`, headers });
                expect(grants.statusCode, grants.body).toBe(200);
                expect(grants.json().grants).toHaveLength(actor.id === owner.id ? 2 : 1);
            }
        });
    });
});
