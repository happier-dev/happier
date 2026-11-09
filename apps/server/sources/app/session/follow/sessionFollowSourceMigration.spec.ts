import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { FollowPolicyV1Schema, resolveFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { applySqliteMigrations } from '../../../../scripts/prismaMigrations';

const migrations = resolve(import.meta.dirname, '../../../../prisma/sqlite/migrations');
const managerMigration = '20261018213000_merge_manager_follow_relation';
const machineSourceMigration = '20261024200000_execution_run_follow_machine_source';

describe('Session Follow source identity upgrades', () => {
    it('preserves every existing frontier and attachment while admitting a disjoint Discussion source', () => {
        const sqlite = new DatabaseSync(':memory:');
        try {
            // Only referenced resources are fixture boundaries; all Follow DDL and the
            // data transition below run from the actual canonical migration files.
            sqlite.exec(`PRAGMA foreign_keys = ON;
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "messageSeq" INTEGER);
                CREATE TABLE "DiscussionParticipant" ("discussionId" TEXT, "sessionId" TEXT, "removedAt" DATETIME);
                CREATE TABLE "SessionReportsTo" (
                    "sessionId" TEXT, "leadSessionId" TEXT, "attachedAt" DATETIME,
                    "deliveredTranscriptSeq" INTEGER, "deliveredReadyEventSeq" INTEGER,
                    "deliveredAgentStateVersion" INTEGER, "deliveredTurnId" TEXT, "deliveredTurnStatus" TEXT
                );
                INSERT INTO "Session" VALUES ('same-id'), ('destination'), ('other-source');
                INSERT INTO "AutomationRun" VALUES ('same-id');
                INSERT INTO "Discussion" VALUES ('same-id', 11);
                INSERT INTO "DiscussionParticipant" VALUES ('same-id', 'destination', NULL),
                    ('same-id', 'same-id', '2026-10-18 12:01:00'), ('same-id', NULL, NULL);`);
            sqlite.exec(readFileSync(resolve(migrations, '20260905230000_add_session_follow_edges/migration.sql'), 'utf8'));
            sqlite.exec(`INSERT INTO "SessionFollowEdge" VALUES ('same-id', 'destination', 'wake_on_human_change', 7, 8, 9, 'old-turn', 'failed');
                INSERT INTO "SessionReportsTo" VALUES ('same-id', 'destination', '2026-10-18 12:00:00.123', 3, 4, 5, 'manager-turn', 'completed');`);
            sqlite.exec(readFileSync(resolve(migrations, managerMigration, 'migration.sql'), 'utf8'));
            const before = sqlite.prepare('SELECT * FROM "SessionFollowEdge" ORDER BY "relation"').all();
            for (const name of readdirSync(migrations).filter(name => name > managerMigration && name < machineSourceMigration).sort()) {
                if (name === 'migration_lock.toml') continue;
                const sql = readFileSync(resolve(migrations, name, 'migration.sql'), 'utf8');
                if (/\b(?:ALTER TABLE|CREATE TABLE) "(?:new_)?SessionFollowEdge"/u.test(sql)) sqlite.exec(sql);
            }
            const after = sqlite.prepare('SELECT * FROM "SessionFollowEdge" WHERE "sourceSessionId" IS NOT NULL ORDER BY "relation"').all();
            expect(after.map(({ policyJson, sourceExecutionRunSessionId, sourceExecutionRunId, sourceWorkflowRunId,
                deliveredExecutionRunTerminalEventId, deliveredWorkflowRunRevision, ...row }) => row))
                .toEqual(before.map(({ mode, ...row }) => ({ ...row, sourceKey: 'session:same-id', sourceDiscussionId: null })));
            for (const row of after) {
                const policy = FollowPolicyV1Schema.parse(JSON.parse(String(row.policyJson)));
                expect(policy.preset).toBe(row.relation === 'manager' ? 'important' : 'custom');
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'person_wrote' } }).session.wake)
                    .toBe(row.relation === 'follower');
            }
            expect(sqlite.prepare('SELECT "sourceKey", "sourceSessionId", "destinationSessionId", "deliveredTranscriptSeq" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL').all())
                .toEqual([{ sourceKey: 'discussion:same-id', sourceSessionId: null, destinationSessionId: 'destination', deliveredTranscriptSeq: 11 }]);
            const discussionPolicy = sqlite.prepare('SELECT "policyJson" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL').get();
            expect(JSON.parse(String(discussionPolicy?.policyJson))).toEqual({ preset: 'important' });
            sqlite.exec(`INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceExecutionRunSessionId", "sourceExecutionRunId", "destinationSessionId", "policyJson", "deliveredExecutionRunTerminalEventId")
                VALUES ('execution_run:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'same-id', 'run-id', 'destination', '{"preset":"important"}', 'terminal-id');
                INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceWorkflowRunId", "destinationSessionId", "policyJson", "deliveredWorkflowRunRevision")
                VALUES ('workflow_run:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'same-id', 'destination', '{"preset":"important"}', 7);`);
            expect(sqlite.prepare(`SELECT "sourceSessionId", "sourceDiscussionId", "sourceExecutionRunSessionId", "sourceExecutionRunId", "sourceWorkflowRunId", "deliveredExecutionRunTerminalEventId", "deliveredWorkflowRunRevision"
                FROM "SessionFollowEdge" WHERE "sourceKey" LIKE '%_run:%' ORDER BY "sourceKey"`).all()).toEqual([
                { sourceSessionId: null, sourceDiscussionId: null, sourceExecutionRunSessionId: 'same-id', sourceExecutionRunId: 'run-id',
                    sourceWorkflowRunId: null, deliveredExecutionRunTerminalEventId: 'terminal-id', deliveredWorkflowRunRevision: null },
                { sourceSessionId: null, sourceDiscussionId: null, sourceExecutionRunSessionId: null, sourceExecutionRunId: null,
                    sourceWorkflowRunId: 'same-id', deliveredExecutionRunTerminalEventId: null, deliveredWorkflowRunRevision: 7 },
            ]);
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'same-id'
                WHERE "sourceExecutionRunId" = 'run-id'`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "sourceDiscussionId" = 'same-id'
                WHERE "sourceExecutionRunId" = 'run-id'`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "sourceKey" = 'session:other-source' WHERE "sourceDiscussionId" IS NOT NULL`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "sourceSessionId" = 'other-source' WHERE "sourceDiscussionId" IS NOT NULL`)).toThrow();
            expect(() => sqlite.exec(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'other-source'
                WHERE "sourceDiscussionId" IS NOT NULL`)).toThrow();
            sqlite.exec(`DELETE FROM "Discussion" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "SessionFollowEdge"').get()).toEqual({ n: 4 });
            sqlite.exec(`DELETE FROM "AutomationRun" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "SessionFollowEdge"').get()).toEqual({ n: 3 });
            expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
            sqlite.exec(`DELETE FROM "Session" WHERE "id" = 'same-id'`);
            expect(sqlite.prepare('SELECT COUNT(*) AS n FROM "SessionFollowEdge"').get()).toEqual({ n: 0 });
        } finally {
            sqlite.close();
        }
    });

    it('preserves the same upgrade and source constraints in PostgreSQL', async () => {
        const postgres = new PGlite();
        const postgresMigrations = resolve(migrations, '../../migrations');
        try {
            await postgres.waitReady;
            await postgres.exec(`CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "messageSeq" INTEGER);
                CREATE TABLE "DiscussionParticipant" ("discussionId" TEXT, "sessionId" TEXT, "removedAt" TIMESTAMP(3));
                INSERT INTO "Session" VALUES ('same-id'), ('destination'), ('other-source');
                INSERT INTO "AutomationRun" VALUES ('same-id');
                INSERT INTO "Discussion" VALUES ('same-id', 11);
                INSERT INTO "DiscussionParticipant" VALUES ('same-id', 'destination', NULL), ('same-id', 'same-id', CURRENT_TIMESTAMP);`);
            await postgres.exec(readFileSync(resolve(postgresMigrations, '20260905230000_add_session_follow_edges/migration.sql'), 'utf8'));
            await postgres.exec(`CREATE TABLE "SessionReportsTo" (
                "sessionId" TEXT, "leadSessionId" TEXT, "attachedAt" TIMESTAMP(3),
                "deliveredTranscriptSeq" INTEGER, "deliveredReadyEventSeq" INTEGER,
                "deliveredAgentStateVersion" INTEGER, "deliveredTurnId" TEXT, "deliveredTurnStatus" "SessionFollowDeliveredTurnStatus"
            );
            INSERT INTO "SessionFollowEdge" VALUES ('same-id', 'destination', 'wake_on_human_change', 7, 8, 9, 'old-turn', 'failed');
            INSERT INTO "SessionReportsTo" VALUES ('same-id', 'destination', '2026-10-18 12:00:00.123', 3, 4, 5, 'manager-turn', 'completed');`);
            await postgres.exec(readFileSync(resolve(postgresMigrations, managerMigration, 'migration.sql'), 'utf8'));
            const before = await postgres.query<Record<string, unknown>>('SELECT * FROM "SessionFollowEdge" ORDER BY "relation"');
            await postgres.exec(readFileSync(resolve(postgresMigrations, '20261018230000_session_follow_source_identity/migration.sql'), 'utf8'));
            await postgres.exec(readFileSync(resolve(postgresMigrations, '20261018233000_session_follow_policy/migration.sql'), 'utf8'));
            const genericEdgeMigration = resolve(postgresMigrations, '20261019150100_session_follow_run_sources/migration.sql');
            if (existsSync(genericEdgeMigration)) await postgres.exec(readFileSync(genericEdgeMigration, 'utf8'));
            const after = (await postgres.query<Record<string, unknown>>('SELECT * FROM "SessionFollowEdge" WHERE "sourceSessionId" IS NOT NULL ORDER BY "relation"')).rows;
            expect(after.map(({ policyJson, sourceExecutionRunSessionId, sourceExecutionRunId, sourceWorkflowRunId,
                deliveredExecutionRunTerminalEventId, deliveredWorkflowRunRevision, ...row }) => row))
                .toEqual(before.rows.map(({ mode, ...row }) => ({ ...row, sourceKey: 'session:same-id', sourceDiscussionId: null })));
            for (const row of after) {
                const policy = FollowPolicyV1Schema.parse(JSON.parse(String(row.policyJson)));
                expect(policy.preset).toBe(row.relation === 'manager' ? 'important' : 'custom');
                expect(resolveFollowDeliveryV1({ policies: [policy], event: { kind: 'person_wrote' } }).session.wake)
                    .toBe(row.relation === 'follower');
            }
            expect((await postgres.query('SELECT "sourceKey", "sourceSessionId", "destinationSessionId", "deliveredTranscriptSeq" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL')).rows)
                .toEqual([{ sourceKey: 'discussion:same-id', sourceSessionId: null, destinationSessionId: 'destination', deliveredTranscriptSeq: 11 }]);
            const discussionPolicy = (await postgres.query<{ policyJson: string }>('SELECT "policyJson" FROM "SessionFollowEdge" WHERE "sourceDiscussionId" IS NOT NULL')).rows[0];
            expect(JSON.parse(String(discussionPolicy?.policyJson))).toEqual({ preset: 'important' });
            await expect(postgres.exec(`UPDATE "SessionFollowEdge" SET "sourceKey" = 'session:other-source' WHERE "sourceDiscussionId" IS NOT NULL`))
                .rejects.toThrow();
            await expect(postgres.exec(`UPDATE "SessionFollowEdge" SET "sourceSessionId" = 'other-source' WHERE "sourceDiscussionId" IS NOT NULL`))
                .rejects.toThrow();
            await expect(postgres.exec(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'other-source' WHERE "sourceDiscussionId" IS NOT NULL`))
                .rejects.toThrow();
            await postgres.exec(`DELETE FROM "Discussion" WHERE "id" = 'same-id'`);
            expect((await postgres.query('SELECT COUNT(*)::int AS n FROM "SessionFollowEdge"')).rows).toEqual([{ n: 2 }]);
            await postgres.exec(`DELETE FROM "Session" WHERE "id" = 'same-id'`);
            expect((await postgres.query('SELECT COUNT(*)::int AS n FROM "SessionFollowEdge"')).rows).toEqual([{ n: 0 }]);
        } finally {
            await postgres.close();
        }
    });

    it.each(['sqlite', 'postgres'] as const)('adds exact Machine Run anchors without changing existing Follow custody (%s)', async provider => {
        const directory = provider === 'sqlite' ? mkdtempSync(resolve(tmpdir(), 'happier-follow-source-migration-')) : null;
        const databasePath = directory ? resolve(directory, 'follow.sqlite') : null;
        const database = databasePath ? new DatabaseSync(databasePath) : new PGlite();
        const execute = async (sql: string) => { await database.exec(sql); };
        const query = async (sql: string) => database instanceof DatabaseSync
            ? database.prepare(sql).all() : (await database.query<Record<string, unknown>>(sql)).rows;
        const root = provider === 'sqlite' ? migrations : resolve(migrations, '../../migrations');
        const migrate = async (name: string) => {
            const sql = readFileSync(resolve(root, name, 'migration.sql'), 'utf8');
            if (directory && databasePath && name === machineSourceMigration) {
                // Use the same Node adapter and transaction owner as deployed
                // SQLite migrations; raw exec alone misses nested BEGIN/COMMIT.
                const catalog = resolve(directory, 'migrations');
                const migrationDirectory = resolve(catalog, name);
                mkdirSync(migrationDirectory, { recursive: true });
                // The old migration wrapper must fail through the real runner;
                // a retry with canonical bytes must preserve the original rows.
                writeFileSync(resolve(migrationDirectory, 'migration.sql'), `BEGIN;\n${sql}\nCOMMIT;\n`);
                await expect(applySqliteMigrations({ databasePath, migrationsDir: catalog }))
                    .rejects.toThrow(/cannot start a transaction within a transaction/);
                writeFileSync(resolve(migrationDirectory, 'migration.sql'), sql);
                await expect(applySqliteMigrations({ databasePath, migrationsDir: catalog }))
                    .resolves.toEqual({ applied: [name] });
                await expect(applySqliteMigrations({ databasePath, migrationsDir: catalog }))
                    .resolves.toEqual({ applied: [] });
                return;
            }
            await execute(sql);
        };
        try {
            if (database instanceof PGlite) await database.waitReady;
            else database.exec('PRAGMA foreign_keys = ON;');
            await execute(`CREATE TABLE "Account" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "Discussion" ("id" TEXT PRIMARY KEY, "messageSeq" INTEGER);
                CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY);
                CREATE TABLE "DiscussionParticipant" ("discussionId" TEXT, "sessionId" TEXT, "removedAt" ${provider === 'sqlite' ? 'DATETIME' : 'TIMESTAMP(3)'});
                CREATE TABLE "ManagedMachine" ("homeId" TEXT, "custodianAccountId" TEXT, "archivedAt" TEXT, "createdAt" TEXT);
                CREATE INDEX "ManagedMachine_homeId_custodianAccountId_archivedAt_createdAt_idx"
                    ON "ManagedMachine" ("homeId", "custodianAccountId", "archivedAt", "createdAt");
                INSERT INTO "Account" VALUES ('account');
                INSERT INTO "Session" VALUES ('source'), ('destination');
                INSERT INTO "Machine" VALUES ('machine');
                INSERT INTO "Discussion" VALUES ('discussion', 3);
                INSERT INTO "AutomationRun" VALUES ('workflow');`);
            for (const name of ['20260906120000_add_account_session_follows', '20261018120000_account_follow_personal_once',
                '20261019150000_account_follow_generic_sources', '20261021045500_personal_run_permission_progress',
                '20261022140000_account_follow_policy_only', '20261023233000_account_follow_source_identity_required',
                '20260905230000_add_session_follow_edges']) await migrate(name);
            await execute(`CREATE TABLE "SessionReportsTo" (
                "sessionId" TEXT, "leadSessionId" TEXT, "attachedAt" ${provider === 'sqlite' ? 'DATETIME' : 'TIMESTAMP(3)'},
                "deliveredTranscriptSeq" INTEGER, "deliveredReadyEventSeq" INTEGER,
                "deliveredAgentStateVersion" INTEGER, "deliveredTurnId" TEXT, "deliveredTurnStatus" ${provider === 'sqlite' ? 'TEXT' : '"SessionFollowDeliveredTurnStatus"'}
            );
            INSERT INTO "SessionFollowEdge" VALUES ('source', 'destination', 'wake_on_human_change', 7, 8, 9, 'turn', 'failed');
            INSERT INTO "SessionReportsTo" VALUES ('source', 'destination', '2026-10-18 12:00:00.123', 3, 4, 5, 'manager-turn', 'completed');`);
            for (const name of [managerMigration, '20261018230000_session_follow_source_identity',
                '20261018233000_session_follow_policy', '20261019150100_session_follow_run_sources',
                '20261021200000_shorten_overlong_index_names']) await migrate(name);
            await execute(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sessionId", "followPolicy", "voiceDeliveredFrontier", "notifyOnce")
                VALUES ('legacy', 'account', 'source', '{"preset":"quiet"}', 'voice-frontier', '{"kind":"first_needs_you"}');
                INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceExecutionRunSessionId", "sourceExecutionRunId", "deliveredExecutionRunTerminalEventId", "deliveredExecutionRunPermissionKey", "followPolicy")
                VALUES ('session-run', 'account', 'execution_run:session', 'source', 'run', 'terminal', 'permission', '{"preset":"important"}');
                INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceExecutionRunSessionId", "sourceExecutionRunId", "destinationSessionId", "policyJson", "deliveredExecutionRunTerminalEventId")
                VALUES ('execution_run:session', 'source', 'run', 'destination', '{"preset":"important"}', 'terminal');`);
            const beforeAccount = await query('SELECT * FROM "AccountSessionFollow" ORDER BY "id"');
            const beforeEdges = await query('SELECT * FROM "SessionFollowEdge" ORDER BY "sourceKey", "relation"');
            // Before the additive migration exists, the intended Machine insert below
            // fails at the real storage boundary, establishing missing source support.
            if (existsSync(resolve(root, machineSourceMigration, 'migration.sql'))) await migrate(machineSourceMigration);
            await execute(`INSERT INTO "AccountSessionFollow" ("id", "accountId", "sourceKey", "sourceExecutionRunMachineId", "sourceExecutionRunId", "following", "hasPersistentFollow", "followPolicy", "notifyOnce", "deliveredExecutionRunTerminalEventId", "deliveredExecutionRunPermissionKey")
                VALUES ('machine-run', 'account', 'execution_run:machine', 'machine', 'run', false, false, NULL, '{"kind":"run_settled"}', 'machine-terminal', 'machine-permission');
                INSERT INTO "SessionFollowEdge" ("sourceKey", "sourceExecutionRunMachineId", "sourceExecutionRunId", "destinationSessionId", "policyJson", "deliveredExecutionRunTerminalEventId")
                VALUES ('execution_run:machine', 'machine', 'run', 'destination', '{"preset":"quiet"}', 'machine-terminal');`);
            expect((await query('SELECT * FROM "AccountSessionFollow" WHERE "id" <> \'machine-run\' ORDER BY "id"'))
                .map(({ sourceExecutionRunMachineId, ...row }) => row)).toEqual(beforeAccount);
            expect((await query('SELECT * FROM "SessionFollowEdge" WHERE "sourceKey" <> \'execution_run:machine\' ORDER BY "sourceKey", "relation"'))
                .map(({ sourceExecutionRunMachineId, ...row }) => row)).toEqual(beforeEdges);
            for (const table of ['AccountSessionFollow', 'SessionFollowEdge']) {
                for (const mutation of [
                    '"sourceExecutionRunSessionId" = \'source\'',
                    '"sourceExecutionRunMachineId" = NULL',
                    '"sourceExecutionRunId" = NULL',
                    '"sourceDiscussionId" = \'discussion\'',
                    '"sourceWorkflowRunId" = \'workflow\'',
                    '"sourceKey" = \'workflow_run:machine\'',
                    '"sourceKey" = \'executionXrun:machine\'',
                ]) await expect(execute(`UPDATE "${table}" SET ${mutation} WHERE "sourceKey" = 'execution_run:machine'`))
                    .rejects.toThrow(new RegExp(`${table}_source_identity_check`));
                await expect(execute(`UPDATE "${table}" SET "sourceExecutionRunMachineId" = 'machine' WHERE "sourceKey" = 'execution_run:session'`))
                    .rejects.toThrow(new RegExp(`${table}_source_identity_check`));
                await expect(execute(`UPDATE "${table}" SET "sourceExecutionRunMachineId" = 'missing-machine' WHERE "sourceKey" = 'execution_run:machine'`))
                    .rejects.toThrow();
            }
            await expect(execute(`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = 'source'
                WHERE "sourceKey" = 'execution_run:machine'`)).rejects.toThrow(/SessionFollowEdge_manager_relation_check/);
            await execute('DELETE FROM "Machine" WHERE "id" = \'machine\'');
            expect((await query('SELECT * FROM "AccountSessionFollow" ORDER BY "id"')).map(({ sourceExecutionRunMachineId, ...row }) => row)).toEqual(beforeAccount);
            expect((await query('SELECT * FROM "SessionFollowEdge" ORDER BY "sourceKey", "relation"')).map(({ sourceExecutionRunMachineId, ...row }) => row)).toEqual(beforeEdges);
            if (database instanceof DatabaseSync) {
                expect(await query('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
                expect(await query('PRAGMA foreign_key_check')).toEqual([]);
            }
        } finally {
            await database.close();
            if (directory) rmSync(directory, { recursive: true, force: true });
        }
    });
});
