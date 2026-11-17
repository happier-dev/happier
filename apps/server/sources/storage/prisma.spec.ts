import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    RelationshipStatus,
    applyConfiguredDatabaseConnectionLimit,
    db,
    getDbProviderFromEnv,
    getPrismaConnectionLimit,
    initDbPostgres,
    requireDbProviderFromEnv,
    isPrismaErrorCode,
    isPrismaUniqueConstraintError,
    shutdownDbClient,
} from "./prisma";

function parseEnumValues(schemaText: string, enumName: string): string[] {
    const block = schemaText.match(new RegExp(`enum\\s+${enumName}\\s*\\{([\\s\\S]*?)\\}`, "m"));
    if (!block?.[1]) {
        throw new Error(`enum ${enumName} not found in schema`);
    }
    return block[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//"))
        .map((line) => line.split(/\s+/)[0])
        .filter(Boolean);
}

function readMigration(providerRoot: string, migrationName: string): string {
    return readFileSync(join(providerRoot, "migrations", migrationName, "migration.sql"), "utf-8");
}

describe("storage/prisma", () => {
    it("throws a helpful error when db is accessed before initialization", () => {
        // `db` is a proxy so simply importing it is fine; accessing properties should fail loudly until initDb* runs.
        // Use a regex match to avoid brittle exact-string assertions.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(() => (db as any).user).toThrow(/not initialized/i);
    });

    it("RelationshipStatus matches prisma/schema.prisma", () => {
        const root = join(process.cwd());
        const fullSchema = readFileSync(join(root, "prisma", "schema.prisma"), "utf-8");

        const fullValues = parseEnumValues(fullSchema, "RelationshipStatus");

        const exportedValues = Object.values(RelationshipStatus);
        expect(exportedValues.sort()).toEqual([...new Set(fullValues)].sort());
    });

    it("ships the contracted runtime-activity projection migration for every supported provider", () => {
        const root = join(process.cwd());
        const migrationName = "20260701123000_add_session_runtime_activity_projection";
        const migrationFiles = [
            join(root, "prisma", "migrations", migrationName, "migration.sql"),
            join(root, "prisma", "sqlite", "migrations", migrationName, "migration.sql"),
            join(root, "prisma", "mysql", "migrations", migrationName, "migration.sql"),
        ];
        const fields = [
            "runtimeActivityState",
            "runtimeActivityActiveCount",
            "runtimeActivityObservedAt",
            "runtimeActivityRevision",
        ];

        for (const migrationFile of migrationFiles) {
            const migrationSql = readFileSync(migrationFile, "utf-8");
            for (const field of fields) {
                expect(migrationSql).toContain(field);
            }
            expect(migrationSql).not.toContain("runtimeActivityExpiresAt");
            expect(migrationSql).not.toContain("runtimeActivitySourceClass");
        }
    });

    it("defines the External Sessions publication authority in every supported schema and migration", () => {
        const root = join(process.cwd());
        const migrationName = "20260723150000_add_external_session_publication_authority";
        const providerRoots = [
            join(root, "prisma"),
            join(root, "prisma", "sqlite"),
            join(root, "prisma", "mysql"),
        ];
        const expectedFields = [
            "currentStorageState",
            "acceptedThroughServerSeq",
            "materializationPublicationId",
            "materializedThroughSourceAt",
            "publishedThroughServerSeq",
        ];

        for (const providerRoot of providerRoots) {
            const schema = readFileSync(join(providerRoot, "schema.prisma"), "utf-8");
            const sessionModel = schema.match(/model Session \{([\s\S]*?)\n\}/)?.[1];
            expect(sessionModel, `${providerRoot} Session model`).toBeDefined();
            for (const field of expectedFields) {
                expect(sessionModel).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
            }
            expect(sessionModel).toMatch(/^\s*currentStorageState\s+String\s+@default\("hosted"\)\s*$/m);

            const migrationSql = readFileSync(
                join(providerRoot, "migrations", migrationName, "migration.sql"),
                "utf-8",
            );
            for (const field of expectedFields) {
                expect(migrationSql).toContain(field);
            }
            expect(migrationSql).toMatch(/currentStorageState[^;]*NOT NULL[^;]*DEFAULT ['"]hosted['"]/i);
        }
    });

    it("keeps the Lane 10 schema and migrations provider-portable", () => {
        const root = join(process.cwd(), "prisma");
        const postgresRoot = root;
        const mysqlRoot = join(root, "mysql");
        const sqliteRoot = join(root, "sqlite");
        const migrationNames = [
            "20260906220000_add_team_credential_resources",
            "20260907000000_add_team_credential_usage_limits",
            "20260907010000_add_team_credential_recipient_material",
            "20260907090000_add_saved_secret_resources",
            "20260907100000_add_team_credential_external_api_keys",
        ];

        const mysqlMigrations = migrationNames.map((name) => readMigration(mysqlRoot, name)).join("\n");
        const mysqlIdentifiers = [
            ...mysqlMigrations.matchAll(
                /(?:(?:CREATE (?:UNIQUE )?INDEX|CONSTRAINT|(?:UNIQUE )?KEY)\s+`([^`]+)`)/g,
            ),
        ]
            .map((match) => match[1]);
        expect(mysqlIdentifiers.filter((identifier) => identifier.length > 64)).toEqual([]);

        const mysqlSchema = readFileSync(join(mysqlRoot, "schema.prisma"), "utf-8");
        const mysqlRecipientMaterial = readMigration(mysqlRoot, migrationNames[2]);
        const mysqlSavedSecrets = readMigration(mysqlRoot, migrationNames[3]);
        expect(mysqlSchema).toMatch(/^\s*storedMaterial\s+Bytes\s+@db\.LongBlob\s*$/m);
        expect(mysqlSchema).toMatch(/^\s*encryptedDataKey\s+Bytes\s+@db\.LongBlob\s*$/m);
        expect(mysqlSchema).toMatch(/^\s*sourceMemberKey\s+String\s+@db\.Char\(43\)\s*$/m);
        expect(mysqlSchema).toMatch(/^\s*sourceVersion\s+String\s+@db\.VarChar\(256\)\s*$/m);
        for (const providerRoot of [postgresRoot, mysqlRoot, sqliteRoot]) {
            const schema = readFileSync(join(providerRoot, "schema.prisma"), "utf-8");
            const bindingModel = schema.match(/model SessionTeamCredentialBinding \{([\s\S]*?)\n\}/)?.[1];
            expect(bindingModel, `${providerRoot} SessionTeamCredentialBinding model`).toBeDefined();
            expect(bindingModel).toMatch(/^\s*resourceRevision\s+Int\s*$/m);
        }
        expect(mysqlRecipientMaterial).toMatch(/`sourceMemberKey`\s+CHAR\(43\)\s+NOT NULL/);
        expect(mysqlRecipientMaterial).toMatch(/`sourceVersion`\s+VARCHAR\(256\)\s+NOT NULL/);
        expect(mysqlRecipientMaterial).toMatch(/`recipientContentPublicKeyFingerprint`\s+VARCHAR\(256\)\s+NULL/);
        expect(mysqlRecipientMaterial).toMatch(/`storedMaterial`\s+LONGBLOB\s+NOT NULL/);
        expect(mysqlSavedSecrets).toMatch(/`encryptedDataKey`\s+LONGBLOB\s+NOT NULL/);

        const resourceIndex = "TeamCredentialResource_teamId_enabled_updatedAt_idx";
        const savedSecretIndex = "SavedSecretResource_owner_updated_idx";
        for (const providerRoot of [postgresRoot, mysqlRoot, sqliteRoot]) {
            const resourceMigration = readMigration(providerRoot, migrationNames[0]);
            const savedSecretMigration = readMigration(providerRoot, migrationNames[3]);
            expect(resourceMigration).toContain(resourceIndex);
            expect(resourceMigration).toContain("updatedAt");
            expect(resourceMigration.match(new RegExp(`${resourceIndex}[^;]*\\bDESC\\b`, "i")) !== null).toBe(false);
            expect(savedSecretMigration).toContain(savedSecretIndex);
            expect(savedSecretMigration.match(new RegExp(`${savedSecretIndex}[^;]*\\bDESC\\b`, "i")) !== null).toBe(false);
        }

        const sqliteSavedSecrets = readMigration(sqliteRoot, migrationNames[3]);
        expect(sqliteSavedSecrets).not.toMatch(/"updatedAt"\s+DATETIME\s+NOT NULL\s+DEFAULT\s+CURRENT_TIMESTAMP/);

        for (const providerRoot of [postgresRoot, mysqlRoot, sqliteRoot]) {
            const externalKeys = readMigration(providerRoot, migrationNames[4]);
            expect(externalKeys).toMatch(/TeamCredentialExternalApiKey_teamMembershipId_fkey[^;]*ON DELETE RESTRICT/i);
            expect(readMigration(providerRoot, migrationNames[0])).toMatch(/directSourceVersionsJson/);
            expect(readMigration(providerRoot, migrationNames[0])).toMatch(/resourceRevision/);
        }
    });

    it("detects Prisma-like error codes without relying on Prisma error classes", () => {
        expect(isPrismaErrorCode({ code: "P2034" }, "P2034")).toBe(true);
        expect(isPrismaErrorCode({ code: "P2002" }, "P2034")).toBe(false);
        expect(isPrismaErrorCode(new Error("no code"), "P2034")).toBe(false);
        expect(isPrismaErrorCode(null, "P2034")).toBe(false);
    });

    it("recognizes unique constraints from Prisma model and raw SQL writes on every supported provider", () => {
        const raw = (kind: string, originalCode: string) => ({
            code: "P2010",
            meta: { driverAdapterError: { cause: { kind, originalCode, originalMessage: "constraint failed" } } },
        });
        expect(isPrismaUniqueConstraintError({ code: "P2002" })).toBe(true);
        expect(isPrismaUniqueConstraintError(raw("UniqueConstraintViolation", "23505"))).toBe(true);
        expect(isPrismaUniqueConstraintError(raw("postgres", "23505"))).toBe(true);
        expect(isPrismaUniqueConstraintError(raw("mysql", "1062"))).toBe(true);
        expect(isPrismaUniqueConstraintError(raw("sqlite", "2067"))).toBe(true);
        expect(isPrismaUniqueConstraintError(raw("sqlite", "1555"))).toBe(true);
        expect(isPrismaUniqueConstraintError(raw("sqlite", "787"))).toBe(false);
        expect(isPrismaUniqueConstraintError(raw("postgres", "23503"))).toBe(false);
        expect(isPrismaUniqueConstraintError({ code: "P2010", meta: {} })).toBe(false);
        expect(isPrismaUniqueConstraintError(new Error("UNIQUE constraint failed: table.column"))).toBe(false);
    });

    it("parses DB provider from env with a fallback", () => {
        expect(getDbProviderFromEnv({}, "postgres")).toBe("postgres");
        expect(getDbProviderFromEnv({ HAPPY_DB_PROVIDER: "mysql" }, "postgres")).toBe("mysql");
        expect(getDbProviderFromEnv({ HAPPIER_DB_PROVIDER: " sqlite " }, "postgres")).toBe("sqlite");
        expect(getDbProviderFromEnv({ HAPPY_DB_PROVIDER: "nope" }, "postgres")).toBe("postgres");
    });

    it("can require an explicitly configured DB provider", () => {
        expect(requireDbProviderFromEnv({}, "sqlite")).toBe("sqlite");
        expect(requireDbProviderFromEnv({ HAPPIER_DB_PROVIDER: "postgresql" }, "sqlite")).toBe("postgres");
        expect(() => requireDbProviderFromEnv({ HAPPY_DB_PROVIDER: "postgress" }, "sqlite")).toThrow(/Unsupported/);
    });

    it("applies an explicit database connection limit from env to the database url", () => {
        const limited = applyConfiguredDatabaseConnectionLimit(
            "postgresql://user:pass@db.example.com:5432/happier?sslmode=require",
            { HAPPIER_DB_CONNECTION_LIMIT: "7" },
        );

        expect(limited).toBe("postgresql://user:pass@db.example.com:5432/happier?sslmode=require&connection_limit=7");
    });

    it("leaves the database url unchanged when no explicit connection limit is configured", () => {
        const original = "postgresql://user:pass@db.example.com:5432/happier?sslmode=require";
        expect(applyConfiguredDatabaseConnectionLimit(original, {})).toBe(original);
    });

    it.each(["file:./relative db.sqlite", "file:C:\\Users\\fixture\\data.sqlite"])("preserves the Prisma SQLite path when overriding its pool (%s)", (databaseUrl) => {
        expect(applyConfiguredDatabaseConnectionLimit(`${databaseUrl}?socket_timeout=5&connection_limit=2`, {
            HAPPIER_DB_CONNECTION_LIMIT: "3",
        })).toBe(`${databaseUrl}?socket_timeout=5&connection_limit=3`);
    });

    it.each([
        { query: "", override: "", expected: null },
        { query: "?connection_limit=invalid", override: "", expected: null },
        { query: "?connection_limit=1", override: "", expected: 1 },
        { query: "?connection_limit=3", override: "", expected: 3 },
        { query: "?connection_limit=3", override: "4", expected: 4 },
    ])("captures the initialized pool budget ($query, override $override)", async ({ query, override, expected }) => {
        vi.stubEnv("DATABASE_URL", `postgresql://fixture:fixture@localhost/fixture${query}`);
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "");
        vi.stubEnv("HAPPY_DB_CONNECTION_LIMIT", override);
        try {
            // Construct the real Prisma owner without opening a connection.
            initDbPostgres();
            expect(getPrismaConnectionLimit()).toBe(expected);
            vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/fixture?connection_limit=9");
            expect(getPrismaConnectionLimit()).toBe(expected);
            await shutdownDbClient();
            expect(getPrismaConnectionLimit()).toBeNull();
        } finally {
            await shutdownDbClient();
            vi.unstubAllEnvs();
        }
    });
});
