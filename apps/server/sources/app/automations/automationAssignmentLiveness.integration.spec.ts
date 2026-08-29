import { createHash, randomUUID } from "node:crypto";

import {
    AutomationTriggerIdSchema,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
    type AutomationRunCause,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { runAutomationNow } from "./automationCrudService";
import { admitAutomationRunTx } from "./automationRunAdmissionService";
import { admitDueAutomationScheduleTriggerTx } from "./automationRunQueueService";
import { admitCompletedParentTurnAutomationRunsTx } from "./automationSessionLifecycleAdmission";

/**
 * Assignment-liveness defense in depth. The definition writers reject an
 * enabled Automation with zero enabled assignments transactionally; these
 * tests prove the canonical Run admission owner also refuses such corrupted or
 * raced legacy state with one typed ineligible result and creates no Run, for
 * every cause whose frozen assignment snapshot would otherwise be permanently
 * unclaimable — schedule, pluginEvent, exact-turn, manual, and Conversation.
 */

function storedRecipe(templateVersion: number): string {
    const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: "Assignment liveness recipe" } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-assignment-liveness",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") throw new Error("Test recipe did not serialize");
    return serialized.serialized;
}

function occurrenceKey(): string {
    return createHash("sha256").update(randomUUID()).digest("base64url");
}

