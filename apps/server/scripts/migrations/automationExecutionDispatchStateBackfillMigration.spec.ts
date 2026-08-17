import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { serializeAutomationRunExecutionRecipeV1 } from "@happier-dev/protocol";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260816233000_backfill_automation_execution_dispatch_state";
const canonicalExecutionRunRecipePattern =
    '{"target":{"kind":"executionRun","request":%},"template":%,"templateVersion":%,"triggerEvidence":%,"v":1}';
const canonicalExecutionRunRecipeGlob = canonicalExecutionRunRecipePattern.replaceAll("%", "*");

const fixtureFields = [
    "id",
    "executionInputEnvelope",
    "executionDispatchState",
    "executionAttempt",
    "state",
    "startedAt",
    "finishedAt",
    "executionDispatchCommittedAt",
    "executionDispatchDueAt",
    "executionNativeRunId",
    "executionNativeCallId",
    "executionNativeSidechainId",
    "resultEnvelope",
    "summaryCiphertext",
    "errorCode",
    "errorMessage",
    "producedSessionId",
    "attempt",
    "revision",
    "updatedAt",
] as const;

type FixtureField = (typeof fixtureFields)[number];
type AutomationRunFixture = Record<FixtureField, string | number | null>;

const createAutomationRunTableSql = `
    CREATE TABLE "AutomationRun" (
        "id" TEXT PRIMARY KEY,
        "executionInputEnvelope" TEXT,
        "executionDispatchState" TEXT,
        "executionAttempt" INTEGER NOT NULL,
        "state" TEXT NOT NULL,
        "startedAt" TIMESTAMP,
        "finishedAt" TIMESTAMP,
        "executionDispatchCommittedAt" TIMESTAMP,
        "executionDispatchDueAt" TIMESTAMP,
        "executionNativeRunId" TEXT,
        "executionNativeCallId" TEXT,
        "executionNativeSidechainId" TEXT,
        "resultEnvelope" TEXT,
        "summaryCiphertext" TEXT,
        "errorCode" TEXT,
        "errorMessage" TEXT,
        "producedSessionId" TEXT,
        "attempt" INTEGER NOT NULL,
        "revision" INTEGER NOT NULL,
        "updatedAt" TIMESTAMP NOT NULL
    );
`;

function strictExecutionRunRecipe(): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: "plain",
            v: { v: 1, prompt: "repair the frozen execution Run" },
        },
        triggerEvidence: null,
        target: {
            kind: "executionRun",
            request: {
                intent: "task",
                backendTarget: { kind: "builtInAgent", agentId: "codex" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("expected a valid strict executionRun fixture");
    }
    return serialized.serialized;
}

function strictNewSessionRecipe(): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: {
            t: "plain",
            v: { v: 1, prompt: "leave a Session target untouched" },
        },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("expected a valid strict newSession fixture");
    }
    return serialized.serialized;
}

function noncanonicalStrictExecutionRunRecipe(): string {
    return JSON.stringify({
        v: 1,
        templateVersion: 1,
        template: {
            t: "plain",
            v: { v: 1, prompt: "same strict fields in source-noncanonical order" },
        },
        triggerEvidence: null,
        target: {
            kind: "executionRun",
            request: {
                intent: "task",
                backendTarget: { kind: "builtInAgent", agentId: "codex" },
                permissionMode: "read_only",
                retentionPolicy: "ephemeral",
                runClass: "bounded",
                ioMode: "request_response",
            },
        },
    });
}

function fixture(params: Readonly<{
    id: string;
    executionInputEnvelope: string | null;
    executionDispatchState?: string | null;
    executionAttempt?: number;
    state?: string;
    startedAt?: string | null;
    finishedAt?: string | null;
    executionDispatchCommittedAt?: string | null;
    executionDispatchDueAt?: string | null;
    executionNativeRunId?: string | null;
    executionNativeCallId?: string | null;
    executionNativeSidechainId?: string | null;
    resultEnvelope?: string | null;
    summaryCiphertext?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    producedSessionId?: string | null;
    attempt?: number;
    revision?: number;
}>): AutomationRunFixture {
    return {
        id: params.id,
        executionInputEnvelope: params.executionInputEnvelope,
        executionDispatchState: params.executionDispatchState ?? null,
        executionAttempt: params.executionAttempt ?? 0,
        state: params.state ?? "queued",
        startedAt: params.startedAt ?? null,
        finishedAt: params.finishedAt ?? null,
        executionDispatchCommittedAt: params.executionDispatchCommittedAt ?? null,
        executionDispatchDueAt: params.executionDispatchDueAt ?? null,
        executionNativeRunId: params.executionNativeRunId ?? null,
        executionNativeCallId: params.executionNativeCallId ?? null,
        executionNativeSidechainId: params.executionNativeSidechainId ?? null,
        resultEnvelope: params.resultEnvelope ?? null,
        summaryCiphertext: params.summaryCiphertext ?? null,
        errorCode: params.errorCode ?? null,
        errorMessage: params.errorMessage ?? null,
        producedSessionId: params.producedSessionId ?? null,
        attempt: params.attempt ?? 0,
        revision: params.revision ?? 7,
        updatedAt: "2026-08-15 12:00:00",
    };
}

