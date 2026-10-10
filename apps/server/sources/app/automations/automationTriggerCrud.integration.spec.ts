import { randomUUID } from "node:crypto";

import {
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationStoredWorkflowDefinitionRecipeV2Schema,
    AutomationTriggerIdSchema,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createAutomationWorkflowRecipeFixture } from "@/testkit/automationWorkflowRecipe";

import {
    createAutomation,
    deleteAutomationTrigger,
    listAutomationRuns,
    reconcileAutomationDefinition,
    runAutomationNow,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { AutomationSessionLifecycleRegistrationValidationError } from "./automationSessionLifecycleRegistration";
import { encodeAutomationSessionLifecycleConfiguration } from "./automationSessionLifecycleConfigurationCodec";
import { runAutomationScheduleWorkerPass } from "./automationScheduleWorker";

function executionRecipe(templateVersion: number) {
    return createAutomationWorkflowRecipeFixture({ templateVersion,
        directory: "/tmp/automation-trigger-set", prompt: `Trigger-set recipe ${templateVersion}` });
}

function intervalDefinition(everyMs: number) {
    return {
        kind: "schedule" as const,
        schedule: {
            kind: "interval" as const,
            scheduleExpr: null,
            everyMs,
            timezone: null,
        },
    };
}

function intervalTrigger(everyMs: number) {
    return { ...intervalDefinition(everyMs), enabled: true };
}

function automationTriggerId() {
    return AutomationTriggerIdSchema.parse(randomUUID());
}

function lifecycleDefinition(params: Readonly<{
    sourceSessionId: string;
    sourceTurnId: string;
}>) {
    return {
        kind: "sessionLifecycle" as const,
        sourceSessionId: params.sourceSessionId,
        events: ["parentTurnCompleted"] as ["parentTurnCompleted"],
        policy: { kind: "currentTurn" as const, sourceTurnId: params.sourceTurnId },
    };
}

function lifecycleTrigger(params: Readonly<{
    sourceSessionId: string;
    sourceTurnId: string;
    enabled: boolean;
}>) {
    return {
        ...lifecycleDefinition(params),
        enabled: params.enabled,
    };
}

function boundedLifecycleDefinition(params: Readonly<{
    sourceSessionId: string;
    events: Array<"parentTurnCompleted" | "parentTurnFailed" | "parentTurnCancelled" | "userActionRequired">;
    count: number;
}>) {
    return {
        kind: "sessionLifecycle" as const,
        sourceSessionId: params.sourceSessionId,
        events: params.events,
        policy: { kind: "nextMatches" as const, count: params.count },
    };
}

function existingSessionExecutionRecipe(templateVersion: number, sessionId: string, machineId: string) {
    return createAutomationWorkflowRecipeFixture({ templateVersion,
        directory: "/tmp/automation-trigger-set", prompt: `Retarget lifecycle recipe ${templateVersion}`,
        conversation: { kind: "existing_session", sessionId, machineId } });
}

async function seedHistoricalSameSourceAutomation(accountId: string, source: Readonly<{ sessionId: string; turnId: string }>) {
    // Never-current strict V1 data remains readable; it is not authored through a current writer.
    const recipe = AutomationStoredDefinitionExecutionRecipeV1Schema.parse({ v: 1, templateVersion: 1,
        template: { t: "plain", v: { v: 1, prompt: "Historical lifecycle target" } }, triggerEvidence: null,
        target: { kind: "existingSession", sessionId: source.sessionId } });
    return db.automation.create({ data: { id: randomUUID(), accountId, name: "Historical same-source target", enabled: false,
        targetType: "existing_session", templateVersion: 1, templateCiphertext: JSON.stringify(recipe),
        triggers: { create: { id: randomUUID(), kind: "sessionLifecycle", enabled: true,
            ...encodeAutomationSessionLifecycleConfiguration(lifecycleDefinition({
                sourceSessionId: source.sessionId, sourceTurnId: source.turnId,
            })) } },
    }, include: { triggers: true } });
}

/** Creates one account machine for enabled-Automation assignment fixtures. */
async function seedExecutionMachine(accountId: string): Promise<string> {
    const machineId = `execution-machine-${randomUUID()}`;
    await db.machine.create({
        data: { id: machineId, accountId, metadata: "{}" },
    });
    return machineId;
}

async function seedActiveSourceTurn(accountId: string) {
    const suffix = randomUUID();
    const sessionId = `source-session-${suffix}`;
    const turnId = `source-turn-${suffix}`;
    await db.session.create({
        data: {
            id: sessionId,
            tag: `source-${suffix}`,
            accountId,
            encryptionMode: "e2ee",
            metadata: "opaque-source-metadata",
            latestTurnId: turnId,
            latestTurnStatus: "in_progress",
        },
    });
    await db.sessionTurn.create({
        data: {
            sessionId,
            turnId,
            status: "in_progress",
            startedAt: 1n,
            updatedAt: 1n,
        },
    });
    return { sessionId, turnId };
}

describe("automation trigger-set CRUD", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-trigger-crud-",
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.sessionTurnMutationReceipt.deleteMany(),
            () => db.sessionTurn.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("allows a zero-trigger Automation to run directly without inventing a trigger row", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Direct only",
                enabled: true,
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [],
            },
        });
        expect(created.triggers).toEqual([]);

        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
        })).resolves.toMatchObject({
            triggerId: null,
            causeKind: "manual",
            causeTriggerKind: null,
        });
        await expect(db.automationTrigger.count({
            where: { automationId: created.id },
        })).resolves.toBe(0);
    });

    it("keeps independent trigger identity and state across recipe and trigger edits", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Two schedules",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(60_000) },
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(120_000) },
                ],
            },
        });

        expect(created.triggers).toHaveLength(2);
        const first = created.triggers.find((trigger) => trigger.everyMs === 60_000);
        const second = created.triggers.find((trigger) => trigger.everyMs === 120_000);
        expect(first).toMatchObject({ kind: "schedule", revision: 0, everyMs: 60_000 });
        expect(second).toMatchObject({ kind: "schedule", revision: 0, everyMs: 120_000 });

        const retainedNextRunAt = new Date("2026-08-27T12:00:00.000Z");
        await db.automationTrigger.update({
            where: { id: first!.id },
            data: { nextRunAt: retainedNextRunAt },
        });

        const recipeEdited = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: { executionRecipe: executionRecipe(2) },
        });
        expect(recipeEdited?.triggers.map(({ id, revision }) => ({ id, revision })))
            .toEqual(created.triggers.map(({ id, revision }) => ({ id, revision })));
        expect(recipeEdited?.triggers.find((trigger) => trigger.id === first!.id)?.nextRunAt)
            .toEqual(retainedNextRunAt);

        const unchangedTrigger = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: first!.id,
            expectedRevision: first!.revision,
            trigger: intervalDefinition(60_000),
        });
        expect(unchangedTrigger?.triggers.find((trigger) => trigger.id === first!.id)).toMatchObject({
            id: first!.id,
            revision: first!.revision,
            nextRunAt: retainedNextRunAt,
        });

        const triggerEdited = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: first!.id,
            expectedRevision: first!.revision,
            trigger: intervalDefinition(180_000),
        });
        expect(triggerEdited?.triggers).toHaveLength(2);
        expect(triggerEdited?.triggers.find((trigger) => trigger.id === first!.id)).toMatchObject({
            id: first!.id,
            revision: 1,
            everyMs: 180_000,
        });
        expect(triggerEdited?.triggers.find((trigger) => trigger.id === second!.id)).toMatchObject({
            id: second!.id,
            revision: 0,
            everyMs: 120_000,
        });
    });

    it("rolls back the whole visible Save when a later trigger row is invalid", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Atomic editor",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(60_000) },
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(120_000) },
                ],
            },
        });
        const [first, second] = created.triggers;
        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Partially applied name",
                description: null,
                enabled: false,
                assignments: [],
                triggers: [
                    {
                        kind: "existing",
                        triggerId: AutomationTriggerIdSchema.parse(first!.id),
                        expectedRevision: first!.revision,
                        enabled: false,
                        trigger: intervalDefinition(180_000),
                    },
                    {
                        kind: "existing",
                        triggerId: AutomationTriggerIdSchema.parse(second!.id),
                        expectedRevision: second!.revision,
                    },
                    {
                        kind: "new",
                        triggerId: automationTriggerId(),
                        trigger: lifecycleTrigger({
                            sourceSessionId: "missing-source-session",
                            sourceTurnId: "missing-source-turn",
                            enabled: true,
                        }),
                    },
                ],
                removedTriggers: [],
            },
        })).rejects.toMatchObject({ code: "sourceSessionUnavailable" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: {
                name: true,
                templateVersion: true,
                triggers: {
                    where: { deletedAt: null },
                    select: { revision: true, everyMs: true },
                },
            },
        })).resolves.toEqual({
            name: "Atomic editor",
            templateVersion: 1,
            triggers: expect.arrayContaining([
                { revision: first!.revision, everyMs: 60_000 },
                { revision: second!.revision, everyMs: 120_000 },
            ]),
        });
    });

    it("keeps an admitted Run's sole cause truthful after its trigger is edited and removed", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Historical schedule cause",
                enabled: true,
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [{ triggerId: automationTriggerId(), trigger: intervalTrigger(60_000) }],
            },
        });
        const trigger = created.triggers[0]!;
        await expect(db.automationRun.count({ where: { automationId: created.id } })).resolves.toBe(0);
        const dueAt = new Date();
        await db.automationTrigger.update({ where: { id: trigger.id }, data: { nextRunAt: dueAt } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const admitted = await db.automationRun.findFirstOrThrow({
            where: { automationId: created.id, triggerId: trigger.id },
            select: {
                id: true,
                triggerId: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
            },
        });
        expect(admitted).toMatchObject({
            triggerId: trigger.id,
            causeKind: "trigger",
            causeTriggerKind: "schedule",
            causeTriggerRevision: trigger.revision,
        });

        const edited = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            trigger: intervalDefinition(120_000),
        });
        const editedTrigger = edited!.triggers[0]!;
        await expect(deleteAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: editedTrigger.id,
            expectedRevision: editedTrigger.revision,
        })).resolves.toEqual(expect.objectContaining({ triggers: [] }));

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: admitted.id },
            select: {
                triggerId: true,
                causeKind: true,
                causeTriggerKind: true,
                causeTriggerRevision: true,
            },
        })).resolves.toEqual({
            triggerId: trigger.id,
            causeKind: "trigger",
            causeTriggerKind: "schedule",
            causeTriggerRevision: trigger.revision,
        });
    });

    it("keeps every admitted queued Run immutable when the Automation is disabled", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Disable all schedules",
                enabled: true,
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(60_000) },
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(120_000) },
                ],
            },
        });
        await expect(db.automationRun.count({
            where: { automationId: created.id, state: "queued" },
        })).resolves.toBe(0);
        await expect(db.automationTrigger.count({
            where: { automationId: created.id, kind: "schedule", nextRunAt: { not: null } },
        })).resolves.toBe(2);

        const dueAt = new Date();
        await db.automationTrigger.updateMany({
            where: { automationId: created.id, kind: "schedule" },
            data: { nextRunAt: dueAt },
        });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        await expect(db.automationRun.count({
            where: { automationId: created.id, state: "queued" },
        })).resolves.toBe(2);

        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { enabled: false },
        })).resolves.toEqual(expect.objectContaining({ enabled: false }));

        await expect(db.automationRun.count({
            where: { automationId: created.id, state: "queued" },
        })).resolves.toBe(2);
        await expect(db.automationRun.count({
            where: { automationId: created.id, state: "cancelled" },
        })).resolves.toBe(0);
    });

    it("revalidates lifecycle source truth only when registration becomes newly effective", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const source = await seedActiveSourceTurn(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Lifecycle registration",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [{
                    triggerId: automationTriggerId(),
                    trigger: lifecycleTrigger({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                        enabled: false,
                    }),
                }],
            },
        });
        const trigger = created.triggers[0]!;

        await db.sessionTurn.update({
            where: { sessionId_turnId: { sessionId: source.sessionId, turnId: source.turnId } },
            data: { status: "completed", terminalAt: 2n, updatedAt: 2n },
        });

        await expect(updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            enabled: false,
            trigger: lifecycleDefinition({
                sourceSessionId: source.sessionId,
                sourceTurnId: source.turnId,
            }),
        })).resolves.toEqual(expect.objectContaining({
            triggers: [expect.objectContaining({ id: trigger.id, enabled: false })],
        }));

        await expect(updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision + 1,
            enabled: true,
        })).rejects.toMatchObject({ code: "sourceTurnNotInProgress" });
    });

    it("rejects stale lifecycle sources while current Workflow targets defer self-target admission to the Workflow owner", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const source = await seedActiveSourceTurn(account.id);
        const staleSource = await seedActiveSourceTurn(account.id);
        await db.sessionTurn.update({
            where: {
                sessionId_turnId: {
                    sessionId: staleSource.sessionId,
                    turnId: staleSource.turnId,
                },
            },
            data: { status: "completed", terminalAt: 2n, updatedAt: 2n },
        });
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Stale lifecycle creation",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [{
                    triggerId: automationTriggerId(),
                    trigger: lifecycleTrigger({
                        sourceSessionId: staleSource.sessionId,
                        sourceTurnId: staleSource.turnId,
                        enabled: true,
                    }),
                }],
            },
        })).rejects.toMatchObject({ code: "sourceTurnNotInProgress" });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Lifecycle retargeting",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [{
                    triggerId: automationTriggerId(),
                    trigger: lifecycleTrigger({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                        enabled: true,
                    }),
                }],
            },
        });
        const trigger = created.triggers[0]!;

        await expect(updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            trigger: lifecycleDefinition({
                sourceSessionId: staleSource.sessionId,
                sourceTurnId: staleSource.turnId,
            }),
        })).rejects.toMatchObject({ code: "sourceTurnNotInProgress" });

        const recipe = existingSessionExecutionRecipe(2, source.sessionId, await seedExecutionMachine(account.id));
        const retargeted = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                executionRecipe: recipe,
            },
        });
        expect(retargeted).toMatchObject({ targetType: null, templateVersion: 2 });
        expect(AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(retargeted!.templateCiphertext))).toEqual(recipe);

        const historical = await seedHistoricalSameSourceAutomation(account.id, source);
        const historicalTrigger = historical.triggers[0]!;
        const retargetError = await updateAutomationTrigger({ accountId: account.id, automationId: historical.id,
            triggerId: historicalTrigger.id, expectedRevision: historicalTrigger.revision,
            trigger: lifecycleDefinition({ sourceSessionId: source.sessionId, sourceTurnId: source.turnId }),
        }).then(() => null, (error: unknown) => error);
        expect(retargetError).toBeInstanceOf(
            AutomationSessionLifecycleRegistrationValidationError,
        );
        expect(retargetError).toMatchObject({ code: "sourceMatchesExecutionTarget" });
    });

    it("retains the historical same-source guard even when the exact-turn trigger patch is unchanged", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const source = await seedActiveSourceTurn(account.id);
        const created = await seedHistoricalSameSourceAutomation(account.id, source);
        const trigger = created.triggers[0]!;

        // The explicit trigger patch resubmits the exact unchanged
        // registration, so registration-freshness alone must not skip the
        // effective source/target inequality proof.
        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: created.name,
                description: null,
                enabled: false,
                assignments: [],
                triggers: [{
                    kind: "existing",
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                    enabled: true,
                    trigger: lifecycleDefinition({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                    }),
                }],
                removedTriggers: [],
            },
        })).rejects.toMatchObject({ code: "sourceMatchesExecutionTarget" });
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { targetType: true, templateVersion: true },
        })).resolves.toMatchObject({ targetType: "existing_session", templateVersion: 1 });
    });

    it("preserves the lifecycle occurrence budget across pause, resume, and reordered Event submissions", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const source = await seedActiveSourceTurn(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Bounded lifecycle budget",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [{
                    triggerId: automationTriggerId(),
                    trigger: {
                        ...boundedLifecycleDefinition({
                            sourceSessionId: source.sessionId,
                            events: ["parentTurnCompleted", "parentTurnFailed"],
                            count: 3,
                        }),
                        enabled: true,
                    },
                }],
            },
        });
        const trigger = created.triggers[0]!;
        // Runtime consumption of two of the three configured matches.
        await db.automationTrigger.update({
            where: { id: trigger.id },
            data: { remainingOccurrences: 1 },
        });

        const paused = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            enabled: false,
        });
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
            select: { remainingOccurrences: true },
        })).resolves.toEqual({ remainingOccurrences: 1 });

        // Resuming with the same Event membership in a different submitted
        // order is the same registration, not a new one.
        const resumed = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: paused!.triggers[0]!.revision,
            enabled: true,
            trigger: boundedLifecycleDefinition({
                sourceSessionId: source.sessionId,
                events: ["parentTurnFailed", "parentTurnCompleted"],
                count: 3,
            }),
        });
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
            select: { remainingOccurrences: true, sessionLifecycleEventsJson: true },
        })).resolves.toEqual({
            remainingOccurrences: 1,
            sessionLifecycleEventsJson: JSON.stringify(["parentTurnCompleted", "parentTurnFailed"]),
        });

        // A changed Event membership is a new registration and restarts the
        // configured budget.
        await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: resumed!.triggers[0]!.revision,
            enabled: true,
            trigger: boundedLifecycleDefinition({
                sourceSessionId: source.sessionId,
                events: ["parentTurnCompleted"],
                count: 3,
            }),
        });
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
            select: { remainingOccurrences: true },
        })).resolves.toEqual({ remainingOccurrences: 3 });
    });

    it("does not block unrelated editor edits on an unchanged terminal exact-turn trigger", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const source = await seedActiveSourceTurn(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Terminal trigger edit",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [{
                    triggerId: automationTriggerId(),
                    trigger: lifecycleTrigger({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                        enabled: true,
                    }),
                }],
            },
        });
        const trigger = created.triggers[0]!;
        await db.sessionTurn.update({
            where: { sessionId_turnId: { sessionId: source.sessionId, turnId: source.turnId } },
            data: { status: "completed", terminalAt: 2n, updatedAt: 2n },
        });

        const edited = await reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Terminal trigger edited",
                description: "Unrelated copy edit",
                enabled: false,
                assignments: [],
                triggers: [{
                    kind: "existing",
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                    enabled: true,
                    trigger: lifecycleDefinition({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                    }),
                }],
                removedTriggers: [],
            },
        });
        expect(edited).toMatchObject({ name: "Terminal trigger edited" });
        expect(edited?.triggers[0]).toMatchObject({
            id: trigger.id,
            enabled: true,
            sourceSessionId: source.sessionId,
            sourceTurnId: source.turnId,
        });
    });

    it("retargets to a present distinct existing-Session target while the unchanged exact-turn registration is retained", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const source = await seedActiveSourceTurn(account.id);
        const target = await seedActiveSourceTurn(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Distinct existing target",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [{
                    triggerId: automationTriggerId(),
                    trigger: lifecycleTrigger({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                        enabled: true,
                    }),
                }],
            },
        });
        const trigger = created.triggers[0]!;

        const retargeted = await reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Distinct existing target",
                description: null,
                enabled: false,
                assignments: [],
                triggers: [{
                    kind: "existing",
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                    enabled: true,
                    trigger: lifecycleDefinition({
                        sourceSessionId: source.sessionId,
                        sourceTurnId: source.turnId,
                    }),
                }],
                removedTriggers: [],
                executionRecipe: existingSessionExecutionRecipe(2, target.sessionId, await seedExecutionMachine(account.id)),
            },
        });
        expect(retargeted).toMatchObject({ targetType: null, templateVersion: 2 });
        const current = AutomationStoredWorkflowDefinitionRecipeV2Schema.parse(JSON.parse(retargeted!.templateCiphertext));
        expect(current.workflow).toMatchObject({ t: "plain", v: { inlineDefinition: { defaults: {
            conversation: { kind: "existing_session", sessionId: target.sessionId },
        } } } });
        expect(retargeted?.triggers[0]).toMatchObject({
            id: trigger.id,
            enabled: true,
            sourceSessionId: source.sessionId,
            sourceTurnId: source.turnId,
        });
    });

    it("pauses and resumes a schedule identically across request shapes without missed backfill", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = await seedExecutionMachine(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Pause shapes",
                enabled: true,
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId }],
                triggers: [{ triggerId: automationTriggerId(), trigger: intervalTrigger(60_000) }],
            },
        });
        const trigger = created.triggers[0]!;
        expect(trigger.nextRunAt).not.toBeNull();

        // Enablement-only pause is the canonical paused shape: cursor null.
        const pausedOnly = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
            enabled: false,
        });
        expect(pausedOnly?.triggers[0]).toMatchObject({
            enabled: false,
            revision: trigger.revision + 1,
            nextRunAt: null,
        });

        // Resuming while redundantly supplying the unchanged definition
        // initializes the cursor from the transaction clock, never backfilling
        // paused time.
        const beforeResume = new Date();
        const resumed = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision + 1,
            enabled: true,
            trigger: intervalDefinition(60_000),
        });
        expect(resumed?.triggers[0]).toMatchObject({ enabled: true });
        expect(resumed?.triggers[0]?.nextRunAt?.getTime() ?? 0)
            .toBeGreaterThanOrEqual(beforeResume.getTime() + 60_000);
        const resumedRevision = resumed!.triggers[0]!.revision;

        // Pausing while redundantly supplying the unchanged definition must
        // produce the same paused shape as the enablement-only patch.
        const pausedWithDefinition = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: resumedRevision,
            enabled: false,
            trigger: intervalDefinition(60_000),
        });
        expect(pausedWithDefinition?.triggers[0]).toMatchObject({
            enabled: false,
            revision: resumedRevision + 1,
            nextRunAt: null,
        });

        // The whole-editor shape follows the same pause contract.
        const reconcilePaused = await reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: pausedWithDefinition!.templateVersion,
                name: "Pause shapes",
                description: null,
                enabled: true,
                assignments: [{ machineId }],
                triggers: [{
                    kind: "existing",
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: pausedWithDefinition!.triggers[0]!.revision,
                    enabled: false,
                    trigger: intervalDefinition(60_000),
                }],
                removedTriggers: [],
            },
        });
        expect(reconcilePaused?.triggers[0]).toMatchObject({
            enabled: false,
            nextRunAt: null,
        });

        // Whole-editor resume also initializes from the transaction clock.
        const beforeReconcileResume = new Date();
        const reconcileResumed = await reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: reconcilePaused!.templateVersion,
                name: "Pause shapes",
                description: null,
                enabled: true,
                assignments: [{ machineId }],
                triggers: [{
                    kind: "existing",
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: reconcilePaused!.triggers[0]!.revision,
                    enabled: true,
                    trigger: intervalDefinition(60_000),
                }],
                removedTriggers: [],
            },
        });
        expect(reconcileResumed?.triggers[0]?.nextRunAt?.getTime() ?? 0)
            .toBeGreaterThanOrEqual(beforeReconcileResume.getTime() + 60_000);

        // A cadence change still resets and reinitializes from now.
        const beforeCadenceEdit = new Date();
        const cadenceEdited = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: trigger.id,
            expectedRevision: reconcileResumed!.triggers[0]!.revision,
            trigger: intervalDefinition(180_000),
        });
        expect(cadenceEdited?.triggers[0]).toMatchObject({ everyMs: 180_000 });
        expect(cadenceEdited?.triggers[0]?.nextRunAt?.getTime() ?? 0)
            .toBeGreaterThanOrEqual(beforeCadenceEdit.getTime() + 180_000);
    });

    it("pages Run history by stable trigger-aware anchors while triggers are edited and removed between reads", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Paged history",
                enabled: true,
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(60_000) },
                    { triggerId: automationTriggerId(), trigger: intervalTrigger(120_000) },
                ],
            },
        });
        const [first, second] = created.triggers;
        const dueAt = new Date();
        await db.automationTrigger.update({ where: { id: first!.id }, data: { nextRunAt: dueAt } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const secondDueAt = new Date(dueAt.getTime() + 1);
        await db.automationTrigger.update({ where: { id: second!.id }, data: { nextRunAt: secondDueAt } });
        await runAutomationScheduleWorkerPass({ now: secondDueAt });
        const manual = await runAutomationNow({ accountId: account.id, automationId: created.id });
        expect(manual).toMatchObject({ triggerId: null, causeKind: "manual" });
        const allRuns = await db.automationRun.findMany({
            where: { automationId: created.id },
            select: { id: true, triggerId: true, causeKind: true, causeTriggerKind: true, causeTriggerRevision: true },
        });
        expect(allRuns).toHaveLength(3);
        const admissionById = new Map(allRuns.map((run) => [run.id, run]));

        // The first page anchors on exact Run identity and carries per-page
        // trigger currentness for every row.
        const pageOne = await listAutomationRuns({
            accountId: account.id,
            automationId: created.id,
            limit: 2,
        });
        expect(pageOne).not.toBeNull();
        expect(pageOne!.runs).toHaveLength(2);
        expect(pageOne!.nextCursor).toBe(pageOne!.runs[1]!.id);
        expect(pageOne!.runs.every((run) => run.triggerRetired === false)).toBe(true);

        // A trigger edit between page reads must not reshape Run pages: page
        // membership anchors on the Run row, never on trigger state.
        await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: second!.id,
            expectedRevision: second!.revision,
            trigger: intervalDefinition(240_000),
        });
        const pageTwo = await listAutomationRuns({
            accountId: account.id,
            automationId: created.id,
            limit: 2,
            cursor: pageOne!.nextCursor,
        });
        expect(pageTwo).not.toBeNull();
        expect(pageTwo!.runs).toHaveLength(1);
        expect(pageTwo!.nextCursor).toBeNull();
        const pagedIds = [...pageOne!.runs, ...pageTwo!.runs].map((run) => run.id);
        expect(new Set(pagedIds).size).toBe(3);
        expect(new Set(pagedIds)).toEqual(new Set(allRuns.map((run) => run.id)));
        for (const run of [...pageOne!.runs, ...pageTwo!.runs]) {
            const admitted = admissionById.get(run.id)!;
            expect(run.causeKind).toBe(admitted.causeKind);
            expect(run.causeTriggerKind).toBe(admitted.causeTriggerKind);
            expect(run.causeTriggerRevision).toBe(admitted.causeTriggerRevision);
        }

        // Removing one trigger between reads flips only that trigger's
        // per-page retired fact; sibling and manual rows stay current and
        // every immutable cause stays renderable.
        await deleteAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: first!.id,
            expectedRevision: first!.revision,
        });
        const repaged = await listAutomationRuns({
            accountId: account.id,
            automationId: created.id,
            limit: 3,
        });
        expect(repaged).not.toBeNull();
        expect(repaged!.runs).toHaveLength(3);
        expect(repaged!.nextCursor).toBeNull();
        const retiredById = new Map(repaged!.runs.map((run) => [run.id, run.triggerRetired]));
        expect(retiredById.get(manual!.id)).toBe(false);
        for (const run of repaged!.runs) {
            const admitted = admissionById.get(run.id)!;
            expect(run.triggerRetired).toBe(admitted.triggerId === first!.id);
            expect(run.causeTriggerKind).toBe(admitted.causeTriggerKind);
            expect(run.causeTriggerRevision).toBe(admitted.causeTriggerRevision);
        }
    });

    it("distinguishes a missing Automation from retained history for a soft-deleted Automation", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Retained deleted history",
                enabled: true,
                executionRecipe: executionRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [],
            },
        });
        const run = await runAutomationNow({ accountId: account.id, automationId: automation.id });
        expect(run).not.toBeNull();

        await expect(listAutomationRuns({
            accountId: account.id,
            automationId: "automation-that-never-existed",
            limit: 20,
        })).resolves.toBeNull();

        await db.automation.update({
            where: { id: automation.id },
            data: { enabled: false, deletedAt: new Date() },
        });
        await expect(listAutomationRuns({
            accountId: account.id,
            automationId: automation.id,
            limit: 20,
        })).resolves.toMatchObject({
            runs: [expect.objectContaining({ id: run!.id })],
        });
    });

    it("bounds V2 history to one raw Run window and advances with that raw cursor", async () => {
        const account = await db.account.create({
            data: { id: `account-${randomUUID()}`, encryptionMode: "plain" },
            select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "V2 raw history window",
                enabled: false,
                executionRecipe: executionRecipe(1),
                triggers: [],
            },
        });
        const templateCiphertext = JSON.stringify({
            kind: "happier_automation_template_plain_v1",
            payload: { prompt: "released V2" },
        });
        const v2Input = (invokedAt: number) => JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext,
            origin: { kind: "manual", invokedAt },
        });
        const base = Date.now();
        const [olderV2, newerV2, currentOnly] = await Promise.all([
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    accountId: account.id,
                    state: "succeeded",
                    causeKind: "manual",
                    causeOccurredAt: new Date(base),
                    executionInputEnvelope: v2Input(base),
                    scheduledAt: new Date(base), dueAt: new Date(base), finishedAt: new Date(base),
                    createdAt: new Date(base), updatedAt: new Date(base),
                },
                select: { id: true },
            }),
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    accountId: account.id,
                    state: "succeeded",
                    causeKind: "manual",
                    causeOccurredAt: new Date(base + 1),
                    executionInputEnvelope: v2Input(base + 1),
                    scheduledAt: new Date(base + 1), dueAt: new Date(base + 1), finishedAt: new Date(base + 1),
                    createdAt: new Date(base + 1), updatedAt: new Date(base + 1),
                },
                select: { id: true },
            }),
            db.automationRun.create({
                data: {
                    automationId: automation.id,
                    accountId: account.id,
                    // Workflow Runs share the physical table, but their
                    // additional lifecycle states are not Automation API
                    // states and must only advance the raw history cursor.
                    state: "interrupted",
                    causeKind: "manual",
                    causeOccurredAt: new Date(base + 2),
                    executionInputEnvelope: JSON.stringify(executionRecipe(1)),
                    scheduledAt: new Date(base + 2), dueAt: new Date(base + 2), finishedAt: new Date(base + 2),
                    createdAt: new Date(base + 2), updatedAt: new Date(base + 2),
                },
                select: { id: true },
            }),
        ]);

        const first = await listAutomationRuns({
            accountId: account.id, automationId: automation.id, limit: 1,
        });
        expect(first).toEqual({ runs: [], nextCursor: currentOnly.id });
        await expect(listAutomationRuns({
            accountId: account.id, automationId: automation.id, limit: 1,
        })).resolves.toEqual({ runs: [], nextCursor: currentOnly.id });
        const second = await listAutomationRuns({
            accountId: account.id, automationId: automation.id, limit: 1,
            cursor: first!.nextCursor,
        });
        expect(second).toMatchObject({
            runs: [expect.objectContaining({ id: newerV2.id })],
            nextCursor: newerV2.id,
        });
        expect(olderV2.id).not.toBe(newerV2.id);
    });
});
