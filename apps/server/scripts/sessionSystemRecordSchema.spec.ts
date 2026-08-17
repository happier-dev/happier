import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const schemaPaths = [
    "prisma/schema.prisma",
    "prisma/mysql/schema.prisma",
    "prisma/sqlite/schema.prisma",
] as const;

function readSchema(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("SessionSystemRecord Prisma schema", () => {
    it.each(schemaPaths)("defines the final account-scoped session system record contract in %s", (schemaPath) => {
        const schema = readSchema(schemaPath);

        expect(schema).toContain("model SessionSystemRecord");
        expect(schema).toContain("accountId String");
        expect(schema).toContain("sessionId String");
        expect(schema).toContain("namespace String");
        expect(schema).toContain("kind      String");
        expect(schema).toContain("localId   String");
        expect(schema).toContain("content   Json");
        expect(schema).toContain("ownerKind String");
        expect(schema).toContain("pluginId String?");
        expect(schema).toContain("namespaceAddressKey Bytes");
        expect(schema).toContain("recordAddressKey Bytes");
        expect(schema).toContain("version Int @default(1)");
        expect(schema).toContain(
            '@@unique([accountId, sessionId, recordAddressKey], map: "SessionSystemRecord_account_session_record_key")',
        );
        expect(schema).toContain("@@index([accountId, sessionId, namespaceAddressKey, kind, updatedAt");
        expect(schema).toContain('@@index([sessionId], map: "SessionSystemRecord_sessionId_idx")');
        expect(schema).not.toContain("@@unique([accountId, sessionId, namespace, localId])");
        expect(schema).not.toContain("@@index([accountId, sessionId, namespace, kind, updatedAt");
        expect(schema).not.toContain("@@index([sessionId, namespace, kind, updatedAt");
    });

    it("keeps the predecessor migration immutable and expands all providers append-only", () => {
        for (const providerPath of ["", "mysql/", "sqlite/"]) {
            const predecessor = readSchema(`prisma/${providerPath}migrations/20260519183000_add_session_system_records/migration.sql`);
            const expand = readSchema(`prisma/${providerPath}migrations/20260731170000_expand_session_system_record_addresses/migration.sql`);
            expect(predecessor).toContain("SessionSystemRecord");
            expect(expand).toContain("ownerKind");
            expect(expand).toContain("namespaceAddressKey");
            expect(expand).toContain("recordAddressKey");
            expect(expand).toContain("version");
        }
        const mysqlExpand = readSchema("prisma/mysql/migrations/20260731170000_expand_session_system_record_addresses/migration.sql");
        expect(mysqlExpand).toContain("MODIFY `namespace` VARCHAR(64) NOT NULL");
        expect(mysqlExpand).toContain("MODIFY `kind` VARCHAR(64) NOT NULL");
        expect(mysqlExpand).toContain("BINARY(32)");
    });
});