function repairFixtures(): AutomationRunFixture[] {
    const strictExecution = strictExecutionRunRecipe();
    return [
        fixture({ id: "repair-queued", executionInputEnvelope: strictExecution }),
        fixture({
            id: "repair-claimed-after-lease-claim",
            executionInputEnvelope: strictExecution,
            state: "claimed",
            // Claim attempts occur before the start owner observes the missing
            // dispatch state. This must remain repairable while executionAttempt
            // still proves no detached execution was permitted.
            attempt: 4,
        }),
        fixture({
            id: "leave-execution-attempt",
            executionInputEnvelope: strictExecution,
            executionAttempt: 1,
        }),
        fixture({
            id: "leave-running",
            executionInputEnvelope: strictExecution,
            state: "running",
        }),
        fixture({
            id: "leave-started",
            executionInputEnvelope: strictExecution,
            startedAt: "2026-08-15 12:01:00",
        }),
        fixture({
            id: "leave-finished",
            executionInputEnvelope: strictExecution,
            finishedAt: "2026-08-15 12:01:00",
        }),
        fixture({
            id: "leave-committed",
            executionInputEnvelope: strictExecution,
            executionDispatchCommittedAt: "2026-08-15 12:01:00",
        }),
        fixture({
            id: "leave-retry-due",
            executionInputEnvelope: strictExecution,
            executionDispatchDueAt: "2026-08-15 12:01:00",
        }),
        fixture({
            id: "leave-native-run",
            executionInputEnvelope: strictExecution,
            executionNativeRunId: "native-run",
        }),
        fixture({
            id: "leave-result",
            executionInputEnvelope: strictExecution,
            resultEnvelope: '{"t":"plain","v":{}}',
        }),
        fixture({
            id: "leave-legacy-summary",
            executionInputEnvelope: strictExecution,
            summaryCiphertext: "legacy-summary",
        }),
        fixture({
            id: "leave-error",
            executionInputEnvelope: strictExecution,
            errorCode: "execution_run_failed",
        }),
        fixture({
            id: "leave-produced-session",
            executionInputEnvelope: strictExecution,
            producedSessionId: "session",
        }),
        fixture({
            id: "leave-current-dispatch-state",
            executionInputEnvelope: strictExecution,
            executionDispatchState: "notStarted",
        }),
        fixture({ id: "leave-session-target", executionInputEnvelope: strictNewSessionRecipe() }),
        fixture({
            id: "leave-legacy-v2",
            executionInputEnvelope: JSON.stringify({
                kind: "happier_automation_run_execution_input_v1",
                targetType: "execution_run",
                templateVersion: 1,
            }),
        }),
        fixture({
            id: "leave-noncanonical-strict",
            executionInputEnvelope: noncanonicalStrictExecutionRunRecipe(),
        }),
    ];
}

function fixtureValues(row: AutomationRunFixture): Array<string | number | null> {
    return fixtureFields.map((field) => row[field]);
}

function postgresInsertSql(): string {
    return `
        INSERT INTO "AutomationRun" (${fixtureFields.map((field) => `"${field}"`).join(", ")})
        VALUES (${fixtureFields.map((_, index) => `$${index + 1}`).join(", ")});
    `;
}

function sqliteInsertSql(): string {
    return `
        INSERT INTO "AutomationRun" (${fixtureFields.map((field) => `"${field}"`).join(", ")})
        VALUES (${fixtureFields.map(() => "?").join(", ")});
    `;
}

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

type RepairResult = Readonly<{
    id: string;
    executionDispatchState: string | null;
    revision: number;
}>;

function expectRepairResult(rows: RepairResult[]): void {
    expect(rows).toEqual([
        { id: "leave-committed", executionDispatchState: null, revision: 7 },
        { id: "leave-current-dispatch-state", executionDispatchState: "notStarted", revision: 7 },
        { id: "leave-error", executionDispatchState: null, revision: 7 },
        { id: "leave-execution-attempt", executionDispatchState: null, revision: 7 },
        { id: "leave-finished", executionDispatchState: null, revision: 7 },
        { id: "leave-legacy-summary", executionDispatchState: null, revision: 7 },
        { id: "leave-legacy-v2", executionDispatchState: null, revision: 7 },
        { id: "leave-native-run", executionDispatchState: null, revision: 7 },
        { id: "leave-noncanonical-strict", executionDispatchState: null, revision: 7 },
        { id: "leave-produced-session", executionDispatchState: null, revision: 7 },
        { id: "leave-result", executionDispatchState: null, revision: 7 },
        { id: "leave-retry-due", executionDispatchState: null, revision: 7 },
        { id: "leave-running", executionDispatchState: null, revision: 7 },
        { id: "leave-session-target", executionDispatchState: null, revision: 7 },
        { id: "leave-started", executionDispatchState: null, revision: 7 },
        { id: "repair-claimed-after-lease-claim", executionDispatchState: "notStarted", revision: 8 },
        { id: "repair-queued", executionDispatchState: "notStarted", revision: 8 },
    ]);
}

