import { createRequire } from "node:module";

import { describe, expect, it } from "vitest";

// `node:sqlite` ships with the runtime but has no bundled types here, and adding a dependency
// for one spec would be worse than describing the two calls actually used.
type SqliteStatement = Readonly<{
    run: (...values: unknown[]) => unknown;
    all: (...values: unknown[]) => unknown[];
}>;
type SqliteDatabase = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => SqliteStatement;
}>;
type SqliteModule = Readonly<{ DatabaseSync: new (path: string) => SqliteDatabase }>;

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as SqliteModule;

import { buildSessionTurnProjectionIdsSql } from "./buildSessionTurnProjectionSql";

/**
 * Executes the projection against a real SQLite engine.
 *
 * The sibling spec pins the statement's TEXT across dialects; this one proves the statement
 * actually selects the right rows, which no amount of string assertion can. SQLite is the
 * engine available in-process, and the logic under test is plain standard SQL — the parts that
 * genuinely differ between SQLite, Postgres and MySQL are identifier quoting and placeholder
 * style, and those are what the text matrix covers.
 *
 * The fixture is deliberately agent-heavy, because that is the shape that made the old
 * `roles=user,agent` fetch pathological: many reply rows per turn, of which the rail keeps one.
 */

type Row = Readonly<{ id: string; seq: number; role: string | null }>;

function seedDatabase(rows: readonly Row[]): SqliteDatabase {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE "SessionMessage" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL,
        "sidechainId" TEXT,
        "seq" INTEGER NOT NULL,
        "messageRole" TEXT
    )`);
    const insert = db.prepare(
        `INSERT INTO "SessionMessage" ("id","sessionId","sidechainId","seq","messageRole")
         VALUES (?, 'session-1', NULL, ?, ?)`,
    );
    for (const row of rows) insert.run(row.id, row.seq, row.role);
    return db;
}

function selectIds(db: SqliteDatabase, params: Readonly<{
    hasBeforeSeq: boolean;
    beforeSeq?: number;
    turnLimit: number;
}>): string[] {
    const built = buildSessionTurnProjectionIdsSql({
        dialect: "sqlite",
        sidechainId: null,
        hasBeforeSeq: params.hasBeforeSeq,
    });
    const values = built.parameterOrder.map((name) => {
        if (name === "sessionId") return "session-1";
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
