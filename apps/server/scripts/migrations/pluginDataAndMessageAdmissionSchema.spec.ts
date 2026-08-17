import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { encodePluginCollectionIndexSortKeyV1 } from "@happier-dev/protocol";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260809170000_add_plugin_data_and_message_admission";
const predecessorRowRevisionMigrationId = "20260810190000_add_session_message_row_revision";

// Exact read-only predecessor migration SQL from
// ../remote-dev@e47e0307b5db9c61d7dedf7970cac1995e67fb7d.
// The migration remains predecessor-owned; this is a provenance-pinned upgrade vector.
const predecessorRowRevisionMigration = {
    postgres: 'ALTER TABLE "SessionMessage" ADD COLUMN "rowRevision" BIGINT NOT NULL DEFAULT 0;\n',
    sqlite: 'ALTER TABLE "SessionMessage" ADD COLUMN "rowRevision" BIGINT NOT NULL DEFAULT 0;\n',
    mysql: "ALTER TABLE `SessionMessage` ADD COLUMN `rowRevision` BIGINT NOT NULL DEFAULT 0;\n",
} as const;

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

function model(schema: string, name: string): string {
    const match = schema.match(new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, "m"));
    if (!match?.[1]) {
        throw new Error(`model ${name} not found`);
    }
    return match[1];
}

const validContractDigest = "A".repeat(43);
const invalidContractDigest = "A".repeat(42);
const unicodeRowId = "café-東京";
const unicodeTargetRowId = "mål-δ";
const indexedStringContainingNul = "before\u0000after";
const nulEscapedIndexedSortKey = encodePluginCollectionIndexSortKeyV1({
    fields: [{ kind: "string", value: indexedStringContainingNul }],
    rowId: unicodeRowId,
});
const nulEscapedIndexedSortKeyHex = Array.from(
    nulEscapedIndexedSortKey,
    (byte) => byte.toString(16).padStart(2, "0"),
).join("");

