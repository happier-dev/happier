import { createRequire } from "node:module";

import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";

// `node:sqlite` ships with the runtime but has no bundled types here, and adding a dependency
// for one spec would be worse than describing the two calls actually used.
type SqliteStatement = Readonly<{
    run: (...values: unknown[]) => unknown;
    all: (...values: unknown[]) => unknown[];
}>;
type SqliteDatabase = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => SqliteStatement;
    close: () => void;
}>;
type SqliteModule = Readonly<{ DatabaseSync: new (path: string) => SqliteDatabase }>;

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

import { buildSessionTurnProjectionIdsSql } from "./buildSessionTurnProjectionSql";

/**
 * Executes the projection against real database engines.
 *
 * Execute against SQLite and Postgres (PGlite), including their real query planners. The
 * sibling spec checks quoting and positional binding across all supported dialects; it
 * cannot establish execution or planner behavior on an engine that has not run.
 *
 * The fixture is deliberately agent-heavy, because that is the shape that made the old
 * `roles=user,agent` fetch pathological: many reply rows per turn, of which the rail keeps one.
 */

type Row = Readonly<{ id: string; seq: number; role: string | null; sessionId?: string; sidechainId?: string }>;

const databases: SqliteDatabase[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
});

function seedDatabase(rows: readonly Row[]): SqliteDatabase {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(`CREATE TABLE "SessionMessage" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL,
        "sidechainId" TEXT,
        "seq" INTEGER NOT NULL,
        "messageRole" TEXT
    );
    CREATE INDEX "SessionMessage_sessionId_seq_idx" ON "SessionMessage" ("sessionId", "seq");
    CREATE INDEX "SessionMessage_sessionId_sidechainId_seq_idx" ON "SessionMessage" ("sessionId", "sidechainId", "seq");
    CREATE INDEX "SessionMessage_sessionId_messageRole_seq_idx" ON "SessionMessage" ("sessionId", "messageRole", "seq");
    CREATE INDEX "SessionMessage_sessionId_sidechainId_messageRole_seq_idx" ON "SessionMessage" ("sessionId", "sidechainId", "messageRole", "seq");`);
    const insert = db.prepare(
        `INSERT INTO "SessionMessage" ("id","sessionId","sidechainId","seq","messageRole")
         VALUES (?, ?, ?, ?, ?)`,
    );
    for (const row of rows) insert.run(row.id, row.sessionId ?? "session-1", row.sidechainId ?? null, row.seq, row.role);
    return db;
}

function selectIds(db: SqliteDatabase, params: Readonly<{
    hasBeforeSeq: boolean;
    beforeSeq?: number;
    turnLimit: number;
    sidechainId?: string;
}>): string[] {
    const built = buildSessionTurnProjectionIdsSql({
        dialect: "sqlite",
        sidechainId: params.sidechainId ?? null,
        hasBeforeSeq: params.hasBeforeSeq,
    });
    const values = built.parameterOrder.map((name) => {
        if (name === "sessionId") return "session-1";
        if (name === "sidechainId") return params.sidechainId;
        if (name === "beforeSeq") return params.beforeSeq ?? 0;
        if (name === "turnLimit") return params.turnLimit;
        if (name === "userRole") return "user";
        if (name === "agentRole") return "agent";
        if (name === "toolRole") return "tool";
        throw new Error(`Unbound parameter: ${name}`);
    });
    const statement = db.prepare(built.sql);
    return statement.all(...values).map((row) => String((row as { id: unknown }).id)).sort();
}

