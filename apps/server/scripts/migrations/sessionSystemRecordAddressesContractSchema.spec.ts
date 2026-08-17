import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260810120000_contract_session_system_record_addresses";

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

const expandedSqliteSessionSystemRecord = `
    CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "SessionSystemRecord" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "accountId" TEXT NOT NULL,
        "sessionId" TEXT NOT NULL,
        "namespace" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "localId" TEXT NOT NULL,
        "content" JSONB NOT NULL,
        "ownerKind" TEXT,
        "pluginId" TEXT,
        "namespaceAddressKey" BLOB,
        "recordAddressKey" BLOB,
        "version" INTEGER NOT NULL DEFAULT 1,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL,
        CONSTRAINT "SessionSystemRecord_accountId_fkey"
            FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "SessionSystemRecord_sessionId_fkey"
            FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "SessionSystemRecord_ownerKind_check"
            CHECK ("ownerKind" IS NULL OR "ownerKind" IN ('host', 'plugin')),
        CONSTRAINT "SessionSystemRecord_version_check"
            CHECK ("version" BETWEEN 1 AND 2147483647)
    );
    CREATE UNIQUE INDEX "SessionSystemRecord_accountId_sessionId_namespace_localId_key"
    ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "localId");
    CREATE INDEX "SessionSystemRecord_account_kind_updated_idx"
    ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "kind", "updatedAt", "id");
    CREATE INDEX "SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx"
    ON "SessionSystemRecord"("sessionId", "namespace", "kind", "updatedAt", "id");
`;

const expandedPostgresSessionSystemRecord = `
    CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY);
    CREATE TABLE "SessionSystemRecord" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "accountId" TEXT NOT NULL,
        "sessionId" TEXT NOT NULL,
        "namespace" TEXT NOT NULL,
        "kind" TEXT NOT NULL,
        "localId" TEXT NOT NULL,
        "content" JSONB NOT NULL,
        "ownerKind" TEXT,
        "pluginId" TEXT,
        "namespaceAddressKey" BYTEA,
        "recordAddressKey" BYTEA,
        "version" INTEGER NOT NULL DEFAULT 1,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "SessionSystemRecord_accountId_fkey"
            FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "SessionSystemRecord_sessionId_fkey"
            FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "SessionSystemRecord_ownerKind_check"
            CHECK ("ownerKind" IS NULL OR "ownerKind" IN ('host', 'plugin')),
        CONSTRAINT "SessionSystemRecord_version_check"
            CHECK ("version" BETWEEN 1 AND 2147483647)
    );
    CREATE UNIQUE INDEX "SessionSystemRecord_accountId_sessionId_namespace_localId_key"
    ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "localId");
    CREATE INDEX "SessionSystemRecord_account_kind_updated_idx"
    ON "SessionSystemRecord"("accountId", "sessionId", "namespace", "kind", "updatedAt" DESC, "id" DESC);
    CREATE INDEX "SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx"
    ON "SessionSystemRecord"("sessionId", "namespace", "kind", "updatedAt" DESC, "id" DESC);
`;

