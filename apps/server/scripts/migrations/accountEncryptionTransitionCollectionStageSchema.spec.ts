import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260812210000_add_account_encryption_transition_collection_staging";
const contractDigest = "A".repeat(43);

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

function updateStatement(sql: string, table: string, quote: "\"" | "`"): string {
    const escapedQuote = quote === "\"" ? "\\\"" : "`";
    const match = sql.match(new RegExp(
        `UPDATE\\s+${escapedQuote}${table}${escapedQuote}[\\s\\S]*?;`,
        "i",
    ));
    if (!match?.[0]) {
        throw new Error(`missing ${table} backfill UPDATE`);
    }
    return match[0];
}

const providers = [
    {
        name: "postgres",
        schema: "prisma/schema.prisma",
        migration: `prisma/migrations/${migrationId}/migration.sql`,
        quote: "\"" as const,
        jsonNull: /'null'::jsonb/,
        idempotence: /"contentEnvelope"\s+IS DISTINCT FROM\s+'null'::jsonb/i,
    },
    {
        name: "sqlite",
        schema: "prisma/sqlite/schema.prisma",
        migration: `prisma/sqlite/migrations/${migrationId}/migration.sql`,
        quote: "\"" as const,
        jsonNull: /json\('null'\)/i,
        idempotence: /json_type\("contentEnvelope"\)\s*<>\s*'null'/i,
    },
    {
        name: "mysql",
        schema: "prisma/mysql/schema.prisma",
        migration: `prisma/mysql/migrations/${migrationId}/migration.sql`,
        quote: "`" as const,
        jsonNull: /CAST\('null' AS JSON\)/i,
        idempotence: /JSON_TYPE\(`contentEnvelope`\)\s*<>\s*'NULL'/i,
    },
] as const;

