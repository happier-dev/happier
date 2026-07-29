import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runSqliteMigrationDeploy } from "./migrate.sqlite.deploy";

type NodeSqliteDatabase = Readonly<{
    exec: (sql: string) => void;
    prepare: (sql: string) => Readonly<{
        get: (...params: unknown[]) => unknown;
    }>;
    close: () => void;
}>;

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (path: string) => NodeSqliteDatabase;
};

describe("migrate.sqlite.deploy.ts", () => {
    let tmpDir = "";
    let lightDataDir = "";
    let serverRoot = "";
    let migrationsDir = "";

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "happier-server-light-deploy-"));
        lightDataDir = join(tmpDir, "happy server #light");
        serverRoot = join(tmpDir, "server");
        migrationsDir = join(serverRoot, "prisma", "sqlite", "migrations");
        await mkdir(lightDataDir, { recursive: true });
        await mkdir(migrationsDir, { recursive: true });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it("applies through the real Node adapter with the URL busy timeout", async () => {
        const migrationName = "20260101000000_first";
        const migrationDir = join(migrationsDir, migrationName);
        await mkdir(migrationDir, { recursive: true });
        await writeFile(
            join(migrationDir, "migration.sql"),
            [
                "CREATE TABLE Account(id INTEGER);",
                "CREATE TABLE BusyTimeoutProbe AS SELECT timeout FROM pragma_busy_timeout;",
                "",
            ].join("\n"),
            "utf8",
        );

        const env: NodeJS.ProcessEnv = {
            HAPPY_SERVER_LIGHT_DATA_DIR: lightDataDir,
            HAPPIER_SERVER_LIGHT_DATA_DIR: lightDataDir,
        };

        await expect(
            runSqliteMigrationDeploy({
                env,
                serverRoot,
                runSchemaSync: async () => {},
            }),
        ).resolves.toEqual({ applied: [migrationName] });

        const databasePath = join(lightDataDir, "happier-server-light.sqlite");
        expect(env.DATABASE_URL).toBe(
            `${pathToFileURL(databasePath).href}?socket_timeout=30&connection_limit=1`,
        );
        const db = new DatabaseSync(databasePath);
        try {
            expect(db.prepare("SELECT timeout FROM BusyTimeoutProbe").get()).toEqual({
                timeout: 30_000,
            });
        } finally {
            db.close();
        }
    });

    it("fails closed when an explicit DATABASE_URL is not a SQLite file URL", async () => {
        const migrationDir = join(migrationsDir, "20260101000000_first");
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, "migration.sql"), "CREATE TABLE Account(id INTEGER);\n", "utf8");

        await expect(
            runSqliteMigrationDeploy({
                env: {
                    HAPPY_SERVER_LIGHT_DATA_DIR: lightDataDir,
                    HAPPIER_SERVER_LIGHT_DATA_DIR: lightDataDir,
                    DATABASE_URL: "postgresql://db.example.invalid/happier",
                },
                serverRoot,
                runSchemaSync: async () => {},
            }),
        ).rejects.toThrow(/requires DATABASE_URL=file:/i);
    });
});
