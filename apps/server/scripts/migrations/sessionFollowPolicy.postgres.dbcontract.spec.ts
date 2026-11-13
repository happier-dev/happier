import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { FollowPolicyV1Schema, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import { splitMigrationStatements } from '../../sources/migrations/missingMigrationReconciliation';

// Never fall back to a retained application database.
const testDatabaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL?.trim();

describe('Follow policy PostgreSQL migration', () => {
    (testDatabaseUrl ? it : it.skip)('preserves original route custody and converts old delivery intent once', async () => {
        const schema = `follow_policy_${randomUUID().replaceAll('-', '')}`;
        const admin = new PrismaClient({ datasourceUrl: testDatabaseUrl });
        const target = new URL(testDatabaseUrl!);
        target.searchParams.set('schema', schema);
        const database = new PrismaClient({ datasourceUrl: target.toString() });
        const execute = async (sql: string) => {
            // Match the migration owner's per-file transaction, including
            // transaction-scoped locks in the retained merge migration.
            await database.$transaction(async tx => {
                for (const statement of splitMigrationStatements(sql)) await tx.$executeRawUnsafe(statement);
            });
        };
        const migrations = resolve(import.meta.dirname, '../../prisma/migrations');
        const apply = async (name: string) => execute(await readFile(resolve(migrations, name, 'migration.sql'), 'utf8'));
        let created = false;
        try {
            await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
            created = true;
            await execute(`CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "messageSeq" INTEGER NOT NULL);
                CREATE TABLE "DiscussionParticipant" ("discussionId" TEXT, "sessionId" TEXT, "removedAt" TIMESTAMP(3));
                INSERT INTO "Session" VALUES ('worker'), ('destination'), ('other');
                INSERT INTO "Discussion" VALUES ('worker', 17);
                INSERT INTO "DiscussionParticipant" VALUES ('worker', 'destination', NULL);`);
            await apply('20260905230000_add_session_follow_edges');
            await apply('20260930120000_add_session_reports_to');
            await execute(`INSERT INTO "SessionFollowEdge" VALUES ('worker', 'destination', 'next_turn', 7, 8, 9, 'ordinary-turn', 'completed'),
                    ('other', 'destination', 'wake_on_human_change', 11, 12, 13, 'other-turn', 'failed');
                INSERT INTO "SessionReportsTo" VALUES ('worker', 'destination', '2026-10-18 12:00:00.123', 3, 4, 5, 'manager-turn', NULL);`);
            await apply('20261018213000_merge_manager_follow_relation');
            await apply('20261018230000_session_follow_source_identity');
            // JSON keeps the prepared query's result type stable across column DDL.
            const readRows = async () => (await database.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
                'SELECT to_jsonb(edge) AS row FROM "SessionFollowEdge" AS edge ORDER BY "sourceKey", "relation"')).map(result => result.row);
            const before = await readRows();
            await apply('20261018233000_session_follow_policy');
            const after = await readRows();
            expect(after.map(({ policyJson, ...row }) => row)).toEqual(before.map(({ mode, ...row }) => row));
            expect(after).toHaveLength(4);
            for (const row of after) {
                const policy = FollowPolicyV1Schema.parse(JSON.parse(String(row.policyJson)));
                if (row.relation === 'manager' || row.sourceDiscussionId !== null) {
                    expect(policy).toEqual({ preset: 'important' });
                    continue;
                }
                expect(policy.preset).toBe('custom');
                for (const event of [{ kind: 'needs_you', type: 'decision' }, { kind: 'needs_you', type: 'approval' },
                    { kind: 'needs_you', type: 'blocked' }, { kind: 'finished' }, { kind: 'failed_or_stopped' },
                    { kind: 'stalled' }, { kind: 'update_posted' }, { kind: 'goal_changed' }, { kind: 'message' }] as const) {
                    expect(resolveFollowDeliveryV1({ policies: [policy], event }).session).toEqual({ nextTurn: true, wake: false });
                }
                const humanWake = row.sourceKey !== 'session:worker';
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'person_wrote' } }).session)
                    .toEqual({ nextTurn: !humanWake, wake: humanWake });
            }
            expect(await database.$queryRawUnsafe(`SELECT column_name FROM information_schema.columns
                WHERE table_schema = current_schema() AND table_name = 'SessionFollowEdge' AND column_name = 'mode'`)).toEqual([]);
            await expect(database.$executeRawUnsafe(`INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceSessionId", "destinationSessionId")
                VALUES ('session:destination', 'destination', 'other')`)).rejects.toThrow();
            await expect(database.$executeRawUnsafe(`INSERT INTO "SessionFollowEdge"
                ("sourceKey", "sourceSessionId", "destinationSessionId", "relation", "managerSourceSessionId", "policyJson")
                VALUES ('session:worker', 'worker', 'other', 'manager', 'worker', '{"preset":"important"}')`)).rejects.toThrow();
            await database.$executeRawUnsafe(`DELETE FROM "Discussion" WHERE "id" = 'worker'`);
            expect(await database.sessionFollowEdge.count()).toBe(3);
        } finally {
            await database.$disconnect();
            if (created) await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
            await admin.$disconnect();
        }
    });
});
