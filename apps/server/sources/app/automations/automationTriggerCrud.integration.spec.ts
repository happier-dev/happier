import { randomUUID } from "node:crypto";

import { AutomationStoredDefinitionExecutionRecipeV1Schema } from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    createAutomation,
    deleteAutomationTrigger,
    reconcileAutomationDefinition,
    runAutomationNow,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { AutomationSessionLifecycleRegistrationValidationError } from "./automationSessionLifecycleRegistration";
import { runAutomationScheduleWorkerPass } from "./automationScheduleWorker";

function executionRecipe(templateVersion: number) {
    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: {
            t: "plain",
            v: { v: 1, prompt: `Trigger-set recipe ${templateVersion}` },
        },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-trigger-set",
                agentTarget: {
                    kind: "agent",
                    identity: {
                        pluginId: "happier.agent.codex",
                        localId: "codex",
                    },
                },
            },
        },
    });
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

function lifecycleDefinition(params: Readonly<{
    sourceSessionId: string;
    sourceTurnId: string;
}>) {
    return {
        kind: "sessionLifecycle" as const,
        event: "parentTurnCompleted" as const,
        scope: {
            kind: "exactTurn" as const,
            sourceSessionId: params.sourceSessionId,
            sourceTurnId: params.sourceTurnId,
        },
        consumption: "once" as const,
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

function existingSessionExecutionRecipe(templateVersion: number, sessionId: string) {
    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: {
            t: "plain",
            v: { v: 1, prompt: `Retarget lifecycle recipe ${templateVersion}` },
        },
        triggerEvidence: null,
        target: { kind: "existingSession", sessionId },
    });
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
                    { triggerId: randomUUID(), trigger: intervalTrigger(60_000) },
                    { triggerId: randomUUID(), trigger: intervalTrigger(120_000) },
                ],
            },
        });

        expect(created.triggers).toHaveLength(2);
        const [first, second] = created.triggers;
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
        expect(recipeEdited?.triggers[0]?.nextRunAt).toEqual(retainedNextRunAt);

        const unchangedTrigger = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: first!.id,
            expectedRevision: first!.revision,
            trigger: intervalDefinition(60_000),
        });
        expect(unchangedTrigger?.triggers[0]).toMatchObject({
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
        expect(triggerEdited?.triggers[0]).toMatchObject({
            id: first!.id,
            revision: 1,
            everyMs: 180_000,
        });
        expect(triggerEdited?.triggers[1]).toMatchObject({
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
                    { triggerId: randomUUID(), trigger: intervalTrigger(60_000) },
                    { triggerId: randomUUID(), trigger: intervalTrigger(120_000) },
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
                        triggerId: first!.id,
                        expectedRevision: first!.revision,
                        enabled: false,
                        trigger: intervalDefinition(180_000),
                    },
                    {
                        kind: "existing",
                        triggerId: second!.id,
                        expectedRevision: second!.revision,
                    },
                    {
                        kind: "new",
                        triggerId: randomUUID(),
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
                triggers: [{ triggerId: randomUUID(), trigger: intervalTrigger(60_000) }],
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
                triggers: [
                    { triggerId: randomUUID(), trigger: intervalTrigger(60_000) },
                    { triggerId: randomUUID(), trigger: intervalTrigger(120_000) },
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
                    triggerId: randomUUID(),
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

    it("rejects lifecycle source changes and recipe retargeting against canonical source truth", async () => {
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
                    triggerId: randomUUID(),
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
                    triggerId: randomUUID(),
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

        const retargetError = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                executionRecipe: existingSessionExecutionRecipe(2, source.sessionId),
            },
        }).then(() => null, (error: unknown) => error);
        expect(retargetError).toBeInstanceOf(
            AutomationSessionLifecycleRegistrationValidationError,
        );
        expect(retargetError).toMatchObject({ code: "sourceMatchesExecutionTarget" });
    });
});
