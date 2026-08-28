import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveAutomationOccurrenceKeyV1 } from "@happier-dev/protocol";

import { db, initDbMysql, initDbPostgres, isPrismaErrorCode } from "@/storage/db";
import { AUTOMATION_RUN_TERMINAL_STATES, type AutomationRunState } from "./automationTypes";

/**
 * Native-provider post-migration invariants for the consolidated unreleased
 * Automation trigger-set transition (`20260816231000_add_event_automations_v1`).
 *
 * The predecessor-data transition itself (activation preflight refusal and the
 * cause backfill) is executed by `scripts/migrations/eventAutomationsSchema.spec.ts`
 * on the PostgreSQL (PGlite) and SQLite engines, including the executable
 * deploy-twice convergence proof. This contract proves, against the native
 * PostgreSQL/MySQL database deployed by the canonical ephemeral provider harness,
 * that the deployed database carries that transition's identity and activation
 * preflight (one applied ledger record; the queued/claimed/running open-Run drain
 * guard precedes every canonical mutation; the transition never synthesizes the
 * frozen execution input it cannot know) and that the final schema enforces the
 * same durable invariants after the migration chain has been applied: the
 * nonterminal frozen execution-input CHECK
 * (rejected for every nonterminal state, retained as approved history for every
 * canonical terminal state), the trigger/manual/conversation cause arms,
 * trigger-scoped occurrence identity, the exact pluginEvent live arms plus the one
 * canonical tombstone arm accepted by deleted checkpointed-pull and durable-push
 * triggers while half-scrubbed deletions are rejected, mandatory reporter
 * generation provenance, and the removal of the predecessor singular-trigger and
 * dead filter fields.
 */
type MigrationInvariantProvider = "postgres" | "mysql" | "sqlite";

/**
 * Normalizes every native provider name (sqlite, postgresql/postgres, mysql) to
 * its canonical form. Unknown names fail loudly instead of silently skipping
 * the contract suite.
 */