describe("Account encryption transition Collection-stage persistence contract", () => {
    it.each(providers)("keeps Account as the sole transition owner in $name", async (provider) => {
        const schema = await read(provider.schema);
        const account = model(schema, "Account");
        const transition = model(schema, "AccountEncryptionTransition");
        const stage = model(schema, "AccountEncryptionTransitionCollectionStage");

        expect(account).toMatch(/^\s*AccountEncryptionTransitions\s+AccountEncryptionTransition\[\]\s*$/m);
        expect(transition).toMatch(/^\s*id\s+String(?:\s+@db\.[^\s]+)?\s+@id\s+@default\(uuid\(\)\)\s*$/m);
        expect(transition).toMatch(/^\s*accountId\s+String\b/m);
        expect(transition).toMatch(/^\s*account\s+Account\s+@relation\(fields: \[accountId\], references: \[id\], onDelete: Cascade\)\s*$/m);
        for (const field of [
            "fromEncryptionMode",
            "toEncryptionMode",
            "sourceAccountVersion",
            "sourceSettingsVersion",
            "sourceSigningKeyFingerprint",
            "sourceContentKeyFingerprint",
            "targetSigningKeyFingerprint",
            "targetContentKeyFingerprint",
            "targetAccountPublicKey",
            "targetContentPublicKey",
            "targetContentPublicKeySig",
            "status",
            "activeAccountId",
            "preparedAt",
            "authorizedAt",
            "expiresAt",
            "activatedAt",
            "activatedAccountVersion",
            "activatedAccountUpdatedAt",
            "activatedAccountCursor",
            "cancelledAt",
            "expiredAt",
            "censusParticipantCount",
            "censusSourceBytes",
            "censusTargetBytes",
            "stagedParticipantCount",
            "stagedSourceBytes",
            "stagedTargetBytes",
            "reservedCapacityBytes",
            "measuredParticipantLimit",
            "measuredEncodedByteLimit",
        ]) {
            expect(transition).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
        }
        expect(transition).toMatch(/^\s*activeAccountId\s+String\?(?:\s+@db\.[^\s]+)?\s+@unique\s*$/m);
        expect(transition).toMatch(/^\s*measuredParticipantLimit\s+Int\?\s*$/m);
        expect(transition).toMatch(/^\s*measuredEncodedByteLimit\s+BigInt\?\s*$/m);
        expect(transition).toMatch(/^\s*stages\s+AccountEncryptionTransitionCollectionStage\[\]\s*$/m);
        expect(transition).toContain('@@index([accountId, status, expiresAt], map: "AccountEncryptionTransition_account_status_expiry_idx")');

        expect(stage).toMatch(/^\s*transitionId\s+String\b/m);
        expect(stage).toMatch(/^\s*transition\s+AccountEncryptionTransition\s+@relation\(fields: \[transitionId\], references: \[id\], onDelete: Cascade\)\s*$/m);
        for (const field of [
            "pluginId",
            "collectionId",
            "rowId",
            "sourceRevision",
            "sourceEnvelope",
            "targetEnvelope",
            "schemaVersion",
            "contractDigest",
            "sourceEncodedBytes",
            "targetEncodedBytes",
        ]) {
            expect(stage).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
        }
        expect(stage).toMatch(/^\s*sourceEnvelope\s+Json\s*$/m);
        // Prepare persists the complete immutable source census before any
        // client target exists; only later stage writes fill these fields.
        expect(stage).toMatch(/^\s*targetEnvelope\s+Json\?\s*$/m);
        expect(stage).toMatch(/^\s*sourceEncodedBytes\s+BigInt\s*$/m);
        expect(stage).toMatch(/^\s*targetEncodedBytes\s+BigInt\?\s*$/m);
        expect(stage).toContain('@@unique([transitionId, pluginId, collectionId, rowId], map: "AccountEncryptionTransitionCollectionStage_identity_key")');
        // Inventory and re-census keyset on the public stage identity, so the
        // supporting index must match that order rather than a surrogate id.
        expect(stage).toContain('@@index([transitionId, pluginId, collectionId, rowId], map: "AccountEncryptionTransitionCollectionStage_transition_page_idx")');

        if (provider.name === "mysql") {
            expect(transition).toMatch(/^\s*id\s+String\s+@db\.VarChar\(36\)\s+@id\s+@default\(uuid\(\)\)\s*$/m);
            expect(transition).toMatch(/^\s*accountId\s+String\s+@db\.VarChar\(191\)\s*$/m);
            expect(transition).toMatch(/^\s*activeAccountId\s+String\?\s+@db\.VarChar\(191\)\s+@unique\s*$/m);
            expect(stage).toMatch(/^\s*transitionId\s+String\s+@db\.VarChar\(36\)\s*$/m);
        }

        // Collection rows remain independent retained records; the stage carries only exact facts.
        expect(model(schema, "PluginCollectionRow")).not.toMatch(/AccountEncryptionTransitionCollectionStage/);
    });

    it.each(providers)("adds an idempotent JSON-null tombstone scrub without mutating revision facts in $name", async (provider) => {
        const sql = await read(provider.migration);
        const transitionTable = `${provider.quote}AccountEncryptionTransition${provider.quote}`;
        const stageTable = `${provider.quote}AccountEncryptionTransitionCollectionStage${provider.quote}`;
        const backfill = updateStatement(sql, "PluginCollectionRow", provider.quote);

        expect(sql).toContain(transitionTable);
        expect(sql).toContain(stageTable);
        expect(sql).toContain(`${provider.quote}activeAccountId${provider.quote}`);
        expect(sql).toContain(`${provider.quote}sourceEnvelope${provider.quote}`);
        expect(sql).toContain(`${provider.quote}targetEnvelope${provider.quote}`);
        expect(sql).toContain(`${provider.quote}sourceEncodedBytes${provider.quote}`);
        expect(sql).toContain(`${provider.quote}targetEncodedBytes${provider.quote}`);
        expect(sql).toMatch(provider.jsonNull);
        expect(backfill).toMatch(provider.idempotence);
        expect(backfill).toMatch(new RegExp(`${provider.quote}deletedAt${provider.quote}\\s+IS NOT NULL`, "i"));
        expect(backfill).not.toMatch(/\b(?:revision|deletedAt)\s*=/i);
        expect(sql).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${provider.quote}PluginCollectionRow${provider.quote}`, "i"));
        expect(sql).toMatch(/ON DELETE CASCADE ON UPDATE CASCADE/i);
        expect(sql).toMatch(new RegExp(
            `${provider.quote}status${provider.quote}\\s+IN\\s*\\('preparing', 'authorized', 'activated', 'cancelled', 'expired'\\)`,
        ));
        expect(sql).toMatch(new RegExp(
            `${provider.quote}fromEncryptionMode${provider.quote}\\s+IN\\s*\\('plain', 'e2ee'\\)`,
        ));
        expect(sql).toMatch(new RegExp(
            `${provider.quote}toEncryptionMode${provider.quote}\\s+IN\\s*\\('plain', 'e2ee'\\)`,
        ));
        expect(sql).toMatch(new RegExp(`${provider.quote}sourceRevision${provider.quote}\\s*>=\\s*1`));
        expect(sql).not.toMatch(new RegExp(
            `${provider.quote}targetEnvelope${provider.quote}\\s+(?:JSONB|JSON|TEXT)\\s+NOT NULL`,
            "i",
        ));
    });

    it("applies the PostgreSQL migration with in-place JSON-null tombstones and Account-owned stage cleanup", async () => {
        const db = new PGlite();
        try {
            const sql = await read(`prisma/migrations/${migrationId}/migration.sql`);
            await db.exec(`
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "PluginCollectionRow" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "revision" INTEGER NOT NULL,
                    "contractDigest" TEXT NOT NULL,
                    "contentEnvelope" JSONB NOT NULL,
                    "deletedAt" TIMESTAMP(3)
                );
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "PluginCollectionRow" ("id", "revision", "contractDigest", "contentEnvelope", "deletedAt") VALUES
                    ('live', 3, '${contractDigest}', '{"t":"plain","v":{"keep":true}}'::jsonb, NULL),
                    ('tombstone', 7, '${contractDigest}', '{"t":"plain","v":{"secret":"erase"}}'::jsonb, TIMESTAMP '2026-08-12 00:00:00'),
                    ('already-null', 9, '${contractDigest}', 'null'::jsonb, TIMESTAMP '2026-08-12 01:00:00');
            `);
            await db.exec(sql);

            const rows = await db.query<{
                id: string;
                revision: number;
                contractDigest: string;
                tombstoneRetained: boolean;
                contentIsSqlNull: boolean;
                contentIsJsonNull: boolean;
            }>(`
                SELECT
                    "id",
                    "revision",
                    "contractDigest",
                    ("deletedAt" IS NOT NULL) AS "tombstoneRetained",
                    ("contentEnvelope" IS NULL) AS "contentIsSqlNull",
                    ("contentEnvelope" = 'null'::jsonb) AS "contentIsJsonNull"
                FROM "PluginCollectionRow"
                ORDER BY "id";
            `);
            expect(rows.rows).toEqual([
                { id: "already-null", revision: 9, contractDigest, tombstoneRetained: true, contentIsSqlNull: false, contentIsJsonNull: true },
                { id: "live", revision: 3, contractDigest, tombstoneRetained: false, contentIsSqlNull: false, contentIsJsonNull: false },
                { id: "tombstone", revision: 7, contractDigest, tombstoneRetained: true, contentIsSqlNull: false, contentIsJsonNull: true },
            ]);
            await db.exec(updateStatement(sql, "PluginCollectionRow", "\""));

            await db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status", "activeAccountId",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'transition-1', 'account-1', 'e2ee', 'plain',
                    11, 13, 'preparing', 'account-1',
                    TIMESTAMP '2026-08-12 00:00:00', TIMESTAMP '2026-08-12 01:00:00', TIMESTAMP '2026-08-12 00:00:00'
                );
                INSERT INTO "AccountEncryptionTransitionCollectionStage" (
                    "id", "transitionId", "pluginId", "collectionId", "rowId", "sourceRevision",
                    "sourceEnvelope", "targetEnvelope", "schemaVersion", "contractDigest",
                    "sourceEncodedBytes", "targetEncodedBytes", "updatedAt"
                ) VALUES (
                    'stage-1', 'transition-1', 'plugin', 'tasks', 'task-1', 7,
                    '{"t":"encrypted","c":"source"}'::jsonb, '{"t":"plain","v":{"title":"task"}}'::jsonb,
                    1, '${contractDigest}', 24, 21, TIMESTAMP '2026-08-12 00:00:00'
                );
            `);
            await expect(db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status", "activeAccountId",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'transition-2', 'account-1', 'plain', 'e2ee',
                    12, 14, 'authorized', 'account-1',
                    TIMESTAMP '2026-08-12 00:00:00', TIMESTAMP '2026-08-12 01:00:00', TIMESTAMP '2026-08-12 00:00:00'
                );
            `)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'unknown-transition', 'account-1', 'e2ee', 'plain',
                    13, 15, 'unknown',
                    TIMESTAMP '2026-08-12 00:00:00', TIMESTAMP '2026-08-12 01:00:00', TIMESTAMP '2026-08-12 00:00:00'
                );
            `)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'invalid-mode-transition', 'account-1', 'unknown', 'plain',
                    13, 15, 'cancelled',
                    TIMESTAMP '2026-08-12 00:00:00', TIMESTAMP '2026-08-12 01:00:00', TIMESTAMP '2026-08-12 00:00:00'
                );
            `)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "AccountEncryptionTransitionCollectionStage" (
                    "id", "transitionId", "pluginId", "collectionId", "rowId", "sourceRevision",
                    "sourceEnvelope", "targetEnvelope", "schemaVersion", "contractDigest",
                    "sourceEncodedBytes", "targetEncodedBytes", "updatedAt"
                ) VALUES (
                    'invalid-stage', 'transition-1', 'plugin', 'tasks', 'task-0', 0,
                    '{"t":"encrypted","c":"source"}'::jsonb, '{"t":"plain","v":{}}'::jsonb,
                    1, '${contractDigest}', 24, 2, TIMESTAMP '2026-08-12 00:00:00'
                );
            `)).rejects.toThrow();
            await db.exec(`DELETE FROM "AccountEncryptionTransition" WHERE "id" = 'transition-1';`);
            const stages = await db.query<{ count: number }>(`
                SELECT COUNT(*)::int AS "count" FROM "AccountEncryptionTransitionCollectionStage";
            `);
            expect(stages.rows).toEqual([{ count: 0 }]);
        } finally {
            await db.close();
        }
    });

    it("applies the SQLite migration with the same in-place JSON-null and cascade semantics", async () => {
        const db = new DatabaseSync(":memory:");
        try {
            const sql = await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`);
            db.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "PluginCollectionRow" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "revision" INTEGER NOT NULL,
                    "contractDigest" TEXT NOT NULL,
                    "contentEnvelope" JSONB NOT NULL,
                    "deletedAt" DATETIME
                );
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "PluginCollectionRow" ("id", "revision", "contractDigest", "contentEnvelope", "deletedAt") VALUES
                    ('live', 3, '${contractDigest}', '{"t":"plain","v":{"keep":true}}', NULL),
                    ('tombstone', 7, '${contractDigest}', '{"t":"plain","v":{"secret":"erase"}}', '2026-08-12T00:00:00.000Z'),
                    ('already-null', 9, '${contractDigest}', json('null'), '2026-08-12T01:00:00.000Z');
            `);
            db.exec(sql);
            const rows = db.prepare(`
                SELECT
                    "id",
                    "revision",
                    "contractDigest",
                    ("deletedAt" IS NOT NULL) AS "tombstoneRetained",
                    ("contentEnvelope" IS NULL) AS "contentIsSqlNull",
                    (json_type("contentEnvelope") = 'null') AS "contentIsJsonNull"
                FROM "PluginCollectionRow"
                ORDER BY "id";
            `).all() as Array<{
                id: string;
                revision: number;
                contractDigest: string;
                tombstoneRetained: number;
                contentIsSqlNull: number;
                contentIsJsonNull: number;
            }>;
            expect(rows).toEqual([
                { id: "already-null", revision: 9, contractDigest, tombstoneRetained: 1, contentIsSqlNull: 0, contentIsJsonNull: 1 },
                { id: "live", revision: 3, contractDigest, tombstoneRetained: 0, contentIsSqlNull: 0, contentIsJsonNull: 0 },
                { id: "tombstone", revision: 7, contractDigest, tombstoneRetained: 1, contentIsSqlNull: 0, contentIsJsonNull: 1 },
            ]);
            db.exec(updateStatement(sql, "PluginCollectionRow", "\""));

            db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status", "activeAccountId",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'transition-1', 'account-1', 'e2ee', 'plain',
                    11, 13, 'preparing', 'account-1',
                    '2026-08-12T00:00:00.000Z', '2026-08-12T01:00:00.000Z', '2026-08-12T00:00:00.000Z'
                );
                INSERT INTO "AccountEncryptionTransitionCollectionStage" (
                    "id", "transitionId", "pluginId", "collectionId", "rowId", "sourceRevision",
                    "sourceEnvelope", "targetEnvelope", "schemaVersion", "contractDigest",
                    "sourceEncodedBytes", "targetEncodedBytes", "updatedAt"
                ) VALUES (
                    'stage-1', 'transition-1', 'plugin', 'tasks', 'task-1', 7,
                    '{"t":"encrypted","c":"source"}', '{"t":"plain","v":{"title":"task"}}',
                    1, '${contractDigest}', 24, 21, '2026-08-12T00:00:00.000Z'
                );
            `);
            expect(() => db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status", "activeAccountId",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'transition-2', 'account-1', 'plain', 'e2ee',
                    12, 14, 'authorized', 'account-1',
                    '2026-08-12T00:00:00.000Z', '2026-08-12T01:00:00.000Z', '2026-08-12T00:00:00.000Z'
                );
            `)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'invalid-mode-transition', 'account-1', 'unknown', 'plain',
                    13, 15, 'cancelled',
                    '2026-08-12T00:00:00.000Z', '2026-08-12T01:00:00.000Z', '2026-08-12T00:00:00.000Z'
                );
            `)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "AccountEncryptionTransition" (
                    "id", "accountId", "fromEncryptionMode", "toEncryptionMode",
                    "sourceAccountVersion", "sourceSettingsVersion", "status",
                    "preparedAt", "expiresAt", "updatedAt"
                ) VALUES (
                    'unknown-transition', 'account-1', 'e2ee', 'plain',
                    13, 15, 'unknown',
                    '2026-08-12T00:00:00.000Z', '2026-08-12T01:00:00.000Z', '2026-08-12T00:00:00.000Z'
                );
            `)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "AccountEncryptionTransitionCollectionStage" (
                    "id", "transitionId", "pluginId", "collectionId", "rowId", "sourceRevision",
                    "sourceEnvelope", "targetEnvelope", "schemaVersion", "contractDigest",
                    "sourceEncodedBytes", "targetEncodedBytes", "updatedAt"
                ) VALUES (
                    'invalid-stage', 'transition-1', 'plugin', 'tasks', 'task-0', 0,
                    '{"t":"encrypted","c":"source"}', '{"t":"plain","v":{}}',
                    1, '${contractDigest}', 24, 2, '2026-08-12T00:00:00.000Z'
                );
            `)).toThrow();
            db.exec(`DELETE FROM "AccountEncryptionTransition" WHERE "id" = 'transition-1';`);
            const stages = db.prepare(`
                SELECT COUNT(*) AS "count" FROM "AccountEncryptionTransitionCollectionStage";
            `).all();
            expect(stages).toEqual([{ count: 0 }]);
        } finally {
            db.close();
        }
    });
});
