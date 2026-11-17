import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { createDbMaintenanceClient } from "../sources/storage/prisma";
import { runPrismaMigrateCli } from "./prismaMigrateCli";

const serverRoot = join(import.meta.dirname, "..");

describe("Prisma migrator owner (PostgreSQL)", () => {
    const schemaName = `migrate_owner_${randomUUID().replaceAll("-", "")}`;
    const url = new URL(String(process.env.DATABASE_URL));
    url.searchParams.set("schema", schemaName);
    const stage = mkdtemp(join(tmpdir(), "happier-migrate-owner-"));

    afterAll(async () => {
        const client = await createDbMaintenanceClient("postgres");
        try {
            await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
        } finally {
            await client.$disconnect();
            await rm(await stage, { recursive: true, force: true });
        }
    });

    // Committed migrations rely on PostgreSQL running a migration.sql as one transaction
    // (e.g. 20260725100000_activate_qualified_connected_accounts_v4 uses ON COMMIT DROP).
    it("applies a migration file as one transaction", async () => {
        const dir = await stage;
        await mkdir(join(dir, "migrations", "20260101000000_transactional"), { recursive: true });
        await copyFile(join(serverRoot, "prisma", "schema.prisma"), join(dir, "schema.prisma"));
        await copyFile(
            join(serverRoot, "prisma", "migrations", "migration_lock.toml"),
            join(dir, "migrations", "migration_lock.toml"),
        );
        await writeFile(join(dir, "migrations", "20260101000000_transactional", "migration.sql"), [
            `CREATE TEMPORARY TABLE "_staged" ("v" INTEGER NOT NULL) ON COMMIT DROP;`,
            `INSERT INTO "_staged" ("v") VALUES (7);`,
            `CREATE TABLE "Applied" AS SELECT "v" FROM "_staged";`,
            "",
        ].join("\n"));

        await runPrismaMigrateCli({
            serverRoot,
            schemaPath: join(dir, "schema.prisma"),
            args: ["deploy"],
            env: { ...process.env, DATABASE_URL: url.href },
        });

        // A second deploy must retain the applied migration without replaying its DDL.
        await runPrismaMigrateCli({
            serverRoot,
            schemaPath: join(dir, "schema.prisma"),
            args: ["deploy"],
            env: { ...process.env, DATABASE_URL: url.href },
        });

        const client = await createDbMaintenanceClient("postgres");
        try {
            const rows = await client.$queryRawUnsafe<Array<{ v: number }>>(
                `SELECT "v" FROM "${schemaName}"."Applied"`,
            );
            expect(rows).toEqual([{ v: 7 }]);
        } finally {
            await client.$disconnect();
        }
    });
});