function normalizeDbProviderName(raw: string): MigrationInvariantProvider {
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    if (raw === "sqlite") return "sqlite";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql).`,
    );
}

/**
 * Resolves the native provider for this contract. The SQLite engine never
 * selects this file: its trigger-set transition proof is owned by
 * `scripts/migrations/eventAutomationsSchema.spec.ts`, so a sqlite selection
 * fails with that pointer instead of silently skipping every invariant here.
 */
function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const normalized = normalizeDbProviderName(
        String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
            .trim()
            .toLowerCase(),
    );
    if (normalized === "sqlite") {
        throw new Error(
            "HAPPIER_DB_PROVIDER=sqlite does not run this native-provider contract; the SQLite engine trigger-set transition is executed by scripts/migrations/eventAutomationsSchema.spec.ts.",
        );
    }
    return normalized;
}

const MIGRATION_ID = "20260816231000_add_event_automations_v1";
// Vitest runs this suite from the server workspace root (`apps/server`).
const serverRoot = process.cwd();

const EVENT_PLUGIN_ID = "com.happier.trigger-migration-invariants";

type MigrationInvariantFixture = Readonly<{
    suffix: string;
    accountId: string;
    machineId: string;
    automationId: string;
    secondAutomationId: string;
    cleanup: () => Promise<void>;
}>;

async function createMigrationInvariantFixture(): Promise<MigrationInvariantFixture> {
    const suffix = randomUUID();
    const accountId = `trigger-invariants-account-${suffix}`;
    const machineId = `trigger-invariants-machine-${suffix}`;
    const automationId = `trigger-invariants-automation-${suffix}`;
    const secondAutomationId = `trigger-invariants-automation-2-${suffix}`;
    await db.account.create({
        data: { id: accountId, publicKey: null, encryptionMode: "plain" },
        select: { id: true },
    });
    await db.machine.create({
        data: {
            id: machineId,
            accountId,
            installationId: `trigger-invariants-installation-${suffix}`,
            metadata: "{}",
        },
        select: { id: true },
    });
    for (const automationRow of [automationId, secondAutomationId]) {
        await db.automation.create({
            data: {
                id: automationRow,
                accountId,
                name: `Trigger migration invariants ${suffix}`,
                targetType: "new_session",
                templateCiphertext: '{"t":"plain","v":{}}',
                templateVersion: 1,
            },
            select: { id: true },
        });
    }
    return {
        suffix,
        accountId,
        machineId,
        automationId,
        secondAutomationId,
        cleanup: async () => {
            await db.automationEventSourceCatalogStatus.deleteMany({
                where: { accountId },
            }).catch(() => {});
            await db.automationRun.deleteMany({ where: { accountId } }).catch(() => {});
            await db.automation.deleteMany({ where: { accountId } }).catch(() => {});
            await db.machine.deleteMany({ where: { accountId } }).catch(() => {});
            await db.account.deleteMany({ where: { id: accountId } }).catch(() => {});
        },
    };
}

function scheduleTriggerRunInput(params: Readonly<{
    id: string;
    accountId: string;
    automationId: string;
    triggerId: string;
    occurrenceKey: string;
    state?: AutomationRunState;
    executionInputEnvelope?: string | null;
}>) {
    const now = new Date();
    return {
        id: params.id,
        automationId: params.automationId,
        accountId: params.accountId,
        state: params.state ?? "queued",
        triggerId: params.triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: "schedule" as const,
        causeTriggerRevision: 1,
        causeOccurredAt: now,
        causeScheduledFor: now,
        occurrenceKey: params.occurrenceKey,
        executionInputEnvelope:
            params.executionInputEnvelope === undefined
                ? '{"t":"plain","v":{}}'
                : params.executionInputEnvelope,
        scheduledAt: now,
        dueAt: now,
    };
}

describe(
    "Automation trigger-set migration invariants (native provider contract)",
    () => {
        const provider = resolveContractProviderFromEnv();
        const migrationRelativePath = provider === "mysql"
            ? join("prisma", "mysql", "migrations", MIGRATION_ID, "migration.sql")
            : join("prisma", "migrations", MIGRATION_ID, "migration.sql");

        beforeAll(async () => {
            if (!process.env.DATABASE_URL) {
                throw new Error("Missing DATABASE_URL (required for the native trigger-set migration invariants).");
            }
            if (provider === "mysql") await initDbMysql();
            else initDbPostgres();
            await db.$connect();
        });
        afterAll(async () => await db.$disconnect());

        function normalizeMigrationSql(sql: string): string {
            return sql.replace(/[`"]/g, "").replace(/\s+/g, " ").trim();
        }

        it("binds the deployed database to the transition's identity and activation preflight", async () => {
            // Migration identity: the canonical harness deployed this exact
            // transition, and its ledger keeps one applied record — the
            // convergence shape a second canonical deploy must preserve.
            const appliedRecords = await db.$queryRawUnsafe<Array<{
                checksum: string;
                finished_at: Date;
                rolled_back_at: Date | null;
            }>>(
                provider === "mysql"
                    ? "SELECT checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = ?"
                    : "SELECT checksum, finished_at, rolled_back_at FROM _prisma_migrations WHERE migration_name = $1",
                MIGRATION_ID,
            );
            expect(appliedRecords).toHaveLength(1);
            expect(appliedRecords[0]).toMatchObject({
                checksum: expect.any(String),
                rolled_back_at: null,
            });
            expect(appliedRecords[0]?.finished_at).toBeInstanceOf(Date);

            // Pre-mutation rejection with no synthesis: the deployed
            // transition refuses activation while any released open
            // predecessor Run (queued/claimed/running, without a frozen
            // execution input) exists, and it never fabricates those opaque
            // recipe bytes. The guard precedes every canonical mutation, so a
            // drained database is the only state that can reach the
            // trigger-set schema.
            const migrationBytes = await readFile(join(serverRoot, migrationRelativePath));
            expect(appliedRecords[0]?.checksum).toBe(
                createHash("sha256").update(migrationBytes).digest("hex"),
            );
            const migrationSql = normalizeMigrationSql(migrationBytes.toString("utf8"));
            const preflightMarkers = [
                migrationSql.indexOf(
                    "Automation activation requires zero open predecessor AutomationRun rows",
                ),
                migrationSql.indexOf("_AutomationRun_open_frozen_input_preflight"),
            ].filter((index) => index >= 0);
            expect(preflightMarkers.length).toBeGreaterThan(0);
            const preflightIndex = Math.min(...preflightMarkers);
            expect(migrationSql).toMatch(/state IN \('queued', 'claimed', 'running'\)/);
            const firstCanonicalMutationIndex = [
                migrationSql.indexOf("CREATE TYPE"),
                migrationSql.indexOf("ADD COLUMN"),
            ]
                .filter((index) => index >= 0)
                .sort((left, right) => left - right)[0];
            expect(firstCanonicalMutationIndex).toBeGreaterThan(preflightIndex);
            expect(migrationSql).not.toMatch(/executionInputEnvelope\s*=|SET\s+executionInputEnvelope/i);
            expect(migrationSql).not.toMatch(
                /INSERT INTO (?:new_)?AutomationRun \([^)]*executionInputEnvelope/i,
            );
        });

        it("removed the predecessor singular-trigger columns and dead filter fields", async () => {
            const automationColumns = await db.$queryRawUnsafe<Array<{ name: string }>>(
                provider === "mysql"
                    ? "SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS "
                        + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Automation'"
                    : "SELECT column_name AS name FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'Automation'",
            );
            const automationTriggerColumns = await db.$queryRawUnsafe<Array<{ name: string }>>(
                provider === "mysql"
                    ? "SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS "
                        + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AutomationTrigger'"
                    : "SELECT column_name AS name FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'AutomationTrigger'",
            );
            const automationRunColumns = await db.$queryRawUnsafe<Array<{ name: string }>>(
                provider === "mysql"
                    ? "SELECT COLUMN_NAME AS name FROM INFORMATION_SCHEMA.COLUMNS "
                        + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AutomationRun'"
                    : "SELECT column_name AS name FROM information_schema.columns "
                        + "WHERE table_schema = current_schema() AND table_name = 'AutomationRun'",
            );
            const automationRunIndexes = await db.$queryRawUnsafe<Array<{ name: string }>>(
                provider === "mysql"
                    ? "SELECT DISTINCT INDEX_NAME AS name FROM INFORMATION_SCHEMA.STATISTICS "
                        + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AutomationRun'"
                    : "SELECT indexname AS name FROM pg_indexes "
                        + "WHERE schemaname = current_schema() AND tablename = 'AutomationRun'",
            );
            const automationNames = new Set(
                automationColumns.map((column) => String(column.name).toLowerCase()),
            );
            const triggerNames = new Set(
                automationTriggerColumns.map((column) => String(column.name).toLowerCase()),
            );
            const runNames = new Set(
                automationRunColumns.map((column) => String(column.name).toLowerCase()),
            );
            const runIndexNames = new Set(
                automationRunIndexes.map((index) => String(index.name).toLowerCase()),
            );
            for (const staleColumn of [
                "schedulekind", "scheduleexpr", "everyms", "timezone", "nextrunat",
            ]) {
                expect(automationNames.has(staleColumn), `Automation.${staleColumn} must be gone`).toBe(false);
            }
            expect(triggerNames.has("filterenvelope"), "AutomationTrigger.filterEnvelope must be gone").toBe(false);
            expect(runNames.has("contentremovedat"), "AutomationRun.contentRemovedAt must be gone").toBe(false);
            for (const requiredColumn of [
                "triggerid", "causekind", "occurrencekey", "executioninputenvelope",
                "idempotencykey", "replyhandoffstate",
            ]) {
                expect(runNames.has(requiredColumn), `AutomationRun.${requiredColumn} must exist`).toBe(true);
            }
            expect(runIndexNames.has("automationrun_automationid_occurrencekey_key"),
                "the predecessor Automation-scoped occurrence index must be gone").toBe(false);
            expect(runIndexNames.has("automationrun_triggerid_occurrencekey_key"),
                "automatic replay must be uniquely trigger-scoped").toBe(true);
            expect(runIndexNames.has("automationrun_automationid_causekind_occurrencekey_key"),
                "Conversation replay keeps its distinct cause-scoped rejoin key").toBe(true);
        });

        it("enforces the durable nonterminal frozen execution-input CHECK", async () => {
            const fixture = await createMigrationInvariantFixture();
            try {
                const triggerId = `trigger-invariants-schedule-${fixture.suffix}`;
                await db.automationTrigger.create({
                    data: {
                        id: triggerId,
                        automationId: fixture.automationId,
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                        revision: 1,
                    },
                    select: { id: true },
                });
                for (const state of ["queued", "claimed", "running"] as const) {
                    await expect(db.automationRun.create({
                        data: scheduleTriggerRunInput({
                            id: `trigger-invariants-open-${state}-${fixture.suffix}`,
                            accountId: fixture.accountId,
                            automationId: fixture.automationId,
                            triggerId,
                            occurrenceKey: `${state[0]}${"B".repeat(42)}`,
                            state,
                            executionInputEnvelope: null,
                        }),
                        select: { id: true },
                    })).rejects.toThrow();
                }
                for (const state of ["queued", "claimed", "running"] as const) {
                    await db.automationRun.create({
                        data: scheduleTriggerRunInput({
                            id: `trigger-invariants-frozen-${state}-${fixture.suffix}`,
                            accountId: fixture.accountId,
                            automationId: fixture.automationId,
                            triggerId,
                            occurrenceKey: `${state[0]}${"C".repeat(42)}`,
                            state,
                        }),
                        select: { id: true },
                    });
                }
                // The approved historical allowance is exactly the canonical
                // terminal-state set owned by automationTypes: every terminal
                // state may retain a null execution input, and no other state may.
                for (const [index, terminalState] of AUTOMATION_RUN_TERMINAL_STATES.entries()) {
                    await db.automationRun.create({
                        data: scheduleTriggerRunInput({
                            id: `trigger-invariants-terminal-null-input-${terminalState}-${fixture.suffix}`,
                            accountId: fixture.accountId,
                            automationId: fixture.automationId,
                            triggerId,
                            occurrenceKey: `${String.fromCharCode(69 + index)}${"D".repeat(42)}`,
                            state: terminalState,
                            executionInputEnvelope: null,
                        }),
                        select: { id: true },
                    });
                }
            } finally {
                await fixture.cleanup();
            }
        });

        it("keeps the trigger, manual, and conversation cause arms mutually exclusive", async () => {
            const fixture = await createMigrationInvariantFixture();
            try {
                const triggerId = `trigger-invariants-cause-${fixture.suffix}`;
                await db.automationTrigger.create({
                    data: {
                        id: triggerId,
                        automationId: fixture.automationId,
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                        revision: 1,
                    },
                    select: { id: true },
                });
                const now = new Date();

                // Trigger cause without an occurrence key cannot be persisted.
                const missingKeyInput = scheduleTriggerRunInput({
                    id: `trigger-invariants-cause-missing-key-${fixture.suffix}`,
                    accountId: fixture.accountId,
                    automationId: fixture.automationId,
                    triggerId,
                    occurrenceKey: "E".repeat(43),
                });
                await expect(db.automationRun.create({
                    data: { ...missingKeyInput, occurrenceKey: null },
                    select: { id: true },
                })).rejects.toThrow();

                // A trigger cause can never carry the released manual idempotency key.
                await expect(db.automationRun.create({
                    data: {
                        ...scheduleTriggerRunInput({
                            id: `trigger-invariants-cause-manual-key-${fixture.suffix}`,
                            accountId: fixture.accountId,
                            automationId: fixture.automationId,
                            triggerId,
                            occurrenceKey: "F".repeat(43),
                        }),
                        legacyManualIdempotencyKey: "released-manual-key",
                    },
                    select: { id: true },
                })).rejects.toThrow();

                // Manual cause: no trigger identity and no occurrence key.
                await expect(db.automationRun.create({
                    data: {
                        id: `trigger-invariants-manual-with-trigger-${fixture.suffix}`,
                        automationId: fixture.automationId,
                        accountId: fixture.accountId,
                        causeKind: "manual",
                        triggerId,
                        causeOccurredAt: now,
                        scheduledAt: now,
                        dueAt: now,
                        executionInputEnvelope: '{"t":"plain","v":{}}',
                    },
                    select: { id: true },
                })).rejects.toThrow();
                await expect(db.automationRun.create({
                    data: {
                        id: `trigger-invariants-manual-with-key-${fixture.suffix}`,
                        automationId: fixture.automationId,
                        accountId: fixture.accountId,
                        causeKind: "manual",
                        causeOccurredAt: now,
                        occurrenceKey: "G".repeat(43),
                        scheduledAt: now,
                        dueAt: now,
                        executionInputEnvelope: '{"t":"plain","v":{}}',
                    },
                    select: { id: true },
                })).rejects.toThrow();
                await db.automationRun.create({
                    data: {
                        id: `trigger-invariants-manual-${fixture.suffix}`,
                        automationId: fixture.automationId,
                        accountId: fixture.accountId,
                        causeKind: "manual",
                        causeOccurredAt: now,
                        legacyManualIdempotencyKey: `released-manual-${fixture.suffix}`,
                        scheduledAt: now,
                        dueAt: now,
                        executionInputEnvelope: '{"t":"plain","v":{}}',
                    },
                    select: { id: true },
                });

                // Conversation cause: occurrence key plus complete reply-handoff identity.
                const conversationRunBase = {
                    automationId: fixture.automationId,
                    accountId: fixture.accountId,
                    causeKind: "conversation" as const,
                    causeOccurredAt: now,
                    occurrenceKey: "H".repeat(43),
                    triggerEvidenceEnvelope: '{"t":"plain","v":{}}',
                    executionInputEnvelope: '{"t":"plain","v":{}}',
                    replyContextEnvelope: "reply context",
                    replyHandoffActionPluginId: "plugin",
                    replyHandoffActionLocalId: "action",
                    replyHandoffTargetMachineId: fixture.machineId,
                    replyHandoffTargetMachineInstallationId: "installation",
                    replyHandoffTargetMaterializationId: "materialization",
                    replyHandoffId: "handoff",
                    replyHandoffState: "awaitingResult" as const,
                    scheduledAt: now,
                    dueAt: now,
                };
                await db.automationRun.create({
                    data: {
                        id: `trigger-invariants-conversation-${fixture.suffix}`,
                        ...conversationRunBase,
                    },
                    select: { id: true },
                });
                await expect(db.automationRun.create({
                    data: {
                        id: `trigger-invariants-conversation-manual-key-${fixture.suffix}`,
                        ...conversationRunBase,
                        occurrenceKey: "I".repeat(43),
                        legacyManualIdempotencyKey: "released-manual-key",
                    },
                    select: { id: true },
                })).rejects.toThrow();
                await expect(db.automationRun.create({
                    data: {
                        id: `trigger-invariants-conversation-no-reply-${fixture.suffix}`,
                        ...conversationRunBase,
                        occurrenceKey: "K".repeat(43),
                        replyContextEnvelope: null,
                    },
                    select: { id: true },
                })).rejects.toThrow();
            } finally {
                await fixture.cleanup();
            }
        });

        it("scopes automatic occurrence replay to the exact trigger", async () => {
            const fixture = await createMigrationInvariantFixture();
            try {
                const firstTriggerId = `trigger-invariants-occ-1-${fixture.suffix}`;
                const secondTriggerId = `trigger-invariants-occ-2-${fixture.suffix}`;
                const otherAutomationTriggerId = `trigger-invariants-occ-3-${fixture.suffix}`;
                for (const trigger of [
                    { id: firstTriggerId, automationId: fixture.automationId },
                    { id: secondTriggerId, automationId: fixture.automationId },
                    { id: otherAutomationTriggerId, automationId: fixture.secondAutomationId },
                ]) {
                    await db.automationTrigger.create({
                        data: {
                            id: trigger.id,
                            automationId: trigger.automationId,
                            kind: "schedule",
                            scheduleKind: "interval",
                            everyMs: 60_000,
                            revision: 1,
                        },
                        select: { id: true },
                    });
                }
                const occurrenceEvidence = {
                    v: 1 as const,
                    kind: "schedule" as const,
                    scheduledFor: Date.now(),
                };
                const firstOccurrenceKey = deriveAutomationOccurrenceKeyV1({
                    triggerId: firstTriggerId,
                    evidence: occurrenceEvidence,
                });
                const secondOccurrenceKey = deriveAutomationOccurrenceKeyV1({
                    triggerId: secondTriggerId,
                    evidence: occurrenceEvidence,
                });
                const otherAutomationOccurrenceKey = deriveAutomationOccurrenceKeyV1({
                    triggerId: otherAutomationTriggerId,
                    evidence: occurrenceEvidence,
                });
                expect(new Set([
                    firstOccurrenceKey,
                    secondOccurrenceKey,
                    otherAutomationOccurrenceKey,
                ])).toHaveSize(3);
                await db.automationRun.create({
                    data: scheduleTriggerRunInput({
                        id: `trigger-invariants-occ-first-${fixture.suffix}`,
                        accountId: fixture.accountId,
                        automationId: fixture.automationId,
                        triggerId: firstTriggerId,
                        occurrenceKey: firstOccurrenceKey,
                    }),
                    select: { id: true },
                });

                // Replaying the same trigger occurrence cannot create a second Run.
                let duplicateError: unknown = null;
                try {
                    await db.automationRun.create({
                        data: scheduleTriggerRunInput({
                            id: `trigger-invariants-occ-replay-${fixture.suffix}`,
                            accountId: fixture.accountId,
                            automationId: fixture.automationId,
                            triggerId: firstTriggerId,
                            occurrenceKey: firstOccurrenceKey,
                        }),
                        select: { id: true },
                    });
                } catch (error) {
                    duplicateError = error;
                }
                expect(isPrismaErrorCode(duplicateError, "P2002")).toBe(true);

                // A distinct trigger observing the same upstream fact derives its
                // own trigger-scoped occurrence key and admits independently.
                await db.automationRun.create({
                    data: scheduleTriggerRunInput({
                        id: `trigger-invariants-occ-second-trigger-${fixture.suffix}`,
                        accountId: fixture.accountId,
                        automationId: fixture.automationId,
                        triggerId: secondTriggerId,
                        occurrenceKey: secondOccurrenceKey,
                    }),
                    select: { id: true },
                });

                // A second definition's trigger derives and retains its own key.
                await db.automationRun.create({
                    data: scheduleTriggerRunInput({
                        id: `trigger-invariants-occ-other-automation-${fixture.suffix}`,
                        accountId: fixture.accountId,
                        automationId: fixture.secondAutomationId,
                        triggerId: otherAutomationTriggerId,
                        occurrenceKey: otherAutomationOccurrenceKey,
                    }),
                    select: { id: true },
                });
                const retained = await db.automationRun.findMany({
                    where: { accountId: fixture.accountId },
                    select: { triggerId: true, occurrenceKey: true },
                    orderBy: { id: "asc" },
                });
                expect(retained).toHaveLength(3);
                expect(retained).toEqual(expect.arrayContaining([
                    { triggerId: firstTriggerId, occurrenceKey: firstOccurrenceKey },
                    { triggerId: secondTriggerId, occurrenceKey: secondOccurrenceKey },
                    { triggerId: otherAutomationTriggerId, occurrenceKey: otherAutomationOccurrenceKey },
                ]));
            } finally {
                await fixture.cleanup();
            }
        });

        it("keeps the exact pluginEvent live and tombstone arms", async () => {
            const fixture = await createMigrationInvariantFixture();
            try {
                const liveBase = {
                    automationId: fixture.automationId,
                    kind: "pluginEvent" as const,
                    enabled: true,
                    revision: 1,
                    eventPluginId: EVENT_PLUGIN_ID,
                    eventLocalId: "repository-event",
                    sourceSelectorId: `trigger-invariants-source-${fixture.suffix}`,
                    sourceContractVersion: 1,
                    definitionEnvelope: '{"t":"plain","v":{}}',
                };

                // checkpointedPull forbids a webhook endpoint identity.
                await expect(db.automationTrigger.create({
                    data: {
                        id: `trigger-invariants-pull-webhook-${fixture.suffix}`,
                        ...liveBase,
                        observationTransport: "checkpointedPull",
                        webhookEndpointId: "endpoint",
                    },
                    select: { id: true },
                })).rejects.toThrow();

                // checkpointedPull requires the watcher identity to be complete or absent.
                await expect(db.automationTrigger.create({
                    data: {
                        id: `trigger-invariants-pull-partial-watcher-${fixture.suffix}`,
                        ...liveBase,
                        observationTransport: "checkpointedPull",
                        watcherMachineId: fixture.machineId,
                    },
                    select: { id: true },
                })).rejects.toThrow();
                const pullTriggerId = `trigger-invariants-pull-watcher-${fixture.suffix}`;
                await db.automationTrigger.create({
                    data: {
                        id: pullTriggerId,
                        ...liveBase,
                        observationTransport: "checkpointedPull",
                        watcherMachineId: fixture.machineId,
                        watcherMachineInstallationId: "installation",
                        watcherPluginId: "plugin",
                        watcherMaterializationId: "materialization",
                    },
                    select: { id: true },
                });

                // durablePush requires the webhook endpoint and observation start.
                await expect(db.automationTrigger.create({
                    data: {
                        id: `trigger-invariants-push-no-webhook-${fixture.suffix}`,
                        ...liveBase,
                        observationTransport: "durablePush",
                        observationStartsAt: new Date(),
                    },
                    select: { id: true },
                })).rejects.toThrow();
                const durableTriggerId = `trigger-invariants-push-${fixture.suffix}`;
                await db.automationTrigger.create({
                    data: {
                        id: durableTriggerId,
                        ...liveBase,
                        observationTransport: "durablePush",
                        webhookEndpointId: "endpoint",
                        observationStartsAt: new Date(),
                    },
                    select: { id: true },
                });

                // A live pluginEvent trigger can never carry Session lifecycle facts.
                await expect(db.automationTrigger.create({
                    data: {
                        id: `trigger-invariants-event-lifecycle-${fixture.suffix}`,
                        ...liveBase,
                        observationTransport: "checkpointedPull",
                        sessionLifecycleEvent: "parentTurnCompleted",
                        sourceSessionId: "session",
                        sourceTurnId: "turn",
                    },
                    select: { id: true },
                })).rejects.toThrow();

                // Half-scrubbed deletion attempts are rejected: the tombstone
                // arm is all-or-none per transport, so a deletion that leaves
                // any private observation fact behind cannot be persisted.
                const deletedAt = new Date();
                const halfScrubbedDeletionAttempts: ReadonlyArray<Readonly<{
                    id: string;
                    transport: "checkpointedPull" | "durablePush";
                    retain: Partial<{
                        observationTransport: "checkpointedPull" | "durablePush";
                        watcherMaterializationId: string;
                        webhookEndpointId: string;
                        observationStartsAt: Date;
                    }>;
                }>> = [
                    {
                        id: `trigger-invariants-halfscrub-pull-transport-${fixture.suffix}`,
                        transport: "checkpointedPull",
                        retain: { observationTransport: "checkpointedPull" },
                    },
                    {
                        id: `trigger-invariants-halfscrub-pull-watcher-${fixture.suffix}`,
                        transport: "checkpointedPull",
                        retain: { watcherMaterializationId: "materialization" },
                    },
                    {
                        id: `trigger-invariants-halfscrub-push-endpoint-${fixture.suffix}`,
                        transport: "durablePush",
                        retain: { webhookEndpointId: "endpoint" },
                    },
                    {
                        id: `trigger-invariants-halfscrub-push-start-${fixture.suffix}`,
                        transport: "durablePush",
                        retain: { observationStartsAt: new Date() },
                    },
                ];
                for (const halfScrub of halfScrubbedDeletionAttempts) {
                    await db.automationTrigger.create({
                        data: {
                            id: halfScrub.id,
                            ...liveBase,
                            observationTransport: halfScrub.transport,
                            ...(halfScrub.transport === "checkpointedPull"
                                ? {
                                    watcherMachineId: fixture.machineId,
                                    watcherMachineInstallationId: "installation",
                                    watcherPluginId: "plugin",
                                    watcherMaterializationId: "materialization",
                                }
                                : {
                                    webhookEndpointId: "endpoint",
                                    observationStartsAt: new Date(),
                                }),
                        },
                        select: { id: true },
                    });
                    await expect(db.automationTrigger.update({
                        where: { id: halfScrub.id },
                        data: {
                            enabled: false,
                            deletedAt,
                            definitionEnvelope: null,
                            observationTransport: null,
                            webhookEndpointId: null,
                            observationStartsAt: null,
                            watcherMachineId: null,
                            watcherMachineInstallationId: null,
                            watcherPluginId: null,
                            watcherMaterializationId: null,
                            ...halfScrub.retain,
                        },
                        select: { id: true },
                    })).rejects.toThrow();
                }

                // Tombstones: identity is retained, private observation state is
                // scrubbed; both observation transports accept the one canonical
                // tombstone arm.
                for (const triggerId of [pullTriggerId, durableTriggerId]) {
                    await db.automationTrigger.update({
                        where: { id: triggerId },
                        data: {
                            enabled: false,
                            deletedAt,
                            definitionEnvelope: null,
                            observationTransport: null,
                            webhookEndpointId: null,
                            observationStartsAt: null,
                            watcherMachineId: null,
                            watcherMachineInstallationId: null,
                            watcherPluginId: null,
                            watcherMaterializationId: null,
                        },
                        select: { id: true },
                    });
                }
                const expectCanonicalTombstone = async (triggerId: string): Promise<void> => {
                    const tombstone = await db.automationTrigger.findUniqueOrThrow({
                        where: { id: triggerId },
                        select: {
                            enabled: true,
                            deletedAt: true,
                            eventPluginId: true,
                            eventLocalId: true,
                            sourceSelectorId: true,
                            sourceContractVersion: true,
                            definitionEnvelope: true,
                            observationTransport: true,
                            webhookEndpointId: true,
                            observationStartsAt: true,
                            watcherMachineId: true,
                            watcherMaterializationId: true,
                        },
                    });
                    expect(tombstone).toEqual({
                        enabled: false,
                        deletedAt,
                        eventPluginId: EVENT_PLUGIN_ID,
                        eventLocalId: "repository-event",
                        sourceSelectorId: `trigger-invariants-source-${fixture.suffix}`,
                        sourceContractVersion: 1,
                        definitionEnvelope: null,
                        observationTransport: null,
                        webhookEndpointId: null,
                        observationStartsAt: null,
                        watcherMachineId: null,
                        watcherMaterializationId: null,
                    });
                };
                await expectCanonicalTombstone(pullTriggerId);
                await expectCanonicalTombstone(durableTriggerId);

                // A tombstone cannot regain private observation state.
                await expect(db.automationTrigger.update({
                    where: { id: durableTriggerId },
                    data: { definitionEnvelope: '{"t":"plain","v":{}}' },
                    select: { id: true },
                })).rejects.toThrow();

                // A non-pluginEvent tombstone must also drop its kind identity.
                const scheduleTriggerId = `trigger-invariants-tombstone-schedule-${fixture.suffix}`;
                await db.automationTrigger.create({
                    data: {
                        id: scheduleTriggerId,
                        automationId: fixture.automationId,
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                        revision: 1,
                    },
                    select: { id: true },
                });
                await expect(db.automationTrigger.update({
                    where: { id: scheduleTriggerId },
                    data: {
                        enabled: false,
                        deletedAt,
                        scheduleExpr: null,
                        everyMs: null,
                        nextRunAt: null,
                    },
                    select: { id: true },
                })).rejects.toThrow();
                await db.automationTrigger.update({
                    where: { id: scheduleTriggerId },
                    data: {
                        enabled: false,
                        deletedAt,
                        scheduleKind: null,
                        scheduleExpr: null,
                        everyMs: null,
                        timezone: null,
                        nextRunAt: null,
                    },
                    select: { id: true },
                });

                // The Session lifecycle live arm requires the exact-turn scope.
                await expect(db.automationTrigger.create({
                    data: {
                        id: `trigger-invariants-lifecycle-missing-turn-${fixture.suffix}`,
                        automationId: fixture.automationId,
                        kind: "sessionLifecycle",
                        revision: 1,
                        sessionLifecycleEvent: "parentTurnCompleted",
                        sourceSessionId: "session",
                    },
                    select: { id: true },
                })).rejects.toThrow();
                await db.automationTrigger.create({
                    data: {
                        id: `trigger-invariants-lifecycle-${fixture.suffix}`,
                        automationId: fixture.automationId,
                        kind: "sessionLifecycle",
                        revision: 1,
                        sessionLifecycleEvent: "parentTurnCompleted",
                        sourceSessionId: "session",
                        sourceTurnId: "turn",
                    },
                    select: { id: true },
                });
            } finally {
                await fixture.cleanup();
            }
        });

        it("requires reporter generation provenance on source and catalog status", async () => {
            const fixture = await createMigrationInvariantFixture();
            try {
                const triggerId = `trigger-invariants-provenance-${fixture.suffix}`;
                await db.automationTrigger.create({
                    data: {
                        id: triggerId,
                        automationId: fixture.automationId,
                        kind: "pluginEvent",
                        revision: 1,
                        eventPluginId: EVENT_PLUGIN_ID,
                        eventLocalId: "repository-event",
                        sourceSelectorId: `trigger-invariants-provenance-source-${fixture.suffix}`,
                        sourceContractVersion: 1,
                        observationTransport: "checkpointedPull",
                        definitionEnvelope: '{"t":"plain","v":{}}',
                    },
                    select: { id: true },
                });

                const quote = (name: string) => (provider === "mysql" ? `\`${name}\`` : `"${name}"`);
                await expect(db.$executeRawUnsafe(
                    `INSERT INTO ${quote("AutomationEventSourceStatus")} (`
                    + `${quote("triggerId")}, ${quote("eventPluginId")}, ${quote("eventLocalId")}, `
                    + `${quote("sourceSelectorId")}, ${quote("triggerRevision")}, ${quote("reporterMachineId")}, `
                    + `${quote("reporterMachineInstallationId")}, ${quote("reporterMaterializationId")}, ${quote("state")}) VALUES (`
                    + `'${triggerId}', '${EVENT_PLUGIN_ID}', 'repository-event', 'source', 1, 'machine', 'installation', `
                    + `'materialization', 'observing')`,
                )).rejects.toThrow();
                await expect(db.$executeRawUnsafe(
                    `INSERT INTO ${quote("AutomationEventSourceCatalogStatus")} (`
                    + `${quote("accountId")}, ${quote("eventPluginId")}, ${quote("reporterMachineId")}, `
                    + `${quote("reporterMachineInstallationId")}, ${quote("reporterMaterializationId")}, `
                    + `${quote("scopeKey")}, ${quote("observedRevision")}, ${quote("state")}, ${quote("reportedAt")}) VALUES (`
                    + `'${fixture.accountId}', '${EVENT_PLUGIN_ID}', 'machine', 'installation', 'materialization', `
                    + `'checkpointedPull', 1, 'current', CURRENT_TIMESTAMP)`,
                )).rejects.toThrow();

                // With the exact reporter generation identity both rows persist.
                await db.automationEventSourceStatus.create({
                    data: {
                        triggerId,
                        eventPluginId: EVENT_PLUGIN_ID,
                        eventLocalId: "repository-event",
                        sourceSelectorId: `trigger-invariants-provenance-source-${fixture.suffix}`,
                        triggerRevision: 1,
                        reporterMachineId: fixture.machineId,
                        reporterMachineInstallationId: "installation",
                        reporterMaterializationId: "materialization",
                        reporterImmutableGenerationId: `trigger-invariants-generation-${fixture.suffix}`,
                        state: "observing",
                    },
                    select: { triggerId: true },
                });
                await db.automationEventSourceCatalogStatus.create({
                    data: {
                        accountId: fixture.accountId,
                        eventPluginId: EVENT_PLUGIN_ID,
                        reporterMachineId: fixture.machineId,
                        reporterMachineInstallationId: "installation",
                        reporterMaterializationId: "materialization",
                        reporterImmutableGenerationId: `trigger-invariants-generation-${fixture.suffix}`,
                        scopeKey: "checkpointedPull",
                        observedRevision: 1,
                        state: "current",
                        reportedAt: new Date(),
                    },
                    select: { accountId: true },
                });
            } finally {
                await fixture.cleanup();
            }
        });

        it("keeps case-variant author plugin identities distinct in SQL equality", async () => {
            const fixture = await createMigrationInvariantFixture();
            try {
                const caseVariantPluginId = "com.happier.Trigger-Migration-Invariants";
                expect(caseVariantPluginId).not.toBe(EVENT_PLUGIN_ID);
                expect(caseVariantPluginId.toLowerCase()).toBe(EVENT_PLUGIN_ID.toLowerCase());

                // Live pluginEvent triggers keep distinct author identities:
                // a stored-definition or event lookup for one plugin must never
                // fold onto the other plugin's trigger rows.
                for (const [variant, pluginId] of [
                    ["lower", EVENT_PLUGIN_ID],
                    ["variant", caseVariantPluginId],
                ] as const) {
                    await db.automationTrigger.create({
                        data: {
                            id: `trigger-invariants-identity-${variant}-${fixture.suffix}`,
                            automationId: fixture.automationId,
                            kind: "pluginEvent",
                            revision: 1,
                            eventPluginId: pluginId,
                            eventLocalId: "repository-event",
                            sourceSelectorId: `trigger-invariants-identity-source-${variant}-${fixture.suffix}`,
                            sourceContractVersion: 1,
                            observationTransport: "checkpointedPull",
                            definitionEnvelope: '{"t":"plain","v":{}}',
                        },
                        select: { id: true },
                    });
                }
                const matched = await db.automationTrigger.findMany({
                    where: { automationId: fixture.automationId, eventPluginId: EVENT_PLUGIN_ID },
                    select: { eventPluginId: true },
                });
                expect(matched).toEqual([{ eventPluginId: EVENT_PLUGIN_ID }]);

                // Catalog-status primary keys must not fold the two distinct
                // plugin IDs into one row for the same scope and reporter.
                const shared = {
                    accountId: fixture.accountId,
                    reporterMachineId: fixture.machineId,
                    reporterMachineInstallationId: "installation",
                    reporterMaterializationId: "materialization",
                    reporterImmutableGenerationId: `trigger-invariants-identity-generation-${fixture.suffix}`,
                    scopeKey: "checkpointedPull",
                    observedRevision: 1n,
                    state: "current" as const,
                    reportedAt: new Date(),
                };
                await db.automationEventSourceCatalogStatus.create({
                    data: { ...shared, eventPluginId: EVENT_PLUGIN_ID },
                    select: { eventPluginId: true },
                });
                await db.automationEventSourceCatalogStatus.create({
                    data: { ...shared, eventPluginId: caseVariantPluginId },
                    select: { eventPluginId: true },
                });
                const retained = await db.automationEventSourceCatalogStatus.findMany({
                    where: { accountId: fixture.accountId },
                    select: { eventPluginId: true },
                });
                expect(retained.map((row) => row.eventPluginId).sort()).toEqual(
                    [caseVariantPluginId, EVENT_PLUGIN_ID].sort(),
                );
            } finally {
                await fixture.cleanup();
            }
        });
    },
);