describe("automation assignment liveness (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-assignment-liveness-",
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRunAssignment.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    async function createAccount(): Promise<string> {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        return account.id;
    }

    /**
     * Seeds the corrupted state the definition writers now prevent: an enabled
     * Automation whose execution-assignment set is empty, plus an optional
     * enabled trigger row.
     */
    async function seedEnabledAutomationWithZeroEnabledAssignments(params: Readonly<{
        accountId: string;
        trigger?: Readonly<{
            kind: "schedule" | "pluginEvent" | "sessionLifecycle";
            nextRunAt?: Date;
            sourceSessionId?: string;
            sourceTurnId?: string;
        }>;
    }>): Promise<{ automationId: string; triggerId: string | null }> {
        const automationId = `automation-${randomUUID()}`;
        const triggerId = params.trigger
            ? AutomationTriggerIdSchema.parse(randomUUID())
            : null;
        await db.automation.create({
            data: {
                id: automationId,
                accountId: params.accountId,
                name: "Corrupted zero-assignment definition",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: storedRecipe(1),
                templateVersion: 1,
                triggers: params.trigger && triggerId
                    ? {
                        create: {
                            id: triggerId,
                            kind: params.trigger.kind,
                            enabled: true,
                            revision: 0,
                            ...(params.trigger.kind === "schedule"
                                ? {
                                    scheduleKind: "interval" as const,
                                    everyMs: 60_000,
                                    nextRunAt: params.trigger.nextRunAt ?? null,
                                }
                                : {}),
                            ...(params.trigger.kind === "pluginEvent"
                                ? {
                                    eventPluginId: "happier.test",
                                    eventLocalId: "liveness-event",
                                    sourceSelectorId: randomUUID(),
                                    sourceContractVersion: 1,
                                    observationTransport: "checkpointedPull" as const,
                                    watcherMachineId: "watcher-machine",
                                    watcherMachineInstallationId: "watcher-installation",
                                    watcherPluginId: "happier.test",
                                    watcherMaterializationId: "watcher-materialization",
                                    definitionEnvelope: "{}",
                                }
                                : {}),
                            ...(params.trigger.kind === "sessionLifecycle"
                                ? {
                                    sessionLifecycleEvent: "parentTurnCompleted" as const,
                                    sourceSessionId: params.trigger.sourceSessionId ?? null,
                                    sourceTurnId: params.trigger.sourceTurnId ?? null,
                                }
                                : {}),
                        },
                    }
                    : undefined,
            },
            select: { id: true },
        });
        return { automationId, triggerId };
    }

    it("creates no Run for corrupted state across every cause at the canonical admission owner", async () => {
        const accountId = await createAccount();
        const now = new Date("2026-08-29T12:00:00.000Z");
        const occurredAt = now.getTime();

        const bare = await seedEnabledAutomationWithZeroEnabledAssignments({ accountId });
        const scheduled = await seedEnabledAutomationWithZeroEnabledAssignments({
            accountId,
            trigger: { kind: "schedule", nextRunAt: now },
        });
        const event = await seedEnabledAutomationWithZeroEnabledAssignments({
            accountId,
            trigger: { kind: "pluginEvent" },
        });

        const causes: ReadonlyArray<{
            label: string;
            automationId: string;
            cause: AutomationRunCause;
        }> = [
            {
                label: "manual",
                automationId: bare.automationId,
                cause: { kind: "manual", invokedAt: occurredAt },
            },
            {
                label: "conversation",
                automationId: bare.automationId,
                cause: {
                    kind: "conversation",
                    occurrenceKey: occurrenceKey(),
                    occurredAt,
                },
            },
            {
                label: "schedule trigger",
                automationId: scheduled.automationId,
                cause: {
                    kind: "trigger",
                    triggerId: scheduled.triggerId!,
                    triggerRevision: 0,
                    triggerKind: "schedule",
                    occurrenceKey: occurrenceKey(),
                    occurredAt,
                    evidence: { scheduledFor: occurredAt },
                },
            },
            {
                label: "pluginEvent trigger",
                automationId: event.automationId,
                cause: {
                    kind: "trigger",
                    triggerId: event.triggerId!,
                    triggerRevision: 0,
                    triggerKind: "pluginEvent",
                    occurrenceKey: occurrenceKey(),
                    occurredAt,
                    evidence: {
                        eventRef: { pluginId: "happier.test", localId: "liveness-event" },
                        sourceSelectorId: randomUUID(),
                    },
                },
            },
        ];

        for (const candidate of causes) {
            const result = await inTx(async (tx) => await admitAutomationRunTx({
                tx,
                accountId,
                automationId: candidate.automationId,
                now,
                cause: candidate.cause,
                ...(candidate.cause.kind === "trigger" && candidate.cause.triggerKind === "pluginEvent"
                    ? { triggerEvidenceEnvelope: JSON.stringify({ v: 1, kind: "liveness" }) }
                    : {}),
            }));
            expect(result).toEqual({ kind: "ineligible", reason: "noEnabledAssignment" });
        }
        await expect(db.automationRun.count({ where: { accountId } })).resolves.toBe(0);
    });

    it("admits no schedule Run through the due-cursor owner when no enabled assignment exists", async () => {
        const accountId = await createAccount();
        const now = new Date("2026-08-29T12:00:00.000Z");
        const { automationId, triggerId } = await seedEnabledAutomationWithZeroEnabledAssignments({
            accountId,
            trigger: { kind: "schedule", nextRunAt: now },
        });

        const result = await inTx(async (tx) => await admitDueAutomationScheduleTriggerTx({
            tx,
            triggerId: triggerId!,
            expectedRevision: 0,
            expectedNextRunAt: now,
            now,
        }));

        expect(result).toBeNull();
        await expect(db.automationRun.count({ where: { automationId } })).resolves.toBe(0);
    });

    it("admits no exact-turn Run and leaves terminal truth untouched when no enabled assignment exists", async () => {
        const accountId = await createAccount();
        const suffix = randomUUID();
        const sourceSessionId = `session-${suffix}`;
        const sourceTurnId = `turn-${suffix}`;
        await db.session.create({
            data: {
                id: sourceSessionId,
                tag: `liveness-${suffix}`,
                accountId,
                encryptionMode: "e2ee",
                metadata: "{}",
                latestTurnId: sourceTurnId,
                latestTurnStatus: "completed",
            },
        });
        await db.sessionTurn.create({
            data: {
                sessionId: sourceSessionId,
                turnId: sourceTurnId,
                status: "completed",
                startedAt: 1n,
                updatedAt: 1n,
            },
        });
        const { automationId } = await seedEnabledAutomationWithZeroEnabledAssignments({
            accountId,
            trigger: { kind: "sessionLifecycle", sourceSessionId, sourceTurnId },
        });
        const occurredAt = Date.now();

        const results = await inTx(async (tx) => await admitCompletedParentTurnAutomationRunsTx({
            tx,
            accountId,
            sourceSessionId,
            sourceTurnId,
            occurredAt,
        }));

        expect(results).toHaveLength(1);
        expect(results[0]!.result).toEqual({ kind: "ineligible", reason: "noEnabledAssignment" });
        await expect(db.automationRun.count({ where: { automationId } })).resolves.toBe(0);
    });

    it("rejects Run Now with a typed error and creates no Run when no enabled assignment exists", async () => {
        const accountId = await createAccount();
        const { automationId } = await seedEnabledAutomationWithZeroEnabledAssignments({ accountId });

        await expect(runAutomationNow({ accountId, automationId })).rejects.toMatchObject({
            name: "AutomationValidationError",
            message: expect.stringContaining("noEnabledAssignment"),
        });
        await expect(db.automationRun.count({ where: { automationId } })).resolves.toBe(0);
    });

    it("keeps an already-admitted Run on its immutable snapshot when assignments later vanish", async () => {
        const accountId = await createAccount();
        const machineId = `execution-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId, metadata: "{}" } });
        const automationId = `automation-${randomUUID()}`;
        await db.automation.create({
            data: {
                id: automationId,
                accountId,
                name: "Rejoin snapshot",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: storedRecipe(1),
                templateVersion: 1,
            },
            select: { id: true },
        });
        await db.automationAssignment.create({
            data: { automationId, machineId, enabled: true, priority: 0 },
        });

        const admitted = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "liveness-rejoin",
        });
        expect(admitted).toMatchObject({ state: "queued", causeKind: "manual" });

        // Simulated corruption/raced legacy mutation the writers now prevent.
        await db.automationAssignment.deleteMany({ where: { automationId } });

        const rejoined = await runAutomationNow({
            accountId,
            automationId,
            idempotencyKey: "liveness-rejoin",
        });
        expect(rejoined?.id).toBe(admitted!.id);
        await expect(db.automationRun.count({ where: { automationId } })).resolves.toBe(1);
        await expect(db.automationRunAssignment.findMany({
            where: { runId: admitted!.id },
            select: { machineId: true },
        })).resolves.toEqual([{ machineId }]);
    });
});
