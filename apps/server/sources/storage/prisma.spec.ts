import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    RelationshipStatus,
    applyConfiguredDatabaseConnectionLimit,
    db,
    getDbProviderFromEnv,
    requireDbProviderFromEnv,
    isPrismaErrorCode,
    isPrismaUniqueConstraintError,
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
});
