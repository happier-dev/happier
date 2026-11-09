import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readText(path: string): string {
    return readFileSync(path, "utf-8");
}

function listMigrationNames(migrationsDir: string): string[] {
    return readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{14}_/u.test(e.name))
        .map((e) => e.name)
        .sort();
}

function listMigrationSqlFiles(migrationsDir: string): string[] {
    return listMigrationNames(migrationsDir).map((name) => join(migrationsDir, name, "migration.sql"));
}

type MigrationProvider = "postgres" | "mysql" | "sqlite";

const MIGRATION_PROVIDER_DIRS: Record<MigrationProvider, string[]> = {
    postgres: ["prisma", "migrations"],
    mysql: ["prisma", "mysql", "migrations"],
    sqlite: ["prisma", "sqlite", "migrations"],
};

interface ReleasedMigrationsFixture {
    tag: string;
    commit: string;
    providers: Record<MigrationProvider, Record<string, string>>;
}

/**
 * `migrationsConsistency.released.json` pins every migration that shipped in the newest released
 * server tag, per provider, as `<name>: sha256(migration.sql)`. Released migrations are immutable
 * (`docs/compatibility.md` §Migration history): a released database records each name in
 * `_prisma_migrations`, so a deleted or edited released migration fails `migrate deploy` on every
 * supported database before any new migration runs. Regenerate only when a newer server tag is
 * released: for each provider directory in MIGRATION_PROVIDER_DIRS, list
 * `git ls-tree --name-only <tag> -- apps/server/<dir>/` and record
 * `git show <tag>:apps/server/<dir>/<name>/migration.sql | sha256sum` under that provider.
 */
function readReleasedMigrationsFixture(root: string): ReleasedMigrationsFixture {
    const parsed: unknown = JSON.parse(readText(join(root, "scripts", "migrationsConsistency.released.json")));
    if (typeof parsed !== "object" || parsed === null) {
        throw new Error("released migrations fixture must be an object");
    }
    const fixture = parsed as Partial<ReleasedMigrationsFixture>;
    if (typeof fixture.tag !== "string" || typeof fixture.commit !== "string" || typeof fixture.providers !== "object" || fixture.providers === null) {
        throw new Error("released migrations fixture must carry tag, commit and providers");
    }
    for (const provider of Object.keys(MIGRATION_PROVIDER_DIRS) as MigrationProvider[]) {
        const entries = fixture.providers[provider];
        if (typeof entries !== "object" || entries === null || Object.values(entries).some((digest) => !/^[0-9a-f]{64}$/u.test(String(digest)))) {
            throw new Error(`released migrations fixture provider ${provider} must map names to sha256 digests`);
        }
    }
    return fixture as ReleasedMigrationsFixture;
}

