import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from '@electric-sql/pglite';

const ROOT = join(import.meta.dirname, "..", "..");
const MIGRATION_ID = "20260908120000_add_workflow_run_invocations";

const WORKFLOW_INVOCATION_LIFECYCLES = [
    "pending",
    "waiting_for_capacity",
    "admitting",
    "running",
    "waiting_for_approval",
    "needs_attention",
    "completed",
    "failed",
    "skipped",
    "cancel_requested",
    "cancelled",
    "outcome_uncertain",
    "superseded",
] as const;

const DIRECT_ORIGIN_NULL_COLUMNS = [
    "automationId",
    "triggerId",
    "causeKind",
    "causeTriggerKind",
    "causeTriggerRevision",
    "causeEventPluginId",
    "causeEventLocalId",
    "causeOccurredAt",
    "causeScheduledFor",
    "causeSessionLifecycleEvent",
    "causeSourceSessionId",
    "causeSourceTurnId",
    "causeSessionLifecycleRequestId",
    "causeSessionLifecycleRequestKind",
    "causeSessionLifecyclePolicyKind",
    "causeSessionLifecycleConfiguredCount",
    "occurrenceKey",
    "idempotencyKey",
    "occurrenceEvidenceEqualityTag",
    "causeSourceSelectorId",
    "triggerEvidenceEnvelope",
    "replyContextEnvelope",
    "replyHandoffActionPluginId",
    "replyHandoffActionLocalId",
    "replyHandoffTargetMachineId",
    "replyHandoffTargetMachineInstallationId",
    "replyHandoffTargetMaterializationId",
    "replyHandoffId",
    "replyHandoffDueAt",
] as const;

function normalizeSql(sql: string): string {
    return sql.replaceAll("`", '"').replace(/\s+/gu, " ").trim();
}

