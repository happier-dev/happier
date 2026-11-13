import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerSessionFilteredListingRoute } from '@/app/api/routes/session/registerSessionFilteredListingRoute';
import { db, getDbProviderFromEnv, initDbPostgres, shutdownDbClient } from '@/storage/db';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Project selection before Session pagination (PostgreSQL)', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Run with the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await shutdownDbClient(); });

    it('returns only accepted Project matches plus unpublished candidates, preserving access, cursors and updates', async () => {
        const prefix = `project-selection-${randomUUID()}`;
        const [owner, foreign] = await Promise.all([0, 1].map(index => db.account.create({ data: {
            id: `${prefix}-account-${index}`, publicKey: `${prefix}-key-${index}`, encryptionMode: 'plain',
        } })));
        // Reuse queryPlan's workload above the measured heavy Account's 2,450
        // null-key Sessions; a sparse Project contains three accepted rows.
        const ids = Array.from({ length: 2748 }, (_, index) => `${prefix}-session-${index}`);
        const app = createAuthenticatedTestApp();
        registerSessionFilteredListingRoute(app);
        const headers = { 'x-test-user-id': owner.id,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
        await db.session.createMany({ data: ids.map((id, index) => ({ id, accountId: owner.id, tag: id,
            encryptionMode: 'plain', metadataLayoutVersion: 1, metadata: '{"v":1}', ownerMetadata: '{"t":"plain","v":{"v":1}}',
            projectKey: index < 3 ? 'payments' : index <= 5 ? null : 'other', meaningfulActivityAt: new Date(index),
            // Two owner-published "no Project" rows: skipped by an include, admitted by an exclude-only selection.
            projectKeyNone: index === 4 || index === 5,
        })) });
        await db.session.create({ data: { id: `${prefix}-foreign`, tag: prefix, accountId: foreign.id,
            projectKey: 'payments', encryptionMode: 'plain', metadata: '{}' } });
        const read = async (include: string[], exclude: string[]) => {
            const selected: string[] = [];
            let cursor: string | undefined;
            do {
                const response = await app.inject({ method: 'POST', url: '/v2/sessions/query', headers, payload: {
                    v: 1, storage: 'active', scope: 'my_work', attention: 'any', includeInactive: true,
                    audiences: [], tagIds: [], projectKeys: { include, exclude }, limit: 2, includeAttention: false,
                    ...(cursor ? { cursor } : {}),
                } });
                expect(response.statusCode, response.body).toBe(200);
                const page = response.json();
                selected.push(...page.sessions.map((row: { id: string }) => row.id));
                expect(page.sessions.length).toBeLessThanOrEqual(2);
                cursor = page.hasNext ? page.nextCursor : undefined;
                if (page.hasNext) expect(cursor).toBeTruthy();
                // A broad or repeating query must fail promptly instead of paging the whole fixture.
                expect(selected.length).toBeLessThanOrEqual(6);
            } while (cursor);
            return selected.sort();
        };
        try {
            const expected = ids.slice(0, 4).sort();
            expect(await read(['payments'], [])).toEqual(expected);
            expect(await read([], ['other'])).toEqual(ids.slice(0, 6).sort());
            await db.session.update({ where: { id: ids[4] }, data: { projectKey: 'payments', projectKeyNone: false } });
            expect(await read(['payments'], [])).toEqual(ids.slice(0, 5).sort());
        } finally {
            await app.close();
            await db.session.deleteMany({ where: { accountId: { in: [owner.id, foreign.id] } } });
            await db.account.deleteMany({ where: { id: { in: [owner.id, foreign.id] } } });
        }
    });
});