describe("session turn projection SQL (executed)", () => {
    it("uses bounded role seeks on Postgres too", async () => {
        const db = new PGlite();
        try {
            await db.exec(`CREATE TABLE "SessionMessage" (
                "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL, "sidechainId" TEXT,
                "seq" INTEGER NOT NULL, "messageRole" TEXT
            );
            CREATE INDEX sid_seq ON "SessionMessage" ("sessionId", "seq");
            CREATE INDEX sid_chain_seq ON "SessionMessage" ("sessionId", "sidechainId", "seq");
            CREATE INDEX sid_role_seq ON "SessionMessage" ("sessionId", "messageRole", "seq");
            CREATE INDEX sid_chain_role_seq ON "SessionMessage" ("sessionId", "sidechainId", "messageRole", "seq");
            INSERT INTO "SessionMessage"
                SELECT 'm' || i, 'session-1', NULL, i + 1,
                    CASE WHEN i % 400 = 0 THEN 'user' WHEN i % 400 = 1 THEN 'agent' ELSE 'event' END
                FROM generate_series(0, 39999) AS i;
            ANALYZE "SessionMessage";`);
            const bindings: Record<string, string | number> = {
                sessionId: "session-1", beforeSeq: 39_601, turnLimit: 2,
                userRole: "user", agentRole: "agent", toolRole: "tool",
            };
            for (const hasBeforeSeq of [true, false]) {
                const built = buildSessionTurnProjectionIdsSql({ dialect: "postgres", sidechainId: null, hasBeforeSeq });
                const values = built.parameterOrder.map((name) => bindings[name]);
                const result = await db.query<{ id: string }>(built.sql, values);
                expect(result.rows.map((row) => row.id).sort()).toEqual(hasBeforeSeq
                    ? ["m38800", "m38801", "m39200", "m39201"]
                    : ["m39200", "m39201", "m39600", "m39601"]);

                type Plan = {
                    "Relation Name"?: string;
                    Alias?: string;
                    "Node Type"?: string;
                    "Index Cond"?: string;
                    "Actual Rows"?: number;
                    "Rows Removed by Filter"?: number;
                    Plans?: Plan[];
                };
                const explanation = await db.query<{ "QUERY PLAN": Array<{ Plan: Plan }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${built.sql}`, values);
                const accesses: Plan[] = [];
                const visit = (plan: Plan) => {
                    if (plan["Relation Name"] === "SessionMessage") accesses.push(plan);
                    for (const child of plan.Plans ?? []) visit(child);
                };
                visit(explanation.rows[0]["QUERY PLAN"][0].Plan);
                expect(accesses.length).toBeGreaterThan(0);
                for (const access of accesses) {
                    // PostgreSQL uniquifies repeated aliases (edge, edge_1, ...).
                    const isTailSeek = /^edge(?:_\d+)?$/.test(access.Alias ?? "");
                    expect(access["Node Type"]).toMatch(/Index.*Scan/);
                    expect(access["Index Cond"]).toContain(isTailSeek ? "sessionId" : "messageRole");
                    if (isTailSeek) {
                        expect(access["Actual Rows"]).toBeLessThanOrEqual(1);
                        expect(access["Rows Removed by Filter"] ?? 0).toBe(0);
                    }
                }
            }
        } finally {
            await db.close();
        }
    });

    it("seeks role ranges instead of scanning event-heavy history before limiting turns", () => {
        const rows: Row[] = Array.from({ length: 40_000 }, (_, i) => ({
            id: `m${i}`, seq: i + 1, role: i % 400 === 0 ? "user" : i % 400 === 1 ? "agent" : "event",
        }));
        const db = seedDatabase(rows);
        db.exec("ANALYZE");
        const built = buildSessionTurnProjectionIdsSql({ dialect: "sqlite", sidechainId: null, hasBeforeSeq: true });
        const bindings: Record<string, string | number> = {
            sessionId: "session-1", beforeSeq: 39_601, turnLimit: 2,
            userRole: "user", agentRole: "agent", toolRole: "tool",
        };
        const values = built.parameterOrder.map((name) => bindings[name]);
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${built.sql}`).all(...values) as Array<{ detail: string }>;
        // The page-size bound belongs before any window over history. A session/chain-only
        // seek still visits every event and is the regression reported in #661.
        const accesses = plan.map((row) => row.detail).filter((detail) => /(?:SEARCH|SCAN) (?:SessionMessage|reply)\b/.test(detail));
        expect(accesses.length).toBeGreaterThan(0);
        expect(accesses.filter((detail) => !detail.includes("messageRole=?"))).toEqual([]);
        expect(selectIds(db, { hasBeforeSeq: true, beforeSeq: 39_601, turnLimit: 2 }))
            .toEqual(["m38800", "m38801", "m39200", "m39201"]);
    });

    it("keeps turn boundaries within the requested session and chain, including a cursor inside a turn", () => {
        const db = seedDatabase([
            { id: "u", seq: 1, role: "user", sidechainId: "sc" },
            { id: "a", seq: 3, role: "agent", sidechainId: "sc" },
            { id: "later", seq: 5, role: "agent", sidechainId: "sc" },
            { id: "main", seq: 2, role: "user" },
            { id: "other", seq: 4, role: "user", sessionId: "other", sidechainId: "sc" },
        ]);
        expect(selectIds(db, { hasBeforeSeq: true, beforeSeq: 5, turnLimit: 2, sidechainId: "sc" }))
            .toEqual(["a", "u"]);
    });
    it("keeps every prompt and only the LAST reply of each turn", () => {
        // Two turns, each with several agent rows. The rail shows the last reply of a turn as
        // the subtitle, so u1 must pair with a1c and u2 with a2b — and a1a/a1b/a2a, which the
        // old fetch transferred and decrypted, must never leave the database.
        const db = seedDatabase([
            { id: "u1", seq: 1, role: "user" },
            { id: "a1a", seq: 2, role: "agent" },
            { id: "a1b", seq: 3, role: "agent" },
            { id: "a1c", seq: 4, role: "agent" },
            { id: "u2", seq: 5, role: "user" },
            { id: "a2a", seq: 6, role: "agent" },
            { id: "a2b", seq: 7, role: "agent" },
        ]);

        expect(selectIds(db, { hasBeforeSeq: false, turnLimit: 10 })).toEqual(["a1c", "a2b", "u1", "u2"]);
    });

    it("keeps the last tool row too, so a tool-only turn still has a subtitle", () => {
        const db = seedDatabase([
            { id: "u1", seq: 1, role: "user" },
            { id: "t1a", seq: 2, role: "tool" },
            { id: "t1b", seq: 3, role: "tool" },
        ]);

        expect(selectIds(db, { hasBeforeSeq: false, turnLimit: 10 })).toEqual(["t1b", "u1"]);
    });

    it("treats a legacy null role as a prompt that opens its own turn", () => {
        const db = seedDatabase([
            { id: "legacy", seq: 1, role: null },
            { id: "a1", seq: 2, role: "agent" },
            { id: "u2", seq: 3, role: "user" },
            { id: "a2", seq: 4, role: "agent" },
        ]);

        // Two turns, not one: the legacy row anchors the first.
        expect(selectIds(db, { hasBeforeSeq: false, turnLimit: 10 })).toEqual(["a1", "a2", "legacy", "u2"]);
    });

    it("returns the NEWEST turns when the limit bites, not the oldest", () => {
        const db = seedDatabase([
            { id: "u1", seq: 1, role: "user" },
            { id: "a1", seq: 2, role: "agent" },
            { id: "u2", seq: 3, role: "user" },
            { id: "a2", seq: 4, role: "agent" },
            { id: "u3", seq: 5, role: "user" },
            { id: "a3", seq: 6, role: "agent" },
        ]);

        expect(selectIds(db, { hasBeforeSeq: false, turnLimit: 2 })).toEqual(["a2", "a3", "u2", "u3"]);
    });

    it("pages backwards from the cursor without re-returning what came after it", () => {
        const db = seedDatabase([
            { id: "u1", seq: 1, role: "user" },
            { id: "a1", seq: 2, role: "agent" },
            { id: "u2", seq: 3, role: "user" },
            { id: "a2", seq: 4, role: "agent" },
            { id: "u3", seq: 5, role: "user" },
            { id: "a3", seq: 6, role: "agent" },
        ]);

        expect(selectIds(db, { hasBeforeSeq: true, beforeSeq: 5, turnLimit: 10 }))
            .toEqual(["a1", "a2", "u1", "u2"]);
    });

    it("does not invent a reply for a trailing prompt that has none yet", () => {
        const db = seedDatabase([
            { id: "u1", seq: 1, role: "user" },
            { id: "a1", seq: 2, role: "agent" },
            { id: "u2", seq: 3, role: "user" },
        ]);

        expect(selectIds(db, { hasBeforeSeq: false, turnLimit: 10 })).toEqual(["a1", "u1", "u2"]);
    });

    it("ignores reply rows that precede the first prompt", () => {
        // Rows before any prompt sit in turn 0, which has no anchor and must contribute nothing.
        const db = seedDatabase([
            { id: "orphan", seq: 1, role: "agent" },
            { id: "u1", seq: 2, role: "user" },
            { id: "a1", seq: 3, role: "agent" },
        ]);

        expect(selectIds(db, { hasBeforeSeq: false, turnLimit: 10 })).toEqual(["a1", "u1"]);
    });
});
