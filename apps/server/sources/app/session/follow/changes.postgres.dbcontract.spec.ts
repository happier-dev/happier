import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, buildSessionFollowChangeHintV1, readSessionFollowChangeHintV1 } from '@happier-dev/protocol/sessions/follow/changes';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { markSessionFollowsChangedForAccountsInTx } from './changes';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Follow publication write cost', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
            || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        connected = true;
        // Observe physical storage effects, including a hint-only tail, while
        // every Follow/publication/coalescing decision remains real.
        await db.$executeRawUnsafe('CREATE TABLE "FollowWriteObservation" ("accountId" text NOT NULL, "operation" text NOT NULL)');
        await db.$executeRawUnsafe(`CREATE FUNCTION "observeFollowPublicationWrite"() RETURNS trigger
            LANGUAGE plpgsql AS $$ BEGIN
                IF TG_LEVEL = 'STATEMENT' THEN
                    INSERT INTO "FollowWriteObservation" ("accountId", "operation") VALUES ('', TG_OP || '-STATEMENT');
                    RETURN NULL;
                END IF;
                INSERT INTO "FollowWriteObservation" ("accountId", "operation") VALUES (NEW."accountId", TG_OP);
                RETURN NEW;
            END $$`);
        await db.$executeRawUnsafe(`CREATE TRIGGER "observeFollowPublicationWrite"
            AFTER INSERT OR UPDATE ON "AccountChange" FOR EACH ROW EXECUTE FUNCTION "observeFollowPublicationWrite"()`);
        await db.$executeRawUnsafe(`CREATE TRIGGER "observeFollowPublicationStatements"
            AFTER INSERT OR UPDATE ON "AccountChange" FOR EACH STATEMENT EXECUTE FUNCTION "observeFollowPublicationWrite"()`);
    });
    afterAll(async () => {
        if (!connected) return;
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "observeFollowPublicationStatements" ON "AccountChange"');
        await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS "observeFollowPublicationWrite" ON "AccountChange"');
        await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS "observeFollowPublicationWrite"()');
        await db.$executeRawUnsafe('DROP TABLE IF EXISTS "FollowWriteObservation"');
        await db.$disconnect();
    });

    it.each([1, 100])('writes each Follow hint once for %i recipients with unchanged reader bytes and cursors', async count => {
        const accountIds = Array.from({ length: count }, () => randomUUID()).sort();
        await db.account.createMany({ data: accountIds.map(id => ({ id, encryptionMode: 'plain' })) });
        const [canonical] = await db.$queryRawUnsafe<Array<{ bytes: string }>>(
            'SELECT $1::jsonb::text AS bytes', JSON.stringify(buildSessionFollowChangeHintV1()),
        );
        try {
            for (const cursor of [1, 2]) {
                await db.$executeRawUnsafe('DELETE FROM "FollowWriteObservation"');
                const publications = await inTx(tx => markSessionFollowsChangedForAccountsInTx(tx, [...accountIds].reverse()));
                expect(publications.map(publication => ({ accountId: publication.accountId, cursor: publication.resolveCursor() })))
                    .toEqual(accountIds.map(accountId => ({ accountId, cursor })));
                // Match the feed reader's cursor filter and strict Follow
                // consumer, including the coalesced row's exact JSONB bytes.
                const rows = await db.accountChange.findMany({ where: {
                    accountId: { in: accountIds }, cursor: { gt: cursor - 1 }, kind: 'account',
                    entityId: ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID,
                }, orderBy: { accountId: 'asc' }, select: { accountId: true, cursor: true, hint: true } });
                expect(rows).toEqual(accountIds.map(accountId => ({ accountId, cursor, hint: buildSessionFollowChangeHintV1() })));
                for (const row of rows) expect(readSessionFollowChangeHintV1(row.hint)).toEqual(buildSessionFollowChangeHintV1());
                const stored = await db.$queryRawUnsafe<Array<{ bytes: string }>>(
                    'SELECT "hint"::text AS bytes FROM "AccountChange" WHERE "accountId" = ANY($1::text[])', accountIds,
                );
                expect(stored.map(row => row.bytes)).toEqual(accountIds.map(() => canonical.bytes));
                expect(await db.accountChange.count({ where: { accountId: { in: accountIds }, cursor: { gt: cursor } } })).toBe(0);
                const [writes] = await db.$queryRawUnsafe<Array<{ inserts: number; updates: number }>>(
                    `SELECT count(*) FILTER (WHERE "operation" = 'INSERT')::int AS inserts,
                        count(*) FILTER (WHERE "operation" = 'UPDATE')::int AS updates FROM "FollowWriteObservation"`,
                );
                expect(writes).toEqual(cursor === 1 ? { inserts: count, updates: 0 } : { inserts: 0, updates: count });
                // PostgreSQL fires both statement triggers for an upsert,
                // even on an insert-only attempt. Fanout remains one upsert.
                const [statements] = await db.$queryRawUnsafe<Array<{ inserts: number; updates: number }>>(
                    `SELECT count(*) FILTER (WHERE "operation" = 'INSERT-STATEMENT')::int AS inserts,
                        count(*) FILTER (WHERE "operation" = 'UPDATE-STATEMENT')::int AS updates FROM "FollowWriteObservation"`,
                );
                expect(statements).toEqual({ inserts: 1, updates: 1 });
            }
        } finally {
            await db.account.deleteMany({ where: { id: { in: accountIds } } });
        }
    });
});
