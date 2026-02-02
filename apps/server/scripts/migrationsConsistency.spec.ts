import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readText(path: string): string {
    return readFileSync(path, "utf-8");
}

function listMigrationSqlFiles(migrationsDir: string): string[] {
    const entries = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(migrationsDir, e.name, "migration.sql"));
    return entries;
}

function anyFileContains(paths: string[], patterns: string[]): boolean {
    for (const p of paths) {
        let text = "";
        try {
            text = readText(p);
        } catch {
            continue;
        }
        if (patterns.every((pat) => text.includes(pat))) {
            return true;
        }
    }
    return false;
}

describe("migrations (provider completeness)", () => {
    it("includes AccountChange entity FK columns across providers", () => {
        const root = process.cwd();
        const schema = readText(join(root, "prisma", "schema.prisma"));
        expect(schema).toContain("sessionId");
        expect(schema).toContain("machineId");
        expect(schema).toContain("artifactId");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountChange" ADD COLUMN',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "AccountChange"',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `AccountChange`",
                "`sessionId`",
                "`machineId`",
                "`artifactId`",
            ]),
        ).toBe(true);
    });
});

