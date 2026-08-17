import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import {
    applySqliteMigrations,
    type SqliteMigrationExecutor,
} from "../../sources/flavors/light/sqliteMigrations";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260816231000_add_event_automations_v1";

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

async function applySqliteMigrationThroughCanonicalExecutor(
    db: DatabaseSync,
    sql: string,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "event-automations-v1-"));
    const migrationDir = join(root, migrationId);
    try {
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, "migration.sql"), sql, "utf8");
        const executor: SqliteMigrationExecutor = {
            exec: (statement) => {
                db.exec(statement);
            },
            queryRows: (statement, params = []) =>
                db.prepare(statement).all(...params),
            run: (statement, params = []) => {
                db.prepare(statement).run(...params);
            },
            queryTableNames: () => new Set(
                db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
                    .all()
                    .map((row) => String((row as { name: unknown }).name)),
            ),
            queryAppliedMigrations: () => db.prepare(`
                SELECT migration_name AS name, checksum
                FROM _prisma_migrations
                WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
            `).all() as Array<{ name: string; checksum: string }>,
            insertAppliedMigration: ({ name, checksum }) => {
                db.prepare(`
                    INSERT INTO _prisma_migrations (
                        id, checksum, finished_at, migration_name, applied_steps_count
                    ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, 1)
                `).run(randomUUID(), checksum, name);
            },
        };
        await applySqliteMigrations({ executor, migrationsDir: root });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function model(schema: string, name: string): string {
    const match = schema.match(new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, "m"));
    if (!match?.[1]) {
        throw new Error(`model ${name} not found`);
    }
    return match[1];
}

async function listTypeScriptFiles(relativeDirectory: string): Promise<string[]> {
    const directory = join(serverRoot, relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    const paths = await Promise.all(entries.map(async (entry) => {
        const relativePath = join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
            return await listTypeScriptFiles(relativePath);
        }
        return entry.isFile() && entry.name.endsWith(".ts")
            ? [relativePath]
            : [];
    }));
    return paths.flat().sort();
}

