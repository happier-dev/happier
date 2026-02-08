import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("mysql baseline migration", () => {
    it("stores PublicSessionShare.tokenHash as VARBINARY(32) so MySQL can index it", () => {
        const schema = readFileSync(join(import.meta.dirname, "../prisma/mysql/schema.prisma"), "utf8");
        expect(schema).toContain("tokenHash");
        expect(schema).toContain("@db.VarBinary(32)");
        expect(schema).toContain("@db.LongText");

        const sql = readFileSync(
            join(import.meta.dirname, "../prisma/mysql/migrations/20260202164738_baseline/migration.sql"),
            "utf8",
        );

        expect(sql).not.toContain("`tokenHash` LONGBLOB");
        expect(sql).toContain("`tokenHash` VARBINARY(32) NOT NULL");

        expect(sql).not.toContain("`metadata` VARCHAR(191) NOT NULL");
        expect(sql).toContain("`metadata` LONGTEXT NOT NULL");
        expect(sql).not.toContain("`agentState` VARCHAR(191) NULL");
        expect(sql).toContain("`agentState` LONGTEXT NULL");
        expect(sql).not.toContain("`daemonState` VARCHAR(191) NULL");
        expect(sql).toContain("`daemonState` LONGTEXT NULL");
    });
});