describe("Session System Record address CONTRACT migration", () => {
    const schemaPaths = [
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ] as const;

    it.each(schemaPaths)("makes the derived address the only persistence identity in %s", async (schemaPath) => {
        const sessionSystemRecord = model(await read(schemaPath), "SessionSystemRecord");

        expect(sessionSystemRecord).toMatch(/^\s*ownerKind\s+String\b(?!\?)(?:\s+@db\.[^\s]+)?\s*$/m);
        expect(sessionSystemRecord).toMatch(/^\s*pluginId\s+String\?(?:\s+@db\.[^\s]+)?\s*$/m);
        expect(sessionSystemRecord).toMatch(/^\s*namespaceAddressKey\s+Bytes\b(?!\?)(?:\s+@db\.[^\s]+)?\s*$/m);
        expect(sessionSystemRecord).toMatch(/^\s*recordAddressKey\s+Bytes\b(?!\?)(?:\s+@db\.[^\s]+)?\s*$/m);
        expect(sessionSystemRecord).toMatch(/^\s*permissionTurnId\s+String\?(?:\s+@db\.[^\s]+)?\s*$/m);
        expect(sessionSystemRecord).toMatch(/^\s*permissionRequestId\s+String\?(?:\s+@db\.[^\s]+)?\s*$/m);
        if (schemaPath === "prisma/mysql/schema.prisma") {
            expect(sessionSystemRecord).toMatch(/^\s*permissionTurnId\s+String\?\s+@db\.VarChar\(191\)\s*$/m);
            expect(sessionSystemRecord).toMatch(/^\s*permissionRequestId\s+String\?\s+@db\.VarChar\(256\)\s*$/m);
        }
        expect(sessionSystemRecord).toContain(
            '@@unique([accountId, sessionId, recordAddressKey], map: "SessionSystemRecord_account_session_record_key")',
        );
        expect(sessionSystemRecord).toContain(
            '@@index([accountId, sessionId, namespaceAddressKey, kind, updatedAt',
        );
        expect(sessionSystemRecord).toContain(
            'map: "SessionSystemRecord_account_namespace_kind_updated_idx")',
        );
        expect(sessionSystemRecord).toContain(
            '@@index([sessionId], map: "SessionSystemRecord_sessionId_idx")',
        );
        expect(sessionSystemRecord).not.toContain(
            "@@unique([accountId, sessionId, namespace, localId])",
        );
        expect(sessionSystemRecord).not.toContain(
            "SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx",
        );
    });

    it.each([
        ["prisma/migrations", '"'],
        ["prisma/sqlite/migrations", '"'],
        ["prisma/mysql/migrations", "`"],
    ] as const)("requires a complete backfill before finalizing %s", async (migrationRoot, quote) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);

        expect(sql).toContain(`${quote}SessionSystemRecord${quote}`);
        expect(sql).toContain("namespaceAddressKey");
        expect(sql).toContain("recordAddressKey");
        expect(sql).toContain("permissionTurnId");
        expect(sql).toContain("permissionRequestId");
        expect(sql).toContain("SessionSystemRecord_permission_mediation_identity_check");
        if (migrationRoot === "prisma/mysql/migrations") {
            expect(sql).toContain("`namespaceAddressKey` BINARY(32) NOT NULL");
            expect(sql).toContain("`recordAddressKey` BINARY(32) NOT NULL");
        } else {
            expect(sql).toContain("namespaceAddressKey_length_check");
            expect(sql).toContain("recordAddressKey_length_check");
        }
        expect(sql).toContain("SessionSystemRecord_account_session_record_key");
        expect(sql).toContain("SessionSystemRecord_account_namespace_kind_updated_idx");
        expect(sql).toContain("SessionSystemRecord_sessionId_idx");
        expect(sql).not.toContain("namespace, localId");
    });

    it("runs a MySQL invalid-row and duplicate-key preflight before irreversible contract DDL", async () => {
        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        const preflight = "CREATE TEMPORARY TABLE `_SessionSystemRecord_contract_preflight`";
        const alter = "ALTER TABLE `SessionSystemRecord`";

        expect(sql.indexOf(preflight)).toBeGreaterThanOrEqual(0);
        expect(sql.indexOf(preflight)).toBeLessThan(sql.indexOf(alter));
        // A duplicate primary-key insert is an error in every supported sql_mode;
        // it cannot silently coerce an expanded NULL row to zero bytes.
        expect(sql).toContain("PRIMARY KEY");
        expect(sql).toContain("`ownerKind` IS NULL");
        expect(sql).toContain("OCTET_LENGTH(`namespaceAddressKey`) <> 32");
        expect(sql).toContain("OCTET_LENGTH(`recordAddressKey`) <> 32");
        expect(sql).toContain("GROUP BY `accountId`, `sessionId`, `recordAddressKey`");
        expect(sql).toContain("DROP TEMPORARY TABLE `_SessionSystemRecord_contract_preflight`");
    });

    it("replaces the MySQL foreign-key support index before retiring the legacy session index", async () => {
        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        const supportIndex = "CREATE INDEX `SessionSystemRecord_sessionId_idx`";
        const legacyIndexDrop = "DROP INDEX `SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx`";

        expect(sql.indexOf(supportIndex)).toBeGreaterThanOrEqual(0);
        expect(sql.indexOf(supportIndex)).toBeLessThan(sql.indexOf(legacyIndexDrop));
        expect(sql).toContain("ON `SessionSystemRecord`(`sessionId`)");
    });

    it("rejects an expanded-only SQLite row before replacing the table", async () => {
        const sqliteContract = await read(
            `prisma/sqlite/migrations/${migrationId}/migration.sql`,
        );
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`PRAGMA foreign_keys = ON; ${expandedSqliteSessionSystemRecord}`);
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Session" ("id") VALUES ('session-1');
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content", "updatedAt"
                ) VALUES (
                    'record-1', 'account-1', 'session-1', 'activity', 'workflow', 'legacy', '{}', CURRENT_TIMESTAMP
                );
            `);

            expect(() => db.exec(sqliteContract)).toThrow(
                /SessionSystemRecord_contract_backfill_required/i,
            );
            expect(db.prepare(`
                SELECT "ownerKind" FROM "SessionSystemRecord" WHERE "id" = 'record-1'
            `).get()).toEqual({ ownerKind: null });
        } finally {
            db.close();
        }
    });

    it("finalizes a backfilled SQLite row and rejects a different raw address with the same record key", async () => {
        const sqliteContract = await read(
            `prisma/sqlite/migrations/${migrationId}/migration.sql`,
        );
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`PRAGMA foreign_keys = ON; ${expandedSqliteSessionSystemRecord}`);
            db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Session" ("id") VALUES ('session-1');
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "ownerKind", "pluginId", "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'record-1', 'account-1', 'session-1', 'activity', 'workflow', 'one', '{}',
                    'host', NULL, zeroblob(32), zeroblob(32), 1, CURRENT_TIMESTAMP
                );
            `);
            db.exec(sqliteContract);

            expect(db.prepare(`
                SELECT "ownerKind", "permissionTurnId", "permissionRequestId",
                    length("namespaceAddressKey") AS namespaceBytes,
                    length("recordAddressKey") AS recordBytes
                FROM "SessionSystemRecord" WHERE "id" = 'record-1'
            `).get()).toEqual({
                ownerKind: "host",
                permissionTurnId: null,
                permissionRequestId: null,
                namespaceBytes: 32,
                recordBytes: 32,
            });
            const indexNames = db.prepare(`
                SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'SessionSystemRecord'
            `).all().map((row) => (row as { name: string }).name);
            expect(indexNames).toContain("SessionSystemRecord_account_session_record_key");
            expect(indexNames).toContain("SessionSystemRecord_account_namespace_kind_updated_idx");
            expect(indexNames).toContain("SessionSystemRecord_sessionId_idx");
            expect(indexNames).not.toContain("SessionSystemRecord_accountId_sessionId_namespace_localId_key");
            expect(indexNames).not.toContain("SessionSystemRecord_account_kind_updated_idx");
            expect(indexNames).not.toContain("SessionSystemRecord_sessionId_namespace_kind_updatedAt_id_idx");

            expect(() => db.exec(`
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "permissionTurnId", "permissionRequestId", "ownerKind",
                    "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'permission-record-missing-request', 'account-1', 'session-1',
                    'permission', 'remote_settlement.v1', 'one', '{}',
                    'turn-1', NULL, 'host',
                    X'0101010101010101010101010101010101010101010101010101010101010101',
                    X'1111111111111111111111111111111111111111111111111111111111111111',
                    1, CURRENT_TIMESTAMP
                );
            `)).toThrow(/SessionSystemRecord_permission_mediation_identity_check/i);

            db.exec(`
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "permissionTurnId", "permissionRequestId", "ownerKind",
                    "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'permission-record-complete', 'account-1', 'session-1',
                    'permission', 'remote_settlement.v1', 'two', '{}',
                    'turn-1', 'request-1', 'host',
                    X'0202020202020202020202020202020202020202020202020202020202020202',
                    X'2222222222222222222222222222222222222222222222222222222222222222',
                    1, CURRENT_TIMESTAMP
                );
            `);
            expect(db.prepare(`
                SELECT "permissionTurnId", "permissionRequestId"
                FROM "SessionSystemRecord" WHERE "id" = 'permission-record-complete'
            `).get()).toEqual({ permissionTurnId: "turn-1", permissionRequestId: "request-1" });

            expect(() => db.exec(`
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "permissionTurnId", "permissionRequestId", "ownerKind",
                    "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'activity-record-with-permission-identity', 'account-1', 'session-1',
                    'activity', 'workflow', 'three', '{}',
                    'turn-1', 'request-1', 'host',
                    X'0303030303030303030303030303030303030303030303030303030303030303',
                    X'3333333333333333333333333333333333333333333333333333333333333333',
                    1, CURRENT_TIMESTAMP
                );
            `)).toThrow(/SessionSystemRecord_permission_mediation_identity_check/i);

            expect(() => db.exec(`
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "ownerKind", "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'record-2', 'account-1', 'session-1', 'different', 'workflow', 'two', '{}',
                    'host', zeroblob(32), zeroblob(32), 1, CURRENT_TIMESTAMP
                );
            `)).toThrow();
        } finally {
            db.close();
        }
    });

    it("rejects an expanded-only PostgreSQL row before applying final constraints", async () => {
        const postgresContract = await read(
            `prisma/migrations/${migrationId}/migration.sql`,
        );
        const db = new PGlite();
        try {
            await db.exec(expandedPostgresSessionSystemRecord);
            await db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Session" ("id") VALUES ('session-1');
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content", "updatedAt"
                ) VALUES (
                    'record-1', 'account-1', 'session-1', 'activity', 'workflow', 'legacy', '{}'::jsonb, NOW()
                );
            `);
            await expect(db.exec(postgresContract)).rejects.toThrow(
                /SessionSystemRecord address CONTRACT/i,
            );
        } finally {
            await db.close();
        }
    });

    it("finalizes a fully backfilled PostgreSQL row and enforces the derived-key checks", async () => {
        const postgresContract = await read(
            `prisma/migrations/${migrationId}/migration.sql`,
        );
        const db = new PGlite();
        try {
            await db.exec(expandedPostgresSessionSystemRecord);
            await db.exec(`
                INSERT INTO "Account" ("id") VALUES ('account-1');
                INSERT INTO "Session" ("id") VALUES ('session-1');
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "ownerKind", "pluginId", "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'record-1', 'account-1', 'session-1', 'activity', 'workflow', 'one', '{}'::jsonb,
                    'host', NULL, decode(repeat('00', 32), 'hex'), decode(repeat('01', 32), 'hex'), 1, NOW()
                );
            `);
            await db.exec(postgresContract);

            const indexNames = await db.query<{ indexname: string }>(`
                SELECT indexname
                FROM pg_indexes
                WHERE tablename = 'SessionSystemRecord'
            `);
            expect(indexNames.rows.map((row) => row.indexname)).toContain(
                "SessionSystemRecord_account_session_record_key",
            );
            expect(indexNames.rows.map((row) => row.indexname)).toContain(
                "SessionSystemRecord_account_namespace_kind_updated_idx",
            );
            expect(indexNames.rows.map((row) => row.indexname)).toContain(
                "SessionSystemRecord_sessionId_idx",
            );
            expect(indexNames.rows.map((row) => row.indexname)).not.toContain(
                "SessionSystemRecord_accountId_sessionId_namespace_localId_key",
            );

            await expect(db.exec(`
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "ownerKind", "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'record-2', 'account-1', 'session-1', 'different', 'workflow', 'two', '{}'::jsonb,
                    'host', decode('00', 'hex'), decode(repeat('02', 32), 'hex'), 1, NOW()
                );
            `)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "SessionSystemRecord" (
                    "id", "accountId", "sessionId", "namespace", "kind", "localId", "content",
                    "ownerKind", "namespaceAddressKey", "recordAddressKey", "version", "updatedAt"
                ) VALUES (
                    'record-3', 'account-1', 'session-1', 'different', 'workflow', 'three', '{}'::jsonb,
                    'host', decode(repeat('00', 32), 'hex'), decode(repeat('01', 32), 'hex'), 1, NOW()
                );
            `)).rejects.toThrow();
        } finally {
            await db.close();
        }
    });
});
