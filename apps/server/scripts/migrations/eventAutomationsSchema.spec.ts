import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

import {
    applySqliteMigrations,
    type SqliteMigrationExecutor,
} from "../../sources/flavors/light/sqliteMigrations";
import { AUTOMATION_RUN_TERMINAL_STATES } from "../../sources/app/automations/automationTypes";

const serverRoot = join(import.meta.dirname, "..", "..");
const migrationId = "20260816231000_add_event_automations_v1";
// Provenance-pinned compatibility basis: server-v0.2.1 at
// 4913c1e533c872a0712ba1c25b3104fd470aacc2. Its
// enqueueImmediateRunTx wrote scheduledAt === dueAt without an idempotency key;
// enqueueNextScheduledRunIfMissingTx wrote scheduledAt as enqueue time and a
// strictly later dueAt as the actual scheduled occurrence instant.

async function read(relativePath: string): Promise<string> {
    return await readFile(join(serverRoot, relativePath), "utf8");
}

function model(schema: string, name: string): string {
    const match = schema.match(new RegExp(`model\\s+${name}\\s+\\{([\\s\\S]*?)\\n\\}`, "m"));
    if (!match?.[1]) throw new Error(`model ${name} not found`);
    return match[1];
}

function normalizeSql(sql: string): string {
    return sql.replace(/[`\"]/g, "").replace(/\s+/g, " ").trim();
}

function namedCheck(sql: string, name: string): string {
    // One consolidated migration owns each dialect's final shape, so every
    // named CHECK must be declared exactly once in it; a second declaration
    // would reintroduce a forward rebuild transition.
    const matches = [
        ...sql.matchAll(new RegExp(
            `CONSTRAINT\\s+[\`\"]?${name}[\`\"]?\\s+CHECK\\s*\\(`,
            "gi",
        )),
    ];
    const marker = matches[0];
    if (matches.length !== 1 || marker?.index === undefined) {
        throw new Error(`constraint ${name} must be declared exactly once (found ${matches.length})`);
    }
    const openingParen = sql.indexOf("(", marker.index + marker[0].length - 1);
    let depth = 0;
    let quote: "'" | "\"" | "`" | null = null;
    for (let index = openingParen; index < sql.length; index += 1) {
        const character = sql[index]!;
        if (quote !== null) {
            if (character === quote && sql[index - 1] !== "\\") quote = null;
            continue;
        }
        if (character === "'" || character === "\"" || character === "`") {
            quote = character;
        } else if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth -= 1;
            if (depth === 0) return normalizeSql(sql.slice(openingParen, index + 1));
        }
    }
    throw new Error(`constraint ${name} is unclosed`);
}

function createdTable(sql: string, name: string): string {
    const marker = new RegExp(
        `CREATE\\s+TABLE\\s+[\`"]?${name}[\`"]?\\s*\\(`,
        "i",
    ).exec(sql);
    if (marker?.index === undefined) throw new Error(`table ${name} not found`);
    const openingParen = sql.indexOf("(", marker.index + marker[0].length - 1);
    let depth = 0;
    let quote: "'" | "\"" | "`" | null = null;
    for (let index = openingParen; index < sql.length; index += 1) {
        const character = sql[index]!;
        if (quote !== null) {
            if (character === quote && sql[index - 1] !== "\\") quote = null;
            continue;
        }
        if (character === "'" || character === "\"" || character === "`") {
            quote = character;
        } else if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth -= 1;
            if (depth === 0) return normalizeSql(sql.slice(marker.index, index + 1));
        }
    }
    throw new Error(`table ${name} is unclosed`);
}

function discriminantArm(check: string, field: string, value: string): string {
    const marker = `${field} = '${value}'`;
    const start = check.indexOf(marker);
    if (start < 0) throw new Error(`${marker} arm not found`);
    const next = check.indexOf(`${field} = '`, start + marker.length);
    return check.slice(start, next < 0 ? undefined : next);
}

function topLevelArmContaining(check: string, markers: readonly string[]): string {
    const arms: string[] = [];
    let depth = 0;
    let start = 0;
    let quote: "'" | null = null;
    for (let index = 0; index < check.length; index += 1) {
        const character = check[index]!;
        if (quote !== null) {
            if (character === quote && check[index - 1] !== "\\") quote = null;
            continue;
        }
        if (character === "'") {
            quote = character;
        } else if (character === "(") {
            depth += 1;
        } else if (character === ")") {
            depth -= 1;
        } else if (depth === 1 && check.startsWith(" OR ", index)) {
            arms.push(check.slice(start, index));
            start = index + 4;
            index += 3;
        }
    }
    arms.push(check.slice(start));
    const arm = arms.find((candidate) => markers.every((marker) => candidate.includes(marker)));
    if (arm === undefined) throw new Error(`${markers.join(" + ")} arm not found`);
    return arm;
}

const replyHandoffDueIndexName = "AutomationRun_replyHandoffState_replyHandoffDueAt_idx";

function createsReplyHandoffDueIndex(sql: string): boolean {
    const columns = `\\(\\s*[\`"]?replyHandoffState[\`"]?\\s*,\\s*[\`"]?replyHandoffDueAt[\`"]?\\s*\\)`;
    return new RegExp(
        `CREATE\\s+INDEX\\s+[\`"]?${replyHandoffDueIndexName}[\`"]?\\s+ON\\s+[\`"]?AutomationRun[\`"]?\\s*${columns}`,
        "i",
    ).test(sql) || new RegExp(
        `ADD\\s+INDEX\\s+[\`"]?${replyHandoffDueIndexName}[\`"]?\\s*${columns}`,
        "i",
    ).test(sql);
}

function migrationIdOf(migrationPath: string): string {
    return migrationPath.split("/").at(-2)!;
}

