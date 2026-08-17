import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260812123000_add_plugin_release_package_asset_artifact";
const relationName = "AccountPluginReleasePackageAsset";

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

function model(schema: string, name: string): string {
    const match = schema.match(new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, "m"));
    if (!match?.[1]) throw new Error(`model ${name} not found`);
    return match[1];
}

describe("plugin release package-asset Artifact migration", () => {
    const variants = [
        {
            name: "postgres",
            schema: "prisma/schema.prisma",
            migration: `prisma/migrations/${migrationId}/migration.sql`,
            descriptorColumn: /ADD COLUMN\s+"packageAssetArchive"\s+JSONB,?/,
            addColumn: /ADD COLUMN\s+"packageAssetArtifactId"\s+TEXT;/,
            unique: /CREATE UNIQUE INDEX\s+"AccountPluginRelease_packageAssetArtifactId_key"\s+ON "AccountPluginRelease"\("packageAssetArtifactId"\);/,
            foreignKey: 'FOREIGN KEY ("packageAssetArtifactId") REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
        },
        {
            name: "mysql",
            schema: "prisma/mysql/schema.prisma",
            migration: `prisma/mysql/migrations/${migrationId}/migration.sql`,
            descriptorColumn: /ADD COLUMN\s+`packageAssetArchive`\s+JSON\s+NULL,?/,
            addColumn: /ADD COLUMN\s+`packageAssetArtifactId`\s+VARCHAR\(191\)\s+NULL;/,
            unique: /CREATE UNIQUE INDEX\s+`AccountPluginRelease_packageAssetArtifactId_key`\s+ON `AccountPluginRelease`\(`packageAssetArtifactId`\);/,
            foreignKey: "FOREIGN KEY (`packageAssetArtifactId`) REFERENCES `Artifact`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE",
        },
        {
            name: "sqlite",
            schema: "prisma/sqlite/schema.prisma",
            migration: `prisma/sqlite/migrations/${migrationId}/migration.sql`,
            descriptorColumn: /ALTER TABLE\s+"AccountPluginRelease"\s+ADD COLUMN\s+"packageAssetArchive"\s+JSONB;/,
            addColumn: /ALTER TABLE\s+"AccountPluginRelease"\s+ADD COLUMN\s+"packageAssetArtifactId"\s+TEXT\s+REFERENCES\s+"Artifact"\("id"\)\s+ON DELETE RESTRICT ON UPDATE CASCADE;/,
            unique: /CREATE UNIQUE INDEX\s+"AccountPluginRelease_packageAssetArtifactId_key"\s+ON "AccountPluginRelease"\("packageAssetArtifactId"\);/,
            foreignKey: 'REFERENCES "Artifact"("id") ON DELETE RESTRICT ON UPDATE CASCADE',
        },
    ] as const;

    it.each(variants)("adds a nullable immutable descriptor and one nullable unique protected Artifact relation in $name", async (variant) => {
        const [schema, migration] = await Promise.all([
            read(variant.schema),
            read(variant.migration),
        ]);
        const release = model(schema, "AccountPluginRelease");
        const artifact = model(schema, "Artifact");

        expect(release).toMatch(/^\s*packageAssetArchive\s+Json\?\s*$/m);
        expect(release).toMatch(/^\s*packageAssetArtifactId\s+String\?\s+@unique\s*$/m);
        expect(release).toMatch(new RegExp(
            `^\\s*packageAssetArtifact\\s+Artifact\\?\\s+@relation\\("${relationName}", fields: \\[packageAssetArtifactId\\], references: \\[id\\], onDelete: Restrict\\)\\s*$`,
            "m",
        ));
        expect(artifact).toMatch(new RegExp(
            `^\\s*packageAssetRelease\\s+AccountPluginRelease\\?\\s+@relation\\("${relationName}"\\)\\s*$`,
            "m",
        ));
        expect(migration).toMatch(variant.descriptorColumn);
        expect(migration).toMatch(variant.addColumn);
        expect(migration).toMatch(variant.unique);
        expect(migration).toContain(variant.foreignKey);
    });

    it("applies the PostgreSQL successor without inventing a descriptor and enforces the protected Artifact link", async () => {
        const db = new PGlite();
        try {
            await db.exec(`
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "AccountPluginRelease" ("id" TEXT NOT NULL PRIMARY KEY);
            `);
            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));
            await db.exec(`
                INSERT INTO "AccountPluginRelease" ("id") VALUES ('legacy-release');
                INSERT INTO "Artifact" ("id") VALUES ('asset-1'), ('asset-2');
                UPDATE "AccountPluginRelease"
                SET "packageAssetArchive" = '{"archiveDigestSha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resources":[]}'::jsonb,
                    "packageAssetArtifactId" = 'asset-1'
                WHERE "id" = 'legacy-release';
                INSERT INTO "AccountPluginRelease" ("id") VALUES ('second-release');
            `);
            const descriptor = await db.query<{ packageAssetArchive: unknown }>(`
                SELECT "packageAssetArchive" FROM "AccountPluginRelease" WHERE "id" = 'legacy-release'
            `);
            expect(descriptor.rows).toEqual([{
                packageAssetArchive: {
                    archiveDigestSha256: `sha256:${"a".repeat(64)}`,
                    resources: [],
                },
            }]);
            await expect(db.exec(`
                UPDATE "AccountPluginRelease" SET "packageAssetArtifactId" = 'asset-1' WHERE "id" = 'second-release';
            `)).rejects.toThrow();
            await expect(db.exec(`DELETE FROM "Artifact" WHERE "id" = 'asset-1';`)).rejects.toThrow();
            const legacy = await db.query<{ packageAssetArchive: unknown; packageAssetArtifactId: string | null }>(`
                SELECT "packageAssetArchive", "packageAssetArtifactId"
                FROM "AccountPluginRelease" WHERE "id" = 'second-release'
            `);
            expect(legacy.rows).toEqual([{
                packageAssetArchive: null,
                packageAssetArtifactId: null,
            }]);
        } finally {
            await db.close();
        }
    });

    it("applies the SQLite successor with the same nullable descriptor, unique link, and restrictive foreign key", async () => {
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys = ON;
                CREATE TABLE "Artifact" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "AccountPluginRelease" ("id" TEXT NOT NULL PRIMARY KEY);
            `);
            db.exec(await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`));
            db.exec(`
                INSERT INTO "AccountPluginRelease" ("id") VALUES ('legacy-release'), ('second-release');
                INSERT INTO "Artifact" ("id") VALUES ('asset-1');
                UPDATE "AccountPluginRelease"
                SET "packageAssetArchive" = '{"archiveDigestSha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","resources":[]}',
                    "packageAssetArtifactId" = 'asset-1'
                WHERE "id" = 'legacy-release';
            `);
            expect(() => db.exec(`
                UPDATE "AccountPluginRelease" SET "packageAssetArtifactId" = 'asset-1' WHERE "id" = 'second-release';
            `)).toThrow();
            expect(() => db.exec(`DELETE FROM "Artifact" WHERE "id" = 'asset-1';`)).toThrow();
            const legacy = db.prepare(`
                SELECT "packageAssetArchive", "packageAssetArtifactId"
                FROM "AccountPluginRelease" WHERE "id" = 'second-release'
            `).get() as { packageAssetArchive: null; packageAssetArtifactId: null };
            expect(legacy).toEqual({ packageAssetArchive: null, packageAssetArtifactId: null });
        } finally {
            db.close();
        }
    });
});
