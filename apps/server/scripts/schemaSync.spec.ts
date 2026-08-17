import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

    it("keeps the MySQL Voice identity schema in the prepare/activate phase", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url = env("DATABASE_URL")
}

model VoiceSessionLease {
    id String @id
    sessionId String?
    providerConversationId String?
    providerConversationKey String?
}

model VoiceConversation {
    id String @id
    providerConversationId String
    providerConversationKey String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql.match(/providerConversationId String\?? @db\.VarChar\(191\)/g)).toHaveLength(2);
        expect(mysql.match(/providerConversationKey String\? @db\.Char\(64\)/g)).toHaveLength(2);
        expect(mysql).toContain("sessionId String? @db.VarChar(512)");
    });

    it("pins canonical AutomationRun occurrence keys to their binary ASCII width in MySQL", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model AutomationRun {
    id            String @id
    occurrenceKey String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("occurrenceKey String? @db.Char(43)");
    });

    it("pins Automation catalog reporter materialization identity to its canonical MySQL width", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model AutomationEventSourceCatalogStatus {
    accountId                 String
    eventPluginId             String
    reporterMaterializationId String
    scopeKey                  String

    @@id([accountId, eventPluginId, reporterMaterializationId, scopeKey])
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("reporterMaterializationId String @db.VarChar(256)");
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

    it("strips composite primary-key constraint names, which SQLite and MySQL cannot name", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Account {
    id     String  @id
    fences Fence[]
}

model Fence {
    accountId            String @map("account_id")
    qualifiedGroupDigest String @map("qualified_group_digest")

    account Account @relation(fields: [accountId], references: [id], onDelete: Cascade, onUpdate: Cascade)

    @@id([accountId, qualifiedGroupDigest], map: "fence_pkey")
    @@unique([qualifiedGroupDigest], map: "fence_digest_key")
    @@index([accountId], map: "fence_account_idx")
    @@map("fence")
}
`;

        for (const generated of [
            generateSqliteSchemaFromPostgres(master),
            generateMySqlSchemaFromPostgres(master),
        ]) {
            expect(generated).toContain("@@id([accountId, qualifiedGroupDigest])");
            expect(generated).not.toContain('map: "fence_pkey"');
            // Unique/index constraint names remain nameable on both providers.
            expect(generated).toContain('@@unique([qualifiedGroupDigest], map: "fence_digest_key")');
            expect(generated).toContain('@@index([accountId], map: "fence_account_idx")');
        }
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
    ownerMetadata String?
    agentState String?
}

model Account {
    id       String @id
    settings String?
}

model Machine {
    id         String @id
    metadata   String
    daemonState String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("metadata  String @db.LongText");
        expect(mysql).toMatch(/ownerMetadata\s+String\?\s+@db\.LongText/);
        expect(mysql).toContain("agentState String? @db.LongText");
        expect(mysql).toContain("settings String? @db.LongText");
        expect(mysql).toContain("daemonState String? @db.LongText");
    });

    it("bounds MySQL SessionSystemRecord catalog fields so composite indexes fit InnoDB", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model SessionSystemRecord {
    id        String @id
    namespace String
    kind      String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("namespace String @db.VarChar(64)");
        expect(mysql).toContain("kind      String @db.VarChar(64)");
    });

    it("prefixes MySQL plugin-permission lookup indexes to the InnoDB key limit", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model PluginPermissionGrant {
    id String @id
    accountId String
    pluginId String
    capability String
    scopeKind String
    scopeProjectId String?
    scopeWorkspaceId String?
    authorityKind String
    authorityMachineId String?
    authorityInstallationId String?
    status String
    updatedAt BigInt
    eventKind String
    createdAt BigInt

    @@index([accountId, pluginId, capability, scopeKind, scopeProjectId, scopeWorkspaceId, authorityKind, authorityMachineId, authorityInstallationId, status, updatedAt], map: "plugin_permission_grants_scope_idx")
    @@index([accountId, pluginId, capability, scopeKind, scopeProjectId, scopeWorkspaceId, authorityKind, authorityMachineId, authorityInstallationId, status, updatedAt], map: "plugin_permission_requests_scope_idx")
    @@index([accountId, pluginId, capability, eventKind, createdAt], map: "plugin_permission_events_kind_idx")
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        const boundedScopeIndex = [
            "accountId(length: 64)",
            "pluginId(length: 64)",
            "capability(length: 64)",
            "scopeKind(length: 64)",
            "scopeProjectId(length: 64)",
            "scopeWorkspaceId(length: 64)",
            "authorityKind(length: 64)",
            "authorityMachineId(length: 64)",
            "authorityInstallationId(length: 64)",
            "status(length: 64)",
            "updatedAt",
        ].join(", ");
        expect(mysql).toContain(
            `@@index([${boundedScopeIndex}], map: "plugin_permission_grants_scope_idx")`,
        );
        expect(mysql).toContain(
            `@@index([${boundedScopeIndex}], map: "plugin_permission_requests_scope_idx")`,
        );
        expect(mysql).toContain(
            '@@index([accountId(length: 64), pluginId(length: 64), capability(length: 64), eventKind(length: 64), createdAt], map: "plugin_permission_events_kind_idx")',
        );
    });

    it("bounds MySQL session-organization order identity fields to their canonical encodings", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model SessionOrganizationOrderEntry {
    id String @id
    scopeKind String
    scopeHash String
    itemKind String
    itemHash String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("scopeKind String @db.VarChar(64)");
        expect(mysql).toContain("scopeHash String @db.VarChar(71)");
        expect(mysql).toContain("itemKind String @db.VarChar(64)");
        expect(mysql).toContain("itemHash String @db.VarChar(71)");
    });

    it("stores MySQL session-organization digests at their canonical prefixed-hash width", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model SessionOrganizationFolder {
    id         String @id
    folderHash String
    parentHash String?
}

model SessionOrganizationTag {
    id      String @id
    tagHash String
}

model SessionOrganizationLabel {
    id        String @id
    labelKind String
    scopeHash String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("folderHash String @db.VarChar(71)");
        expect(mysql).toContain("parentHash String? @db.VarChar(71)");
        expect(mysql).toContain("tagHash String @db.VarChar(71)");
        expect(mysql).toContain("scopeHash String @db.VarChar(71)");
    });

    it("projects nullable materialization archive evidence to its bounded MySQL width", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model PluginMachineMaterialization {
    id                  String @id
    archiveDigestSha256 String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("archiveDigestSha256 String? @db.VarChar(71)");
    });

    it("generates portable qualified-account digests and unbounded MySQL source values on canonical rows", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model ServiceAccountToken {
    id                       String @id
    accountId                String
    qualifiedServiceDigest   String
    qualifiedIdentityDigest  String
    servicePluginId          String
    serviceLocalId           String
    connectedAccountId       String

    @@unique([accountId, qualifiedIdentityDigest])
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("qualifiedServiceDigest   String @db.Char(64)");
        expect(mysql).toContain("qualifiedIdentityDigest  String @db.Char(64)");
        expect(mysql).toContain("servicePluginId          String @db.LongText");
        expect(mysql).toContain("serviceLocalId           String @db.LongText");
        expect(mysql).toContain("connectedAccountId       String @db.LongText");
        expect(mysql).toContain("@@unique([accountId, qualifiedIdentityDigest])");

        const member = generateMySqlSchemaFromPostgres(master.replace(
            "model ServiceAccountToken",
            "model ConnectedServiceAuthGroupMember",
        ));
        expect(member).toContain("qualifiedServiceDigest   String @db.Char(64)");
        expect(member).toContain("qualifiedIdentityDigest  String @db.Char(64)");
    });

    it("uses LongText for connected-service auth-group policy and state in MySQL", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model ConnectedServiceAuthGroup {
    id         String @id
    policyJson String
    stateJson  String?
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("policyJson String @db.LongText");
        expect(mysql).toContain("stateJson  String? @db.LongText");
    });

    it("generates provider schemas from the canonical SessionTurn storage contract", () => {
        const master = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf-8");

        for (const generated of [generateSqliteSchemaFromPostgres(master), generateMySqlSchemaFromPostgres(master)]) {
            expect(generated).toMatch(/^\s*agentRollbackOrdinal\s+Int\?\s*$/m);
            expect(generated).not.toContain("providerRollbackOrdinal");
            expect(generated).not.toContain("rollbackProviderOrdinal");
            expect(generated).not.toContain("primaryTurnProjectionStateJson");
            expect(generated).toMatch(/^\s*transcriptAnchorProjectionVersion\s+Int\s+@default\(0\)\s*$/m);
            expect(generated).toMatch(/^\s*transcriptAnchorMinSeq\s+Int\?\s*$/m);
            expect(generated).toMatch(/^\s*transcriptAnchorMaxSeq\s+Int\?\s*$/m);
            expect(generated).toContain(
                '@@index([sessionId, transcriptAnchorProjectionVersion, transcriptAnchorMaxSeq, transcriptAnchorMinSeq], map: "SessionTurn_transcript_anchor_range_idx")',
            );
        }
    });
});