describe("workflow Run persistence contract", () => {
    it('adds only nullable failure identity acknowledgement while retaining existing Run data in isolated providers', async () => {
        const migration = '20261024010000_workflow_failure_seen/migration.sql';
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            readFile(join(ROOT, 'prisma/migrations', migration), 'utf8'),
            readFile(join(ROOT, 'prisma/sqlite/migrations', migration), 'utf8'),
            readFile(join(ROOT, 'prisma/mysql/migrations', migration), 'utf8'),
        ]);
        // MySQL has no embedded engine here. SQLite executes its unchanged portable
        // ALTER grammar below; that does not prove native MySQL precision behavior.
        expect(normalizeSql(mysqlSql)).toBe('ALTER TABLE "AutomationRun" ADD COLUMN "attentionSeenFailureAt" DATETIME(3) NULL;');
        expect(normalizeSql(postgresSql)).toBe('ALTER TABLE "AutomationRun" ADD COLUMN "attentionSeenFailureAt" TIMESTAMP(3);');
        expect(normalizeSql(sqliteSql)).toBe('ALTER TABLE "AutomationRun" ADD COLUMN "attentionSeenFailureAt" DATETIME;');
        const { DatabaseSync } = await import('node:sqlite');
        const sqlite = new DatabaseSync(':memory:');
        const mysqlPortable = new DatabaseSync(':memory:');
        const postgres = new PGlite();
        try {
            sqlite.exec(`CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY, "state" TEXT NOT NULL,
                "revision" INTEGER NOT NULL, "finishedAt" DATETIME);
                INSERT INTO "AutomationRun" VALUES ('failed','failed',2,100),('queued','queued',0,NULL);`);
            const beforeSqlite = sqlite.prepare('SELECT * FROM "AutomationRun" ORDER BY "id"').all();
            sqlite.exec(sqliteSql);
            expect(sqlite.prepare('SELECT "id","state","revision","finishedAt" FROM "AutomationRun" ORDER BY "id"').all()).toEqual(beforeSqlite);
            expect(sqlite.prepare('SELECT "attentionSeenFailureAt" FROM "AutomationRun"').all())
                .toEqual([{ attentionSeenFailureAt: null }, { attentionSeenFailureAt: null }]);
            expect(sqlite.prepare('PRAGMA table_info("AutomationRun")').all().find(column => column.name === 'attentionSeenFailureAt'))
                .toMatchObject({ type: 'DATETIME', notnull: 0, dflt_value: null });
            sqlite.exec(`UPDATE "AutomationRun" SET "attentionSeenFailureAt"="finishedAt" WHERE "id"='failed';
                UPDATE "AutomationRun" SET "revision"=3 WHERE "id"='failed';`);
            expect(sqlite.prepare('SELECT "revision","finishedAt","attentionSeenFailureAt" FROM "AutomationRun" WHERE "id"=?').get('failed'))
                .toEqual({ revision: 3, finishedAt: 100, attentionSeenFailureAt: 100 });
            expect(sqlite.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
            mysqlPortable.exec(`CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY, "state" TEXT NOT NULL,
                "revision" INTEGER NOT NULL, "finishedAt" DATETIME(3));
                INSERT INTO "AutomationRun" VALUES ('failed','failed',2,100),('queued','queued',0,NULL);`);
            const beforeMysqlPortable = mysqlPortable.prepare('SELECT * FROM "AutomationRun" ORDER BY "id"').all();
            mysqlPortable.exec(mysqlSql);
            expect(mysqlPortable.prepare('SELECT "id","state","revision","finishedAt" FROM "AutomationRun" ORDER BY "id"').all()).toEqual(beforeMysqlPortable);
            expect(mysqlPortable.prepare('SELECT "attentionSeenFailureAt" FROM "AutomationRun"').all())
                .toEqual([{ attentionSeenFailureAt: null }, { attentionSeenFailureAt: null }]);
            expect(mysqlPortable.prepare('PRAGMA table_info("AutomationRun")').all().find(column => column.name === 'attentionSeenFailureAt'))
                .toMatchObject({ type: 'DATETIME(3)', notnull: 0, dflt_value: null });
            expect(mysqlPortable.prepare('PRAGMA integrity_check').get()).toMatchObject({ integrity_check: 'ok' });
            await postgres.exec(`CREATE TABLE "AutomationRun" ("id" TEXT PRIMARY KEY, "state" TEXT NOT NULL,
                "revision" INTEGER NOT NULL, "finishedAt" TIMESTAMP(3));
                INSERT INTO "AutomationRun" VALUES ('failed','failed',2,'2026-10-23T10:00:00Z'),('queued','queued',0,NULL);`);
            const beforePostgres = await postgres.query('SELECT * FROM "AutomationRun" ORDER BY "id"');
            await postgres.exec(postgresSql);
            expect((await postgres.query('SELECT "id","state","revision","finishedAt" FROM "AutomationRun" ORDER BY "id"')).rows)
                .toEqual(beforePostgres.rows);
            expect((await postgres.query('SELECT "attentionSeenFailureAt" FROM "AutomationRun"')).rows)
                .toEqual([{ attentionSeenFailureAt: null }, { attentionSeenFailureAt: null }]);
            expect((await postgres.query(`SELECT data_type,is_nullable,datetime_precision,column_default FROM information_schema.columns
                WHERE table_name='AutomationRun' AND column_name='attentionSeenFailureAt'`)).rows)
                .toEqual([{ data_type: 'timestamp without time zone', is_nullable: 'YES', datetime_precision: 3, column_default: null }]);
            await postgres.exec(`UPDATE "AutomationRun" SET "attentionSeenFailureAt"="finishedAt" WHERE "id"='failed';
                UPDATE "AutomationRun" SET "revision"=3 WHERE "id"='failed';`);
            expect((await postgres.query(`SELECT "revision", "attentionSeenFailureAt"="finishedAt" AS "sameFailure"
                FROM "AutomationRun" WHERE "id"='failed'`)).rows).toEqual([{ revision: 3, sameFailure: true }]);
        } finally { sqlite.close(); mysqlPortable.close(); await postgres.close(); }
    });

    it.each([
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ])("keeps one origin-neutral Run parent and one invocation row store in %s", async (relativePath) => {
        const schema = await readFile(join(ROOT, relativePath), "utf8");
        expect(schema).toContain("originKind                 String   @default(\"automation\")");
        expect(schema).toContain("automationId               String?");
        expect(schema).toContain('originSession              Session? @relation("WorkflowRunOriginSession", fields: [originSessionId], references: [id], onDelete: SetNull)');
        expect(schema).toContain("workflowAcceptedSnapshotEnvelope String?");
        expect(schema).toContain("workflowCheckpointEnvelope String?");
        expect(schema).toContain("workflowCustodyState       WorkflowRunCustodyState?");
        expect(schema).toMatch(/^\s*originDeliveryAckRevision\s+Int\?\s*$/mu);
        expect(schema).toMatch(/^\s*attentionSeenFailureAt\s+DateTime\?\s*$/mu);
        expect(schema).not.toContain("workflowResultDeliveryState");
        expect(schema).not.toContain("WorkflowRunResultDeliveryState");
        expect(schema).toMatch(/model AccountEncryptionTransitionAutomationStage \{[\s\S]*?automationId\s+String\?[\s\S]*?sourceRevision\s+Int\?/u);
        expect(schema).toContain("model WorkflowRunInvocation {");
        expect(schema).toContain("sequence        BigInt");
        expect(schema).toContain("memberOrdinal   BigInt");
        expect(schema).toContain("attempt         BigInt   @default(0)");
        expect(schema).toContain("lifecycle       WorkflowInvocationLifecycle @default(pending)");
        expect(schema).toContain("contentEnvelope String");
        expect(schema).toContain('@@unique([runId, sequence], map: "WorkflowRunInvocation_run_sequence_key")');
        expect(schema).toContain('@@unique([runId, parentRecordId, memberOrdinal, attempt], map: "WorkflowRunInvocation_slot_attempt_key")');
        expect(schema).toContain('@@index([runId, lifecycle, sequence], map: "WorkflowRunInvocation_lifecycle_idx")');
        expect(schema).toMatch(/@@index\(\[accountId, createdAt(?:\(sort: Desc\))?, id(?:\(sort: Desc\))?\], map: "AutomationRun_account_created_id_idx"\)/u);
        if (relativePath === "prisma/mysql/schema.prisma") {
            expect(schema).toMatch(/^\s*workflowAcceptedSnapshotEnvelope\s+String\?\s+@db\.LongText$/mu);
            expect(schema).toMatch(/^\s*workflowCheckpointEnvelope\s+String\?\s+@db\.LongText$/mu);
            expect(schema).toMatch(/^\s*contentEnvelope\s+String\s+@db\.LongText$/mu);
        }
    });

    it.each([
        `prisma/migrations/${MIGRATION_ID}/migration.sql`,
        `prisma/sqlite/migrations/${MIGRATION_ID}/migration.sql`,
        `prisma/mysql/migrations/${MIGRATION_ID}/migration.sql`,
    ])("enforces the same origin, lifecycle, counter, index and FK contract in %s", async (relativePath) => {
        const migration = normalizeSql(await readFile(join(ROOT, relativePath), "utf8"));
        if (relativePath.includes("/mysql/")) {
            // MySQL rejects a CHECK that reads automationId/originSessionId
            // because those columns participate in FKs with referential
            // actions (error 3823). Its write-boundary triggers must retain
            // the same invariant instead of silently dropping it.
            expect(migration).not.toContain("AutomationRun_origin_kind_check");
            expect(migration).toContain('CREATE TRIGGER "AutomationRun_origin_kind_insert"');
            expect(migration).toContain('CREATE TRIGGER "AutomationRun_origin_kind_update"');
            expect(migration.match(/SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'AutomationRun origin shape is invalid'/gu)).toHaveLength(2);
            expect(migration).not.toMatch(/SET NEW\."id" = CASE WHEN/gu);
        } else {
            expect(migration).toContain("AutomationRun_origin_kind_check");
        }
        expect(migration).toContain("WorkflowRunInvocation_counter_check");
        expect(migration).toMatch(/(?:AccountEncryptionTransitionAutomationStage|AETAS)_kind_(?:check|ck)/u);
        expect(migration).toMatch(/(?:AccountEncryptionTransitionAutomationStage|AETAS)_currentness_(?:check|ck)/u);
        expect(migration).toContain("'workflow_invocation'");
        expect(migration).toMatch(/"participantKind" = 'workflow_invocation'.*"automationId" IS NULL.*"sourceRevision" IS NULL/iu);
        expect(migration).toContain('"originKind" = \'automation\'');
        expect(migration).toContain('"originKind" = \'direct\'');
        // Scoped Automation runs may retain their origin Session; the complete
        // Automation arm requires only Automation identity and cause identity.
        expect(migration).toMatch(/\((?:NEW\.)?"originKind" = 'automation' AND (?:NEW\.)?"automationId" IS NOT NULL AND (?:NEW\.)?"causeKind" IS NOT NULL\)/iu);
        expect(migration).toMatch(/"originKind" = 'direct'.*"workflowAcceptedSnapshotEnvelope" IS NOT NULL.*"workflowCustodyState" IS NOT NULL/iu);
        for (const column of DIRECT_ORIGIN_NULL_COLUMNS) {
            expect(migration).toContain(`"${column}" IS NULL`);
        }
        expect(migration).toContain('"workflowAcceptedSnapshotEnvelope" IS NOT NULL');
        expect(migration).toContain('"workflowCustodyState" IS NOT NULL');
        expect(migration).toContain('"replyHandoffState" = \'none\'');
        expect(migration).toContain('"replyHandoffAttempt" = 0');
        expect(migration).toContain('FOREIGN KEY ("originSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE');
        expect(migration).toContain('FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE');
        expect(migration).toContain('CREATE UNIQUE INDEX "WorkflowRunInvocation_run_sequence_key" ON "WorkflowRunInvocation"("runId", "sequence")');
        expect(migration).toContain('CREATE UNIQUE INDEX "WorkflowRunInvocation_slot_attempt_key" ON "WorkflowRunInvocation"("runId", "parentRecordId", "memberOrdinal", "attempt")');
        expect(migration).toContain('CREATE INDEX "WorkflowRunInvocation_lifecycle_idx" ON "WorkflowRunInvocation"("runId", "lifecycle", "sequence")');
        expect(migration).toContain('CREATE INDEX "AutomationRun_account_created_id_idx" ON "AutomationRun"("accountId", "createdAt" DESC, "id" DESC)');
        for (const lifecycle of WORKFLOW_INVOCATION_LIFECYCLES) {
            expect(migration).toContain(`'${lifecycle}'`);
        }
        expect(migration).toMatch(/"sequence" (?:BIGINT|INTEGER) NOT NULL/iu);
        expect(migration).toMatch(/"memberOrdinal" (?:BIGINT|INTEGER) NOT NULL/iu);
        expect(migration).toMatch(/"attempt" (?:BIGINT|INTEGER) NOT NULL DEFAULT 0/iu);
        if (relativePath.includes("/mysql/")) {
            expect(migration).toContain('"workflowAcceptedSnapshotEnvelope" LONGTEXT NULL');
            expect(migration).toContain('"workflowCheckpointEnvelope" LONGTEXT NULL');
            expect(migration).toContain('"contentEnvelope" LONGTEXT NOT NULL');
        }
        for (const state of ["pause_requested", "paused", "interrupted"]) {
            expect(migration).toContain(`'${state}'`);
        }
    });
});
