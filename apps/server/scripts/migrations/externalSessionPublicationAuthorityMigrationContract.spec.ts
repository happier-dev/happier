import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import {
    isSessionTranscriptShareable,
    resolveSessionTranscriptPublicationCeiling,
} from "../../sources/app/session/sessionTranscriptPublicationPolicy";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260723150000_add_external_session_publication_authority";

const migrationPaths = {
    postgres: `prisma/migrations/${migrationId}/migration.sql`,
    sqlite: `prisma/sqlite/migrations/${migrationId}/migration.sql`,
    mysql: `prisma/mysql/migrations/${migrationId}/migration.sql`,
} as const;

async function readMigration(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

/**
 * The pre-migration Session shape. The publication-authority columns are
 * deliberately absent: the migration under test is the statement that adds
 * them, so every fixture row reaches it exactly as a predecessor row would.
 */
const createFixtureTablesSql = `
    CREATE TABLE "Session" (
        "id" TEXT PRIMARY KEY,
        "accountId" TEXT NOT NULL,
        "tag" TEXT NOT NULL,
        "metadata" TEXT NOT NULL,
        "seq" INTEGER NOT NULL
    );
    CREATE TABLE "SessionMessage" (
        "id" TEXT PRIMARY KEY,
        "sessionId" TEXT NOT NULL,
        "seq" INTEGER NOT NULL
    );
`;

type SessionFixture = Readonly<{
    id: string;
    tag: string;
    seq: number;
    messageCount: number;
    expectedStorageState: "hosted" | "legacy_external_unknown";
}>;

/**
 * `direct-nonzero` is the deciding row. A backfill restricted to empty
 * Sessions passes every other case here and still leaves a predecessor direct
 * transcript unbounded and shareable, so the emptiness decoys exist only to
 * keep that distinction observable.
 */
const fixtures: readonly SessionFixture[] = [
    { id: "ordinary-hosted", tag: "ordinary-session", seq: 4, messageCount: 4, expectedStorageState: "hosted" },
    { id: "ordinary-hosted-empty", tag: "ordinary-empty-session", seq: 0, messageCount: 0, expectedStorageState: "hosted" },
    { id: "direct-zero", tag: "direct:v1:aaaa", seq: 0, messageCount: 0, expectedStorageState: "legacy_external_unknown" },
    { id: "direct-nonzero", tag: "direct:v1:bbbb", seq: 7, messageCount: 5, expectedStorageState: "legacy_external_unknown" },
    { id: "direct-suffix-only", tag: "linked-direct:v1:cccc", seq: 2, messageCount: 2, expectedStorageState: "hosted" },
    { id: "direct-case-variant", tag: "DIRECT:V1:DDDD", seq: 3, messageCount: 3, expectedStorageState: "hosted" },
    { id: "direct-wildcard-decoy", tag: "direct_v1:eeee", seq: 1, messageCount: 1, expectedStorageState: "hosted" },
];

type MigratedRow = Readonly<{
    id: string;
    seq: number;
    currentStorageState: string;
    acceptedThroughServerSeq: number | null;
    materializationPublicationId: string | null;
    materializedThroughSourceAt: bigint | number | string | null;
    publishedThroughServerSeq: number | null;
}>;

const selectMigratedRowsSql = `
    SELECT
        "id",
        "seq",
        "currentStorageState",
        "acceptedThroughServerSeq",
        "materializationPublicationId",
        "materializedThroughSourceAt",
        "publishedThroughServerSeq"
    FROM "Session"
    ORDER BY "id"
`;

/**
 * The migration outcome is asserted through the production publication owner
 * rather than a restated table of strings, so a state that reads "safe" but
 * still projects an unbounded, shareable transcript cannot pass.
 */
function expectMigratedAuthority(rows: readonly MigratedRow[]): void {
    const expected = [...fixtures].sort((left, right) => left.id.localeCompare(right.id));
    expect(rows.map((row) => row.id)).toEqual(expected.map((fixture) => fixture.id));

    for (const [index, fixture] of expected.entries()) {
        const row = rows[index]!;
        const observed = {
            id: row.id,
            currentStorageState: row.currentStorageState,
            shareable: isSessionTranscriptShareable(row),
            ceiling: resolveSessionTranscriptPublicationCeiling(row),
        };
        expect(observed).toEqual(
            fixture.expectedStorageState === "hosted"
                ? { id: fixture.id, currentStorageState: "hosted", shareable: true, ceiling: null }
                : {
                    id: fixture.id,
                    currentStorageState: "legacy_external_unknown",
                    shareable: false,
                    ceiling: 0,
                },
        );
    }
}

describe("External Sessions publication-authority migration", () => {
    it("backfills only predecessor direct rows, on every supported provider SQL", async () => {
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            readMigration(migrationPaths.postgres),
            readMigration(migrationPaths.sqlite),
            readMigration(migrationPaths.mysql),
        ]);

        for (const [sql, quote] of [
            [postgresSql, '"'],
            [sqliteSql, '"'],
            [mysqlSql, "`"],
        ] as const) {
            // Fresh Sessions stay hosted: the column default is untouched.
            expect(sql).toMatch(
                new RegExp(`${quote}currentStorageState${quote}[^;]*NOT NULL[^;]*DEFAULT 'hosted'`, "u"),
            );
            // Exactly one authority write, and it is the fail-closed backfill.
            expect(sql.match(new RegExp(`UPDATE\\s+${quote}Session${quote}`, "giu")) ?? []).toHaveLength(1);
            expect(sql).toContain(`${quote}currentStorageState${quote} = 'legacy_external_unknown'`);
            expect(sql).toContain(`${quote}tag${quote}`);
            // No emptiness inference may gate the backfill.
            expect(sql).not.toMatch(new RegExp(`${quote}seq${quote}`, "u"));
            expect(sql).not.toMatch(/SessionMessage|EXISTS|COUNT\s*\(/iu);
            // Nothing in the migration may advance authority later on its own.
            expect(sql).not.toMatch(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:TRIGGER|EVENT|FUNCTION|PROCEDURE)/iu);
            expect(sql).not.toMatch(/\bDELETE\b|\bINSERT\b/iu);
        }

        // Byte-exact, prefix-anchored tag matching on each provider's own
        // default collation semantics.
        expect(postgresSql).toContain(`"tag" COLLATE "C" LIKE 'direct:v1:%'`);
        expect(sqliteSql).toContain(`"tag" GLOB 'direct:v1:*'`);
        expect(mysqlSql).toContain("CONVERT(`tag` USING BINARY) LIKE _binary'direct:v1:%'");
    });

    it("executes the PostgreSQL migration into fail-closed predecessor direct authority", async () => {
        const database = new PGlite();
        try {
            await database.exec(createFixtureTablesSql);
            for (const fixture of fixtures) {
                await database.query(
                    `INSERT INTO "Session" ("id", "accountId", "tag", "metadata", "seq") VALUES ($1, $2, $3, $4, $5)`,
                    [fixture.id, "account", fixture.tag, "{}", fixture.seq],
                );
                for (let index = 0; index < fixture.messageCount; index += 1) {
                    await database.query(
                        `INSERT INTO "SessionMessage" ("id", "sessionId", "seq") VALUES ($1, $2, $3)`,
                        [`${fixture.id}-message-${index}`, fixture.id, index + 1],
                    );
                }
            }

            await database.exec(await readMigration(migrationPaths.postgres));

            const migrated = await database.query<MigratedRow>(selectMigratedRowsSql);
            expectMigratedAuthority(migrated.rows);
        } finally {
            await database.close();
        }
    });

    it("executes the SQLite migration into fail-closed predecessor direct authority", async () => {
        const database = new DatabaseSync(":memory:");
        try {
            database.exec(createFixtureTablesSql);
            const insertSession = database.prepare(
                `INSERT INTO "Session" ("id", "accountId", "tag", "metadata", "seq") VALUES (?, ?, ?, ?, ?)`,
            );
            const insertMessage = database.prepare(
                `INSERT INTO "SessionMessage" ("id", "sessionId", "seq") VALUES (?, ?, ?)`,
            );
            for (const fixture of fixtures) {
                insertSession.run(fixture.id, "account", fixture.tag, "{}", fixture.seq);
                for (let index = 0; index < fixture.messageCount; index += 1) {
                    insertMessage.run(`${fixture.id}-message-${index}`, fixture.id, index + 1);
                }
            }

            database.exec(await readMigration(migrationPaths.sqlite));

            expectMigratedAuthority(database.prepare(selectMigratedRowsSql).all() as unknown as MigratedRow[]);
        } finally {
            database.close();
        }
    });
});
