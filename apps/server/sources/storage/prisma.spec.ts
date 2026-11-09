import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    RelationshipStatus,
    applyConfiguredDatabaseConnectionLimit,
    db,
    getDbProviderFromEnv,
    getPrismaConnectionLimit,
    createDbMaintenanceClient,
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

    it("includes release binaryTargets in prisma/schema.prisma (cross-compiled self-host)", () => {
        const root = join(process.cwd());
        const fullSchema = readFileSync(join(root, "prisma", "schema.prisma"), "utf-8");
        expect(fullSchema).toMatch(
            /binaryTargets\s*=\s*\["native",\s*"debian-openssl-3\.0\.x",\s*"linux-arm64-openssl-3\.0\.x",\s*"darwin",\s*"darwin-arm64",\s*"windows"\]/,
        );
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
        expect(isPrismaUniqueConstraintError({ code: "P2002" })).toBe(true);
        expect(isPrismaUniqueConstraintError({ code: "P2010", meta: { code: "23505" } })).toBe(true);
        expect(isPrismaUniqueConstraintError({ code: "P2010", meta: { code: 1062 } })).toBe(true);
        expect(isPrismaUniqueConstraintError({ code: "P2010", meta: { code: 2067 } })).toBe(true);
        expect(isPrismaUniqueConstraintError({ code: "P2010", meta: { code: "other" } })).toBe(false);
        expect(isPrismaUniqueConstraintError({ code: "P2034", meta: { code: "23505" } })).toBe(false);
    });

    it("recognizes SQLite raw-write unique violations that surface without a driver code in meta", () => {
        expect(isPrismaUniqueConstraintError({
            code: "P2010",
            meta: {},
            message: [
                "Invalid `prisma.$executeRaw()` invocation:",
                "Raw query failed. Code: `2067`. Message: `UNIQUE constraint failed: review_comment_publication_correlations.publication_correlation_id`",
            ].join("\n"),
        })).toBe(true);
        expect(isPrismaUniqueConstraintError({
            code: "P2010",
            message: "UNIQUE constraint failed: review_comment_publication_correlations.publication_correlation_id",
        })).toBe(true);
        expect(isPrismaUniqueConstraintError(
            new Error("UNIQUE constraint failed: review_comment_publication_correlations.publication_correlation_id"),
        )).toBe(true);
        expect(isPrismaUniqueConstraintError({
            code: "P2010",
            meta: {},
            message: "Raw query failed. Code: `19`. Message: `FOREIGN KEY constraint failed`",
        })).toBe(false);
    });

    it("recognizes only provider-specific raw unique-violation messages", () => {
        expect(isPrismaUniqueConstraintError(
            new Error('duplicate key value violates unique constraint "review_comment_publication_correlations_pkey"'),
        )).toBe(true);
        expect(isPrismaUniqueConstraintError(
            new Error("Duplicate entry 'correlation-1' for key 'review_comment_publication_correlations.PRIMARY'"),
        )).toBe(true);
        expect(isPrismaUniqueConstraintError(
            new Error("operation requires unique constraint semantics"),
        )).toBe(false);
        expect(isPrismaUniqueConstraintError(
            new Error("CHECK constraint failed: review_comment_publication_correlations"),
        )).toBe(false);
        expect(isPrismaUniqueConstraintError(
            new Error("FOREIGN KEY constraint failed"),
        )).toBe(false);
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

    it.each(["postgres", "mysql", "sqlite"] as const)("uses the server pool before startup maintenance first loads the engine and keeps that budget for later clients (%s)", async (provider) => {
        // Each module instance models first construction; native loading remains real.
        vi.resetModules();
        const storage = await import("./prisma");
        const databaseUrl = provider === "sqlite" ? "file:./worker-budget.sqlite" : `${provider === "postgres" ? "postgresql" : "mysql"}://fixture:fixture@localhost/fixture`;
        vi.stubEnv("DATABASE_URL", `${databaseUrl}?connection_limit=2`);
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "3");
        vi.stubEnv("HAPPY_DB_CONNECTION_LIMIT", "7");
        vi.stubEnv("TOKIO_WORKER_THREADS", undefined);
        const limitsAtLoad: Array<string | undefined> = [];
        const dlopen = process.dlopen;
        const loader = vi.spyOn(process, "dlopen").mockImplementation((module, filename, flags) => {
            if (filename.includes("query_engine")) limitsAtLoad.push(process.env.TOKIO_WORKER_THREADS);
            return dlopen(module, filename, flags);
        });
        const clients: Awaited<ReturnType<typeof createDbMaintenanceClient>>[] = [];
        try {
            clients.push(await storage.createDbMaintenanceClient(provider, `${databaseUrl}?connection_limit=1`));
            await clients[0]!.$disconnect();
            if (provider === "postgres") storage.initDbPostgres();
            else if (provider === "mysql") await storage.initDbMysql();
            else clients.push(await storage.createDbMaintenanceClient("sqlite"));
            await storage.shutdownDbClient();
            expect.soft(limitsAtLoad.length).toBeGreaterThan(0);
            // SQLite adds one worker per side connection: read snapshot, maintenance, readiness.
            const expectedWorkers = provider === "sqlite" ? "6" : "3";
            expect.soft(new Set(limitsAtLoad)).toEqual(new Set([expectedWorkers]));
            clients.push(await storage.createDbMaintenanceClient(provider, `${databaseUrl}?connection_limit=1`));
            await clients.at(-1)!.$disconnect();
            expect(process.env.TOKIO_WORKER_THREADS).toBe(expectedWorkers);
        } finally {
            await Promise.all(clients.map(client => client.$disconnect()));
            await storage.shutdownDbClient();
            loader.mockRestore();
            vi.unstubAllEnvs();
        }
    });

    it("preserves an explicit Tokio operator override across main and maintenance clients", async () => {
        vi.resetModules();
        const storage = await import("./prisma");
        vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/fixture?connection_limit=2");
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "3");
        vi.stubEnv("TOKIO_WORKER_THREADS", "5");
        let maintenance: Awaited<ReturnType<typeof createDbMaintenanceClient>> | undefined;
        try {
            storage.initDbPostgres();
            expect.soft(process.env.TOKIO_WORKER_THREADS).toBe("5");
            expect(storage.getPrismaConnectionLimit()).toBe(3);
            maintenance = await storage.createDbMaintenanceClient("postgres", "postgresql://fixture:fixture@localhost/fixture?connection_limit=1");
            expect(process.env.TOKIO_WORKER_THREADS).toBe("5");
        } finally {
            await maintenance?.$disconnect();
            await storage.shutdownDbClient();
            vi.unstubAllEnvs();
        }
    });

    it("does not advertise a later client pool as a resized runtime when the first pool was unconfigured", async () => {
        vi.resetModules();
        const storage = await import("./prisma");
        vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost/fixture");
        vi.stubEnv("HAPPIER_DB_CONNECTION_LIMIT", "");
        vi.stubEnv("HAPPY_DB_CONNECTION_LIMIT", "");
        vi.stubEnv("TOKIO_WORKER_THREADS", undefined);
        let maintenance: Awaited<ReturnType<typeof createDbMaintenanceClient>> | undefined;
        try {
            storage.initDbPostgres();
            await storage.shutdownDbClient();
            maintenance = await storage.createDbMaintenanceClient("postgres", "postgresql://fixture:fixture@localhost/fixture?connection_limit=1");
            expect(process.env.TOKIO_WORKER_THREADS).toBeUndefined();
        } finally {
            await maintenance?.$disconnect();
            await storage.shutdownDbClient();
            vi.unstubAllEnvs();
        }
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
        vi.stubEnv("TOKIO_WORKER_THREADS", "1");
        try {
            // Construct the real Prisma owner without opening a connection.
            initDbPostgres();
            expect(getPrismaConnectionLimit()).toBe(expected);
            expect(process.env.TOKIO_WORKER_THREADS).toBe("1");
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
