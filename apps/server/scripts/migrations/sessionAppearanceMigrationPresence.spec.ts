import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20261026150000_add_session_appearance";

describe("session appearance migration", () => {
    it.each(["prisma/schema.prisma", "prisma/sqlite/schema.prisma", "prisma/mysql/schema.prisma"])(
        "declares one account/session display envelope in %s", async (path) => {
            const schema = await readFile(join(serverRoot, path), "utf8");
            const model = schema.match(/model SessionAppearance \{[\s\S]*?\n\}/)?.[0];
            expect(model).toBeDefined();
            expect(model).toContain("@@unique([accountId, sessionId])");
            expect(model).toContain("@@index([sessionId])");
            expect(model).toContain("account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)");
            expect(model).toContain("session Session @relation(fields: [sessionId], references: [id], onDelete: Cascade)");
            expect(model).toMatch(/displayDbValue\s+String(?!\?)/);
            if (path.includes("mysql")) expect(model).toMatch(/displayDbValue\s+String\s+@db.LongText/);
            expect(schema).toMatch(/SessionAppearance\s+SessionAppearance\[\]/);
            expect(schema).toContain("sessionAppearances SessionAppearance[]");
        },
    );

    it.each(["prisma", "prisma/sqlite", "prisma/mysql"])("creates cascading account and session ownership in %s", async (path) => {
        const sql = await readFile(join(serverRoot, path, "migrations", migrationId, "migration.sql"), "utf8");
        // Normalize identifier quoting so the same ownership assertions cover each provider.
        const normalized = sql.replaceAll("`", '"').replaceAll('" ("', '"("');
        expect(normalized).toContain('CREATE TABLE "SessionAppearance"');
        expect(normalized).toContain('"displayDbValue" ' + (path.includes("mysql") ? "LONGTEXT" : "TEXT") + " NOT NULL");
        expect(normalized).toContain('UNIQUE INDEX "SessionAppearance_accountId_sessionId_key"');
        expect(normalized).toContain('"SessionAppearance_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE');
        expect(normalized).toContain('"SessionAppearance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE');
    });
});
