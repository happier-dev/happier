import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");

const migrationId = "20260819120000_add_session_attention_standing";

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

describe("session attention standing migration", () => {
    it.each([
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ])("declares the account-scoped standing override model in %s", async (schemaPath) => {
        const schema = await read(schemaPath);
        expect(schema).toContain("model SessionAttentionStanding {");
        // The override must be able to express "explicitly not standing" against a true default,
        // so the standing decision is a real non-nullable boolean column, never row presence.
        expect(schema).toMatch(/^\s+standing\s+Boolean$/m);
        expect(schema).toContain("@@unique([accountId, sessionId])");
        expect(schema).toContain("@@index([accountId, standing])");
        expect(schema).toContain("SessionAttentionStanding SessionAttentionStanding[]");
        expect(schema).toContain("sessionAttentionStandings SessionAttentionStanding[]");
    });

    it("creates the PostgreSQL table with cascading account and session ownership", async () => {
        const sql = await read(`prisma/migrations/${migrationId}/migration.sql`);
        expect(sql).toContain('CREATE TABLE "SessionAttentionStanding"');
        expect(sql).toContain('"standing" BOOLEAN NOT NULL');
        expect(sql).toContain('CREATE UNIQUE INDEX "SessionAttentionStanding_accountId_sessionId_key"');
        expect(sql).toContain('CREATE INDEX "SessionAttentionStanding_accountId_standing_idx"');
        expect(sql).toContain('CREATE INDEX "SessionAttentionStanding_sessionId_idx"');
        expect(sql).toContain('"SessionAttentionStanding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE');
        expect(sql).toContain('"SessionAttentionStanding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE');
    });

    it("creates the SQLite table with cascading account and session ownership", async () => {
        const sql = await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`);
        expect(sql).toContain('CREATE TABLE "SessionAttentionStanding"');
        expect(sql).toContain('"standing" BOOLEAN NOT NULL');
        expect(sql).toContain('CREATE UNIQUE INDEX "SessionAttentionStanding_accountId_sessionId_key"');
        expect(sql).toContain('CREATE INDEX "SessionAttentionStanding_accountId_standing_idx"');
        expect(sql).toContain('"SessionAttentionStanding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE CASCADE');
        expect(sql).toContain('"SessionAttentionStanding_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session" ("id") ON DELETE CASCADE');
    });

    it("creates the MySQL table with cascading account and session ownership", async () => {
        const sql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        expect(sql).toContain("CREATE TABLE `SessionAttentionStanding`");
        expect(sql).toContain("`standing` BOOLEAN NOT NULL");
        expect(sql).toContain("UNIQUE INDEX `SessionAttentionStanding_accountId_sessionId_key`(`accountId`, `sessionId`)");
        expect(sql).toContain("INDEX `SessionAttentionStanding_accountId_standing_idx`(`accountId`, `standing`)");
        expect(sql).toContain("INDEX `SessionAttentionStanding_sessionId_idx`(`sessionId`)");
        expect(sql).toContain("`SessionAttentionStanding_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE CASCADE");
        expect(sql).toContain("`SessionAttentionStanding_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `Session`(`id`) ON DELETE CASCADE");
    });
});