async function applySqliteMigrationThroughCanonicalExecutor(
    db: DatabaseSync,
    sql: string,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "automation-trigger-sets-"));
    const migrationDir = join(root, migrationId);
    try {
        await mkdir(migrationDir, { recursive: true });
        await writeFile(join(migrationDir, "migration.sql"), sql, "utf8");
        const executor: SqliteMigrationExecutor = {
            exec: (statement) => db.exec(statement),
            queryRows: (statement, params = []) => db.prepare(statement).all(...params),
            run: (statement, params = []) => {
                db.prepare(statement).run(...params);
            },
            queryTableNames: () => new Set(
                db.prepare("SELECT name FROM sqlite_master WHERE type='table'")
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

const schemaPaths = [
    "prisma/schema.prisma",
    "prisma/sqlite/schema.prisma",
    "prisma/mysql/schema.prisma",
] as const;

const migrationPaths = [
    "prisma/migrations/20260816231000_add_event_automations_v1/migration.sql",
    "prisma/sqlite/migrations/20260816231000_add_event_automations_v1/migration.sql",
    "prisma/mysql/migrations/20260816231000_add_event_automations_v1/migration.sql",
] as const;

describe("Automation trigger-set persistence contract", () => {
    it.each(schemaPaths)("uses one trigger child and immutable Run-cause owner in %s", async (schemaPath) => {
        const schema = await read(schemaPath);
        const automation = model(schema, "Automation");
        const trigger = model(schema, "AutomationTrigger");
        const run = model(schema, "AutomationRun");
        const claimReceipt = model(schema, "AutomationWorkerClaimReceipt");
        const assignment = model(schema, "AutomationRunAssignment");
        const sourceStatus = model(schema, "AutomationEventSourceStatus");
        const catalogStatus = model(schema, "AutomationEventSourceCatalogStatus");

        expect(schema).toMatch(
            /enum AutomationTriggerKind \{\s+schedule\s+pluginEvent\s+sessionLifecycle\s+\}/m,
        );
        expect(schema).toMatch(
            /enum AutomationRunCauseKind \{\s+trigger\s+manual\s+conversation\s+\}/m,
        );
        expect(automation).toMatch(/^\s*triggers\s+AutomationTrigger\[\]\s*$/m);
        for (const staleField of [
            "triggerKind", "scheduleKind", "nextRunAt", "triggerEventPluginId",
            "triggerSourceSelectorId", "triggerDefinitionEnvelope",
        ]) {
            expect(automation).not.toMatch(new RegExp(`^\\s*${staleField}\\s+`, "m"));
        }
        for (const field of [
            "automationId", "kind", "enabled", "revision", "deletedAt", "scheduleKind",
            "nextRunAt", "eventPluginId", "eventLocalId", "sourceSelectorId",
            "observationTransport", "definitionEnvelope", "sessionLifecycleEvent",
            "sourceSessionId", "sourceTurnId",
        ]) {
            expect(trigger).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
        }
        for (const field of [
            "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision",
            "causeOccurredAt", "occurrenceKey", "legacyManualIdempotencyKey",
        ]) {
            expect(run).toMatch(new RegExp(`^\\s*${field}\\s+`, "m"));
        }
        expect(schema).not.toContain("filterEnvelope");
        expect(schema).not.toContain("contentRemovedAt");
        expect(claimReceipt).toMatch(/^\s*runId\s+String\?/m);
        expect(claimReceipt).toMatch(/^\s*claimedAttempt\s+Int\?/m);
        // The signed claim receipt carries the exact committed post-claim
        // Account witness: present for every claimed outcome, absent for
        // every empty outcome.
        expect(claimReceipt).toMatch(
            /^\s*accountCurrentnessWitnessJson\s+String\?(?:\s+@db\.LongText)?\s*$/m,
        );
        expect(claimReceipt).toMatch(
            /^\s*claimResultJson\s+String(?:\s+@db\.LongText)?\s*$/m,
        );
        expect(claimReceipt).toContain("@@index([expiresAt])");
        // Runs own immutable cause identity. A mutable Trigger relation would
        // either prevent trigger deletion or SET NULL a field the trigger
        // cause arm requires. Schedule scans use the indexed scalar triggerId
        // through the incumbent Run owner instead.
        expect(trigger).not.toMatch(/^\s*runs\s+AutomationRun\[\]\s*$/m);
        expect(run).not.toMatch(/^\s*trigger\s+AutomationTrigger\??\s+@relation\(/m);
        expect(run).toContain("@@index([triggerId, state])");
        // The reply-handoff worker discovers unresolved delivery attention
        // through this indexed pair; every dialect schema declares it.
        expect(run).toContain("@@index([replyHandoffState, replyHandoffDueAt])");
        expect(run).not.toMatch(/^\s*origin(?:Kind|OccurredAt|SourceSelectorId)\s+/m);
        expect(run).not.toMatch(/^\s*claimRequestNonceDigest\s+/m);
        expect(run).toContain("@@unique([triggerId, occurrenceKey])");
        expect(run).toContain("@@unique([automationId, causeKind, occurrenceKey]");
        expect(run).toContain(
            "@@unique([automationId, legacyManualIdempotencyKey], map: \"AutomationRun_automationId_idempotencyKey_key\")",
        );
        expect(assignment).toMatch(/^\s*runId\s+String\s*$/m);
        expect(assignment).toMatch(/^\s*machineId\s+String\s*$/m);
        expect(assignment).toMatch(/^\s*priority\s+Int\s+@default\(0\)\s*$/m);
        expect(assignment).toContain("@@id([runId, machineId])");
        expect(assignment).not.toMatch(/^\s*(?:automationId|enabled|updatedAt)\s+/m);
        expect(sourceStatus).toMatch(/^\s*triggerId\s+String\s+@id\s*$/m);
        expect(sourceStatus).toMatch(/^\s*trigger\s+AutomationTrigger\s+@relation\(/m);
        expect(sourceStatus).toMatch(/^\s*triggerRevision\s+Int\s*$/m);
        expect(sourceStatus).toMatch(/^\s*reporterImmutableGenerationId\s+String(?:\s+@db\.VarChar\(256\))?\s*$/m);
        expect(sourceStatus).not.toMatch(/^\s*automationId\s+/m);
        expect(catalogStatus).toMatch(/^\s*reporterImmutableGenerationId\s+String(?:\s+@db\.VarChar\(256\))?\s*$/m);
    });

    it.each(migrationPaths)("encodes the same physical trigger/cause arms in %s", async (migrationPath) => {
        const sql = await read(migrationPath);
        const normalized = normalizeSql(sql);
        const triggerCheck = namedCheck(sql, "AutomationTrigger_arm_check");
        const executionInputCheck = namedCheck(sql, "AutomationRun_execution_input_arm_check");
        const causeCheck = namedCheck(sql, "AutomationRun_cause_arm_check");
        const sourceStatusTable = createdTable(sql, "AutomationEventSourceStatus");
        const catalogStatusTable = createdTable(sql, "AutomationEventSourceCatalogStatus");
        const livePluginEvent = topLevelArmContaining(
            triggerCheck,
            ["deletedAt IS NULL", "kind = 'pluginEvent'"],
        );
        const deletedPluginEvent = topLevelArmContaining(
            triggerCheck,
            ["deletedAt IS NOT NULL", "kind = 'pluginEvent'"],
        );
        const triggerCause = discriminantArm(causeCheck, "causeKind", "trigger");
        const manualCause = discriminantArm(causeCheck, "causeKind", "manual");
        const conversationCause = discriminantArm(causeCheck, "causeKind", "conversation");

        expect(normalized).toContain("CREATE TABLE AutomationTrigger");
        expect(normalized).toContain("CREATE TABLE AutomationRunAssignment");
        expect(normalized).toContain("CREATE TABLE AutomationWorkerClaimReceipt");
        expect(normalized).toContain("AutomationWorkerClaimReceipt_outcome_check");
        const outcomeCheck = namedCheck(sql, "AutomationWorkerClaimReceipt_outcome_check");
        // A claimed outcome is durably bound to its committed post-claim
        // witness; an empty outcome never carries one.
        expect(outcomeCheck).toContain("accountCurrentnessWitnessJson IS NULL");
        expect(outcomeCheck).toContain("accountCurrentnessWitnessJson IS NOT NULL");
        // Historical Runs must retain their immutable trigger cause after the
        // mutable definition is soft-deleted. The scalar index supports the
        // schedule worker without coupling Run history to Trigger lifecycle.
        expect(normalized).not.toContain("AutomationRun_triggerId_fkey");
        expect(normalized).toContain("AutomationRun_triggerId_state_idx");
        expect(normalized).not.toContain("claimRequestNonceDigest");
        expect(normalized).toContain("CREATE TABLE AutomationEventSourceStatus");
        expect(normalized).toContain("CREATE TABLE AutomationEventSourceCatalogStatus");
        expect(normalized).not.toContain("ADD COLUMN triggerKind");
        expect(normalized).not.toContain("ADD COLUMN originKind");
        expect(normalized).not.toContain("filterEnvelope");
        expect(normalized).not.toContain("contentRemovedAt");
        expect(triggerCheck).toMatch(/kind = 'schedule'.*scheduleKind.*eventPluginId IS NULL/s);
        expect(livePluginEvent).toContain("deletedAt IS NULL");
        for (const requiredField of [
            "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion",
            "observationTransport", "definitionEnvelope",
        ]) {
            expect(livePluginEvent).toContain(`${requiredField} IS NOT NULL`);
        }
        expect(livePluginEvent).toContain("sessionLifecycleEvent IS NULL");
        expect(livePluginEvent).toMatch(
            /observationTransport = 'socket'.*webhookEndpointId IS NULL.*observationStartsAt IS NULL.*watcherMachineId IS NOT NULL.*watcherMachineInstallationId IS NOT NULL.*watcherPluginId IS NOT NULL.*watcherMaterializationId IS NOT NULL/s,
        );
        expect(triggerCheck).toMatch(/kind = 'sessionLifecycle'.*sessionLifecycleEvent = 'parentTurnCompleted'.*sourceTurnId IS NOT NULL/s);
        expect(deletedPluginEvent).toMatch(/enabled = (?:false|0)/);
        for (const retainedIdentityField of [
            "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion",
        ]) {
            expect(deletedPluginEvent).toContain(`${retainedIdentityField} IS NOT NULL`);
        }
        for (const scrubbedField of [
            "definitionEnvelope", "observationTransport", "webhookEndpointId", "observationStartsAt",
            "watcherMachineId", "watcherMachineInstallationId", "watcherPluginId",
            "watcherMaterializationId", "scheduleKind", "scheduleExpr", "everyMs", "timezone",
            "nextRunAt", "sessionLifecycleEvent", "sourceSessionId", "sourceTurnId",
        ]) {
            expect(deletedPluginEvent).toContain(`${scrubbedField} IS NULL`);
        }
        expect(triggerCheck).toContain("scheduleKind IS NOT NULL");
        expect(triggerCheck).toContain("sessionLifecycleEvent IS NOT NULL");
        expect(executionInputCheck).toMatch(
            /state NOT IN \('queued', 'claimed', 'running'\).*executionInputEnvelope IS NOT NULL/s,
        );
        expect(triggerCause).toContain("idempotencyKey IS NULL");
        expect(triggerCause).toContain("causeTriggerKind IS NOT NULL");
        expect(triggerCause).toContain("triggerId IS NOT NULL");
        expect(triggerCause).toContain("occurrenceKey IS NOT NULL");
        expect(manualCause).toContain("triggerId IS NULL");
        expect(manualCause).toContain("occurrenceKey IS NULL");
        expect(conversationCause).toContain("triggerId IS NULL");
        expect(conversationCause).toContain("occurrenceKey IS NOT NULL");
        expect(conversationCause).toContain("idempotencyKey IS NULL");
        expect(normalized).toMatch(
            /AutomationRun_triggerId_occurrenceKey_key.{0,80}triggerId, occurrenceKey/,
        );
        expect(normalized).not.toContain("AutomationRun_automationId_occurrenceKey_key");
        expect(normalized).toMatch(
            /AutomationRun_automationId_causeKind_occurrenceKey_key.{0,100}automationId, causeKind, occurrenceKey/,
        );
        expect(normalized).toMatch(
            /AutomationEventSourceStatus.*triggerId.*PRIMARY KEY.*triggerId.*REFERENCES AutomationTrigger.*id/s,
        );
        expect(sourceStatusTable).toMatch(
            /reporterImmutableGenerationId (?:VARCHAR\(256\)|TEXT) NOT NULL/,
        );
        expect(catalogStatusTable).toMatch(
            /reporterImmutableGenerationId (?:VARCHAR\(256\)|TEXT) NOT NULL/,
        );
        expect(normalized).toMatch(
            /AutomationRunAssignment.*PRIMARY KEY.*runId.*machineId.*REFERENCES AutomationRun.*id/s,
        );
        const namedPreflightIndex = normalized.indexOf("AutomationRun_open_frozen_input_preflight");
        const preflightIndex = namedPreflightIndex >= 0
            ? namedPreflightIndex
            : normalized.search(
                /DO \$\$\s+BEGIN\s+IF EXISTS \(\s+SELECT 1 FROM (?:"AutomationRun"|AutomationRun)/,
            );
        const firstCanonicalMutationIndex = [
            normalized.indexOf("CREATE TYPE AutomationTriggerKind"),
            normalized.indexOf("PRAGMA defer_foreign_keys"),
            normalized.indexOf("ALTER TABLE Automation ADD COLUMN"),
        ].filter((index) => index >= 0).sort((left, right) => left - right)[0];
        expect(preflightIndex).toBeGreaterThanOrEqual(0);
        expect(firstCanonicalMutationIndex).toBeGreaterThan(preflightIndex);
        expect(normalized).toMatch(/state IN \('queued', 'claimed', 'running'\)/);
        expect(normalized).not.toMatch(/executionInputEnvelope\s*=|SET\s+executionInputEnvelope/i);
        expect(normalized).not.toMatch(
            /INSERT INTO (?:new_)?AutomationRun \([^)]*executionInputEnvelope/i,
        );
        expect(normalized.match(/THEN run\.dueAt ELSE/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    });

    it.each(migrationPaths)("retains reply identity without a second Run-compaction state in %s", async (migrationPath) => {
        const replyCheck = namedCheck(await read(migrationPath), "AutomationRun_reply_handoff_arm_check");
        expect(replyCheck).toMatch(
            /causeKind = 'conversation'.*replyContextEnvelope IS NOT NULL.*replyHandoffActionPluginId IS NOT NULL.*replyHandoffId IS NOT NULL.*replyHandoffState <> 'none'/s,
        );
        expect(replyCheck).toMatch(
            /causeKind IN \('trigger', 'manual', 'conversation'\).*replyContextEnvelope IS NULL.*replyHandoffId IS NULL.*replyHandoffState = 'none'/s,
        );
        expect(replyCheck).not.toContain("contentRemovedAt");
    });

    it("creates the reply-handoff due index exactly once per provider through the single consolidated owner", async () => {
        const ledgerDirectories = [
            "prisma/migrations",
            "prisma/sqlite/migrations",
            "prisma/mysql/migrations",
        ] as const;
        for (const [index, directory] of ledgerDirectories.entries()) {
            const ledgerRoot = join(serverRoot, directory);
            const creating: string[] = [];
            for (const entry of await readdir(ledgerRoot, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const sql = await readFile(join(ledgerRoot, entry.name, "migration.sql"), "utf8")
                    .catch(() => null);
                if (sql !== null && createsReplyHandoffDueIndex(sql)) creating.push(entry.name);
            }
            expect(creating, directory).toEqual([migrationIdOf(migrationPaths[index]!)]);
        }
    });

    it("executes the PostgreSQL reply-handoff due index statement against the canonical columns", async () => {
        const statement = (await read(migrationPaths[0])).match(new RegExp(
            `CREATE\\s+INDEX\\s+"${replyHandoffDueIndexName}"[\\s\\S]*?;`,
            "i",
        ))?.[0];
        expect(statement).toBeDefined();
        const db = new PGlite();
        try {
            await db.exec(`CREATE TABLE "AutomationRun" (
                "id" TEXT NOT NULL PRIMARY KEY,
                "replyHandoffState" TEXT NOT NULL DEFAULT 'none',
                "replyHandoffDueAt" TIMESTAMP(3)
            );`);
            await db.exec(statement!);
            const indexes = await db.query<{ indexname: string; indexdef: string }>(
                "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'AutomationRun'",
            );
            const created = indexes.rows.find((row) => row.indexname === replyHandoffDueIndexName);
            expect(created).toBeDefined();
            expect(created?.indexdef).toContain("replyHandoffState");
            expect(created?.indexdef).toContain("replyHandoffDueAt");
        } finally {
            await db.close();
        }
    });

    it("keeps MySQL identities portable without weakening canonical equality", async () => {
        const sql = await read(migrationPaths[2]);
        const namedIdentifiers = [...sql.matchAll(/\b(?:INDEX|CONSTRAINT)\s+`([^`]+)`/g)]
            .map((match) => match[1]!);
        expect(namedIdentifiers.length).toBeGreaterThan(0);
        expect(namedIdentifiers.filter((identifier) => identifier.length > 64)).toEqual([]);
        expect(sql).toMatch(
            /`occurrenceKey`\s+CHAR\(43\)\s+CHARACTER SET ascii\s+COLLATE ascii_bin/i,
        );
        expect(sql).toMatch(
            /`reporterMaterializationId`\s+VARCHAR\(256\)\s+CHARACTER SET ascii\s+COLLATE ascii_bin/i,
        );
        expect(sql).toMatch(
            /INSERT INTO `AutomationTrigger`[\s\S]*SELECT `id`, `id`, 'schedule'[\s\S]*FROM `Automation`/,
        );
        expect(sql).toMatch(
            /CASE WHEN run\.`idempotencyKey` IS NOT NULL OR run\.`dueAt` = run\.`scheduledAt` THEN 'manual' ELSE 'trigger' END/,
        );
        expect(sql).toMatch(
            /CASE WHEN run\.`idempotencyKey` IS NULL AND run\.`dueAt` <> run\.`scheduledAt` THEN run\.`automationId` ELSE NULL END/,
        );
        expect(sql).toMatch(
            /run\.`causeOccurredAt` = CASE WHEN[\s\S]*?THEN run\.`dueAt` ELSE run\.`createdAt` END/,
        );
        expect(sql).toMatch(
            /run\.`causeScheduledFor` = CASE WHEN[\s\S]*?THEN run\.`dueAt` ELSE NULL END/,
        );
        expect(sql).toMatch(/`AutomationTrigger`[\s\S]*?`id` VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/);
        expect(sql).toMatch(/`AutomationTrigger`[\s\S]*?`eventPluginId` VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL/);
        expect(sql).toMatch(/`AutomationTrigger`[\s\S]*?`eventLocalId` VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL/);
        expect(sql).toMatch(/`AutomationEventSourceStatus`[\s\S]*?`triggerId` VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/);
        // The catalog-status primary key folds distinct author plugin IDs under
        // the table default collation; the member must be exact.
        expect(sql).toMatch(/`AutomationEventSourceCatalogStatus`[\s\S]*?`eventPluginId` VARCHAR\(191\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/);
        expect(sql).toMatch(
            /CASE WHEN run\.`summaryCiphertext` IS NOT NULL[\s\S]*JSON_OBJECT\([\s\S]*'legacySummaryCiphertext'/,
        );
        expect(sql).toContain("INDEX `AutomationRun_triggerId_state_idx`(`triggerId`, `state`)");
    });
});

async function createPostgresPredecessor(): Promise<PGlite> {
    const db = new PGlite();
    await db.exec(`
        CREATE TYPE "AutomationScheduleKind" AS ENUM ('cron', 'interval');
        CREATE TYPE "AutomationTargetType" AS ENUM ('new_session', 'existing_session');
        CREATE TYPE "AutomationRunState" AS ENUM (
            'queued', 'claimed', 'running', 'succeeded', 'failed', 'cancelled', 'expired'
        );
        CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "Automation" (
            "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "name" TEXT NOT NULL,
            "description" TEXT, "enabled" BOOLEAN NOT NULL DEFAULT true,
            "scheduleKind" "AutomationScheduleKind" NOT NULL, "scheduleExpr" TEXT, "everyMs" INTEGER,
            "timezone" TEXT, "targetType" "AutomationTargetType" NOT NULL, "templateCiphertext" TEXT NOT NULL,
            "templateVersion" INTEGER NOT NULL DEFAULT 0, "nextRunAt" TIMESTAMP(3), "lastRunAt" TIMESTAMP(3),
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE TABLE "AutomationAssignment" (
            "id" TEXT NOT NULL PRIMARY KEY, "automationId" TEXT NOT NULL, "machineId" TEXT NOT NULL,
            "enabled" BOOLEAN NOT NULL DEFAULT true, "priority" INTEGER NOT NULL DEFAULT 0,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "AutomationAssignment_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "AutomationAssignment_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE TABLE "AutomationRun" (
            "id" TEXT NOT NULL PRIMARY KEY, "automationId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
            "state" "AutomationRunState" NOT NULL DEFAULT 'queued', "scheduledAt" TIMESTAMP(3) NOT NULL,
            "dueAt" TIMESTAMP(3) NOT NULL, "claimedAt" TIMESTAMP(3), "startedAt" TIMESTAMP(3),
            "finishedAt" TIMESTAMP(3), "claimedByMachineId" TEXT, "leaseExpiresAt" TIMESTAMP(3),
            "attempt" INTEGER NOT NULL DEFAULT 0, "summaryCiphertext" TEXT, "errorCode" TEXT,
            "errorMessage" TEXT, "producedSessionId" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
            CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "AutomationRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE TABLE "AutomationRunEvent" (
            "id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL,
            "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "type" TEXT NOT NULL, "payload" JSONB,
            CONSTRAINT "AutomationRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "AutomationAssignment_automationId_machineId_key" ON "AutomationAssignment"("automationId", "machineId");
        CREATE INDEX "AutomationAssignment_machineId_enabled_idx" ON "AutomationAssignment"("machineId", "enabled");
        CREATE INDEX "AutomationAssignment_automationId_enabled_idx" ON "AutomationAssignment"("automationId", "enabled");
        CREATE INDEX "AutomationRun_accountId_state_dueAt_idx" ON "AutomationRun"("accountId", "state", "dueAt");
        CREATE INDEX "AutomationRun_automationId_dueAt_idx" ON "AutomationRun"("automationId", "dueAt");
        CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx" ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");
        CREATE INDEX "AutomationRunEvent_runId_ts_idx" ON "AutomationRunEvent"("runId", "ts");
        CREATE INDEX "AutomationRunEvent_ts_idx" ON "AutomationRunEvent"("ts");
    `);
    await db.exec(await read("prisma/migrations/20260816230000_add_manual_automation_triggers/migration.sql"));
    await db.exec(`
        INSERT INTO "Account" ("id") VALUES ('account');
        INSERT INTO "Machine" ("id") VALUES ('machine-enabled'), ('machine-disabled');
        INSERT INTO "Automation" (
            "id", "accountId", "name", "enabled", "scheduleKind", "everyMs", "timezone",
            "targetType", "templateCiphertext", "nextRunAt", "updatedAt"
        ) VALUES ('automation', 'account', 'retained schedule', false, 'interval', 60000, 'UTC',
            'new_session', '{}', '2026-08-27T10:00:00.000Z', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationAssignment" ("id", "automationId", "machineId", "enabled", "priority", "updatedAt") VALUES
            ('enabled-assignment', 'automation', 'machine-enabled', true, 7, CURRENT_TIMESTAMP),
            ('disabled-assignment', 'automation', 'machine-disabled', false, 9, CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRun" ("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "finishedAt", "summaryCiphertext", "updatedAt")
            VALUES ('scheduled-run', 'automation', 'account', 'succeeded', '2026-08-27T10:00:00.000Z', '2026-08-27T10:01:00.000Z', '2026-08-27T10:02:00.000Z', ' exact legacy ', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRun" ("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "finishedAt", "updatedAt")
            VALUES ('manual-run', 'automation', 'account', 'succeeded', '2026-08-27T09:30:00.000Z', '2026-08-27T09:30:00.000Z', '2026-08-27T09:31:00.000Z', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRun" ("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "finishedAt", "updatedAt") VALUES
            ('cron-dst-run', 'automation', 'account', 'succeeded', '2026-10-25T00:59:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T01:01:00.000Z', CURRENT_TIMESTAMP),
            ('manual-dst-run', 'automation', 'account', 'succeeded', '2026-10-25T01:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T01:31:00.000Z', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRunEvent" ("id", "runId", "type") VALUES ('event', 'scheduled-run', 'queued');
    `);
    return db;
}

function createSqlitePredecessor(): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec(`
        PRAGMA foreign_keys=ON;
        CREATE TABLE "Account" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "Machine" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "Session" ("id" TEXT NOT NULL PRIMARY KEY);
        CREATE TABLE "Automation" (
            "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "name" TEXT NOT NULL,
            "description" TEXT, "enabled" BOOLEAN NOT NULL DEFAULT true, "scheduleKind" TEXT NOT NULL,
            "scheduleExpr" TEXT, "everyMs" INTEGER, "timezone" TEXT, "targetType" TEXT NOT NULL,
            "templateCiphertext" TEXT NOT NULL, "templateVersion" INTEGER NOT NULL DEFAULT 0,
            "nextRunAt" DATETIME, "lastRunAt" DATETIME,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "Automation_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE TABLE "AutomationAssignment" (
            "id" TEXT NOT NULL PRIMARY KEY, "automationId" TEXT NOT NULL, "machineId" TEXT NOT NULL,
            "enabled" BOOLEAN NOT NULL DEFAULT true, "priority" INTEGER NOT NULL DEFAULT 0,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "AutomationAssignment_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "AutomationAssignment_machineId_fkey" FOREIGN KEY ("machineId") REFERENCES "Machine"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE TABLE "AutomationRun" (
            "id" TEXT NOT NULL PRIMARY KEY, "automationId" TEXT NOT NULL, "accountId" TEXT NOT NULL,
            "state" TEXT NOT NULL DEFAULT 'queued', "scheduledAt" DATETIME NOT NULL, "dueAt" DATETIME NOT NULL,
            "claimedAt" DATETIME, "startedAt" DATETIME, "finishedAt" DATETIME, "claimedByMachineId" TEXT,
            "leaseExpiresAt" DATETIME, "attempt" INTEGER NOT NULL DEFAULT 0, "summaryCiphertext" TEXT,
            "errorCode" TEXT, "errorMessage" TEXT, "producedSessionId" TEXT,
            "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
            CONSTRAINT "AutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE,
            CONSTRAINT "AutomationRun_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE TABLE "AutomationRunEvent" (
            "id" TEXT NOT NULL PRIMARY KEY, "runId" TEXT NOT NULL, "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "type" TEXT NOT NULL, "payload" TEXT,
            CONSTRAINT "AutomationRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE
        );
        CREATE UNIQUE INDEX "AutomationAssignment_automationId_machineId_key" ON "AutomationAssignment"("automationId", "machineId");
        CREATE INDEX "AutomationAssignment_machineId_enabled_idx" ON "AutomationAssignment"("machineId", "enabled");
        CREATE INDEX "AutomationAssignment_automationId_enabled_idx" ON "AutomationAssignment"("automationId", "enabled");
        CREATE INDEX "AutomationRun_accountId_state_dueAt_idx" ON "AutomationRun"("accountId", "state", "dueAt");
        CREATE INDEX "AutomationRun_automationId_dueAt_idx" ON "AutomationRun"("automationId", "dueAt");
        CREATE INDEX "AutomationRun_claimedByMachineId_leaseExpiresAt_idx" ON "AutomationRun"("claimedByMachineId", "leaseExpiresAt");
        CREATE INDEX "AutomationRunEvent_runId_ts_idx" ON "AutomationRunEvent"("runId", "ts");
        CREATE INDEX "AutomationRunEvent_ts_idx" ON "AutomationRunEvent"("ts");
        ALTER TABLE "AutomationRun" ADD COLUMN "idempotencyKey" TEXT;
        CREATE UNIQUE INDEX "AutomationRun_automationId_idempotencyKey_key" ON "AutomationRun"("automationId", "idempotencyKey");
        INSERT INTO "Account" ("id") VALUES ('account');
        INSERT INTO "Machine" ("id") VALUES ('machine-enabled'), ('machine-disabled');
        INSERT INTO "Automation" (
            "id", "accountId", "name", "enabled", "scheduleKind", "everyMs", "timezone", "targetType",
            "templateCiphertext", "nextRunAt", "updatedAt"
        ) VALUES ('automation', 'account', 'retained schedule', false, 'interval', 60000, 'UTC',
            'new_session', '{}', '2026-08-27T10:00:00.000Z', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationAssignment" ("id", "automationId", "machineId", "enabled", "priority", "updatedAt") VALUES
            ('enabled-assignment', 'automation', 'machine-enabled', true, 7, CURRENT_TIMESTAMP),
            ('disabled-assignment', 'automation', 'machine-disabled', false, 9, CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRun" ("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "finishedAt", "summaryCiphertext", "updatedAt")
            VALUES ('scheduled-run', 'automation', 'account', 'succeeded', '2026-08-27T10:00:00.000Z', '2026-08-27T10:01:00.000Z', '2026-08-27T10:02:00.000Z', ' exact legacy ', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRun" ("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "finishedAt", "updatedAt")
            VALUES ('manual-run', 'automation', 'account', 'succeeded', '2026-08-27T09:30:00.000Z', '2026-08-27T09:30:00.000Z', '2026-08-27T09:31:00.000Z', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRun" ("id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "finishedAt", "updatedAt") VALUES
            ('cron-dst-run', 'automation', 'account', 'succeeded', '2026-10-25T00:59:00.000Z', '2026-10-25T01:00:00.000Z', '2026-10-25T01:01:00.000Z', CURRENT_TIMESTAMP),
            ('manual-dst-run', 'automation', 'account', 'succeeded', '2026-10-25T01:30:00.000Z', '2026-10-25T01:30:00.000Z', '2026-10-25T01:31:00.000Z', CURRENT_TIMESTAMP);
        INSERT INTO "AutomationRunEvent" ("id", "runId", "type") VALUES ('event', 'scheduled-run', 'queued');
    `);
    return db;
}

describe("Automation trigger-set executable migration", () => {
    it.each(["queued", "claimed", "running"] as const)(
        "refuses SQLite activation before canonical mutation while a released predecessor Run is %s",
        async (state) => {
            const db = createSqlitePredecessor();
            try {
                db.prepare(`
                    INSERT INTO "AutomationRun" (
                        "id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "updatedAt"
                    ) VALUES (
                        'released-open-manual', 'automation', 'account', ?,
                        '2026-08-27T11:00:00.000Z', '2026-08-27T11:00:00.000Z', CURRENT_TIMESTAMP
                    )
                `).run(state);
                await expect(applySqliteMigrationThroughCanonicalExecutor(
                    db,
                    await read(migrationPaths[1]),
                )).rejects.toThrow(/AutomationRun.*open|drain.*Automation/i);
                expect(db.prepare(`
                    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'AutomationTrigger'
                `).all()).toEqual([]);
                expect(db.prepare(`
                    SELECT name FROM pragma_table_info('AutomationRun') WHERE name = 'executionInputEnvelope'
                `).all()).toEqual([]);
                expect(db.prepare(`
                    SELECT state FROM "AutomationRun" WHERE id = 'released-open-manual'
                `).get()).toEqual({ state });
            } finally {
                db.close();
            }
        },
    );

    it(
        "refuses PostgreSQL activation before canonical mutation for every open released predecessor Run state",
        async () => {
            const db = await createPostgresPredecessor();
            try {
                for (const state of ["queued", "claimed", "running"] as const) {
                    await db.query(`
                        INSERT INTO "AutomationRun" (
                            "id", "automationId", "accountId", "state", "scheduledAt", "dueAt", "updatedAt"
                        ) VALUES (
                            'released-open-manual', 'automation', 'account', $1,
                            '2026-08-27T11:00:00.000Z', '2026-08-27T11:00:00.000Z', CURRENT_TIMESTAMP
                        )
                    `, [state]);
                    await expect(db.exec(await read(migrationPaths[0]))).rejects.toThrow(
                        /Automation activation requires zero open predecessor AutomationRun rows/i,
                    );
                    const tables = await db.query<{ tableName: string }>(`
                        SELECT table_name AS "tableName"
                        FROM information_schema.tables
                        WHERE table_schema = 'public' AND table_name = 'AutomationTrigger'
                    `);
                    expect(tables.rows).toEqual([]);
                    const columns = await db.query<{ columnName: string }>(`
                        SELECT column_name AS "columnName"
                        FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'AutomationRun'
                            AND column_name = 'executionInputEnvelope'
                    `);
                    expect(columns.rows).toEqual([]);
                    await db.query(`DELETE FROM "AutomationRun" WHERE "id" = 'released-open-manual'`);
                }
            } finally {
                await db.close();
            }
        },
        60_000,
    );

    it("migrates PostgreSQL schedule/manual data and enforces trigger-scoped occurrence identity", async () => {
        const db = await createPostgresPredecessor();
        try {
            await db.exec(await read(migrationPaths[0]));
            const triggers = await db.query<{
                id: string; automationId: string; kind: string; enabled: boolean;
                scheduleKind: string; everyMs: number; timezone: string;
            }>(`
                SELECT "id", "automationId", "kind"::text AS "kind", "enabled",
                    "scheduleKind"::text AS "scheduleKind", "everyMs", "timezone"
                FROM "AutomationTrigger"
            `);
            expect(triggers.rows).toEqual([{
                id: "automation",
                automationId: "automation",
                kind: "schedule",
                enabled: true,
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: "UTC",
            }]);
            const runs = await db.query<{
                id: string; triggerId: string | null; causeKind: string;
                causeTriggerKind: string | null; causeTriggerRevision: number | null;
                causeScheduledFor: Date | null; occurrenceKey: string | null;
                legacyManualIdempotencyKey: string | null; resultEnvelope: string | null;
                executionInputEnvelope: string | null;
                causeOccurredMatchesDueAt: boolean; causeScheduledMatchesDueAt: boolean | null;
            }>(`
                SELECT "id", "triggerId", "causeKind"::text AS "causeKind",
                    "causeTriggerKind"::text AS "causeTriggerKind", "causeTriggerRevision",
                    "causeScheduledFor", "occurrenceKey",
                    "idempotencyKey" AS "legacyManualIdempotencyKey", "resultEnvelope",
                    "executionInputEnvelope",
                    "causeOccurredAt" = "dueAt" AS "causeOccurredMatchesDueAt",
                    "causeScheduledFor" = "dueAt" AS "causeScheduledMatchesDueAt"
                FROM "AutomationRun"
                WHERE "id" IN ('manual-run', 'scheduled-run')
                ORDER BY "id"
            `);
            expect(runs.rows[0]).toEqual({
                id: "manual-run",
                triggerId: null,
                causeKind: "manual",
                causeTriggerKind: null,
                causeTriggerRevision: null,
                causeScheduledFor: null,
                occurrenceKey: null,
                legacyManualIdempotencyKey: null,
                resultEnvelope: null,
                executionInputEnvelope: null,
                causeOccurredMatchesDueAt: false,
                causeScheduledMatchesDueAt: null,
            });
            expect(runs.rows[1]).toMatchObject({
                id: "scheduled-run",
                triggerId: "automation",
                causeKind: "trigger",
                causeTriggerKind: "schedule",
                causeTriggerRevision: 0,
                legacyManualIdempotencyKey: null,
                executionInputEnvelope: null,
                causeOccurredMatchesDueAt: true,
                causeScheduledMatchesDueAt: true,
            });
            expect(runs.rows[1]!.occurrenceKey).toHaveLength(43);
            expect(JSON.parse(runs.rows[1]!.resultEnvelope!)).toEqual({
                t: "legacySummaryCiphertext",
                c: " exact legacy ",
            });
            const dstBoundary = await db.query<{
                id: string; causeKind: string; causeScheduledFor: Date | null;
                causeOccurredMatchesDueAt: boolean; causeScheduledMatchesDueAt: boolean | null;
            }>(`
                SELECT "id", "causeKind"::text AS "causeKind", "causeScheduledFor",
                    "causeOccurredAt" = "dueAt" AS "causeOccurredMatchesDueAt",
                    "causeScheduledFor" = "dueAt" AS "causeScheduledMatchesDueAt"
                FROM "AutomationRun" WHERE "id" IN ('cron-dst-run', 'manual-dst-run')
                ORDER BY "id"
            `);
            expect(dstBoundary.rows[0]).toMatchObject({
                id: "cron-dst-run",
                causeKind: "trigger",
                causeOccurredMatchesDueAt: true,
                causeScheduledMatchesDueAt: true,
            });
            expect(dstBoundary.rows[1]).toMatchObject({
                id: "manual-dst-run",
                causeKind: "manual",
                causeScheduledFor: null,
                causeScheduledMatchesDueAt: null,
            });
            const assignments = await db.query<{ runId: string; machineId: string; priority: number }>(`
                SELECT "runId", "machineId", "priority" FROM "AutomationRunAssignment" ORDER BY "runId"
            `);
            expect(assignments.rows).toEqual([
                { runId: "cron-dst-run", machineId: "machine-enabled", priority: 7 },
                { runId: "manual-dst-run", machineId: "machine-enabled", priority: 7 },
                { runId: "manual-run", machineId: "machine-enabled", priority: 7 },
                { runId: "scheduled-run", machineId: "machine-enabled", priority: 7 },
            ]);
            const firstTriggerOccurrenceKey = "E".repeat(43);
            const secondTriggerOccurrenceKey = "F".repeat(43);
            await db.exec(`
                INSERT INTO "AutomationTrigger" ("id", "automationId", "kind", "scheduleKind", "everyMs", "updatedAt")
                    VALUES ('second-trigger', 'automation', 'schedule', 'interval', 60000, CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "triggerId", "causeKind", "causeTriggerKind",
                    "causeTriggerRevision", "causeOccurredAt", "causeScheduledFor", "occurrenceKey",
                    "executionInputEnvelope", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES
                    ('first-shared-occurrence', 'automation', 'account', 'automation', 'trigger', 'schedule', 0,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${firstTriggerOccurrenceKey}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                    ('second-shared-occurrence', 'automation', 'account', 'second-trigger', 'trigger', 'schedule', 0,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${secondTriggerOccurrenceKey}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            `);
            await expect(db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "triggerId", "causeKind", "causeTriggerKind",
                    "causeTriggerRevision", "causeOccurredAt", "causeScheduledFor", "occurrenceKey",
                    "executionInputEnvelope", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('duplicate-trigger-occurrence', 'automation', 'account', 'automation', 'trigger', 'schedule', 0,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${firstTriggerOccurrenceKey}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `)).rejects.toThrow();
            const occurrenceKey = "A".repeat(43);
            await db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "replyContextEnvelope",
                    "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId",
                    "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId",
                    "replyHandoffId", "replyHandoffState", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('conversation-run', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP, '${occurrenceKey}',
                    '{"t":"plain","v":{}}', '{}', 'reply context', 'plugin', 'action', 'machine',
                    'installation', 'materialization', 'handoff-a', 'awaitingResult',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            const noHandoffOccurrenceKey = "N".repeat(43);
            await db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('conversation-no-handoff', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP,
                    '${noHandoffOccurrenceKey}', '{"t":"plain","v":{}}', '{}',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            const appOwnedOccurrenceKey = "D".repeat(43);
            await db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "replyContextEnvelope",
                    "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId",
                    "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId",
                    "replyHandoffId", "replyHandoffState", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('app-owned-conversation-key', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP,
                    '${appOwnedOccurrenceKey}', '{"t":"plain","v":{}}', '{}', 'reply context',
                    'plugin', 'action', 'machine', 'installation', 'materialization', 'handoff-d', 'awaitingResult',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            await expect(db.exec(`UPDATE "AutomationRun" SET "idempotencyKey" = 'manual-namespace' WHERE "id" = 'conversation-run'`)).rejects.toThrow();
            await expect(db.exec(`UPDATE "AutomationRun" SET "idempotencyKey" = 'not-null' WHERE "id" = 'scheduled-run'`)).rejects.toThrow();
            await expect(db.exec(`
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "scheduleKind", "updatedAt"
                ) VALUES ('invalid-cron', 'automation', 'schedule', 'cron', CURRENT_TIMESTAMP)
            `)).rejects.toThrow();
            await expect(db.exec(`
                UPDATE "AutomationRun" SET "causeKind" = 'manual' WHERE "id" = 'scheduled-run'
            `)).rejects.toThrow();
            // Predecessor terminal history keeps its null execution input: the
            // transition never synthesizes recipe bytes that it cannot know.
            for (const terminalState of AUTOMATION_RUN_TERMINAL_STATES) {
                await db.query(`
                    INSERT INTO "AutomationRun" (
                        "id", "automationId", "accountId", "state", "causeKind", "causeOccurredAt",
                        "scheduledAt", "dueAt", "updatedAt"
                    ) VALUES ($1, 'automation', 'account', $2, 'manual',
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `, [`terminal-null-input-${terminalState}`, terminalState]);
            }
            for (const state of ["queued", "claimed", "running"] as const) {
                await expect(db.query(`
                    INSERT INTO "AutomationRun" (
                        "id", "automationId", "accountId", "state", "causeKind", "causeOccurredAt",
                        "scheduledAt", "dueAt", "updatedAt"
                    ) VALUES ($1, 'automation', 'account', $2, 'manual',
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `, [`nonterminal-null-input-${state}`, state])).rejects.toThrow();
            }
            await db.exec(`
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "eventPluginId", "eventLocalId", "sourceSelectorId",
                    "sourceContractVersion", "observationTransport", "definitionEnvelope",
                    "watcherMachineId", "watcherMachineInstallationId", "watcherPluginId",
                    "watcherMaterializationId", "updatedAt"
                ) VALUES ('checkpointed-event', 'automation', 'pluginEvent', 'plugin', 'checkpointed',
                    'checkpointed-source', 1, 'checkpointedPull', '{}', 'machine-enabled', 'installation',
                    'plugin', 'materialization', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "eventPluginId", "eventLocalId", "sourceSelectorId",
                    "sourceContractVersion", "observationTransport", "definitionEnvelope",
                    "webhookEndpointId", "observationStartsAt", "updatedAt"
                ) VALUES ('durable-event', 'automation', 'pluginEvent', 'plugin', 'durable',
                    'durable-source', 1, 'durablePush', '{}', 'endpoint', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
                UPDATE "AutomationTrigger" SET
                    "enabled" = false,
                    "deletedAt" = CURRENT_TIMESTAMP,
                    "definitionEnvelope" = NULL,
                    "observationTransport" = NULL,
                    "webhookEndpointId" = NULL,
                    "observationStartsAt" = NULL,
                    "watcherMachineId" = NULL,
                    "watcherMachineInstallationId" = NULL,
                    "watcherPluginId" = NULL,
                    "watcherMaterializationId" = NULL
                WHERE "id" IN ('checkpointed-event', 'durable-event');
            `);
            const deletedEvents = await db.query<{
                id: string; eventPluginId: string; eventLocalId: string; sourceSelectorId: string;
                sourceContractVersion: number; definitionEnvelope: string | null;
                observationTransport: string | null;
            }>(`
                SELECT "id", "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion",
                    "definitionEnvelope", "observationTransport"
                FROM "AutomationTrigger"
                WHERE "id" IN ('checkpointed-event', 'durable-event')
                ORDER BY "id"
            `);
            expect(deletedEvents.rows).toEqual([
                {
                    id: "checkpointed-event",
                    eventPluginId: "plugin",
                    eventLocalId: "checkpointed",
                    sourceSelectorId: "checkpointed-source",
                    sourceContractVersion: 1,
                    definitionEnvelope: null,
                    observationTransport: null,
                },
                {
                    id: "durable-event",
                    eventPluginId: "plugin",
                    eventLocalId: "durable",
                    sourceSelectorId: "durable-source",
                    sourceContractVersion: 1,
                    definitionEnvelope: null,
                    observationTransport: null,
                },
            ]);
            // The signed V3 request binds exactly one durable outcome,
            // including an empty outcome with no Run.
            const postgresReplayFingerprint = "P".repeat(43);
            await db.exec(`
                INSERT INTO "AutomationWorkerClaimReceipt" (
                    "id", "accountId", "machineId", "machineInstallationId", "claimResultJson", "expiresAt"
                ) VALUES ('${postgresReplayFingerprint}', 'account', 'machine-enabled',
                    'installation-enabled', '{"v":1,"run":null}', CURRENT_TIMESTAMP + INTERVAL '5 minutes')
            `);
            await expect(db.exec(`
                INSERT INTO "AutomationWorkerClaimReceipt" (
                    "id", "accountId", "machineId", "machineInstallationId", "claimResultJson", "expiresAt"
                ) VALUES ('${postgresReplayFingerprint}', 'account', 'machine-enabled',
                    'installation-enabled', '{"v":1,"run":null}', CURRENT_TIMESTAMP + INTERVAL '5 minutes')
            `)).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    it("migrates SQLite data, preserves retained history, and enforces final trigger/Run invariants", async () => {
        const db = createSqlitePredecessor();
        try {
            await applySqliteMigrationThroughCanonicalExecutor(db, await read(migrationPaths[1]));
            expect(db.prepare(`
                SELECT "id", "automationId", "kind", "enabled", "scheduleKind", "everyMs", "timezone"
                FROM "AutomationTrigger"
            `).all()).toEqual([{
                id: "automation",
                automationId: "automation",
                kind: "schedule",
                enabled: 1,
                scheduleKind: "interval",
                everyMs: 60_000,
                timezone: "UTC",
            }]);
            expect(db.prepare(`
                SELECT "id", "triggerId", "causeKind", "causeTriggerKind", "causeTriggerRevision",
                    "causeScheduledFor", "occurrenceKey", "idempotencyKey"
                FROM "AutomationRun"
                WHERE "id" IN ('manual-run', 'scheduled-run')
                ORDER BY "id"
            `).all()).toEqual([
                {
                    id: "manual-run",
                    triggerId: null,
                    causeKind: "manual",
                    causeTriggerKind: null,
                    causeTriggerRevision: null,
                    causeScheduledFor: null,
                    occurrenceKey: null,
                    idempotencyKey: null,
                },
                {
                    id: "scheduled-run",
                    triggerId: "automation",
                    causeKind: "trigger",
                    causeTriggerKind: "schedule",
                    causeTriggerRevision: 0,
                    causeScheduledFor: "2026-08-27T10:01:00.000Z",
                    occurrenceKey: expect.stringMatching(/^.{43}$/),
                    idempotencyKey: null,
                },
            ]);
            expect(db.prepare(`
                SELECT "runId", "machineId", "priority" FROM "AutomationRunAssignment" ORDER BY "runId"
            `).all()).toEqual([
                { runId: "cron-dst-run", machineId: "machine-enabled", priority: 7 },
                { runId: "manual-dst-run", machineId: "machine-enabled", priority: 7 },
                { runId: "manual-run", machineId: "machine-enabled", priority: 7 },
                { runId: "scheduled-run", machineId: "machine-enabled", priority: 7 },
            ]);
            expect(db.prepare(`
                SELECT "id", "causeKind", "causeOccurredAt", "causeScheduledFor" FROM "AutomationRun"
                WHERE "id" IN ('cron-dst-run', 'manual-dst-run') ORDER BY "id"
            `).all()).toEqual([
                {
                    id: "cron-dst-run",
                    causeKind: "trigger",
                    causeOccurredAt: "2026-10-25T01:00:00.000Z",
                    causeScheduledFor: "2026-10-25T01:00:00.000Z",
                },
                {
                    id: "manual-dst-run",
                    causeKind: "manual",
                    causeOccurredAt: expect.any(String),
                    causeScheduledFor: null,
                },
            ]);
            expect(db.prepare("SELECT runId FROM AutomationRunEvent WHERE id = 'event'").all()).toEqual([{ runId: "scheduled-run" }]);
            const migratedResult = db.prepare(`
                SELECT "resultEnvelope" FROM "AutomationRun" WHERE "id" = 'scheduled-run'
            `).get() as { resultEnvelope: string };
            expect(JSON.parse(migratedResult.resultEnvelope)).toEqual({
                t: "legacySummaryCiphertext",
                c: " exact legacy ",
            });
            const firstTriggerOccurrenceKey = "E".repeat(43);
            const secondTriggerOccurrenceKey = "F".repeat(43);
            db.exec(`
                INSERT INTO "AutomationTrigger" ("id", "automationId", "kind", "scheduleKind", "everyMs", "updatedAt")
                    VALUES ('second-trigger', 'automation', 'schedule', 'interval', 60000, CURRENT_TIMESTAMP);
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "triggerId", "causeKind", "causeTriggerKind",
                    "causeTriggerRevision", "causeOccurredAt", "causeScheduledFor", "occurrenceKey",
                    "executionInputEnvelope", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES
                    ('first-shared-occurrence', 'automation', 'account', 'automation', 'trigger', 'schedule', 0,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${firstTriggerOccurrenceKey}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
                    ('second-shared-occurrence', 'automation', 'account', 'second-trigger', 'trigger', 'schedule', 0,
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${secondTriggerOccurrenceKey}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            `);
            expect(() => db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "triggerId", "causeKind", "causeTriggerKind",
                    "causeTriggerRevision", "causeOccurredAt", "causeScheduledFor", "occurrenceKey",
                    "executionInputEnvelope", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('duplicate-trigger-occurrence', 'automation', 'account', 'automation', 'trigger', 'schedule', 0,
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '${firstTriggerOccurrenceKey}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `)).toThrow();
            const appOwnedOccurrenceKey = "D".repeat(43);
            db.prepare(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "replyContextEnvelope",
                    "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId",
                    "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId",
                    "replyHandoffId", "replyHandoffState", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('app-owned-conversation-key', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP,
                    ?, '{"t":"plain","v":{}}', '{}', 'reply context', 'plugin', 'action', 'machine',
                    'installation', 'materialization', 'handoff-d', 'awaitingResult',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(appOwnedOccurrenceKey);
            const noHandoffOccurrenceKey = "N".repeat(43);
            db.prepare(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('conversation-no-handoff', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP,
                    ?, '{"t":"plain","v":{}}', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(noHandoffOccurrenceKey);
            expect(() => db.prepare(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "replyContextEnvelope",
                    "replyHandoffActionPluginId", "replyHandoffActionLocalId", "replyHandoffTargetMachineId",
                    "replyHandoffTargetMachineInstallationId", "replyHandoffTargetMaterializationId",
                    "replyHandoffId", "replyHandoffState", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('duplicate-conversation-key', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP,
                    ?, '{"t":"plain","v":{}}', '{}', 'reply context', 'plugin', 'action', 'machine',
                    'installation', 'materialization', 'handoff-duplicate', 'awaitingResult',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(appOwnedOccurrenceKey)).toThrow();
            const missingIdentityKey = "C".repeat(43);
            expect(() => db.prepare(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "causeKind", "causeOccurredAt", "occurrenceKey",
                    "triggerEvidenceEnvelope", "executionInputEnvelope", "replyHandoffState", "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('missing-handoff-identity', 'automation', 'account', 'conversation', CURRENT_TIMESTAMP, ?,
                    '{"t":"plain","v":{}}', '{}', 'accepted', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `).run(missingIdentityKey)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "updatedAt"
                ) VALUES ('missing-schedule-discriminant', 'automation', 'schedule', CURRENT_TIMESTAMP)
            `)).toThrow();
            expect(() => db.exec(`
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "sourceSessionId", "sourceTurnId", "updatedAt"
                ) VALUES ('missing-lifecycle-discriminant', 'automation', 'sessionLifecycle',
                    'session', 'turn', CURRENT_TIMESTAMP)
            `)).toThrow();
            db.exec(`
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "eventPluginId", "eventLocalId",
                    "sourceSelectorId", "sourceContractVersion", "observationTransport",
                    "definitionEnvelope", "watcherMachineId", "watcherMachineInstallationId",
                    "watcherPluginId", "watcherMaterializationId", "updatedAt"
                ) VALUES ('checkpointed-event', 'automation', 'pluginEvent', 'plugin', 'checkpointed',
                    'checkpointed-source', 1, 'checkpointedPull', '{}', 'machine-enabled', 'installation',
                    'plugin', 'materialization', CURRENT_TIMESTAMP);
                INSERT INTO "AutomationTrigger" (
                    "id", "automationId", "kind", "eventPluginId", "eventLocalId",
                    "sourceSelectorId", "sourceContractVersion", "observationTransport",
                    "definitionEnvelope", "webhookEndpointId", "observationStartsAt", "updatedAt"
                ) VALUES ('durable-event', 'automation', 'pluginEvent', 'plugin', 'durable',
                    'durable-source', 1, 'durablePush', '{}', 'endpoint', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            expect(() => db.exec(`
                UPDATE "AutomationTrigger" SET
                    "enabled" = false,
                    "deletedAt" = CURRENT_TIMESTAMP,
                    "definitionEnvelope" = NULL,
                    "observationTransport" = NULL,
                    "webhookEndpointId" = NULL,
                    "observationStartsAt" = NULL,
                    "watcherMachineId" = NULL,
                    "watcherMachineInstallationId" = NULL,
                    "watcherPluginId" = NULL,
                    "watcherMaterializationId" = NULL
                WHERE "id" IN ('checkpointed-event', 'durable-event')
            `)).not.toThrow();
            expect(db.prepare(`
                SELECT "id", "eventPluginId", "eventLocalId", "sourceSelectorId", "sourceContractVersion",
                    "definitionEnvelope", "observationTransport"
                FROM "AutomationTrigger"
                WHERE "id" IN ('checkpointed-event', 'durable-event')
                ORDER BY "id"
            `).all()).toEqual([
                {
                    id: "checkpointed-event",
                    eventPluginId: "plugin",
                    eventLocalId: "checkpointed",
                    sourceSelectorId: "checkpointed-source",
                    sourceContractVersion: 1,
                    definitionEnvelope: null,
                    observationTransport: null,
                },
                {
                    id: "durable-event",
                    eventPluginId: "plugin",
                    eventLocalId: "durable",
                    sourceSelectorId: "durable-source",
                    sourceContractVersion: 1,
                    definitionEnvelope: null,
                    observationTransport: null,
                },
            ]);
            db.exec(`
                INSERT INTO "AutomationRun" (
                    "id", "automationId", "accountId", "state", "causeKind", "causeOccurredAt",
                    "scheduledAt", "dueAt", "updatedAt"
                ) VALUES ('terminal-historical-null-input', 'automation', 'account', 'succeeded', 'manual',
                    CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            `);
            for (const state of ["queued", "claimed", "running"] as const) {
                expect(() => db.prepare(`
                    INSERT INTO "AutomationRun" (
                        "id", "automationId", "accountId", "state", "causeKind", "causeOccurredAt",
                        "scheduledAt", "dueAt", "updatedAt"
                    ) VALUES (?, 'automation', 'account', ?, 'manual',
                        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                `).run(`nonterminal-null-input-${state}`, state)).toThrow();
            }
            // Empty signed claim outcomes are durable and uniquely fenced.
            const replayFingerprint = "R".repeat(43);
            db.exec(`
                INSERT INTO "AutomationWorkerClaimReceipt" (
                    "id", "accountId", "machineId", "machineInstallationId", "claimResultJson", "expiresAt"
                ) VALUES ('${replayFingerprint}', 'account', 'machine-enabled',
                    'installation-enabled', '{"v":1,"run":null}', datetime('now', '+5 minutes'))
            `);
            expect(() => db.exec(`
                INSERT INTO "AutomationWorkerClaimReceipt" (
                    "id", "accountId", "machineId", "machineInstallationId", "claimResultJson", "expiresAt"
                ) VALUES ('${replayFingerprint}', 'account', 'machine-enabled',
                    'installation-enabled', '{"v":1,"run":null}', datetime('now', '+5 minutes'))
            `)).toThrow();
            expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        } finally {
            db.close();
        }
    });

    it("deploys the consolidated SQLite migration twice and converges on exactly one applied ledger record", async () => {
        const db = createSqlitePredecessor();
        try {
            const sql = await read(migrationPaths[1]);
            await applySqliteMigrationThroughCanonicalExecutor(db, sql);
            // The second canonical deploy must be a ledger no-op: same name,
            // same checksum, no duplicate DDL, schema unchanged.
            await applySqliteMigrationThroughCanonicalExecutor(db, sql);
            expect(db.prepare(`
                SELECT migration_name FROM _prisma_migrations
                WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL
            `).all()).toEqual([{ migration_name: migrationId }]);
            expect(db.prepare(`
                SELECT count(*) AS count FROM sqlite_master
                WHERE type = 'table' AND name = 'AutomationWorkerClaimReceipt'
            `).get()).toEqual({ count: 1 });
            expect(db.prepare(`
                SELECT count(*) AS count FROM sqlite_master
                WHERE type = 'table' AND name = 'AutomationRun'
            `).get()).toEqual({ count: 1 });
        } finally {
            db.close();
        }
    });
});
