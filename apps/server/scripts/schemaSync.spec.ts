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

    it("includes release binaryTargets in sqlite/mysql generator blocks (cross-compiled server binaries)", () => {
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
        expect(sqlite).toMatch(
            /binaryTargets\s*=\s*\["native",\s*"debian-openssl-3\.0\.x",\s*"linux-arm64-openssl-3\.0\.x",\s*"darwin",\s*"darwin-arm64",\s*"windows"\]/,
        );

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toMatch(
            /binaryTargets\s*=\s*\["native",\s*"debian-openssl-3\.0\.x",\s*"linux-arm64-openssl-3\.0\.x",\s*"darwin",\s*"darwin-arm64",\s*"windows"\]/,
        );
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

    it("bounds MySQL session-system-record discriminator columns used in composite indexes", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model SessionSystemRecord {
    id        String @id
    accountId String
    sessionId String
    namespace String
    kind      String
    localId   String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("namespace String @db.VarChar(32)");
        expect(mysql).toContain("kind      String @db.VarChar(32)");
    });

    it("omits the redundant overwide MySQL provider-usage identity index", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model ProviderAccountUsageRecord {
    id                String @id
    accountId         String
    recordId          String
    providerId        String
    accountSubjectId  String
    quotaScope        String
    quotaScopeIdKey   String

    @@unique([accountId, recordId])
    @@unique([accountId, providerId, accountSubjectId, quotaScope, quotaScopeIdKey], map: "paur_identity_key")
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("@@unique([accountId, recordId])");
        expect(mysql).not.toContain("paur_identity_key");
    });

    it("strips SQLite relation maps while preserving index maps", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Account {
    id      String  @id
    records Record[]
}

model Record {
    id        String  @id
    accountId String
    account   Account @relation(fields: [accountId], references: [id], onDelete: Cascade, map: "record_account_fkey")

    @@index([accountId], map: "record_account_idx")
}
`;

        const sqlite = generateSqliteSchemaFromPostgres(master);
        expect(sqlite).toContain('@@index([accountId], map: "record_account_idx")');
        expect(sqlite).toContain("Account @relation(fields: [accountId], references: [id], onDelete: Cascade)");
        expect(sqlite).not.toContain('map: "record_account_fkey"');

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain('map: "record_account_fkey"');
        expect(mysql).toContain('@@index([accountId], map: "record_account_idx")');
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

	model Account {
	    id       String @id
	    settings String?
	}

	model AccountSettingsSnapshot {
	    id              String @id
	    settingsDbValue String?
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
	        expect(mysql).toContain("settings String? @db.LongText");
	        expect(mysql).toContain("settingsDbValue String? @db.LongText");
	        expect(mysql).toContain("daemonState String? @db.LongText");
	    });

	    it("uses LongText for connected-service auth group JSON strings in MySQL", () => {
	        const master = `
	generator client {
	    provider = "prisma-client-js"
	}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

	model ConnectedServiceAuthGroup {
	    id         String @id
	    policyJson String
	    stateJson  String?
	}

	model ConnectedServiceAuthGroupMember {
	    id        String @id
	    stateJson String?
	}
	`;

	        const mysql = generateMySqlSchemaFromPostgres(master);
	        expect(mysql).toContain("policyJson String @db.LongText");
	        expect(mysql).toContain("stateJson  String? @db.LongText");
	        expect(mysql).toContain("stateJson String? @db.LongText");
	    });

    it("uses LongText for session organization legacy keys and display envelopes in MySQL", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model SessionOrganizationFolder {
    id             String @id
    folderKey      String
    folderHash     String
    parentKey      String?
    parentHash     String?
    displayDbValue String?
}

model SessionOrganizationOrderEntry {
    id        String @id
    scopeKind String
    scopeKey  String
    scopeHash String
    itemKind  String
    itemKey   String
    itemHash  String
}

model SessionOrganizationLabel {
    id             String @id
    labelKind      String
    scopeKey       String
    scopeHash      String
    displayDbValue String?
}

model SessionAppearance {
    id             String @id
    displayDbValue String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("folderKey      String @db.LongText");
        expect(mysql).toContain("parentKey      String? @db.LongText");
        expect(mysql).toContain("displayDbValue String? @db.LongText");
        expect(mysql).toContain("displayDbValue String @db.LongText");
        expect(mysql).toContain("scopeKey  String @db.LongText");
        expect(mysql).toContain("itemKey   String @db.LongText");
        expect(mysql).toContain("folderHash     String @db.VarChar(71)");
        expect(mysql).toContain("parentHash     String? @db.VarChar(71)");
        expect(mysql).toContain("scopeKind String @db.VarChar(32)");
        expect(mysql).toContain("scopeHash String @db.VarChar(71)");
        expect(mysql).toContain("itemKind  String @db.VarChar(32)");
        expect(mysql).toContain("itemHash  String @db.VarChar(71)");
        expect(mysql).toContain("labelKind      String @db.VarChar(32)");
    });
	});
