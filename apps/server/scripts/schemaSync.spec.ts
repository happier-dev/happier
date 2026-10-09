import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    AccountApiTokensCreateActionInputV1Schema,
} from "@happier-dev/protocol";

import { generateMySqlSchemaFromPostgres, generateSqliteSchemaFromPostgres } from "./schemaSync";

const serverRoot = join(import.meta.dirname, "..");

describe("schemaSync", () => {
    it("preserves exact retained KV identities within MySQL's full compound index capacity", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const kv = mysql.match(/model UserKVStore\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        // ProfileRecordIdV1 has no retained-id bound. The full utf8mb4 unique
        // index reserves 191 characters for accountId and four bytes per character.
        const maximumKeyCharacters = (3_072 / 4) - 191;
        expect(kv).toMatch(new RegExp(`^\\s*key\\s+String\\s+@db\\.VarChar\\(${maximumKeyCharacters}\\)`, "mu"));
        expect(kv).toContain("@@unique([accountId, key])");
        const migration = readFileSync(join(serverRoot,
            "prisma/mysql/migrations/20261009100000_preserve_exact_user_kv_keys/migration.sql"), "utf8");
        expect(migration).toMatch(new RegExp("`key` VARCHAR\\(" + maximumKeyCharacters
            + "\\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL", "u"));
        expect(migration).not.toMatch(/(?:SUBSTRING|LEFT|SHA|MD5|DROP\s+(?:TABLE|COLUMN|INDEX))/iu);
        for (const schema of [postgres, generateSqliteSchemaFromPostgres(postgres)]) {
            const unchanged = schema.match(/model UserKVStore\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
            expect(unchanged).not.toMatch(/key\s+String\s+@db\./u);
        }
    });
    it("preserves preset names as text without a MySQL-only length restriction", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const preset = mysql.match(/model ManagedMachinePreset\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        expect(preset).toMatch(/name\s+String\s+@db\.LongText/u);
        expect(preset).not.toMatch(/@@index\([^\n]*\bname\b/u);
        const migration = readFileSync(join(serverRoot, "prisma/mysql/migrations/20261008143000_add_managed_machine_authority/migration.sql"), "utf8");
        expect(migration).toMatch(/`name` LONGTEXT NOT NULL/u);
    });
    it("projects PostgreSQL Text fields to native SQLite strings without narrowing MySQL storage", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const sqlite = generateSqliteSchemaFromPostgres(postgres);
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const sqliteSource = sqlite.match(/model ProjectSource\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        const mysqlSource = mysql.match(/model ProjectSource\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        for (const [field, optional] of [["name", false], ["defaultRef", true], ["subdir", true]] as const) {
            expect(sqliteSource).toMatch(new RegExp(`^\\s*${field}\\s+String${optional ? "\\?" : ""}\\s*$`, "mu"));
            expect(mysqlSource).toMatch(new RegExp(`^\\s*${field}\\s+String${optional ? "\\?" : ""}\\s+@db\\.Text\\s*$`, "mu"));
        }
    });
    it("preserves serialized review workspace references beyond MySQL's default string width", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        for (const name of ["ReviewComment", "ReviewCommentEvent"]) {
            const model = mysql.match(new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)^\\}`, "mu"))?.[1] ?? "";
            expect(model).toMatch(/workspaceJson\s+String\?\s+@db\.LongText/u);
        }
    });
    it("does not narrow serialized Workflow invocation identity to MySQL's default string width", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const turn = mysql.match(/model SessionTurn\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        expect(turn).toMatch(/workflowInvocationJson\s+String\?\s+@db\.LongText/u);
    });
    it("keeps scoped governance enums and projects invitation and Team presentation storage without narrowing it", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const sqlite = generateSqliteSchemaFromPostgres(postgres);
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        for (const schema of [sqlite, mysql]) {
            expect(schema).toMatch(/enum TeamMembershipStatus\s*\{\s*active\s+suspended\s*\}/u);
            expect(schema).toMatch(/enum AccountStatus\s*\{\s*active\s+suspended\s+disabled\s*\}/u);
        }
        const invitation = mysql.match(/model TeamInvitation\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        expect(invitation).toMatch(/tokenHash\s+Bytes\s+@db\.VarBinary\(32\)\s+@unique/u);
        expect(invitation).toMatch(/recipientEmailNormalized\s+String\?\s+@db\.VarChar\(320\)/u);
        for (const name of ["Team", "TeamGroup"]) {
            const model = mysql.match(new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)^\\}`, "mu"))?.[1] ?? "";
            expect(model).toMatch(/description\s+String\?\s+@db\.LongText/u);
        }
    });
    it("realizes the complete native email locator and evidence widths on MySQL", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const identity = mysql.match(/model AccountIdentity\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        expect(identity).toMatch(/providerUserId\s+String\s+@db\.VarChar\(512\)/u);
        expect(identity).toMatch(/providerLogin\s+String\?\s+@db\.VarChar\(320\)/u);
        const email = mysql.match(/model AccountEmail\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        expect(email).toMatch(/address\s+String\s+@db\.VarChar\(320\)/u);
        expect(email).toMatch(/normalizedEmail\s+String\s+@db\.VarChar\(320\)/u);
        expect(email).toContain("@@id([accountId, normalizedEmail])");
        expect(email).toContain("@@index([normalizedEmail])");
    });
    it("retains the predecessor Session attention fields and lookup index in every provider schema", () => {
        for (const schemaPath of [
            "prisma/schema.prisma",
            "prisma/sqlite/schema.prisma",
            "prisma/mysql/schema.prisma",
        ]) {
            const schema = readFileSync(join(serverRoot, schemaPath), "utf8");
            expect(schema).toMatch(/^\s*unreadSince\s+DateTime\?\s*$/mu);
            expect(schema).toMatch(/^\s*needsAttention\s+Boolean\s+@default\(dbgenerated\(\)\)\s*$/mu);
            expect(schema).toMatch(
                /^\s*@@index\(\[accountId, needsAttention, meaningfulActivityAt(?:\(sort: Desc\))?, id(?:\(sort: Desc\))?\]\)\s*$/mu,
            );
        }
    });

    it("keeps Session Follow edge invariants provider-complete", () => {
        for (const providerDir of ["prisma", "prisma/sqlite"]) {
            const migration = readFileSync(join(
                serverRoot,
                providerDir,
                "migrations/20260905230000_add_session_follow_edges/migration.sql",
            ), "utf8");

            expect(migration).toMatch(/SessionFollowEdge_distinct_sessions_check/u);
            expect(migration).toMatch(/sourceSessionId[^;]*<>[^;]*destinationSessionId/su);
            expect(migration).toMatch(/SessionFollowEdge_frontier_nonnegative_check/u);
            expect(migration).toMatch(/deliveredTranscriptSeq[^;]*>= 0/su);
            expect(migration).toMatch(/deliveredReadyEventSeq[^;]*>= 0/su);
            expect(migration).toMatch(/deliveredAgentStateVersion[^;]*>= 0/su);
            expect(migration).toMatch(/SessionFollowEdge_deliveredTurn_pair_check/u);
        }

        const mysql = readFileSync(join(
            serverRoot,
            "prisma/mysql/migrations/20260905230000_add_session_follow_edges/migration.sql",
        ), "utf8");
        // MySQL rejects a CHECK over a column that also participates in an
        // ON DELETE/UPDATE CASCADE foreign key (error 3823). Keep both cascade
        // semantics and the same no-self-edge invariant through the provider's
        // smallest supported enforcement point.
        expect(mysql).not.toMatch(/SessionFollowEdge_distinct_sessions_check/u);
        expect(mysql).toMatch(/CREATE TRIGGER `SessionFollowEdge_distinct_sessions_insert`/u);
        expect(mysql).toMatch(/CREATE TRIGGER `SessionFollowEdge_distinct_sessions_update`/u);
        expect(mysql.match(/SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'SessionFollowEdge source and destination must differ'/gu)).toHaveLength(2);
        expect(mysql).not.toMatch(/SET NEW\.`sourceSessionId` = NULLIF/gu);
        expect(mysql).toMatch(/SessionFollowEdge_frontier_nonnegative_check/u);
        expect(mysql).toMatch(/SessionFollowEdge_deliveredTurn_pair_check/u);
    });

    it("keeps the Automation catalog identity within MySQL's exact key boundary", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const catalog = mysql.match(/model AutomationEventSourceCatalogStatus\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        const migration = readFileSync(join(
            serverRoot,
            "prisma/mysql/migrations/20260816231000_add_event_automations_v1/migration.sql",
        ), "utf8");
        // Plugin ids are ASCII and capped at 256 bytes by PluginIdSchema. The
        // longest catalog scope is the 12-character `durablePush:` prefix plus
        // the exact 28-character webhook endpoint id.
        const maximumPluginIdBytes = 256;
        const maximumScopeKey = `durablePush:wh_ep_${"A".repeat(22)}`;

        expect(maximumScopeKey).toHaveLength(40);
        expect(catalog).toMatch(new RegExp(`^\\s*eventPluginId\\s+String\\s+@db\\.VarChar\\(${maximumPluginIdBytes}\\)`, "mu"));
        expect(catalog).toMatch(/^\s*reporterMaterializationId\s+String\s+@db\.VarChar\(256\)/mu);
        expect(catalog).toMatch(/^\s*scopeKey\s+String\s+@db\.VarChar\(40\)/mu);
        expect(migration).toMatch(/`eventPluginId` VARCHAR\(256\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/u);
        expect(migration).toMatch(/`reporterMaterializationId` VARCHAR\(256\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/u);
        expect(migration).toMatch(/`scopeKey` VARCHAR\(40\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/u);

        // The generated Prisma schema cannot express MySQL column character
        // sets, so its conservative utf8mb4 budget must still fit. The real
        // migration is smaller because canonical Plugin and scope ids are ASCII.
        expect((191 + maximumPluginIdBytes + 256 + maximumScopeKey.length) * 4).toBeLessThanOrEqual(3_072);
        expect((191 * 4) + maximumPluginIdBytes + (256 * 4) + maximumScopeKey.length).toBeLessThanOrEqual(3_072);
    });

    it("keeps Session Team/Group access and nullable context lifecycle provider-complete", () => {
        for (const schemaPath of [
            "prisma/schema.prisma",
            "prisma/sqlite/schema.prisma",
            "prisma/mysql/schema.prisma",
        ]) {
            const schema = readFileSync(join(serverRoot, schemaPath), "utf8");
            const teamGrant = schema.match(/model SessionTeamGrant\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
            const groupGrant = schema.match(/model SessionGroupGrant\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
            const session = schema.match(/model Session\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";

            expect(teamGrant).toMatch(/@@id\(\[sessionId, teamId\]\)/u);
            expect(teamGrant).toMatch(/@relation\(fields: \[sessionId\], references: \[id\], onDelete: Cascade\)/u);
            expect(teamGrant).toMatch(/@relation\(fields: \[teamId\], references: \[id\], onDelete: Cascade\)/u);
            expect(teamGrant).toMatch(/^\s*requiredByTeamPolicy\s+Boolean\s+@default\(false\)\s*$/mu);
            expect(teamGrant).toMatch(/^\s*effectiveAt\s+DateTime\s*$/mu);

            expect(groupGrant).toMatch(/@@id\(\[sessionId, teamGroupId\]\)/u);
            expect(groupGrant).toMatch(/@relation\(fields: \[sessionId\], references: \[id\], onDelete: Cascade\)/u);
            expect(groupGrant).toMatch(/@relation\(fields: \[teamGroupId\], references: \[id\], onDelete: Cascade\)/u);
            expect(groupGrant).toMatch(/^\s*effectiveAt\s+DateTime\s*$/mu);

            expect(session).toMatch(/primaryTeam\s+Team\?\s+@relation\("SessionPrimaryTeam", fields: \[primaryTeamId\], references: \[id\], onDelete: SetNull\)/u);
            expect(session).toMatch(/responsibleAccount\s+Account\?\s+@relation\("SessionResponsibleAccount", fields: \[responsibleAccountId\], references: \[id\], onDelete: SetNull\)/u);
            expect(session).toMatch(/@@index\(\[primaryTeamId\]\)/u);
            expect(session).toMatch(/@@index\(\[responsibleAccountId\]\)/u);
        }

        for (const providerDir of ["prisma", "prisma/sqlite", "prisma/mysql"]) {
            const grantsMigration = readFileSync(join(
                serverRoot,
                providerDir,
                "migrations/20260905230000_add_session_team_group_grants/migration.sql",
            ), "utf8");
            const responsibilityMigration = readFileSync(join(
                serverRoot,
                providerDir,
                "migrations/20260906000000_add_session_responsible_account/migration.sql",
            ), "utf8");

            expect(grantsMigration).toMatch(/SessionTeamGrant/u);
            expect(grantsMigration).toMatch(/SessionGroupGrant/u);
            expect(grantsMigration).toMatch(/requiredByTeamPolicy/u);
            expect(grantsMigration).toMatch(/effectiveAt/u);
            expect(grantsMigration).toMatch(/ON DELETE CASCADE/u);
            expect(grantsMigration).toMatch(/primaryTeamId/u);
            expect(grantsMigration).toMatch(/ON DELETE SET NULL/u);
            expect(responsibilityMigration).toMatch(/responsibleAccountId/u);
            expect(responsibilityMigration).toMatch(/ON DELETE SET NULL/u);
        }
    });

    it("preserves predecessor enum lineage and provider-safe Account Directory widths", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);

        expect(postgres).toMatch(/enum AutomationScheduleKind\s*\{[^}]*\bmanual\b[^}]*\}/su);
        expect(mysql).toMatch(/^\s*canonicalServerUrl\s+String\s+@db\.VarChar\(512\)\s*$/mu);
        expect(mysql).toMatch(/^\s*issuerSubjectId\s+String\s+@db\.VarChar\(256\)\s*$/mu);
        expect(mysql).toMatch(/^\s*requesterIssuerSubjectId\s+String\?\s+@db\.VarChar\(256\)\s*$/mu);
        expect(mysql).toMatch(/^\s*flow\s+String\s+@default\("direct_qr"\)\s+@db\.VarChar\(32\)\s*$/mu);
        expect(mysql).toMatch(/^\s*approvalStatus\s+String\?\s+@db\.VarChar\(16\)\s*$/mu);
    });

    it("keeps Account Directory ownership, cascade, and pinned-link invariants provider-complete", () => {
        for (const schemaPath of [
            "prisma/schema.prisma",
            "prisma/sqlite/schema.prisma",
            "prisma/mysql/schema.prisma",
        ]) {
            const schema = readFileSync(join(serverRoot, schemaPath), "utf8");
            const entry = schema.match(/model AccountHomeDirectoryEntry\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
            const link = schema.match(/model AccountDirectoryLink\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
            const pairing = schema.match(/model AuthPairingSession\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";

            expect(schema).toMatch(/^\s*preferredHomeServerIdentityId\s+String\?\s*$/mu);
            expect(entry).toMatch(/@@id\(\[accountId, homeServerIdentityId\]\)/u);
            expect(entry).toMatch(/@relation\(fields: \[accountId\], references: \[id\], onDelete: Cascade\)/u);
            expect(link).toMatch(/@@id\(\[issuerServerIdentityId, issuerSubjectId\]\)/u);
            expect(link).toMatch(/@@unique\(\[accountId, issuerServerIdentityId\]\)/u);
            expect(link).toMatch(/@relation\(fields: \[accountId\], references: \[id\], onDelete: Cascade\)/u);
            expect(pairing).toMatch(/flow\s+String\s+@default\("direct_qr"\)/u);
            expect(pairing).toMatch(/requesterIssuerServerIdentityId\s+String\?/u);
            expect(pairing).toMatch(/requesterIssuerSubjectId\s+String\?/u);
            expect(pairing).toMatch(/approvalStatus\s+String\?/u);
            expect(pairing).toMatch(/decidedAt\s+DateTime\?/u);
            expect(pairing).toMatch(/requestedBindingProof\s+String\?/u);
            if (schemaPath === "prisma/mysql/schema.prisma") {
                expect(link).toMatch(/^\s*issuerSubjectId\s+String\s+@db\.VarChar\(256\)\s*$/mu);
                expect(pairing).toMatch(/^\s*requesterIssuerSubjectId\s+String\?\s+@db\.VarChar\(256\)\s*$/mu);
            }
        }
    });

    it("keeps the account-auth sealed completion result provider-complete and unbounded on MySQL", () => {
        for (const schemaPath of [
            "prisma/schema.prisma",
            "prisma/sqlite/schema.prisma",
            "prisma/mysql/schema.prisma",
        ]) {
            const schema = readFileSync(join(serverRoot, schemaPath), "utf8");
            const accountAuth = schema.match(/model AccountAuthRequest\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";

            if (schemaPath === "prisma/mysql/schema.prisma") {
                expect(accountAuth).toMatch(/^\s*tokenEncrypted\s+String\?\s+@db\.Text\s*$/mu);
            } else {
                expect(accountAuth).toMatch(/^\s*tokenEncrypted\s+String\?\s*$/mu);
            }
        }

        const migrations = [
            "prisma/migrations/20260830142000_add_account_auth_encrypted_result/migration.sql",
            "prisma/sqlite/migrations/20260830142000_add_account_auth_encrypted_result/migration.sql",
            "prisma/mysql/migrations/20260830142000_add_account_auth_encrypted_result/migration.sql",
        ].map((migrationPath) => readFileSync(join(serverRoot, migrationPath), "utf8"));

        expect(migrations[0]).toMatch(/ADD COLUMN "tokenEncrypted" TEXT/u);
        expect(migrations[1]).toMatch(/ADD COLUMN "tokenEncrypted" TEXT/u);
        expect(migrations[2]).toMatch(/ADD COLUMN `tokenEncrypted` TEXT NULL/u);
    });

    it("keeps released Session and quota storage intact across Directory and approval migrations", () => {
        for (const providerDir of ["prisma", "prisma/sqlite", "prisma/mysql"]) {
            const migrations = [
                "20260830120000_add_account_directory_models",
                "20260830140000_add_home_assertion_approval_fields",
                "20260830141000_add_qr_requested_binding_proof",
            ].map((migrationId) => readFileSync(
                join(serverRoot, providerDir, "migrations", migrationId, "migration.sql"),
                "utf8",
            )).join("\n");

            expect(migrations).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)[^;]*(unreadSince|needsAttention)/iu);
            expect(migrations).not.toMatch(/DROP\s+(COLUMN|INDEX|TABLE)[^;]*(serviceAccount|quota)/iu);
            expect(migrations).not.toMatch(/CREATE\s+TABLE[^;]*(approval|replay|consume|quota)/iu);
            expect(migrations).toMatch(/ALTER\s+TABLE\s+["`]AuthPairingSession["`]/u);

            const predecessorReconciliation = readFileSync(join(
                serverRoot,
                providerDir,
                "migrations/20260725110000_reconcile_predecessor_migration_lineage/migration.sql",
            ), "utf8");
            expect(predecessorReconciliation).not.toMatch(
                /DROP\s+(?:TABLE|INDEX|COLUMN)[^;]*(?:ServiceAccountQuotaSnapshot|serviceAccount|quota)/iu,
            );
            expect(predecessorReconciliation).toMatch(
                /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]ServiceAccountQuotaSnapshot["`]/iu,
            );
        }
    });

    it("projects managed-provider protocol bounds without MySQL-only narrowing", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        expect(mysql).toMatch(/^\s*displayName\s+String\s+@db\.VarChar\(256\)$/m);
        expect(mysql).toMatch(/^\s*lastSuccessfulTestRuntimeFingerprint\s+String\?\s+@db\.VarChar\(1024\)$/m);
        expect(mysql).toMatch(/^\s*githubHost\s+String\s+@db\.VarChar\(512\)$/m);
        for (const field of ["githubClientId", "githubAppSlug", "githubOwnerLogin", "githubOrganizationLogin"]) {
            expect(mysql).toMatch(new RegExp(`^\\s*${field}\\s+String\\??\\s+@db\\.VarChar\\(256\\)$`, "m"));
        }
    });

    it("keeps Lane 10 accepted values provider-equivalent on MySQL", () => {
        const postgres = readFileSync(join(serverRoot, "prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const model = (name: string) => mysql.match(new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)^\\}`, "mu"))?.[1] ?? "";
        const teamCredentialResource = mysql.match(/model TeamCredentialResource\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        const externalApiKey = mysql.match(/model TeamCredentialExternalApiKey\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";
        const savedSecret = mysql.match(/model SavedSecretResource\s*\{([\s\S]*?)^\}/mu)?.[1] ?? "";

        expect(teamCredentialResource).toMatch(/^\s*id\s+String\s+@id\s+@default\(cuid\(\)\)\s+@db\.VarChar\(256\)\s*$/mu);
        for (const name of [
            "TeamCredentialExternalApiKey",
            "TeamCredentialRecipientMaterial",
            "TeamCredentialActivityEvent",
            "TeamCredentialGroupGrant",
            "TeamCredentialMemberGrant",
            "SessionTeamCredentialBinding",
            "TeamCredentialUsageLimit",
        ]) {
            expect(model(name), `${name}.resourceId`).toMatch(/^\s*resourceId\s+String\s+@db\.VarChar\(256\)\s*$/mu);
        }
        for (const name of ["SessionTurn", "UsageEvent"]) {
            expect(model(name), `${name}.teamCredentialResourceId`).toMatch(
                /^\s*teamCredentialResourceId\s+String\?\s+@db\.VarChar\(256\)\s*$/mu,
            );
        }
        const usageLimit = model("TeamCredentialUsageLimit");
        expect(usageLimit).toMatch(/^\s*subjectKind\s+String\s+@db\.VarChar\(32\)\s*$/mu);
        expect(usageLimit).toMatch(/^\s*period\s+String\s+@db\.VarChar\(16\)\s*$/mu);
        expect(usageLimit).toMatch(/^\s*metric\s+String\s+@db\.VarChar\(32\)\s*$/mu);
        expect(usageLimit).toMatch(/^\s*maximum\s+String\s+@db\.LongText\s*$/mu);
        expect(teamCredentialResource).toMatch(/^\s*directSourceVersionsJson\s+String\?\s+@db\.LongText\s*$/mu);
        expect(externalApiKey).toMatch(/^\s*label\s+String\s+@db\.LongText\s*$/mu);
        expect(savedSecret).toMatch(/^\s*storedContent\s+String\s+@db\.LongText\s*$/mu);
    });

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

    it("preserves Automation reporter custody as provider-native JSON", () => {
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
    reporterSourceCustody        Json
    scopeKey                  String

    @@id([accountId, eventPluginId, reporterMaterializationId, scopeKey])
}

model AutomationEventSourceStatus {
    triggerId                         String @id
    reporterSourceCustody              Json
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toContain("reporterMaterializationId String @db.VarChar(256)");
        expect(mysql.match(/reporterSourceCustody\s+Json/g)).toHaveLength(2);
    });

    it("matches every Account-transition Automation staging column to the width its migration already created", () => {
        const migration = readFileSync(
            join(
                import.meta.dirname,
                "../prisma/mysql/migrations/20260815110000_add_account_encryption_transition_automation_staging/migration.sql",
            ),
            "utf8",
        );
        const generated = readFileSync(
            join(import.meta.dirname, "../prisma/mysql/schema.prisma"),
            "utf8",
        );

        // The migration is the authority: the generated model must not leave a
        // staging column on MySQL's VARCHAR(191) String default, which would
        // both misdescribe the live table and truncate a staged envelope if a
        // later migration were generated from the model.
        const migrationColumnTypes: readonly (readonly [string, string])[] = [
            ["transitionId", "VARCHAR(36)"],
            ["id", "VARCHAR(36)"],
            ["participantKind", "VARCHAR(16)"],
            ["participantId", "VARCHAR(256)"],
            ["automationId", "VARCHAR(256)"],
            ["sourceContent", "LONGTEXT"],
            ["targetContent", "LONGTEXT"],
        ];
        for (const [column, sqlType] of migrationColumnTypes) {
            expect(migration).toContain(`\`${column}\` ${sqlType}`);
        }
        const workflowMigration = readFileSync(
            join(
                import.meta.dirname,
                "../prisma/mysql/migrations/20260908120000_add_workflow_run_invocations/migration.sql",
            ),
            "utf8",
        );
        expect(workflowMigration).toContain(
            "MODIFY `participantKind` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL",
        );
        expect(workflowMigration).toContain("MODIFY `automationId` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL");
        expect(workflowMigration).toContain("MODIFY `sourceRevision` INTEGER NULL");
        expect(workflowMigration).toContain("'workflow_invocation'");

        const stageStateModel = /^model\s+AccountEncryptionTransitionAutomationStageState\s+\{[\s\S]*?^\}\s*$/m
            .exec(generated)?.[0];
        const stageModel = /^model\s+AccountEncryptionTransitionAutomationStage\s+\{[\s\S]*?^\}\s*$/m
            .exec(generated)?.[0];
        expect(stageStateModel).toBeDefined();
        expect(stageModel).toBeDefined();
        expect(stageStateModel).toContain("transitionId              String @db.VarChar(36)");
        expect(stageModel).toContain("id                 String @db.VarChar(36)");
        expect(stageModel).toContain("transitionId       String @db.VarChar(36)");
        expect(stageModel).toContain("participantKind    String @db.VarChar(32)");
        expect(stageModel).toContain("participantId      String @db.VarChar(256)");
        expect(stageModel).toContain("automationId       String? @db.VarChar(256)");
        expect(stageModel).toContain("sourceContent      String @db.LongText");
        expect(stageModel).toContain("targetContent      String? @db.LongText");
        expect(stageModel).not.toMatch(/^\s*(?:sourceContent|targetContent)\s+String\??\s*$/m);
    });

    it("keeps the signed-claim receipt columns at the width its migration already created in MySQL", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model Account {
    id String @id
}

model AutomationWorkerClaimReceipt {
    id String @id
    accountId String
    account Account @relation(fields: [accountId], references: [id], onDelete: Cascade)
    machineId String
    machineInstallationId String
    claimResultJson String
    expiresAt DateTime
    createdAt DateTime @default(now())

    @@index([accountId, machineId])
    @@index([expiresAt])
}
`;

        // The receipt id and its strict claim result both leave MySQL's
        // VARCHAR(191) String default. The generator must annotate them, or
        // `yarn schema:sync` silently narrows the live LONGTEXT result column
        // in the model.
        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toMatch(/^\s*id String @id @db\.VarChar\(64\)$/m);
        expect(mysql).toMatch(/^\s*claimResultJson\s+String @db\.LongText$/m);
        expect(mysql).not.toMatch(/^\s*claimResultJson\s+String\s*$/m);
        const regenerated = generateMySqlSchemaFromPostgres(mysql);
        expect(
            regenerated.match(/^\s*claimResultJson String @db\.LongText$/gm),
        ).toHaveLength(1);

        const migration = readFileSync(
            join(
                import.meta.dirname,
                "../prisma/mysql/migrations/20260816231000_add_event_automations_v1/migration.sql",
            ),
            "utf8",
        );
        const generated = readFileSync(
            join(import.meta.dirname, "../prisma/mysql/schema.prisma"),
            "utf8",
        );
        expect(migration).toContain("`id` VARCHAR(64)");
        expect(migration).toContain("`claimResultJson` LONGTEXT");
        const receiptModel = /^model\s+AutomationWorkerClaimReceipt\s+\{[\s\S]*?^\}\s*$/m
            .exec(generated)?.[0];
        expect(receiptModel).toBeDefined();
        expect(receiptModel).toMatch(/^\s*id\s+String\s+@id\s+@db\.VarChar\(64\)\s*$/m);
        expect(receiptModel).toMatch(/^\s*claimResultJson\s+String @db\.LongText$/m);
        expect(receiptModel).not.toMatch(/^\s*claimResultJson\s+String\s*$/m);
    });

    it("keeps Account API token label storage compatible with the public 256-character contract", () => {
        const atPublicLimit = "a".repeat(256);
        const tokenId = "08f82e18-c13d-4aae-a211-ab5907a5c269";
        for (const length of [191, 192, atPublicLimit.length]) {
            expect(AccountApiTokensCreateActionInputV1Schema.safeParse({ tokenId, label: "a".repeat(length) }).success).toBe(true);
        }
        expect(AccountApiTokensCreateActionInputV1Schema.safeParse({ tokenId, label: `${atPublicLimit}a` }).success).toBe(false);

        const postgresMigration = readFileSync(
            join(import.meta.dirname, "../prisma/migrations/20260822150000_auth_hardening_and_api_tokens/migration.sql"),
            "utf8",
        );
        const sqliteMigration = readFileSync(
            join(import.meta.dirname, "../prisma/sqlite/migrations/20260822150000_auth_hardening_and_api_tokens/migration.sql"),
            "utf8",
        );
        const mysqlMigration = readFileSync(
            join(import.meta.dirname, "../prisma/mysql/migrations/20260822150000_auth_hardening_and_api_tokens/migration.sql"),
            "utf8",
        );
        const postgresSchema = readFileSync(join(import.meta.dirname, "../prisma/schema.prisma"), "utf8");
        const sqliteSchema = readFileSync(join(import.meta.dirname, "../prisma/sqlite/schema.prisma"), "utf8");
        const mysqlSchema = readFileSync(join(import.meta.dirname, "../prisma/mysql/schema.prisma"), "utf8");
        const accountApiTokenModel = (schema: string) => /^model\s+AccountApiToken\s+\{[\s\S]*?^\}\s*$/m.exec(schema)?.[0];

        // PostgreSQL and SQLite TEXT have no narrower provider limit; MySQL must
        // explicitly opt out of Prisma's VARCHAR(191) default at this public boundary.
        expect(postgresMigration).toContain('"label" TEXT NOT NULL');
        expect(sqliteMigration).toContain('"label" TEXT NOT NULL');
        expect(mysqlMigration).toContain("`label` VARCHAR(256) NOT NULL");
        expect(accountApiTokenModel(postgresSchema)).toMatch(/^\s*label\s+String\s*$/m);
        expect(accountApiTokenModel(sqliteSchema)).toMatch(/^\s*label\s+String\s*$/m);
        expect(accountApiTokenModel(mysqlSchema)).toMatch(/^\s*label\s+String\s+@db\.VarChar\(256\)\s*$/m);
    });

    it("keeps directory lifecycle and accepted field bounds equivalent on MySQL", () => {
        const postgres = readFileSync(join(import.meta.dirname, "../prisma/schema.prisma"), "utf8");
        const mysql = generateMySqlSchemaFromPostgres(postgres);
        const model = (name: string) => new RegExp(`^model\\s+${name}\\s+\\{[\\s\\S]*?^\\}\\s*$`, "m")
            .exec(mysql)?.[0] ?? "";

        expect(postgres).not.toMatch(/enum TeamDirectorySourceState \{[\s\S]*?\bsetup\b/);
        expect(model("TeamDirectorySource")).toMatch(/externalSourceKey\s+String\s+@unique\s+@db\.VarChar\(64\)/);
        expect(model("TeamProvisionedIdentity")).toMatch(/externalUserId\s+String\s+@db\.VarChar\(256\)/);
        expect(model("TeamProvisionedIdentity")).toMatch(/externalSubjectId\s+String\?\s+@db\.VarChar\(512\)/);
        expect(model("TeamProvisionedIdentity")).toMatch(/normalizedEmail\s+String\?\s+@db\.VarChar\(512\)/);
        expect(model("TeamProvisionedIdentity")).toMatch(/displayName\s+String\?\s+@db\.VarChar\(512\)/);
        expect(model("TeamProvisionedIdentity")).toMatch(/externalLogin\s+String\?\s+@db\.VarChar\(512\)/);
        expect(model("TeamDirectoryGroup")).toMatch(/externalDisplayName\s+String\s+@db\.VarChar\(512\)/);
        expect(model("TeamDirectoryGroupMember")).toMatch(/externalGroupId\s+String\s+@db\.VarChar\(256\)/);
        expect(model("TeamDirectoryGroupMember")).toMatch(/externalUserId\s+String\s+@db\.VarChar\(256\)/);
        expect(model("TeamExternalGroupBinding")).toMatch(/externalGroupId\s+String\s+@db\.VarChar\(256\)/);
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

    it("uses LongText for Workflow parent and invocation envelopes in MySQL", () => {
        const master = `
generator client { provider = "prisma-client-js" }

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model AutomationRun {
    id                               String @id
    workflowAcceptedSnapshotEnvelope String?
    workflowCheckpointEnvelope       String?
}

model WorkflowRunInvocation {
    id              String @id
    contentEnvelope String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toMatch(/^\s*workflowAcceptedSnapshotEnvelope\s+String\?\s+@db\.LongText$/mu);
        expect(mysql).toMatch(/^\s*workflowCheckpointEnvelope\s+String\?\s+@db\.LongText$/mu);
        expect(mysql).toMatch(/^\s*contentEnvelope\s+String\s+@db\.LongText$/mu);

        const regenerated = generateMySqlSchemaFromPostgres(mysql);
        expect(regenerated.match(/workflowAcceptedSnapshotEnvelope\s+String\?\s+@db\.LongText/gmu)).toHaveLength(1);
        expect(regenerated.match(/workflowCheckpointEnvelope\s+String\?\s+@db\.LongText/gmu)).toHaveLength(1);
        expect(regenerated.match(/contentEnvelope\s+String\s+@db\.LongText/gmu)).toHaveLength(1);
    });

    it("uses LongText for RepeatKey values without widening other value fields", () => {
        const master = `
generator client {
    provider = "prisma-client-js"
}

datasource db {
    provider = "postgresql"
    url      = env("DATABASE_URL")
}

model RepeatKey {
    key       String @id
    value     String
    createdAt DateTime
    expiresAt DateTime
}

model SimpleCache {
    key   String @id
    value String
}
`;

        const mysql = generateMySqlSchemaFromPostgres(master);
        expect(mysql).toMatch(
            /model RepeatKey \{[\s\S]*?value\s+String\s+@db\.LongText/,
        );
        expect(mysql).toMatch(
            /model SimpleCache \{[\s\S]*?value\s+String\n/,
        );
        expect(readFileSync(
            join(
                import.meta.dirname,
                "../prisma/mysql/migrations/20260825120000_expand_repeat_key_value_longtext/migration.sql",
            ),
            "utf8",
        )).toContain("ALTER TABLE `RepeatKey` MODIFY `value` LONGTEXT NOT NULL;");
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
        const master = readFileSync(join(serverRoot, "prisma", "schema.prisma"), "utf-8");

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
