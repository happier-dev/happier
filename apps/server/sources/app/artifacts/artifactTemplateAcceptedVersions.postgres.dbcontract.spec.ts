import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import * as privacyKit from 'privacy-kit';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { listArtifactAccessGrantsInTx } from './artifactAccessService';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Template accepted-version query (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run only through the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('groups one selected source without loading copy routing, Sessions or unrelated reports', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const recipient = await db.account.create({ data: { encryptionMode: 'plain' } });
        const artifact = () => db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: 'bot_template.v1' }),
            header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'bot_template.v1' })),
            body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ opaque: true })),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER),
            headerVersion: 1, bodyVersion: 1 } });
        const source = await artifact();
        const unrelated = await artifact();
        await db.artifactAccountGrant.create({ data: { artifactId: source.id, accountId: recipient.id,
            createdByAccountId: owner.id, accessLevel: 'view' } });
        await db.artifactTemplateAcceptedVersion.createMany({ data: [
            { artifactId: source.id, recipientAccountId: recipient.id, copyId: 'private-a', acceptedVersion: '1.0.0' },
            { artifactId: source.id, recipientAccountId: recipient.id, copyId: 'private-b', acceptedVersion: '2.0.0' },
            ...Array.from({ length: 1000 }, (_, index) => ({ artifactId: unrelated.id,
                recipientAccountId: recipient.id, copyId: `unrelated-${index}`, acceptedVersion: '9.0.0' })),
        ] });
        const { PrismaClient } = createRequire(import.meta.url)('@prisma/client') as typeof import('@prisma/client');
        const client = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
        const statements: Prisma.QueryEvent[] = [];
        client.$on('query', event => { statements.push(event); });
        try {
            const ownerView = await client.$transaction(tx => listArtifactAccessGrantsInTx(tx, {
                actorAccountId: owner.id, artifactId: source.id,
            }));
            expect(ownerView).toMatchObject({ ok: true, value: { grants: [{ acceptedVersions: [
                { version: '1.0.0', copies: 1 }, { version: '2.0.0', copies: 1 },
            ] }] } });
            const grouped = statements.filter(statement => /FROM "public"\."ArtifactTemplateAcceptedVersion"/u.test(statement.query));
            expect(grouped).toHaveLength(1);
            const query = grouped[0];
            expect(query.query).toMatch(/WHERE .*"artifactId" =/u);
            expect(query.query).toContain('GROUP BY');
            expect(query.query).not.toContain('"copyId"');
            expect(statements.some(statement => /FROM "public"\."Session"/u.test(statement.query))).toBe(false);
            const parameters: unknown = JSON.parse(query.params);
            if (!Array.isArray(parameters)) throw new Error('Expected real PostgreSQL query parameters');
            expect(parameters).toContain(source.id);
            const plan = await client.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.query}`, ...parameters);
            console.info('accepted-template-version-query-plan', JSON.stringify({ groupedStatements: grouped.length, plan }));
            statements.length = 0;
            const recipientView = await client.$transaction(tx => listArtifactAccessGrantsInTx(tx, {
                actorAccountId: recipient.id, artifactId: source.id,
            }));
            expect(recipientView).toMatchObject({ ok: true, value: { grants: [{ principal: { kind: 'account', accountId: recipient.id } }] } });
            expect(JSON.stringify(recipientView)).not.toContain('acceptedVersions');
            expect(statements.some(statement => statement.query.includes('ArtifactTemplateAcceptedVersion'))).toBe(false);
        } finally { await client.$disconnect(); }
    });
});
