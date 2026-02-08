import { describe, expect, it } from "vitest";

import { generateMySqlSchemaFromPostgres, generateSqliteSchemaFromPostgres } from "./schemaSync";

describe("schemaSync", () => {
    it("generates provider-specific schemas from prisma/schema.prisma", () => {
        const master = `
generator client {
    provider        = "prisma-client-js"
    previewFeatures = ["metrics", "relationJoins"]
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Account { id String @id }
`;

        const sqlite = generateSqliteSchemaFromPostgres(master);
        expect(sqlite).toContain('provider = "sqlite"');

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain('provider = "mysql"');
    });

    it("pins MySQL-indexed sha256 token hashes to VARBINARY(32)", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model PublicSessionShare {
    id        String @id
    tokenHash Bytes  @unique
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("tokenHash Bytes  @db.VarBinary(32) @unique");
    });

    it("pins all MySQL tokenHash unique fields to VARBINARY(32)", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model PublicSessionShare {
    id        String @id
    tokenHash Bytes  @unique
}

model InviteToken {
    id        String @id
    tokenHash Bytes  @unique
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        const matches = mysql.match(/tokenHash\s+Bytes\s+@db\.VarBinary\(32\)\s+@unique/g) ?? [];
        expect(matches).toHaveLength(2);
    });

    it("uses LongText for large encrypted state blobs in MySQL", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Session {
    id        String @id
    metadata  String
    agentState String?
}

model Machine {
    id         String @id
    metadata   String
    daemonState String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("metadata  String @db.LongText");
        expect(mysql).toContain("agentState String? @db.LongText");
        expect(mysql).toContain("daemonState String? @db.LongText");
    });
});