describe("plugin data and message-admission persistence contract", () => {
    const schemaPaths = [
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ] as const;

    it.each(schemaPaths)("keeps collection records and nullable admission evidence in %s", async (schemaPath) => {
        const schema = await read(schemaPath);

        for (const collectionModel of [
            "PluginCollectionContract",
            "PluginCollectionRow",
            "PluginCollectionProjection",
            "PluginCollectionIndexState",
            "PluginCollectionIndexEntry",
            "PluginCollectionRelation",
        ]) {
            expect(model(schema, collectionModel)).toBeTruthy();
        }
        for (const artifactModel of [
            "AccountPluginIntent",
            "AccountPluginRelease",
            "AccountPluginUiArtifact",
            "PluginMachineMaterialization",
        ]) {
            expect(model(schema, artifactModel)).toBeTruthy();
        }

        expect(model(schema, "SessionMessage")).toMatch(
            /^\s*inputAdmissionReceipt\s+Json\?\s*$/m,
        );
        expect(model(schema, "SessionMessage")).toMatch(
            /^\s*requestEqualityEvidenceV1\s+Json\?\s*$/m,
        );
        expect(model(schema, "SessionPendingMessage")).toMatch(
            /^\s*inputAdmissionReceipt\s+Json\?\s*$/m,
        );
        expect(model(schema, "SessionPendingMessage")).toMatch(
            /^\s*requestEqualityEvidenceV1\s+Json\?\s*$/m,
        );
        expect(model(schema, "Machine")).toMatch(
            /^\s*operationProtocolCapabilities\s+Json\?\s*$/m,
        );
        expect(model(schema, "Machine")).toMatch(
            /^\s*operationProtocolCapabilitiesRevision\s+Int\?\s*$/m,
        );
        expect(model(schema, "Machine")).toMatch(
            /^\s*pluginMaterializationRevision\s+BigInt\?\s*$/m,
        );
        expect(model(schema, "AccountPluginUiArtifact")).toMatch(
            /^\s*releaseId\s+String\b/m,
        );
        expect(model(schema, "AccountPluginUiArtifact")).toMatch(
            /^\s*artifactId\s+String\b/m,
        );
        expect(model(schema, "Artifact")).toMatch(
            /^\s*pluginUiArtifact\s+AccountPluginUiArtifact\?\s*$/m,
        );
        expect(model(schema, "PluginMachineMaterialization")).not.toMatch(
            /^\s*releaseFacts\s+Json\?\s*$/m,
        );
        expect(model(schema, "PluginMachineMaterialization")).toMatch(
            /^\s*archiveDigestSha256\s+String\?(?:\s|$)/m,
        );
        for (const field of ["normalizedManifest", "collectionContracts", "uiSlots"]) {
            expect(model(schema, "AccountPluginRelease")).toMatch(
                new RegExp(`^\\s*${field}\\s+Json\\b`, "m"),
            );
        }

        // PEP1 is not approved: payload transition staging must not gain a second owner here.
        expect(schema).not.toMatch(/Plugin(?:Collection|AccountKv).*Stage/);
        // Materialization rows reconstruct a machine snapshot; no fifth snapshot record exists.
        expect(schema).not.toContain("PluginMachineMaterializationSnapshot");
    });

    it("keeps the plugin UI slot key MySQL-safe across canonical schemas and migrations", async () => {
        const slotKey = "AccountPluginUiArtifact_release_slot_key";
        const slotUnique = `@@unique([releaseId, contributionId, tier, platform], map: "${slotKey}")`;
        const [postgresSchema, sqliteSchema, mysqlSchema, postgresMigration, sqliteMigration, mysqlMigration] = await Promise.all([
            read("prisma/schema.prisma"),
            read("prisma/sqlite/schema.prisma"),
            read("prisma/mysql/schema.prisma"),
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        expect(slotKey.length).toBeLessThanOrEqual(64);
        for (const schema of [postgresSchema, sqliteSchema, mysqlSchema]) {
            expect(model(schema, "AccountPluginUiArtifact")).toContain(slotUnique);
        }
        expect(postgresMigration).toContain(`CREATE UNIQUE INDEX "${slotKey}"`);
        expect(sqliteMigration).toContain(`CREATE UNIQUE INDEX "${slotKey}"`);
        expect(mysqlMigration).toContain(`UNIQUE INDEX \`${slotKey}\``);
    });

    it("keeps machine materialization index names MySQL-safe across canonical schemas and migrations", async () => {
        const machineIndexKey = "PluginMachineMaterialization_account_server_machine_idx";
        const machineIndex = `@@index([accountId, serverIdentityId, machineId], map: "${machineIndexKey}")`;
        const [postgresSchema, sqliteSchema, mysqlSchema, postgresMigration, sqliteMigration, mysqlMigration] = await Promise.all([
            read("prisma/schema.prisma"),
            read("prisma/sqlite/schema.prisma"),
            read("prisma/mysql/schema.prisma"),
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        expect(machineIndexKey.length).toBeLessThanOrEqual(64);
        for (const schema of [postgresSchema, sqliteSchema, mysqlSchema]) {
            expect(model(schema, "PluginMachineMaterialization")).toContain(machineIndex);
        }
        expect(postgresMigration).toContain(`CREATE INDEX "${machineIndexKey}"`);
        expect(sqliteMigration).toContain(`CREATE INDEX "${machineIndexKey}"`);
        expect(mysqlMigration).toContain(`INDEX \`${machineIndexKey}\``);

        const mysqlPhysicalNames = Array.from(
            mysqlMigration.matchAll(/(?:UNIQUE\s+)?INDEX `([^`]+)`|CONSTRAINT `([^`]+)`/g),
            (match) => match[1] ?? match[2],
        );
        expect(mysqlPhysicalNames).not.toHaveLength(0);
        for (const name of mysqlPhysicalNames) {
            expect(name.length).toBeLessThanOrEqual(64);
        }
    });

    it("keeps contract digests exact and MySQL row identity binary-UTF-8", async () => {
        const [postgresSchema, sqliteSchema, mysqlSchema, mysqlMigration] = await Promise.all([
            read("prisma/schema.prisma"),
            read("prisma/sqlite/schema.prisma"),
            read("prisma/mysql/schema.prisma"),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        for (const schema of [postgresSchema, sqliteSchema]) {
            for (const collectionModel of [
                "PluginCollectionContract",
                "PluginCollectionRow",
                "PluginCollectionIndexState",
            ]) {
                expect(model(schema, collectionModel)).toMatch(/^\s*contractDigest\s+String\b/m);
            }
        }
        for (const collectionModel of [
            "PluginCollectionContract",
            "PluginCollectionRow",
            "PluginCollectionIndexState",
        ]) {
            expect(model(mysqlSchema, collectionModel)).toMatch(
                /^\s*contractDigest\s+String\s+@db\.VarChar\(43\)(?:\s|$)/m,
            );
        }

        for (const [collectionModel, field] of [
            ["PluginCollectionRow", "rowId"],
            ["PluginCollectionProjection", "rowId"],
            ["PluginCollectionIndexEntry", "rowId"],
            ["PluginCollectionRelation", "sourceRowId"],
            ["PluginCollectionRelation", "targetRowId"],
        ] as const) {
            expect(model(mysqlSchema, collectionModel)).toMatch(
                new RegExp(`^\\s*${field}\\s+String\\??\\s+@db\\.VarChar\\(256\\)(?:\\s|$)`, "m"),
            );
        }
        for (const schema of [postgresSchema, sqliteSchema]) {
            expect(model(schema, "PluginCollectionIndexEntry")).toMatch(
                /^\s*encodedSortKey\s+Bytes\b/m,
            );
        }
        expect(model(mysqlSchema, "PluginCollectionIndexEntry")).toMatch(
            /^\s*encodedSortKey\s+Bytes\s+@db\.VarBinary\(2318\)(?:\s|$)/m,
        );
        expect(model(mysqlSchema, "PluginMachineMaterialization")).toMatch(
            /^\s*archiveDigestSha256\s+String\?\s+@db\.VarChar\(71\)(?:\s|$)/m,
        );
        expect(mysqlMigration).toMatch(
            /`archiveDigestSha256` VARCHAR\(71\) CHARACTER SET ascii COLLATE ascii_bin,/,
        );
    });

    it.each([
        ["prisma/migrations", '"'],
        ["prisma/sqlite/migrations", '"'],
        ["prisma/mysql/migrations", "`"],
    ] as const)("adds the same additive database contract for %s", async (migrationRoot, quote) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);

        for (const table of [
            "PluginCollectionContract",
            "PluginCollectionRow",
            "PluginCollectionProjection",
            "PluginCollectionIndexState",
            "PluginCollectionIndexEntry",
            "PluginCollectionRelation",
            "AccountPluginIntent",
            "AccountPluginRelease",
            "AccountPluginUiArtifact",
            "PluginMachineMaterialization",
        ]) {
            expect(sql).toContain(`${quote}${table}${quote}`);
        }
        for (const field of [
            "inputAdmissionReceipt",
            "requestEqualityEvidenceV1",
            "operationProtocolCapabilities",
            "operationProtocolCapabilitiesRevision",
            "pluginMaterializationRevision",
            "archiveDigestSha256",
        ]) {
            expect(sql).toContain(`${quote}${field}${quote}`);
        }
        expect(sql).not.toContain(`${quote}releaseFacts${quote}`);
        expect(sql).not.toMatch(/Plugin(?:Collection|AccountKv).*Stage/);
        expect(sql).not.toContain("PluginMachineMaterializationSnapshot");
    });

    it("stores only 43-character unpadded base64url collection digests in every provider", async () => {
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        for (const sql of [postgresSql, sqliteSql]) {
            expect(sql.match(/(?:char_length|length)\(["`]contractDigest["`]\)\s*=\s*43/gi)).toHaveLength(3);
            expect(sql.match(/A-Za-z0-9_-/g)).toHaveLength(3);
        }
        expect(postgresSql).toMatch(/"contractDigest"\s+VARCHAR\(43\)\s+COLLATE\s+"C"\s+NOT NULL/);
        expect(sqliteSql).toMatch(/"contractDigest"\s+TEXT\s+NOT NULL/);
        expect(mysqlSql).toMatch(/`contractDigest`\s+VARCHAR\(43\)\s+CHARACTER SET ascii COLLATE ascii_bin\s+NOT NULL/);
        expect(mysqlSql).toMatch(/CONSTRAINT `PluginCollectionContract_contract_digest_check`\s+CHECK \(`contractDigest` REGEXP '\^\[A-Za-z0-9_-\]\{43\}\$'\)/);

        for (const field of ["rowId", "sourceRowId", "targetRowId"]) {
            expect(mysqlSql).toMatch(
                new RegExp("`" + field + "` VARCHAR\\(256\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"),
            );
        }
        expect(postgresSql).toMatch(/"encodedSortKey" BYTEA NOT NULL/);
        expect(sqliteSql).toMatch(/"encodedSortKey" BLOB NOT NULL/);
        expect(mysqlSql).toMatch(/`encodedSortKey` VARBINARY\(2318\) NOT NULL/);
    });

    it("applies the additive PostgreSQL contract to the canonical predecessor tables", async () => {
        const db = new PGlite();
        try {
            await db.exec(`
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionPendingMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "accountId" TEXT NOT NULL,
                    UNIQUE ("accountId", "id")
                );
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
            `);
            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));

            const columns = await db.query<{ table_name: string; column_name: string }>(`
                SELECT table_name, column_name
                FROM information_schema.columns
                WHERE (table_name IN ('SessionMessage', 'SessionPendingMessage')
                       AND column_name IN ('inputAdmissionReceipt', 'requestEqualityEvidenceV1'))
                   OR (table_name = 'Machine'
                       AND column_name IN ('operationProtocolCapabilities', 'operationProtocolCapabilitiesRevision'))
                ORDER BY table_name, column_name
            `);
            expect(columns.rows).toHaveLength(6);

            const machineMaterializationRevision = await db.query<{ column_name: string }>(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'Machine'
                  AND column_name = 'pluginMaterializationRevision'
            `);
            expect(machineMaterializationRevision.rows).toEqual([
                { column_name: "pluginMaterializationRevision" },
            ]);

            const materializationReleaseFacts = await db.query<{ column_name: string }>(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'PluginMachineMaterialization'
                  AND column_name = 'releaseFacts'
            `);
            expect(materializationReleaseFacts.rows).toEqual([]);

            const materializationArchiveDigest = await db.query<{ column_name: string }>(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'PluginMachineMaterialization'
                  AND column_name = 'archiveDigestSha256'
            `);
            expect(materializationArchiveDigest.rows).toEqual([
                { column_name: "archiveDigestSha256" },
            ]);

            const artifactLink = await db.query<{ indexname: string }>(`
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'AccountPluginUiArtifact'
                  AND indexname = 'AccountPluginUiArtifact_artifactId_key'
            `);
            expect(artifactLink.rows).toEqual([
                { indexname: "AccountPluginUiArtifact_artifactId_key" },
            ]);

            const index = await db.query<{ indexname: string }>(`
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'PluginCollectionIndexEntry'
                  AND indexname = 'PluginCollectionIndexEntry_sort_key'
            `);
            expect(index.rows).toEqual([{ indexname: "PluginCollectionIndexEntry_sort_key" }]);
        } finally {
            await db.close();
        }
    });

    it("preserves non-NUL Unicode row identity while enforcing digest shape in PostgreSQL", async () => {
        const db = new PGlite();
        try {
            await db.exec(`
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionPendingMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, UNIQUE ("accountId", "id"));
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
                INSERT INTO "Account" ("id") VALUES ('account');
            `);
            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));
            await db.exec(`
                INSERT INTO "PluginCollectionContract" ("id", "pluginId", "collectionId", "schemaVersion", "contractDigest", "normalizedSchema", "indexes", "relations", "privacyProjection")
                VALUES ('contract', 'plugin', 'collection', 1, '${validContractDigest}', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
                INSERT INTO "PluginCollectionRow" ("id", "accountId", "pluginId", "collectionId", "rowId", "schemaVersion", "revision", "contractId", "contractDigest", "contentEnvelope", "updatedAt")
                VALUES ('row', 'account', 'plugin', 'collection', '${unicodeRowId}', 1, 1, 'contract', '${validContractDigest}', '{}'::jsonb, CURRENT_TIMESTAMP);
                INSERT INTO "PluginCollectionProjection" ("id", "rowDbId", "accountId", "pluginId", "collectionId", "rowId", "fieldId", "typedEncodedValue", "rowRevision", "updatedAt")
                VALUES ('projection', 'row', 'account', 'plugin', 'collection', '${unicodeRowId}', 'field', 'value', 1, CURRENT_TIMESTAMP);
                INSERT INTO "PluginCollectionIndexState" ("id", "accountId", "pluginId", "collectionId", "indexId", "contractId", "contractDigest", "buildState", "updatedAt")
                VALUES ('state', 'account', 'plugin', 'collection', 'index', 'contract', '${validContractDigest}', 'ready', CURRENT_TIMESTAMP);
                INSERT INTO "PluginCollectionIndexEntry" ("id", "indexStateId", "encodedSortKey", "rowId", "rowRevision")
                VALUES ('entry', 'state', decode('${nulEscapedIndexedSortKeyHex}', 'hex'), '${unicodeRowId}', 1);
                INSERT INTO "PluginCollectionRelation" ("id", "accountId", "sourceRowDbId", "sourcePluginId", "sourceCollectionId", "sourceRowId", "relationId", "targetKind", "targetPluginId", "targetCollectionId", "targetRowId", "sourceRevision", "updatedAt")
                VALUES ('relation', 'account', 'row', 'plugin', 'collection', '${unicodeRowId}', 'related', 'collection', 'plugin', 'collection', '${unicodeTargetRowId}', 1, CURRENT_TIMESTAMP);
            `);
            const identities = await db.query<{
                rowId: string;
                projectionRowId: string;
                indexRowId: string;
                encodedSortKeyHex: string;
                sourceRowId: string;
                targetRowId: string | null;
            }>(`
                SELECT row."rowId", projection."rowId" AS "projectionRowId", entry."rowId" AS "indexRowId", encode(entry."encodedSortKey", 'hex') AS "encodedSortKeyHex", relation."sourceRowId", relation."targetRowId"
                FROM "PluginCollectionRow" row
                JOIN "PluginCollectionProjection" projection ON projection."rowDbId" = row."id"
                JOIN "PluginCollectionIndexEntry" entry ON entry."id" = 'entry'
                JOIN "PluginCollectionRelation" relation ON relation."id" = 'relation'
            `);
            expect(identities.rows).toEqual([{
                rowId: unicodeRowId,
                projectionRowId: unicodeRowId,
                indexRowId: unicodeRowId,
                encodedSortKeyHex: nulEscapedIndexedSortKeyHex,
                sourceRowId: unicodeRowId,
                targetRowId: unicodeTargetRowId,
            }]);
            await expect(db.exec(`
                INSERT INTO "PluginCollectionContract" ("id", "pluginId", "collectionId", "schemaVersion", "contractDigest", "normalizedSchema", "indexes", "relations", "privacyProjection")
                VALUES ('bad-contract', 'plugin', 'bad', 1, '${invalidContractDigest}', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
            `)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "PluginCollectionContract" ("id", "pluginId", "collectionId", "schemaVersion", "contractDigest", "normalizedSchema", "indexes", "relations", "privacyProjection")
                VALUES ('bad-unicode-contract', 'plugin', 'bad-unicode', 1, '${"é".repeat(43)}', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb);
            `)).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    it("applies the additive SQLite contract to the canonical predecessor tables", async () => {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionPendingMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "accountId" TEXT NOT NULL,
                    UNIQUE ("accountId", "id")
                );
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
            `);
            db.exec(await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`));

            const messageColumns = db.prepare(`
                SELECT name FROM pragma_table_info('SessionMessage')
                WHERE name IN ('inputAdmissionReceipt', 'requestEqualityEvidenceV1')
                ORDER BY name
            `).all();
            expect(messageColumns).toEqual([
                { name: "inputAdmissionReceipt" },
                { name: "requestEqualityEvidenceV1" },
            ]);
            expect(db.prepare(`
                SELECT name FROM pragma_table_info('Machine')
                WHERE name IN ('operationProtocolCapabilities', 'operationProtocolCapabilitiesRevision')
                ORDER BY name
            `).all()).toEqual([
                { name: "operationProtocolCapabilities" },
                { name: "operationProtocolCapabilitiesRevision" },
            ]);
            expect(db.prepare(`
                SELECT name FROM pragma_table_info('Machine')
                WHERE name = 'pluginMaterializationRevision'
            `).all()).toEqual([
                { name: "pluginMaterializationRevision" },
            ]);
            expect(db.prepare(`
                SELECT name FROM pragma_table_info('PluginMachineMaterialization')
                WHERE name = 'releaseFacts'
            `).all()).toEqual([]);
            expect(db.prepare(`
                SELECT name FROM pragma_table_info('PluginMachineMaterialization')
                WHERE name = 'archiveDigestSha256'
            `).all()).toEqual([
                { name: "archiveDigestSha256" },
            ]);
            expect(db.prepare(`
                SELECT name FROM sqlite_master
                WHERE type = 'index' AND name = 'AccountPluginUiArtifact_artifactId_key'
            `).all()).toEqual([
                { name: "AccountPluginUiArtifact_artifactId_key" },
            ]);
            expect(db.prepare(`
                SELECT name FROM sqlite_master
                WHERE type = 'index' AND name = 'PluginCollectionIndexEntry_sort_key'
            `).all()).toEqual([{ name: "PluginCollectionIndexEntry_sort_key" }]);
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("preserves non-NUL Unicode row identity while enforcing digest shape in SQLite", async () => {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionPendingMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, UNIQUE ("accountId", "id"));
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
                INSERT INTO "Account" ("id") VALUES ('account');
            `);
            db.exec(await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`));
            db.exec(`
                INSERT INTO "PluginCollectionContract" ("id", "pluginId", "collectionId", "schemaVersion", "contractDigest", "normalizedSchema", "indexes", "relations", "privacyProjection")
                VALUES ('contract', 'plugin', 'collection', 1, '${validContractDigest}', '{}', '[]', '[]', '[]');
                INSERT INTO "PluginCollectionRow" ("id", "accountId", "pluginId", "collectionId", "rowId", "schemaVersion", "revision", "contractId", "contractDigest", "contentEnvelope", "updatedAt")
                VALUES ('row', 'account', 'plugin', 'collection', '${unicodeRowId}', 1, 1, 'contract', '${validContractDigest}', '{}', CURRENT_TIMESTAMP);
                INSERT INTO "PluginCollectionProjection" ("id", "rowDbId", "accountId", "pluginId", "collectionId", "rowId", "fieldId", "typedEncodedValue", "rowRevision", "updatedAt")
                VALUES ('projection', 'row', 'account', 'plugin', 'collection', '${unicodeRowId}', 'field', 'value', 1, CURRENT_TIMESTAMP);
                INSERT INTO "PluginCollectionIndexState" ("id", "accountId", "pluginId", "collectionId", "indexId", "contractId", "contractDigest", "buildState", "updatedAt")
                VALUES ('state', 'account', 'plugin', 'collection', 'index', 'contract', '${validContractDigest}', 'ready', CURRENT_TIMESTAMP);
                INSERT INTO "PluginCollectionIndexEntry" ("id", "indexStateId", "encodedSortKey", "rowId", "rowRevision")
                VALUES ('entry', 'state', X'${nulEscapedIndexedSortKeyHex}', '${unicodeRowId}', 1);
                INSERT INTO "PluginCollectionRelation" ("id", "accountId", "sourceRowDbId", "sourcePluginId", "sourceCollectionId", "sourceRowId", "relationId", "targetKind", "targetPluginId", "targetCollectionId", "targetRowId", "sourceRevision", "updatedAt")
                VALUES ('relation', 'account', 'row', 'plugin', 'collection', '${unicodeRowId}', 'related', 'collection', 'plugin', 'collection', '${unicodeTargetRowId}', 1, CURRENT_TIMESTAMP);
            `);
            expect(db.prepare(`
                SELECT row."rowId", projection."rowId" AS "projectionRowId", entry."rowId" AS "indexRowId", lower(hex(entry."encodedSortKey")) AS "encodedSortKeyHex", relation."sourceRowId", relation."targetRowId"
                FROM "PluginCollectionRow" row
                JOIN "PluginCollectionProjection" projection ON projection."rowDbId" = row."id"
                JOIN "PluginCollectionIndexEntry" entry ON entry."id" = 'entry'
                JOIN "PluginCollectionRelation" relation ON relation."id" = 'relation'
            `).all()).toEqual([{
                rowId: unicodeRowId,
                projectionRowId: unicodeRowId,
                indexRowId: unicodeRowId,
                encodedSortKeyHex: nulEscapedIndexedSortKeyHex,
                sourceRowId: unicodeRowId,
                targetRowId: unicodeTargetRowId,
            }]);
            expect(() => db.exec(`
                INSERT INTO "PluginCollectionContract" ("id", "pluginId", "collectionId", "schemaVersion", "contractDigest", "normalizedSchema", "indexes", "relations", "privacyProjection")
                VALUES ('bad-contract', 'plugin', 'bad', 1, '${invalidContractDigest}', '{}', '[]', '[]', '[]');
            `)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "PluginCollectionContract" ("id", "pluginId", "collectionId", "schemaVersion", "contractDigest", "normalizedSchema", "indexes", "relations", "privacyProjection")
                VALUES ('bad-unicode-contract', 'plugin', 'bad-unicode', 1, '${"é".repeat(43)}', '{}', '[]', '[]', '[]');
            `)).toThrow();
        } finally {
            db.close();
        }
    });

    it.each(schemaPaths)("keeps private SessionMessage row revision additive in %s", async (schemaPath) => {
        expect(model(await read(schemaPath), "SessionMessage")).toMatch(
            /^\s*rowRevision\s+BigInt\s+@default\(0\)\s*$/m,
        );
    });

    it.each([
        ["prisma/migrations", predecessorRowRevisionMigration.postgres],
        ["prisma/sqlite/migrations", predecessorRowRevisionMigration.sqlite],
        ["prisma/mysql/migrations", predecessorRowRevisionMigration.mysql],
    ] as const)(
        `ships the predecessor Message row revision migration ${predecessorRowRevisionMigrationId} in %s`,
        async (migrationRoot, expectedSql) => {
            await expect(
                read(`${migrationRoot}/${predecessorRowRevisionMigrationId}/migration.sql`),
            ).resolves.toBe(expectedSql);
        },
    );

    it.each([
        ["prisma/migrations", '"', predecessorRowRevisionMigration.postgres],
        ["prisma/sqlite/migrations", '"', predecessorRowRevisionMigration.sqlite],
        ["prisma/mysql/migrations", "`", predecessorRowRevisionMigration.mysql],
    ] as const)(
        `keeps the Message row revision DDL in predecessor migration ${predecessorRowRevisionMigrationId} for %s`,
        async (migrationRoot, quote, predecessorSql) => {
            const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);
            const sessionMessageStatements = sql.match(
                new RegExp(`ALTER TABLE\\s+${quote}SessionMessage${quote}[\\s\\S]*?;`, "gi"),
            ) ?? [];

            expect(predecessorSql).toBe(
                `ALTER TABLE ${quote}SessionMessage${quote} ADD COLUMN ${quote}rowRevision${quote} BIGINT NOT NULL DEFAULT 0;\n`,
            );
            expect(sessionMessageStatements).not.toHaveLength(0);
            expect(sessionMessageStatements.join("\n")).toContain(`${quote}inputAdmissionReceipt${quote}`);
            expect(sessionMessageStatements.join("\n")).toContain(`${quote}requestEqualityEvidenceV1${quote}`);
            expect(sessionMessageStatements.join("\n")).not.toContain(`${quote}rowRevision${quote}`);
        },
    );

    it("applies the clean PostgreSQL dev-to-predecessor migration chain with one private Message row revision", async () => {
        const db = new PGlite();
        try {
            await db.exec(`
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionPendingMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, UNIQUE ("accountId", "id"));
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
            `);
            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));
            await db.exec(predecessorRowRevisionMigration.postgres);
            await db.exec(`INSERT INTO "SessionMessage" ("id") VALUES ('message');`);
            const rowRevisionColumns = await db.query<{ column_name: string }>(`
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'SessionMessage' AND column_name = 'rowRevision'
            `);
            expect(rowRevisionColumns.rows).toEqual([{ column_name: "rowRevision" }]);
            const revision = await db.query<{ rowRevision: string | number | bigint }>(`
                SELECT "rowRevision" FROM "SessionMessage" WHERE "id" = 'message'
            `);
            expect(BigInt(revision.rows[0]!.rowRevision)).toBe(BigInt(0));

            await Promise.all([
                db.exec(`UPDATE "SessionMessage" SET "rowRevision" = "rowRevision" + 1 WHERE "id" = 'message';`),
                db.exec(`UPDATE "SessionMessage" SET "rowRevision" = "rowRevision" + 1 WHERE "id" = 'message';`),
            ]);
            const committedRevision = await db.query<{ rowRevision: string | number | bigint }>(`
                SELECT "rowRevision" FROM "SessionMessage" WHERE "id" = 'message'
            `);
            expect(BigInt(committedRevision.rows[0]!.rowRevision)).toBe(BigInt(2));

            await db.exec(`
                BEGIN;
                UPDATE "SessionMessage" SET "rowRevision" = "rowRevision" + 1 WHERE "id" = 'message';
                ROLLBACK;
            `);
            const rolledBackRevision = await db.query<{ rowRevision: string | number | bigint }>(`
                SELECT "rowRevision" FROM "SessionMessage" WHERE "id" = 'message'
            `);
            expect(BigInt(rolledBackRevision.rows[0]!.rowRevision)).toBe(BigInt(2));
        } finally {
            await db.close();
        }
    });

    it("applies predecessor SQLite row revision before the pending dev migration without a duplicate", async () => {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "SessionPendingMessage" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, UNIQUE ("accountId", "id"));
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
            `);
            db.exec(predecessorRowRevisionMigration.sqlite);
            db.exec(await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`));
            expect(db.prepare(`
                SELECT COUNT(*) AS "count"
                FROM pragma_table_info('SessionMessage')
                WHERE "name" = 'rowRevision'
            `).get()).toEqual({ count: 1 });
            db.exec(`INSERT INTO "SessionMessage" ("id") VALUES ('message');`);
            expect(db.prepare(`SELECT "rowRevision" FROM "SessionMessage" WHERE "id" = 'message'`).get())
                .toEqual({ rowRevision: 0 });

            db.exec(`
                UPDATE "SessionMessage" SET "rowRevision" = "rowRevision" + 1 WHERE "id" = 'message';
                UPDATE "SessionMessage" SET "rowRevision" = "rowRevision" + 1 WHERE "id" = 'message';
            `);
            expect(db.prepare(`SELECT "rowRevision" FROM "SessionMessage" WHERE "id" = 'message'`).get())
                .toEqual({ rowRevision: 2 });

            db.exec(`
                BEGIN;
                UPDATE "SessionMessage" SET "rowRevision" = "rowRevision" + 1 WHERE "id" = 'message';
                ROLLBACK;
            `);
            expect(db.prepare(`SELECT "rowRevision" FROM "SessionMessage" WHERE "id" = 'message'`).get())
                .toEqual({ rowRevision: 2 });
        } finally {
            db.close();
        }
    });
});