function sha256Hex(path: string): string {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function anyFileContains(paths: string[], patterns: string[]): boolean {
    for (const p of paths) {
        let text = "";
        try {
            text = readText(p);
        } catch {
            continue;
        }
        if (patterns.every((pat) => text.includes(pat))) {
            return true;
        }
    }
    return false;
}

function expectNoFileContains(paths: string[], pattern: string): void {
    for (const p of paths) {
        let text = "";
        try {
            text = readText(p);
        } catch {
            continue;
        }
        expect(text, `${p} must not contain ${pattern}`).not.toContain(pattern);
    }
}

describe("migrations (provider completeness)", () => {
    it("renames retained Machine setup through a forward migration while preserving its original identity", () => {
        const root = process.cwd();
        const original = "20261009160000_add_machine_preset_environment";
        const forward = "20261026172000_rename_machine_setup_columns";
        const originalDigests: Record<MigrationProvider, string> = {
            postgres: "bdf802037bae21a81f9a1c0472ba226d3927b5576b062f8925f37c091fe5e1a8",
            sqlite: "bdf802037bae21a81f9a1c0472ba226d3927b5576b062f8925f37c091fe5e1a8",
            mysql: "ab36ac45961fa8aa675fbd77b119cdf9bf687fc9b63ae708e2b509f5e354d473",
        };
        for (const provider of Object.keys(MIGRATION_PROVIDER_DIRS) as MigrationProvider[]) {
            const migrationsDir = join(root, ...MIGRATION_PROVIDER_DIRS[provider]);
            expect(sha256Hex(join(migrationsDir, original, "migration.sql"))).toBe(originalDigests[provider]);
            const sql = readText(join(migrationsDir, forward, "migration.sql"));
            const quote = provider === "mysql" ? "`" : '"';
            expect(sql).toContain(`ALTER TABLE ${quote}ManagedMachinePreset${quote} RENAME COLUMN ${quote}environment${quote} TO ${quote}setup${quote}`);
            expect(sql).toContain(`ALTER TABLE ${quote}ManagedMachine${quote} RENAME COLUMN ${quote}environmentSetup${quote} TO ${quote}machineSetup${quote}`);
            expect(sql).not.toContain("_prisma_migrations");
        }
    });

    it("prepares MySQL digest identity without contracting the legacy writer", () => {
        const root = process.cwd();
        const migration = readText(
            join(
                root,
                "prisma",
                "mysql",
                "migrations",
                "20260710170000_add_voice_provider_conversation_keys",
                "migration.sql",
            ),
        );
        const createDigestIndex = migration.indexOf(
            "CREATE UNIQUE INDEX `VoiceConversation_providerId_providerConversationKey_key`",
        );
        expect(createDigestIndex).toBeGreaterThanOrEqual(0);
        expect(migration).not.toContain("DROP INDEX `VoiceConversation_providerId_providerConversationId_key`");
        expect(migration).not.toContain("DROP INDEX `VoiceSessionLease_provider_binding_lookup_idx`");
        expect(migration).not.toMatch(/UPDATE\s+`Voice(?:Conversation|SessionLease)`/);
        expect(migration).not.toContain("MODIFY `providerConversationKey` CHAR(64) NOT NULL");
    });

    it("does not claim widened MySQL raw identifiers before the contract release", () => {
        const root = process.cwd();
        const migration = readText(
            join(
                root,
                "prisma",
                "mysql",
                "migrations",
                "20260710170000_add_voice_provider_conversation_keys",
                "migration.sql",
            ),
        );
        expect(migration).toContain("CREATE INDEX `VoiceSessionLease_provider_binding_key_lookup_idx`");
        expect(migration).not.toMatch(/MODIFY\s+`providerConversationId`\s+VARCHAR\(512\)/);
    });

    it("includes AccountChange entity FK columns across providers", () => {
        const root = process.cwd();
        const schema = readText(join(root, "prisma", "schema.prisma"));
        expect(schema).toContain("sessionId");
        expect(schema).toContain("machineId");
        expect(schema).toContain("artifactId");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountChange" ADD COLUMN',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "AccountChange"',
                '"sessionId"',
                '"machineId"',
                '"artifactId"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `AccountChange`",
                "`sessionId`",
                "`machineId`",
                "`artifactId`",
            ]),
        ).toBe(true);
    });

    it("includes AccountPushToken.clientServerUrl across providers", () => {
        const root = process.cwd();
        expect(readText(join(root, "prisma", "schema.prisma"))).toContain("clientServerUrl String?");
        expect(readText(join(root, "prisma", "sqlite", "schema.prisma"))).toContain("clientServerUrl String?");
        expect(readText(join(root, "prisma", "mysql", "schema.prisma"))).toContain("clientServerUrl String?");

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "AccountPushToken" ADD COLUMN',
                '"clientServerUrl"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'ALTER TABLE "AccountPushToken" ADD COLUMN',
                '"clientServerUrl"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "ALTER TABLE `AccountPushToken` ADD COLUMN",
                "`clientServerUrl`",
            ]),
        ).toBe(true);
    });

    it("backfills Session.meaningfulActivityAt from pending rows across providers", () => {
        const root = process.cwd();

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expect(
            anyFileContains(pgFiles, [
                'ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt"',
                'FROM "SessionPendingMessage"',
                'MAX("createdAt")',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expect(
            anyFileContains(sqliteFiles, [
                'ALTER TABLE "Session" ADD COLUMN "meaningfulActivityAt"',
                'FROM "SessionPendingMessage"',
                'MAX("createdAt")',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expect(
            anyFileContains(mysqlFiles, [
                "ALTER TABLE `Session` ADD COLUMN `meaningfulActivityAt`",
                "FROM `SessionPendingMessage`",
                "MAX(`createdAt`)",
            ]),
        ).toBe(true);
    });

    it("stores SessionTurn runtime issues and mutation receipts with the v2 durable contract across providers", () => {
        const root = process.cwd();
        for (const schemaPath of [
            join(root, "prisma", "schema.prisma"),
            join(root, "prisma", "sqlite", "schema.prisma"),
            join(root, "prisma", "mysql", "schema.prisma"),
        ]) {
            const schema = readText(schemaPath);
            expect(schema).toContain("lastRuntimeIssueJson");
            expect(schema).toContain("agentRollbackOrdinal    Int?");
            expect(schema).not.toContain("rollbackProviderOrdinal");
            expect(schema).toContain("decision   String");
            expect(schema).toContain("observedAt BigInt");
            expect(schema).toContain("appliedAt  BigInt");
            expect(schema).toContain("@@index([sessionId, status])");
            expect(schema).toContain("@@index([sessionId, rollbackState])");
            expect(schema).toContain("@@index([sessionId, agentId, agentTurnId])");
            expect(schema).toContain("@@index([sessionId, appliedAt])");
        }

        const pgFiles = listMigrationSqlFiles(join(root, "prisma", "migrations"));
        expectNoFileContains(pgFiles, "rollbackProviderOrdinal");
        expect(
            anyFileContains(pgFiles, [
                'CREATE TABLE "SessionTurn"',
                '"lastRuntimeIssueJson"',
                '"providerRollbackOrdinal"',
                'CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"',
            ]),
        ).toBe(true);
        expect(
            anyFileContains(pgFiles, [
                'RENAME COLUMN "providerRollbackOrdinal" TO "agentRollbackOrdinal"',
                'RENAME TO "SessionTurn_sessionId_agentId_agentTurnId_idx"',
            ]),
        ).toBe(true);
        expect(
            anyFileContains(pgFiles, [
                'CREATE TABLE "SessionTurnMutationReceipt"',
                '"decision" TEXT NOT NULL',
                '"observedAt" BIGINT NOT NULL',
                '"appliedAt" BIGINT NOT NULL',
                'CREATE INDEX "SessionTurnMutationReceipt_sessionId_appliedAt_idx"',
            ]),
        ).toBe(true);

        const sqliteFiles = listMigrationSqlFiles(join(root, "prisma", "sqlite", "migrations"));
        expectNoFileContains(sqliteFiles, "rollbackProviderOrdinal");
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "SessionTurn"',
                '"lastRuntimeIssueJson"',
                '"providerRollbackOrdinal"',
                'CREATE INDEX "SessionTurn_sessionId_provider_providerTurnId_idx"',
            ]),
        ).toBe(true);
        expect(
            anyFileContains(sqliteFiles, [
                'RENAME COLUMN "providerRollbackOrdinal" TO "agentRollbackOrdinal"',
                'CREATE INDEX "SessionTurn_sessionId_agentId_agentTurnId_idx"',
            ]),
        ).toBe(true);
        expect(
            anyFileContains(sqliteFiles, [
                'CREATE TABLE "SessionTurnMutationReceipt"',
                '"decision" TEXT NOT NULL',
                '"observedAt" BIGINT NOT NULL',
                '"appliedAt" BIGINT NOT NULL',
                'CREATE INDEX "SessionTurnMutationReceipt_sessionId_appliedAt_idx"',
            ]),
        ).toBe(true);

        const mysqlFiles = listMigrationSqlFiles(join(root, "prisma", "mysql", "migrations"));
        expectNoFileContains(mysqlFiles, "rollbackProviderOrdinal");
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `SessionTurn`",
                "`lastRuntimeIssueJson`",
                "`providerRollbackOrdinal`",
                "CREATE INDEX `SessionTurn_sessionId_provider_providerTurnId_idx`",
            ]),
        ).toBe(true);
        expect(
            anyFileContains(mysqlFiles, [
                "RENAME COLUMN `providerRollbackOrdinal` TO `agentRollbackOrdinal`",
                "TO `SessionTurn_sessionId_agentId_agentTurnId_idx`",
            ]),
        ).toBe(true);
        expect(
            anyFileContains(mysqlFiles, [
                "CREATE TABLE `SessionTurnMutationReceipt`",
                "`decision` VARCHAR(191) NOT NULL",
                "`observedAt` BIGINT NOT NULL",
                "`appliedAt` BIGINT NOT NULL",
                "CREATE INDEX `SessionTurnMutationReceipt_sessionId_appliedAt_idx`",
            ]),
        ).toBe(true);
    });

    it("uses the remote-dev SessionTurn migration identity across providers", () => {
        const root = process.cwd();
        const correctionMigration = "20260725110000_reconcile_predecessor_migration_lineage";
        for (const providerPath of [
            join(root, "prisma"),
            join(root, "prisma", "sqlite"),
            join(root, "prisma", "mysql"),
        ]) {
            expect(
                existsSync(join(providerPath, "migrations", "20260517190000_add_session_turns", "migration.sql")),
                providerPath,
            ).toBe(true);
            expect(
                existsSync(join(providerPath, "migrations", "20260521133000_add_session_turn_rows", "migration.sql")),
                providerPath,
            ).toBe(false);
            expect(
                existsSync(join(providerPath, "migrations", correctionMigration, "migration.sql")),
                providerPath,
            ).toBe(true);
        }
    });

    it("reconciles predecessor physical names at the append-only provider boundary", () => {
        const root = process.cwd();
        const correctionMigration = "20260725110000_reconcile_predecessor_migration_lineage";
        const predecessorSystemRecordMigration = "20260519183000_add_session_system_records";

        const postgresPredecessor = readText(
            join(root, "prisma", "migrations", predecessorSystemRecordMigration, "migration.sql"),
        );
        const postgresCorrection = readText(
            join(root, "prisma", "migrations", correctionMigration, "migration.sql"),
        );
        expect(postgresPredecessor).toContain(
            'CREATE INDEX "ssr_account_session_kind_updated_id_idx"',
        );
        expect(postgresCorrection).toContain(
            'ALTER INDEX "ssr_account_session_kind_updated_id_idx"\n'
            + 'RENAME TO "SessionSystemRecord_account_kind_updated_idx"',
        );

        const mysqlPredecessor = readText(
            join(root, "prisma", "mysql", "migrations", predecessorSystemRecordMigration, "migration.sql"),
        );
        const mysqlCorrection = readText(
            join(root, "prisma", "mysql", "migrations", correctionMigration, "migration.sql"),
        );
        expect(mysqlPredecessor).toContain(
            "CREATE INDEX `ssr_account_session_kind_updated_id_idx`",
        );
        expect(mysqlCorrection).toContain(
            "RENAME INDEX `ssr_account_session_kind_updated_id_idx`\n"
            + "    TO `SessionSystemRecord_account_kind_updated_idx`",
        );
        expect(mysqlCorrection.match(/ALTER TABLE `SessionTurn`/g)).toHaveLength(1);
        expect(mysqlCorrection.match(/ALTER TABLE `ConnectedServiceUsageSource`/g)).toHaveLength(1);

        const sqlitePredecessor = readText(
            join(root, "prisma", "sqlite", "migrations", predecessorSystemRecordMigration, "migration.sql"),
        );
        const sqliteCorrection = readText(
            join(root, "prisma", "sqlite", "migrations", correctionMigration, "migration.sql"),
        );
        expect(sqlitePredecessor).toContain(
            'CREATE INDEX "ssr_account_session_kind_updated_id_idx"',
        );
        expect(sqliteCorrection).toContain(
            'DROP INDEX "ssr_account_session_kind_updated_id_idx"',
        );
        expect(sqliteCorrection).toContain(
            'CREATE INDEX "SessionSystemRecord_account_kind_updated_idx"',
        );
        expect(sqliteCorrection).not.toContain("IF EXISTS");
        expect(sqliteCorrection.match(/IF NOT EXISTS/gu)).toHaveLength(3);
        expect(
            sqliteCorrection
                .split("\n")
                .filter((line) => line.includes("IF NOT EXISTS"))
                .every((line) => line.includes("ServiceAccountQuotaSnapshot")),
        ).toBe(true);
        expect(sqliteCorrection).not.toContain("csus_paur_idx");
    });

    it("does not ship primary turn projection state schema artifacts", () => {
        const root = process.cwd();
        for (const schemaPath of [
            join(root, "prisma", "schema.prisma"),
            join(root, "prisma", "sqlite", "schema.prisma"),
            join(root, "prisma", "mysql", "schema.prisma"),
        ]) {
            expect(readText(schemaPath), schemaPath).not.toContain("primaryTurnProjectionStateJson");
        }

        for (const providerPath of [
            join(root, "prisma"),
            join(root, "prisma", "sqlite"),
            join(root, "prisma", "mysql"),
        ]) {
            expect(
                existsSync(join(providerPath, "migrations", "20260517190000_add_primary_turn_projection_state", "migration.sql")),
                providerPath,
            ).toBe(false);
            expectNoFileContains(listMigrationSqlFiles(join(providerPath, "migrations")), "primaryTurnProjectionStateJson");
        }
    });
});

