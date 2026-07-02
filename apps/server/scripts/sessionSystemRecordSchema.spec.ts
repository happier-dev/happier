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
    it.each(schemaPaths)("defines the account-scoped session system record contract in %s", (schemaPath) => {
        const schema = readSchema(schemaPath);

        expect(schema).toContain("model SessionSystemRecord");
        expect(schema).toContain("accountId String");
        expect(schema).toContain("sessionId String");
        expect(schema).toContain("namespace String");
        expect(schema).toContain("kind      String");
        expect(schema).toContain("localId   String");
        expect(schema).toContain("content   Json");
        expect(schema).toContain("@@unique([accountId, sessionId, namespace, localId])");
        expect(schema).toContain("@@index([accountId, sessionId, namespace, kind, updatedAt");
        expect(schema).toContain("@@index([sessionId, namespace, kind, updatedAt");
    });
});