function enclosingObject(source: string, openingBrace: number): string {
    let depth = 0;
    let quote: "'" | '"' | "`" | null = null;
    let escaped = false;

    for (let index = openingBrace; index < source.length; index += 1) {
        const character = source[index]!;
        if (quote !== null) {
            if (escaped) {
                escaped = false;
            } else if (character === "\\") {
                escaped = true;
            } else if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (character === "'" || character === '"' || character === "`") {
            quote = character;
            continue;
        }
        if (character === "{") {
            depth += 1;
        } else if (character === "}") {
            depth -= 1;
            if (depth === 0) return source.slice(openingBrace, index + 1);
        }
    }
    throw new Error("Unclosed AutomationRun mutation object");
}

function directAutomationRunMutationObjects(source: string): string[] {
    const matcher = /\bautomationRun\.(?:update|updateMany)\s*\(/g;
    const mutations: string[] = [];
    for (const match of source.matchAll(matcher)) {
        const openingBrace = source.indexOf("{", match.index! + match[0].length);
        if (openingBrace < 0) {
            throw new Error("AutomationRun mutation is missing its argument object");
        }
        mutations.push(enclosingObject(source, openingBrace));
    }
    return mutations;
}

describe("Event Automations persistence contract", () => {
    const schemaPaths = [
        "prisma/schema.prisma",
        "prisma/sqlite/schema.prisma",
        "prisma/mysql/schema.prisma",
    ] as const;

    it.each(schemaPaths)("keeps one origin-aware AutomationRun owner in %s", async (schemaPath) => {
        const schema = await read(schemaPath);
        const automation = model(schema, "Automation");
        const run = model(schema, "AutomationRun");

        for (const field of [
            "deletedAt",
            "triggerKind",
            "triggerEventPluginId",
            "triggerEventLocalId",
            "triggerSourceSelectorId",
            "triggerSourceContractVersion",
            "triggerObservationTransport",
            "triggerWebhookEndpointId",
            "triggerObservationStartsAt",
            "watcherMachineId",
            "watcherMachineInstallationId",
            "watcherPluginId",
            "watcherMaterializationId",
            "triggerDefinitionEnvelope",
        ]) {
            expect(automation).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
        }
        expect(automation).toContain(
            "@@index([accountId, enabled, triggerKind, triggerEventPluginId, triggerEventLocalId], map: \"Automation_event_trigger_lookup_idx\")",
        );
        expect(automation).toContain(
            "@@index([accountId, enabled, watcherMachineId, watcherMaterializationId], map: \"Automation_watcher_materialization_lookup_idx\")",
        );

        for (const field of [
            "originKind",
            "originOccurredAt",
            "occurrenceKey",
            "legacyManualIdempotencyKey",
            "occurrenceEvidenceEqualityTag",
            "originSourceSelectorId",
            "triggerEvidenceEnvelope",
            "executionInputEnvelope",
            "executionDispatchState",
            "executionAttempt",
            "executionDispatchCommittedAt",
            "executionDispatchDueAt",
            "executionNativeRunId",
            "executionNativeCallId",
            "executionNativeSidechainId",
            "resultEnvelope",
            "replyContextEnvelope",
            "replyHandoffActionPluginId",
            "replyHandoffActionLocalId",
            "replyHandoffTargetMachineId",
            "replyHandoffTargetMachineInstallationId",
            "replyHandoffTargetMaterializationId",
            "replyHandoffId",
            "replyHandoffState",
            "replyHandoffAttempt",
            "replyHandoffDueAt",
            "replyHandoffReceiptEnvelope",
            "revision",
        ]) {
            expect(run).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
        }
        expect(run).toContain("@@unique([automationId, occurrenceKey])");
        expect(run).toContain(
            "@@unique([automationId, legacyManualIdempotencyKey], map: \"AutomationRun_automationId_idempotencyKey_key\")",
        );
        expect(run).toContain("@@index([accountId, originKind, state])");
        expect(run).toContain("@@index([replyHandoffState, replyHandoffDueAt])");
        expect(run).not.toMatch(/@@index\([^\n]*originOccurredAt/m);
        expect(run).toMatch(/^\s*revision\s+Int\s+@default\(0\)\s*$/m);

        // `scheduledAt` remains non-null for the V2 contract. V3 retains the
        // source-declared Event/Conversation fact in its own nullable column.
        expect(run).toMatch(/^\s*scheduledAt\s+DateTime(?:\s|$)/m);
        expect(run).toMatch(/^\s*originOccurredAt\s+DateTime\?(?:\s|$)/m);
        expect(automation).toMatch(/^\s*scheduleKind\s+AutomationScheduleKind\?(?:\s|$)/m);
        expect(run).toMatch(
            /^\s*automation\s+Automation\s+@relation\([^\n]*onDelete:\s*Restrict[^\n]*\)\s*$/m,
        );

        expect(model(schema, "AutomationEventCatalogState")).toMatch(
            /^\s*eventSourceDefinitionsRevision\s+BigInt\b/m,
        );
        expect(model(schema, "AutomationEventSourceStatus")).toContain(
            "@@id([automationId, eventPluginId, eventLocalId, sourceSelectorId])",
        );
        expect(model(schema, "AutomationEventSourceCatalogStatus")).toContain(
            "@@id([accountId, eventPluginId, reporterMaterializationId, scopeKey])",
        );

        if (schemaPath === "prisma/mysql/schema.prisma") {
            expect(automation).toMatch(
                /^\s*triggerDefinitionEnvelope\s+String\?\s+@db\.LongText\s*$/m,
            );
            for (const field of [
                "triggerEvidenceEnvelope",
                "executionInputEnvelope",
                "resultEnvelope",
                "replyContextEnvelope",
                "replyHandoffReceiptEnvelope",
            ]) {
                expect(run).toMatch(
                    new RegExp(`^\\s*${field}\\s+String\\?\\s+@db\\.LongText\\s*$`, "m"),
                );
            }
        }

        // PEP1 keeps transition coordination Account-owned; Automation must
        // not create a second stage owner.
        expect(schema).not.toMatch(/Automation(?:Run|Event).*Stage/);
        expect(schema).not.toMatch(/Automation(?:Receipt|DispatchLedger|RunQueue)/);
    });

    it.each([
        ["prisma/migrations", '"'],
        ["prisma/sqlite/migrations", '"'],
        ["prisma/mysql/migrations", "`"],
    ] as const)("adds the same additive Event Automation contract for %s", async (migrationRoot, quote) => {
        const sql = await read(`${migrationRoot}/${migrationId}/migration.sql`);

        for (const table of [
            "Automation",
            "AutomationRun",
            "AutomationEventCatalogState",
            "AutomationEventSourceStatus",
            "AutomationEventSourceCatalogStatus",
        ]) {
            expect(sql).toContain(`${quote}${table}${quote}`);
        }
        for (const field of [
            "triggerKind",
            "originKind",
            "originOccurredAt",
            "occurrenceKey",
            "occurrenceEvidenceEqualityTag",
            "executionDispatchState",
            "resultEnvelope",
            "revision",
        ]) {
            expect(sql).toContain(`${quote}${field}${quote}`);
        }
        expect(sql).toMatch(new RegExp(`${quote}revision${quote}[\\s\\S]{0,80}DEFAULT\\s+0`, "i"));
        expect(sql).toContain("legacySummaryCiphertext");
        expect(sql).toContain("summaryCiphertext");
        expect(sql).not.toMatch(/Automation(?:Run|Event).*Stage/);
        expect(sql).not.toMatch(/Automation(?:Receipt|DispatchLedger|RunQueue)/);
    });

    it("keeps the MySQL catalog-status primary key portable within utf8mb4's 3072-byte limit", async () => {
        const mysqlSql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        const catalogStatusDdl = mysqlSql.match(
            /CREATE TABLE `AutomationEventSourceCatalogStatus` \([\s\S]*?\) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;/,
        )?.[0];

        expect(catalogStatusDdl).toBeDefined();
        expect(catalogStatusDdl).toContain(
            "PRIMARY KEY (`accountId`, `eventPluginId`, `reporterMaterializationId`, `scopeKey`)",
        );
        expect(catalogStatusDdl).toContain("`reporterMachineId` VARCHAR(191) NOT NULL");
        expect(catalogStatusDdl).toContain("`reporterMachineInstallationId` VARCHAR(191) NOT NULL");

        // The materialization identity is canonical ASCII, so its binary
        // column preserves exact equality while the full primary key remains
        // within InnoDB's 3072-byte budget.
        expect(191 * 4 + 191 * 4 + 256 + 191 * 4).toBeLessThanOrEqual(3072);
    });

    it("keeps every named MySQL index and constraint within the provider identifier ceiling", async () => {
        const mysqlSql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        const identifiers = [...mysqlSql.matchAll(/\b(?:INDEX|CONSTRAINT)\s+`([^`]+)`/g)]
            .map((match) => match[1]!);

        expect(identifiers.length).toBeGreaterThan(0);
        expect(identifiers.filter((identifier) => identifier.length > 64)).toEqual([]);
    });

    it("replaces the AutomationRun foreign key in separate MySQL statements", async () => {
        const mysqlSql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);

        expect(mysqlSql).toMatch(
            /ALTER TABLE `AutomationRun`\s+DROP FOREIGN KEY `AutomationRun_automationId_fkey`;\s+ALTER TABLE `AutomationRun`\s+ADD CONSTRAINT `AutomationRun_automationId_fkey`/,
        );
    });

    it("adopts preview manual rows before MySQL narrows the schedule enum", async () => {
        const mysqlSql = await read(`prisma/mysql/migrations/${migrationId}/migration.sql`);
        const runAdoption = mysqlSql.indexOf("SET run.`originKind` = 'manual'");
        const definitionAdoption = mysqlSql.indexOf("`triggerKind` = 'manual'");
        const scheduleNarrowing = mysqlSql.indexOf(
            "MODIFY `scheduleKind` ENUM('cron', 'interval') NULL",
        );

        expect(runAdoption).toBeGreaterThanOrEqual(0);
        expect(definitionAdoption).toBeGreaterThan(runAdoption);
        expect(scheduleNarrowing).toBeGreaterThan(definitionAdoption);
    });

    it("uses ordinary nullable occurrence uniqueness in every provider migration", async () => {
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        expect(postgresSql).toMatch(/UNIQUE\s*\(\s*"automationId"\s*,\s*"occurrenceKey"\s*\)/i);
        expect(sqliteSql).toMatch(
            /(?:UNIQUE\s*\(\s*"automationId"\s*,\s*"occurrenceKey"\s*\)|CREATE\s+UNIQUE\s+INDEX[\s\S]*?ON\s+"AutomationRun"\s*\(\s*"automationId"\s*,\s*"occurrenceKey"\s*\))/i,
        );
        expect(mysqlSql).toMatch(/UNIQUE(?:\s+INDEX|\s+KEY)?[^\n]*`automationId`[^\n]*`occurrenceKey`/i);
    });

    it("preserves canonical occurrence-key equality across provider collations", async () => {
        const [postgresSql, sqliteSql, mysqlSql, mysqlSchema] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
            read("prisma/mysql/schema.prisma"),
        ]);

        // PostgreSQL and SQLite TEXT values retain their existing binary/text
        // equality semantics. MySQL needs an explicit per-column binary ASCII
        // collation because the table's default collation is case-insensitive.
        expect(postgresSql).toMatch(/ADD\s+COLUMN\s+"occurrenceKey"\s+TEXT/i);
        expect(sqliteSql).toMatch(
            /ALTER\s+TABLE\s+"AutomationRun"\s+ADD\s+COLUMN\s+"occurrenceKey"\s+TEXT/i,
        );
        expect(mysqlSql).toMatch(
            /ADD\s+COLUMN\s+`occurrenceKey`\s+CHAR\(43\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NULL/i,
        );
        expect(model(mysqlSchema, "AutomationRun")).toMatch(
            /^\s*occurrenceKey\s+String\?\s+@db\.Char\(43\)\s*$/m,
        );
    });

    it("preserves canonical reporter materialization identity across provider collations", async () => {
        const [postgresSql, sqliteSql, mysqlSql, mysqlSchema] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
            read("prisma/mysql/schema.prisma"),
        ]);

        expect(postgresSql).toMatch(
            /CREATE\s+TABLE\s+"AutomationEventSourceCatalogStatus"[\s\S]*?"reporterMaterializationId"\s+TEXT\s+NOT\s+NULL/i,
        );
        expect(sqliteSql).toMatch(
            /CREATE\s+TABLE\s+"AutomationEventSourceCatalogStatus"[\s\S]*?"reporterMaterializationId"\s+TEXT\s+NOT\s+NULL/i,
        );
        expect(mysqlSql).toMatch(
            /`reporterMaterializationId`\s+VARCHAR\(256\)\s+CHARACTER\s+SET\s+ascii\s+COLLATE\s+ascii_bin\s+NOT\s+NULL/i,
        );
        expect(model(mysqlSchema, "AutomationEventSourceCatalogStatus")).toMatch(
            /^\s*reporterMaterializationId\s+String\s+@db\.VarChar\(256\)\s*$/m,
        );
    });

    it("makes every canonical AutomationRun mutation advance the one revision owner", async () => {
        const expectedMutationCounts = new Map([
            ["sources/app/automations/automationClaimService.ts", 3],
            ["sources/app/automations/automationConversationAdmissionService.ts", 1],
            ["sources/app/automations/automationCrudService.ts", 3],
            ["sources/app/automations/automationReplyHandoffService.ts", 4],
            // Cross-machine acknowledgement-loss and failed-input cancellation
            // retain the canonical produced Session identity through the incumbent Run owner.
            ["sources/app/automations/automationRunService.ts", 12],
        ]);
        const expectedMutationEvidence = new Map([
            [
                "sources/app/automations/automationRunService.ts",
                {
                    label: "cancelled Run produced-Session identity retention",
                    pattern: /producedSessionId,\s*revision:\s*\{\s*increment:\s*1\s*\}/,
                },
            ],
        ]);
        const sourceFiles = (await listTypeScriptFiles("sources/app"))
            .filter((path) => !/\.(?:spec|test)\.ts$/.test(path));
        const mutationObjectsByPath = new Map<string, string[]>();

        for (const path of sourceFiles) {
            const mutations = directAutomationRunMutationObjects(await read(path));
            if (mutations.length > 0) {
                mutationObjectsByPath.set(path, mutations);
            }
        }

        expect([...mutationObjectsByPath.keys()].sort()).toEqual(
            [...expectedMutationCounts.keys()].sort(),
        );
        for (const [path, expectedCount] of expectedMutationCounts) {
            const mutations = mutationObjectsByPath.get(path) ?? [];
            expect(mutations, `${path} direct mutation inventory`).toHaveLength(expectedCount);
            for (const mutation of mutations) {
                const dataIndex = mutation.indexOf("data:");
                expect(dataIndex).toBeGreaterThanOrEqual(0);
                expect(mutation.slice(dataIndex)).toMatch(
                    /\brevision\s*:\s*\{\s*increment\s*:\s*1\s*\}/,
                );
            }
        }
        for (const [path, evidence] of expectedMutationEvidence) {
            const mutations = mutationObjectsByPath.get(path) ?? [];
            expect(
                mutations.some((mutation) => evidence.pattern.test(mutation)),
                `${path} ${evidence.label}`,
            ).toBe(true);
        }
    });

    it("adds portable trigger and Run origin-arm constraints in every provider migration", async () => {
        const migrations = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        for (const sql of migrations) {
            expect(sql).toContain("Automation_trigger_arm_check");
            expect(sql).toContain("AutomationRun_origin_arm_check");
            expect(sql).toContain("AutomationRun_reply_handoff_arm_check");
            expect(sql).toContain("originOccurredAt");
            expect(sql).toContain("occurrenceEvidenceEqualityTag");
            expect(sql).toMatch(/CHECK\s*\(/i);
        }
    });

    it("requires source occurrence time only for Event and Conversation Run arms in every provider", async () => {
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        for (const sql of [postgresSql, sqliteSql, mysqlSql]) {
            expect(sql).toMatch(/originKind[^\n]*(?:scheduled|manual)[\s\S]{0,180}originOccurredAt[^\n]*IS\s+NULL/i);
            expect(sql).toMatch(/originKind[^\n]*pluginEvent[\s\S]{0,180}originOccurredAt[^\n]*IS\s+NOT\s+NULL/i);
            expect(sql).toMatch(/originKind[^\n]*conversation[\s\S]{0,180}originOccurredAt[^\n]*IS\s+NOT\s+NULL/i);
            expect(sql).not.toMatch(/(?:CREATE|ADD)\s+(?:UNIQUE\s+)?INDEX[^\n]*originOccurredAt/i);
        }
        expect(postgresSql).toMatch(/ADD\s+COLUMN\s+"originOccurredAt"\s+TIMESTAMP\(3\)/i);
        expect(sqliteSql).toMatch(/ADD\s+COLUMN\s+"originOccurredAt"\s+DATETIME/i);
        expect(mysqlSql).toMatch(/ADD\s+COLUMN\s+`originOccurredAt`\s+DATETIME\(3\)\s+NULL/i);
    });

    it("preserves the legacy non-null origin-time projection without deleting durable run history", async () => {
        const [postgresSql, sqliteSql, mysqlSql] = await Promise.all([
            read(`prisma/migrations/${migrationId}/migration.sql`),
            read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            read(`prisma/mysql/migrations/${migrationId}/migration.sql`),
        ]);

        expect(postgresSql).not.toMatch(
            /ALTER\s+TABLE\s+"AutomationRun"\s+ALTER\s+COLUMN\s+"scheduledAt"\s+DROP\s+NOT\s+NULL/i,
        );
        expect(mysqlSql).toMatch(
            /ALTER\s+TABLE\s+`AutomationRun`\s+MODIFY\s+`scheduledAt`\s+DATETIME\(3\)\s+NOT\s+NULL/i,
        );
        expect(sqliteSql).toMatch(/"scheduledAt"\s+DATETIME\s+NOT\s+NULL/i);

        for (const sql of [postgresSql, sqliteSql, mysqlSql]) {
            expect(sql).not.toMatch(/AutomationRun_automationId_fkey[\s\S]{0,180}ON\s+DELETE\s+CASCADE/i);
            expect(sql).toMatch(/AutomationRun_automationId_fkey[\s\S]{0,180}ON\s+DELETE\s+(?:RESTRICT|NO\s+ACTION)/i);
        }
    });

    it("defers SQLite foreign keys while rebuilding Automation under retained Runs", async () => {
        const sqliteSql = await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`);

        expect(sqliteSql).toMatch(
            /PRAGMA\s+defer_foreign_keys\s*=\s*ON\s*;[\s\S]*?PRAGMA\s+foreign_keys\s*=\s*OFF\s*;[\s\S]*?CREATE\s+TABLE\s+"new_Automation"/i,
        );
        expect(sqliteSql).toMatch(
            /ALTER\s+TABLE\s+"new_Automation"\s+RENAME\s+TO\s+"Automation"[\s\S]*?PRAGMA\s+foreign_keys\s*=\s*ON\s*;[\s\S]*?PRAGMA\s+defer_foreign_keys\s*=\s*OFF\s*;/i,
        );
    });

    it("migrates PostgreSQL schedule rows while preserving their origin-time projection", async () => {
        const db = new PGlite();
        try {
            await db.exec(`
                CREATE TYPE "AutomationScheduleKind" AS ENUM ('cron', 'interval');
                CREATE TYPE "AutomationTargetType" AS ENUM ('new_session', 'existing_session');
                CREATE TYPE "AutomationRunState" AS ENUM ('queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired');
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Automation" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "accountId" TEXT NOT NULL,
                    "name" TEXT NOT NULL,
                    "enabled" BOOLEAN NOT NULL DEFAULT true,
                    "scheduleKind" "AutomationScheduleKind" NOT NULL,
                    "scheduleExpr" TEXT,
                    "everyMs" INTEGER,
                    "timezone" TEXT,
                    "targetType" "AutomationTargetType" NOT NULL,
                    "templateCiphertext" TEXT NOT NULL,
                    "templateVersion" INTEGER NOT NULL DEFAULT 0,
                    "nextRunAt" TIMESTAMP(3),
                    "lastRunAt" TIMESTAMP(3),
                    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" TIMESTAMP(3) NOT NULL,
                    CONSTRAINT "Automation_accountId_fkey"
                        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
                );
                CREATE TABLE "AutomationRun" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "automationId" TEXT NOT NULL,
                    "accountId" TEXT NOT NULL,
                    "state" "AutomationRunState" NOT NULL DEFAULT 'queued',
                    "scheduledAt" TIMESTAMP(3) NOT NULL,
                    "dueAt" TIMESTAMP(3) NOT NULL,
                    "attempt" INTEGER NOT NULL DEFAULT 0,
                    "summaryCiphertext" TEXT,
                    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" TIMESTAMP(3) NOT NULL,
                    CONSTRAINT "AutomationRun_automationId_fkey"
                        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
                    CONSTRAINT "AutomationRun_accountId_fkey"
                        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
                );
                INSERT INTO "Account" ("id") VALUES ('account');
                INSERT INTO "Automation" (
                    "id", "accountId", "name", "scheduleKind", "targetType", "templateCiphertext", "updatedAt"
                ) VALUES ('automation', 'account', 'legacy schedule', 'interval', 'new_session', '{}', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "scheduledAt", "dueAt", "summaryCiphertext", "updatedAt"
                ) VALUES ('run', 'automation', 'account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ' exact legacy ', CURRENT_TIMESTAMP);
            `);

            await db.exec(await read(
                "prisma/migrations/20260816230000_add_manual_automation_triggers/migration.sql",
            ));
            await db.exec(`
                INSERT INTO "Automation" (
                    "id", "accountId", "name", "scheduleKind", "targetType", "templateCiphertext", "updatedAt"
                ) VALUES ('manual-automation', 'account', 'preview manual', 'manual', 'new_session', '{}', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "scheduledAt", "dueAt", "idempotencyKey", "updatedAt"
                ) VALUES (
                    'manual-run', 'manual-automation', 'account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                    'preview-build-41', CURRENT_TIMESTAMP
                );
            `);

            await db.exec(await read(`prisma/migrations/${migrationId}/migration.sql`));
            const adoptedManual = await db.query<{
                triggerKind: string;
                scheduleKind: string | null;
                idempotencyKey: string | null;
                originKind: string;
            }>(`
                SELECT
                    a."triggerKind",
                    a."scheduleKind"::text AS "scheduleKind",
                    r."idempotencyKey",
                    r."originKind"
                FROM "Automation" a
                JOIN "AutomationRun" r ON r."automationId" = a."id"
                WHERE a."id" = 'manual-automation'
            `);
            expect(adoptedManual.rows).toEqual([{
                triggerKind: "manual",
                scheduleKind: null,
                idempotencyKey: "preview-build-41",
                originKind: "manual",
            }]);
            const scheduledAt = await db.query<{ scheduledAt: Date | null }>(`
                SELECT "scheduledAt" FROM "AutomationRun" WHERE "id" = 'run'
            `);
            expect(scheduledAt.rows[0]!.scheduledAt).not.toBeNull();
            await expect(
                db.exec(`UPDATE "AutomationRun" SET "scheduledAt" = NULL WHERE "id" = 'run';`),
            ).rejects.toThrow();
            await expect(
                db.exec(`UPDATE "Automation" SET "triggerKind" = 'pluginEvent' WHERE "id" = 'automation';`),
            ).rejects.toThrow();
            await db.exec(`
                UPDATE "Automation"
                SET
                    "scheduleKind" = NULL,
                    "triggerKind" = 'pluginEvent',
                    "triggerEventPluginId" = 'com.example.source',
                    "triggerEventLocalId" = 'issue.opened',
                    "triggerSourceSelectorId" = 'selector-1',
                    "triggerSourceContractVersion" = 1,
                    "triggerObservationTransport" = 'durablePush',
                    "triggerWebhookEndpointId" = 'endpoint-1',
                    "triggerObservationStartsAt" = CURRENT_TIMESTAMP,
                    "triggerDefinitionEnvelope" = '{"t":"plain","v":{}}'
                WHERE "id" = 'automation';
            `);
            await expect(
                db.exec(`UPDATE "Automation" SET "triggerSourceSelectorId" = NULL WHERE "id" = 'automation';`),
            ).rejects.toThrow();
            await expect(
                db.exec(`UPDATE "AutomationRun" SET "originKind" = 'pluginEvent' WHERE "id" = 'run';`),
            ).rejects.toThrow();
            await db.exec(`
                UPDATE "AutomationRun"
                SET
                    "originKind" = 'pluginEvent',
                    "originOccurredAt" = CURRENT_TIMESTAMP,
                    "occurrenceKey" = 'occurrence-1',
                    "originSourceSelectorId" = 'selector-1',
                    "triggerEvidenceEnvelope" = '{"t":"plain","v":{}}'
                WHERE "id" = 'run';
            `);
            await expect(
                db.exec(`
                    UPDATE "AutomationRun"
                    SET "occurrenceEvidenceEqualityTag" = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                    WHERE "id" = 'run';
                `),
            ).rejects.toThrow();
            await expect(
                db.exec(`
                    UPDATE "AutomationRun"
                    SET "triggerEvidenceEnvelope" = '{"t":"encrypted","c":"ciphertext"}'
                    WHERE "id" = 'run';
                `),
            ).rejects.toThrow();
            await db.exec(`
                UPDATE "AutomationRun"
                SET
                    "triggerEvidenceEnvelope" = '{"t":"encrypted","c":"ciphertext"}',
                    "occurrenceEvidenceEqualityTag" = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                WHERE "id" = 'run';
            `);
            const migrated = await db.query<{ resultEnvelope: string | null; revision: number }>(`
                SELECT "resultEnvelope", "revision" FROM "AutomationRun" WHERE "id" = 'run'
            `);
            expect(JSON.parse(migrated.rows[0]!.resultEnvelope!)).toEqual({
                t: "legacySummaryCiphertext",
                c: " exact legacy ",
            });
            expect(migrated.rows[0]!.revision).toBe(0);
            await expect(db.exec(`DELETE FROM "Automation" WHERE "id" = 'automation';`)).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    it("rebuilds SQLite owners without losing retained Run history", async () => {
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(`
                PRAGMA foreign_keys=ON;
                CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY);
                CREATE TABLE "Automation" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "accountId" TEXT NOT NULL,
                    "name" TEXT NOT NULL,
                    "description" TEXT,
                    "enabled" BOOLEAN NOT NULL DEFAULT true,
                    "scheduleKind" TEXT NOT NULL,
                    "scheduleExpr" TEXT,
                    "everyMs" INTEGER,
                    "timezone" TEXT,
                    "targetType" TEXT NOT NULL,
                    "templateCiphertext" TEXT NOT NULL,
                    "templateVersion" INTEGER NOT NULL DEFAULT 0,
                    "nextRunAt" DATETIME,
                    "lastRunAt" DATETIME,
                    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" DATETIME NOT NULL,
                    CONSTRAINT "Automation_accountId_fkey"
                        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
                );
                CREATE TABLE "AutomationAssignment" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "automationId" TEXT NOT NULL,
                    "machineId" TEXT NOT NULL,
                    "enabled" BOOLEAN NOT NULL DEFAULT true,
                    "priority" INTEGER NOT NULL DEFAULT 0,
                    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" DATETIME NOT NULL,
                    CONSTRAINT "AutomationAssignment_automationId_fkey"
                        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
                    CONSTRAINT "AutomationAssignment_machineId_fkey"
                        FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE
                );
                CREATE TABLE "AutomationRun" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "automationId" TEXT NOT NULL,
                    "accountId" TEXT NOT NULL,
                    "state" TEXT NOT NULL DEFAULT 'queued',
                    "scheduledAt" DATETIME NOT NULL,
                    "dueAt" DATETIME NOT NULL,
                    "claimedAt" DATETIME,
                    "startedAt" DATETIME,
                    "finishedAt" DATETIME,
                    "claimedByMachineId" TEXT,
                    "leaseExpiresAt" DATETIME,
                    "attempt" INTEGER NOT NULL DEFAULT 0,
                    "summaryCiphertext" TEXT,
                    "errorCode" TEXT,
                    "errorMessage" TEXT,
                    "producedSessionId" TEXT,
                    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "updatedAt" DATETIME NOT NULL,
                    CONSTRAINT "AutomationRun_automationId_fkey"
                        FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
                    CONSTRAINT "AutomationRun_accountId_fkey"
                        FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
                    CONSTRAINT "AutomationRun_claimedByMachineId_fkey"
                        FOREIGN KEY ("claimedByMachineId") REFERENCES "Machine"("id") ON DELETE SET NULL ON UPDATE CASCADE,
                    CONSTRAINT "AutomationRun_producedSessionId_fkey"
                        FOREIGN KEY ("producedSessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE
                );
                CREATE TABLE "AutomationRunEvent" (
                    "id" TEXT NOT NULL PRIMARY KEY,
                    "runId" TEXT NOT NULL,
                    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    "type" TEXT NOT NULL,
                    "payload" TEXT,
                    CONSTRAINT "AutomationRunEvent_runId_fkey"
                        FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
                );
                INSERT INTO "Account" ("id") VALUES ('account');
                INSERT INTO "Machine" ("id") VALUES ('machine');
                INSERT INTO "Automation" (
                    "id", "accountId", "name", "scheduleKind", "targetType", "templateCiphertext", "updatedAt"
                ) VALUES ('automation', 'account', 'legacy schedule', 'interval', 'new_session', '{}', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationAssignment" (
                    "id", "automationId", "machineId", "updatedAt"
                ) VALUES ('assignment', 'automation', 'machine', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "scheduledAt", "dueAt", "summaryCiphertext", "updatedAt"
                ) VALUES ('run', 'automation', 'account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ' exact legacy ', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRunEvent" ("id", "runId", "type") VALUES ('event', 'run', 'queued');
            `);

            db.exec(await read(
                "prisma/sqlite/migrations/20260816230000_add_manual_automation_triggers/migration.sql",
            ));
            db.exec(`
                INSERT INTO "Automation" (
                    "id", "accountId", "name", "scheduleKind", "targetType", "templateCiphertext", "updatedAt"
                ) VALUES ('manual-automation', 'account', 'preview manual', 'manual', 'new_session', '{}', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "scheduledAt", "dueAt", "idempotencyKey", "updatedAt"
                ) VALUES (
                    'manual-run', 'manual-automation', 'account', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
                    'preview-build-41', CURRENT_TIMESTAMP
                );
            `);

            await applySqliteMigrationThroughCanonicalExecutor(
                db,
                await read(`prisma/sqlite/migrations/${migrationId}/migration.sql`),
            );
            expect(db.prepare(`
                SELECT a."triggerKind", a."scheduleKind", r."idempotencyKey", r."originKind"
                FROM "Automation" a
                JOIN "AutomationRun" r ON r."automationId" = a."id"
                WHERE a."id" = 'manual-automation'
            `).all()).toEqual([{
                triggerKind: "manual",
                scheduleKind: null,
                idempotencyKey: "preview-build-41",
                originKind: "manual",
            }]);
            expect(
                () => db.exec(`UPDATE "AutomationRun" SET "scheduledAt" = NULL WHERE "id" = 'run';`),
            ).toThrow();
            expect(
                () => db.exec(`UPDATE "Automation" SET "triggerKind" = 'pluginEvent' WHERE "id" = 'automation';`),
            ).toThrow();
            db.exec(`
                UPDATE "Automation"
                SET
                    "scheduleKind" = NULL,
                    "triggerKind" = 'pluginEvent',
                    "triggerEventPluginId" = 'com.example.source',
                    "triggerEventLocalId" = 'issue.opened',
                    "triggerSourceSelectorId" = 'selector-1',
                    "triggerSourceContractVersion" = 1,
                    "triggerObservationTransport" = 'durablePush',
                    "triggerWebhookEndpointId" = 'endpoint-1',
                    "triggerObservationStartsAt" = CURRENT_TIMESTAMP,
                    "triggerDefinitionEnvelope" = '{"t":"plain","v":{}}'
                WHERE "id" = 'automation';
            `);
            expect(
                () => db.exec(`UPDATE "Automation" SET "triggerSourceSelectorId" = NULL WHERE "id" = 'automation';`),
            ).toThrow();
            expect(
                () => db.exec(`UPDATE "AutomationRun" SET "originKind" = 'pluginEvent' WHERE "id" = 'run';`),
            ).toThrow();
            db.exec(`
                UPDATE "AutomationRun"
                SET
                    "originKind" = 'pluginEvent',
                    "originOccurredAt" = CURRENT_TIMESTAMP,
                    "occurrenceKey" = 'occurrence-1',
                    "originSourceSelectorId" = 'selector-1',
                    "triggerEvidenceEnvelope" = '{"t":"plain","v":{}}'
                WHERE "id" = 'run';
            `);
            expect(
                () => db.exec(`
                    UPDATE "AutomationRun"
                    SET "occurrenceEvidenceEqualityTag" = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                    WHERE "id" = 'run';
                `),
            ).toThrow();
            expect(
                () => db.exec(`
                    UPDATE "AutomationRun"
                    SET "triggerEvidenceEnvelope" = '{"t":"encrypted","c":"ciphertext"}'
                    WHERE "id" = 'run';
                `),
            ).toThrow();
            db.exec(`
                UPDATE "AutomationRun"
                SET
                    "triggerEvidenceEnvelope" = '{"t":"encrypted","c":"ciphertext"}',
                    "occurrenceEvidenceEqualityTag" = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                WHERE "id" = 'run';
            `);
            expect(db.prepare(`SELECT "runId" FROM "AutomationRunEvent" WHERE "id" = 'event'`).all()).toEqual([
                { runId: "run" },
            ]);
            const [legacyRun] = db.prepare(`
                SELECT "summaryCiphertext", "resultEnvelope"
                FROM "AutomationRun"
                WHERE "id" = 'run'
            `).all() as Array<{ summaryCiphertext: string | null; resultEnvelope: string | null }>;
            expect(legacyRun?.summaryCiphertext).toBe(" exact legacy ");
            expect(JSON.parse(legacyRun?.resultEnvelope ?? "")).toEqual({
                t: "legacySummaryCiphertext",
                c: " exact legacy ",
            });
            expect(db.prepare(`
                SELECT "automationId", "machineId"
                FROM "AutomationAssignment"
                WHERE "id" = 'assignment'
            `).all()).toEqual([{
                automationId: "automation",
                machineId: "machine",
            }]);
            expect(db.prepare(`SELECT "revision" FROM "AutomationRun" WHERE "id" = 'run'`).all()).toEqual([
                { revision: 0 },
            ]);
            expect(() => db.exec(`DELETE FROM "Automation" WHERE "id" = 'automation';`)).toThrow();
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            db.close();
        }
    });
});