describe("migrations (released set and provider parity)", () => {
    const root = process.cwd();
    const released = readReleasedMigrationsFixture(root);

    it("keeps every released migration present with unchanged bytes in each provider tree", () => {
        for (const [provider, dirSegments] of Object.entries(MIGRATION_PROVIDER_DIRS) as [MigrationProvider, string[]][]) {
            const migrationsDir = join(root, ...dirSegments);
            for (const [name, releasedDigest] of Object.entries(released.providers[provider])) {
                const sqlPath = join(migrationsDir, name, "migration.sql");
                expect(existsSync(sqlPath), `${released.tag} shipped ${provider}/${name}; it must exist on disk`).toBe(true);
                expect(sha256Hex(sqlPath), `${provider}/${name} bytes must equal ${released.tag}`).toBe(releasedDigest);
            }
        }
    });

    it("mirrors every unreleased PostgreSQL migration into the MySQL and SQLite trees by name", () => {
        const releasedPostgresNames = new Set(Object.keys(released.providers.postgres));
        const unreleasedPostgresNames = listMigrationNames(join(root, ...MIGRATION_PROVIDER_DIRS.postgres))
            .filter((name) => !releasedPostgresNames.has(name));
        expect(unreleasedPostgresNames.length).toBeGreaterThan(0);

        for (const provider of ["mysql", "sqlite"] as const) {
            const providerNames = new Set(listMigrationNames(join(root, ...MIGRATION_PROVIDER_DIRS[provider])));
            const missing = unreleasedPostgresNames.filter((name) => !providerNames.has(name));
            expect(missing, `${provider} tree is missing PostgreSQL migrations`).toEqual([]);
        }
    });

    /**
     * The only identifier over PostgreSQL's NAMEDATALEN limit that this gate tolerates. It is owned
     * by the account-encryption-transition program (migration
     * `20260812210000_add_account_encryption_transition_collection_staging`), not by the Teams/Homes
     * work, so only that program may shorten it. Entries are exact `<migration>` + `<identifier>`
     * pairs so every other over-length identifier — including a new one in this same migration —
     * still fails.
     */
    const KNOWN_OVER_LENGTH_POSTGRES_IDENTIFIERS: readonly { migration: string; identifier: string }[] = [
        {
            migration: "20260812210000_add_account_encryption_transition_collection_staging",
            identifier: "AccountEncryptionTransitionCollectionStage_contract_digest_check",
        },
    ];

    it("keeps every PostgreSQL migration identifier within the 63-character NAMEDATALEN limit", () => {
        const postgresMigrationsDir = join(root, ...MIGRATION_PROVIDER_DIRS.postgres);
        const overLength: string[] = [];
        for (const name of listMigrationNames(postgresMigrationsDir)) {
            const sqlPath = join(postgresMigrationsDir, name, "migration.sql");
            for (const match of readText(sqlPath).matchAll(/"([A-Za-z0-9_]{64,})"/gu)) {
                const identifier = match[1]!;
                if (KNOWN_OVER_LENGTH_POSTGRES_IDENTIFIERS.some((known) => known.migration === name && known.identifier === identifier)) {
                    continue;
                }
                overLength.push(`${name}: ${identifier}`);
            }
        }
        expect(overLength, "PostgreSQL truncates these identifiers, so the stored name never matches the migration").toEqual([]);
    });
});
