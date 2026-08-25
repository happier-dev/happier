import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260815170000_add_plugin_collection_candidate_preparation_stages";

// A base64url-encoded SHA-256 digest is exactly 43 characters drawn from
// [A-Za-z0-9_-]. `+`, `/` and `=` are the standard-base64 characters a
// base64url digest can never contain, so a 43-character string carrying them
// is the shortest proof that a provider validates the alphabet and not only
// the length.
const NON_BASE64URL_43 = `${"A".repeat(40)}+/=`;

// A real digest draws from the whole [A-Za-z0-9_-] alphabet, and `-` and `_`
// are exactly the two characters a too-narrow check drops. Every valid fixture
// therefore carries all five character classes, so a provider that admitted
// only [A-Za-z0-9] would fail the control insert instead of passing it.
const DIGEST_ALPHABET_COVERAGE = "aZ9-_";

// Every case needs its own valid candidate identity: the table's unique index
// is (accountId, candidateIdentity, sourceRowDbId, targetContractId), so reusing
// one identity would let a UNIQUE violation stand in for the digest CHECK and
// make the digest assertions pass on a provider that never validates digests.
function validDigest(seed: string): string {
    const fillerLength = 43 - seed.length;
    const filler = DIGEST_ALPHABET_COVERAGE.repeat(Math.ceil(fillerLength / DIGEST_ALPHABET_COVERAGE.length))
        .slice(0, fillerLength);
    return `${seed}${filler}`;
}

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

type Engine = Readonly<{
    exec: (sql: string) => Promise<void>;
    close: () => Promise<void>;
    json: (raw: string) => string;
    timestamp: string;
}>;

type StageColumnOverrides = Readonly<{
    id: string;
    candidateIdentity?: string;
    sourceContractDigest?: string;
    targetContractDigest?: string;
}>;

function insertStage(engine: Engine, overrides: StageColumnOverrides): string {
    const candidateIdentity = overrides.candidateIdentity ?? validDigest(overrides.id);
    const sourceContractDigest = overrides.sourceContractDigest ?? validDigest("src");
    const targetContractDigest = overrides.targetContractDigest ?? validDigest("tgt");
    return `
        INSERT INTO "PluginCollectionCandidatePreparationStage" (
            "id", "accountId", "pluginId", "collectionId", "rowId",
            "candidateIdentity", "sourceRowDbId",
            "sourceContractId", "sourceSchemaVersion", "sourceContractDigest", "sourceRevision",
            "targetContractId", "targetSchemaVersion", "targetContractDigest",
            "candidateReleaseVersion", "candidateArtifactDigest",
            "targetContentEnvelope", "targetProjection", "updatedAt"
        ) VALUES (
            '${overrides.id}', 'account-1', 'plugin', 'tasks', 'task-1',
            '${candidateIdentity}', 'row-1',
            'contract-source', 1, '${sourceContractDigest}', 0,
            'contract-target', 2, '${targetContractDigest}',
            '2.0.0', 'artifact-digest',
            ${engine.json('{"t":"plain","v":{}}')}, ${engine.json('{"fields":[]}')}, ${engine.timestamp}
        );
    `;
}

async function createPostgresEngine(): Promise<Engine> {
    const db = new PGlite();
    const engine: Engine = {
        exec: async (sql) => {
            await db.exec(sql);
        },
        close: async () => {
            await db.close();
        },
        json: (raw) => `'${raw}'::jsonb`,
        timestamp: "TIMESTAMP '2026-08-15 00:00:00'",
    };
    await engine.exec(`
        CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "PluginCollectionRow" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "PluginCollectionContract" ("id" TEXT NOT NULL PRIMARY KEY);
        INSERT INTO "Account" ("id") VALUES ('account-1');
        INSERT INTO "PluginCollectionRow" ("id") VALUES ('row-1');
        INSERT INTO "PluginCollectionContract" ("id") VALUES ('contract-source'), ('contract-target');
    `);
    await engine.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));
    return engine;
}

async function createSqliteEngine(): Promise<Engine> {
    const db = new DatabaseSync(":memory:");
    const engine: Engine = {
        exec: async (sql) => {
            db.exec(sql);
        },
        close: async () => {
            db.close();
        },
        json: (raw) => `'${raw}'`,
        timestamp: "'2026-08-15T00:00:00.000Z'",
    };
    await engine.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "PluginCollectionRow" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "PluginCollectionContract" ("id" TEXT NOT NULL PRIMARY KEY);
        INSERT INTO "Account" ("id") VALUES ('account-1');
        INSERT INTO "PluginCollectionRow" ("id") VALUES ('row-1');
        INSERT INTO "PluginCollectionContract" ("id") VALUES ('contract-source'), ('contract-target');
    `);
    await engine.exec(await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`));
    return engine;
}

const executableProviders = [
    { name: "postgres", create: createPostgresEngine },
    { name: "sqlite", create: createSqliteEngine },
] as const;

// Both engines name the violated constraint in the error text, so asserting the
// name is what separates "the digest check rejected this" from an incidental
// UNIQUE, FOREIGN KEY or length failure.
const alphabetBoundedColumns = [
    {
        column: "candidateIdentity",
        constraint: "PCCPS_candidate_identity_check",
        override: (value: string) => ({ candidateIdentity: value }),
    },
    {
        column: "sourceContractDigest",
        constraint: "PCCPS_source_digest_check",
        override: (value: string) => ({ sourceContractDigest: value }),
    },
    {
        column: "targetContractDigest",
        constraint: "PCCPS_target_digest_check",
        override: (value: string) => ({ targetContractDigest: value }),
    },
] as const;

describe("Plugin Collection candidate preparation stage digest persistence contract", () => {
    it.each(executableProviders)(
        "admits only base64url candidate identities and contract digests in $name",
        async (provider) => {
            const engine = await provider.create();
            try {
                // Control: a genuine base64url digest must still be admitted, so a
                // provider that rejected every insert could not pass this test.
                await engine.exec(insertStage(engine, { id: "valid" }));

                for (const { column, constraint, override } of alphabetBoundedColumns) {
                    const rejection = await engine
                        .exec(insertStage(engine, { id: column, ...override(NON_BASE64URL_43) }))
                        .then(() => null, (error: unknown) => String((error as Error)?.message ?? error));
                    expect(
                        rejection,
                        `${provider.name} must reject a 43-character non-base64url ${column} with ${constraint}`,
                    ).toContain(constraint);
                }
            } finally {
                await engine.close();
            }
        },
        // Booting the embedded PostgreSQL (PGlite WASM) dominates this test and
        // has been measured above the package's 20s default on a loaded machine.
        60_000,
    );

    // MySQL cannot be executed in this lane, so its parity is held by the
    // migration text: the same three columns must be alphabet-bounded.
    it("bounds the MySQL candidate identity and contract digests to the base64url alphabet", async () => {
        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        for (const { column } of alphabetBoundedColumns) {
            expect(sql).toMatch(new RegExp(
                `CHECK\\s*\\(\`${column}\`\\s+REGEXP\\s+'\\^\\[A-Za-z0-9_-\\]\\{43\\}\\$'\\)`,
            ));
        }
    });
});