describe("Automation execution dispatch-state backfill migration", () => {
    const migrationPaths = {
        postgres: `prisma/migrations/${migrationId}/migration.sql`,
        sqlite: `prisma/sqlite/migrations/${migrationId}/migration.sql`,
        mysql: `prisma/mysql/migrations/${migrationId}/migration.sql`,
    } as const;

    it("repairs only canonical unstarted executionRun rows across all provider SQL", async () => {
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            read(migrationPaths.postgres),
            read(migrationPaths.sqlite),
            read(migrationPaths.mysql),
        ]);

        for (const [sql, quote] of [
            [postgresSql, '"'],
            [sqliteSql, '"'],
            [mysqlSql, "`"],
        ] as const) {
            expect(sql.match(new RegExp(`UPDATE\\s+${quote}AutomationRun${quote}`, "giu"))).toHaveLength(1);
            expect(sql).toContain(`${quote}executionDispatchState${quote} = 'notStarted'`);
            expect(sql).toContain(`${quote}revision${quote} = ${quote}revision${quote} + 1`);
            expect(sql).toContain(`${quote}updatedAt${quote}`);
            expect(sql).toContain(`${quote}executionInputEnvelope${quote} IS NOT NULL`);
            expect(sql).toContain(`${quote}executionDispatchState${quote} IS NULL`);
            expect(sql).toContain(`${quote}executionAttempt${quote} = 0`);
            expect(sql).toMatch(new RegExp(`${quote}state${quote}\\s+IN\\s*\\(\\s*'queued'\\s*,\\s*'claimed'\\s*\\)`, "u"));
            for (const field of [
                "startedAt",
                "finishedAt",
                "executionDispatchCommittedAt",
                "executionDispatchDueAt",
                "executionNativeRunId",
                "executionNativeCallId",
                "executionNativeSidechainId",
                "resultEnvelope",
                "summaryCiphertext",
                "errorCode",
                "errorMessage",
                "producedSessionId",
            ]) {
                expect(sql).toContain(`${quote}${field}${quote} IS NULL`);
            }
            expect(sql).not.toMatch(/(?:ALTER|CREATE|DROP|INSERT|DELETE)\\s+/iu);
        }

        expect(postgresSql).toContain(
            `"executionInputEnvelope" COLLATE "C" LIKE '${canonicalExecutionRunRecipePattern}'`,
        );
        expect(sqliteSql).toContain(
            `"executionInputEnvelope" GLOB '${canonicalExecutionRunRecipeGlob}'`,
        );
        expect(mysqlSql).toContain(
            `CONVERT(\`executionInputEnvelope\` USING BINARY) LIKE _binary'${canonicalExecutionRunRecipePattern}'`,
        );
        for (const sql of [postgresSql, sqliteSql, mysqlSql]) {
            expect(sql).not.toMatch(/json(?:b)?_(?:extract|path|query)|JSON_EXTRACT/iu);
        }
    });

    it("executes the PostgreSQL repair exactly once for source-canonical strict rows", async () => {
        const db = new PGlite();
        try {
            await db.exec(createAutomationRunTableSql);
            const insertSql = postgresInsertSql();
            for (const row of repairFixtures()) {
                await db.query(insertSql, fixtureValues(row));
            }

            const migration = await read(migrationPaths.postgres);
            await db.exec(migration);
            const firstResult = await db.query<RepairResult>(`
                SELECT "id", "executionDispatchState", "revision"
                FROM "AutomationRun"
                ORDER BY "id"
            `);
            expectRepairResult(firstResult.rows);

            await db.exec(migration);
            const secondResult = await db.query<RepairResult>(`
                SELECT "id", "executionDispatchState", "revision"
                FROM "AutomationRun"
                ORDER BY "id"
            `);
            expectRepairResult(secondResult.rows);
        } finally {
            await db.close();
        }
    });

    it("executes the SQLite repair exactly once for source-canonical strict rows", async () => {
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(createAutomationRunTableSql);
            const insert = db.prepare(sqliteInsertSql());
            for (const row of repairFixtures()) {
                insert.run(...fixtureValues(row));
            }

            const migration = await read(migrationPaths.sqlite);
            db.exec(migration);
            expectRepairResult(db.prepare(`
                SELECT "id", "executionDispatchState", "revision"
                FROM "AutomationRun"
                ORDER BY "id"
            `).all() as RepairResult[]);

            db.exec(migration);
            expectRepairResult(db.prepare(`
                SELECT "id", "executionDispatchState", "revision"
                FROM "AutomationRun"
                ORDER BY "id"
            `).all() as RepairResult[]);
        } finally {
            db.close();
        }
    });
});
