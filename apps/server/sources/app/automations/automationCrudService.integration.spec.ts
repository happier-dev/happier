import { randomUUID } from "node:crypto";

import {
    AutomationRunExecutionInputV1Schema,
    AutomationStoredDefinitionExecutionRecipeV1Schema,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createSignedAccountContentBinding } from "@/testkit/accountEncryption";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    AutomationDisabledError,
    AutomationDefinitionCreateConflictError,
    AutomationTriggerCreateConflictError,
    createAutomation,
    createAutomationTrigger,
    deleteAutomation,
    deleteAutomationTrigger,
    listAutomations,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
import { AutomationStoredContentReadError } from "./automationStoredContentRead";
import { AutomationValidationError } from "./automationValidation";
import { runAutomationScheduleWorkerPass } from "./automationScheduleWorker";
import { cancelAutomationRun } from "./automationRunService";

function currentRecipe(templateVersion: number) {
    return AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: `Recipe ${templateVersion}` } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine" },
                directory: "/tmp/automation-crud",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
}

function intervalTrigger(everyMs: number, enabled = true) {
    return {
        kind: "schedule" as const,
        enabled,
        schedule: {
            kind: "interval" as const,
            scheduleExpr: null,
            everyMs,
            timezone: null,
        },
    };
}

function triggerInput(trigger: ReturnType<typeof intervalTrigger>) {
    return { triggerId: randomUUID(), trigger };
}

function legacyTemplateEnvelope(payloadCiphertext = "ciphertext-base64"): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext,
    });
}

describe("automationCrudService (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-automation-crud-",
        });
    }, 120_000);

    afterAll(async () => await harness.close());

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRunAssignment.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationEventSourceStatus.deleteMany(),
            () => db.automationEventSourceCatalogStatus.deleteMany(),
            () => db.automationEventCatalogState.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.accountChange.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("accepts zero or many automatic triggers with independent state", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const directOnly = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Direct only",
                enabled: true,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        });
        expect(directOnly.triggers).toEqual([]);

        const scheduled = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Two independent schedules",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [
                    triggerInput(intervalTrigger(60_000)),
                    triggerInput(intervalTrigger(120_000, false)),
                ],
            },
        });
        expect(scheduled.triggers).toHaveLength(2);
        expect(scheduled.triggers[0]).toMatchObject({
            kind: "schedule", enabled: true, revision: 0, everyMs: 60_000,
        });
        expect(scheduled.triggers[1]).toMatchObject({
            kind: "schedule", enabled: false, revision: 0, everyMs: 120_000,
        });
        expect(scheduled.triggers[0]!.id).not.toBe(scheduled.triggers[1]!.id);
    });

    it("rejoins an identical client-identified Automation create after response loss", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const automationId = randomUUID();
        const triggerId = randomUUID();
        const input = {
            automationId,
            name: "Response-loss Automation",
            description: null,
            enabled: false,
            executionRecipe: currentRecipe(1),
            assignments: [] as const,
            triggers: [{ triggerId, trigger: intervalTrigger(60_000) }],
        };

        const created = await createAutomation({ accountId: account.id, input });
        const rejoined = await createAutomation({ accountId: account.id, input });

        expect(rejoined.id).toBe(created.id);
        expect(rejoined.triggers).toHaveLength(1);
        await expect(db.automation.count({ where: { id: automationId } })).resolves.toBe(1);
        await expect(db.automationTrigger.count({ where: { id: triggerId } })).resolves.toBe(1);

        await expect(createAutomation({
            accountId: account.id,
            input: { ...input, name: "Conflicting Automation" },
        })).rejects.toBeInstanceOf(AutomationDefinitionCreateConflictError);
    });

    it("rejoins an identical client-identified trigger create after response loss", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Trigger response loss",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        });
        const triggerId = randomUUID();
        const trigger = intervalTrigger(90_000, false);

        const first = await createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId,
            trigger,
        });
        const rejoined = await createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId,
            trigger,
        });

        expect(rejoined?.triggers).toEqual(first?.triggers);
        await expect(db.automationTrigger.count({ where: { id: triggerId } })).resolves.toBe(1);

        await expect(createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId,
            trigger: intervalTrigger(120_000, false),
        })).rejects.toBeInstanceOf(AutomationTriggerCreateConflictError);
    });

    it("preserves trigger identities, revisions, and next-run state across name and recipe edits", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Stable schedules",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [
                    triggerInput(intervalTrigger(60_000)),
                    triggerInput(intervalTrigger(120_000)),
                ],
            },
        });
        const firstNextRunAt = new Date("2026-08-27T10:00:00.000Z");
        const secondNextRunAt = new Date("2026-08-27T11:00:00.000Z");
        await Promise.all([
            db.automationTrigger.update({
                where: { id: created.triggers[0]!.id }, data: { nextRunAt: firstNextRunAt },
            }),
            db.automationTrigger.update({
                where: { id: created.triggers[1]!.id }, data: { nextRunAt: secondNextRunAt },
            }),
        ]);

        const renamed = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            expectedTemplateVersion: 1,
            input: {
                name: "Renamed stable schedules",
                executionRecipe: currentRecipe(2),
            },
        });
        expect(renamed).toMatchObject({
            name: "Renamed stable schedules",
            templateVersion: 2,
        });
        expect(renamed?.triggers.map((trigger) => ({
            id: trigger.id,
            revision: trigger.revision,
            nextRunAt: trigger.nextRunAt,
        }))).toEqual([
            { id: created.triggers[0]!.id, revision: 0, nextRunAt: firstNextRunAt },
            { id: created.triggers[1]!.id, revision: 0, nextRunAt: secondNextRunAt },
        ]);

        const edited = await updateAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: created.triggers[0]!.id,
            expectedRevision: created.triggers[0]!.revision,
            trigger: {
                kind: "schedule",
                schedule: intervalTrigger(180_000).schedule,
            },
        });
        expect(edited?.triggers).toEqual([
            expect.objectContaining({
                id: created.triggers[0]!.id,
                revision: 1,
                everyMs: 180_000,
            }),
            expect.objectContaining({
                id: created.triggers[1]!.id,
                revision: 0,
                everyMs: 120_000,
            }),
        ]);

        const thirdTriggerId = randomUUID();
        const withThird = await createAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: thirdTriggerId,
            trigger: intervalTrigger(240_000, false),
        });
        const third = withThird?.triggers.find((trigger) => trigger.everyMs === 240_000);
        expect(third).toMatchObject({
            id: thirdTriggerId,
            kind: "schedule",
            enabled: false,
            revision: 0,
        });

        const withoutThird = await deleteAutomationTrigger({
            accountId: account.id,
            automationId: created.id,
            triggerId: third!.id,
            expectedRevision: third!.revision,
        });
        expect(withoutThird?.triggers.map((trigger) => trigger.id)).toEqual([
            created.triggers[0]!.id,
            created.triggers[1]!.id,
        ]);
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: third!.id },
            select: {
                enabled: true,
                deletedAt: true,
                scheduleKind: true,
                scheduleExpr: true,
                everyMs: true,
                timezone: true,
                nextRunAt: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
                sourceContractVersion: true,
                observationTransport: true,
                webhookEndpointId: true,
                observationStartsAt: true,
                watcherMachineId: true,
                watcherMachineInstallationId: true,
                watcherPluginId: true,
                watcherMaterializationId: true,
                definitionEnvelope: true,
                sessionLifecycleEvent: true,
                sourceSessionId: true,
                sourceTurnId: true,
            },
        })).resolves.toEqual({
            enabled: false,
            deletedAt: expect.any(Date),
            scheduleKind: null,
            scheduleExpr: null,
            everyMs: null,
            timezone: null,
            nextRunAt: null,
            eventPluginId: null,
            eventLocalId: null,
            sourceSelectorId: null,
            sourceContractVersion: null,
            observationTransport: null,
            webhookEndpointId: null,
            observationStartsAt: null,
            watcherMachineId: null,
            watcherMachineInstallationId: null,
            watcherPluginId: null,
            watcherMaterializationId: null,
            definitionEnvelope: null,
            sessionLifecycleEvent: null,
            sourceSessionId: null,
            sourceTurnId: null,
        });
    });

    it("runs a zero-trigger Automation manually and rejoins only the same invocation", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "On demand",
                enabled: true,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        });
        const first = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        });
        const replay = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        });
        expect(first).toMatchObject({
            triggerId: null, causeKind: "manual", causeTriggerKind: null, state: "queued",
        });
        expect(replay?.id).toBe(first?.id);
        expect(replay?.causeOccurredAt).toEqual(first?.causeOccurredAt);
        await expect(db.automationRun.count({ where: { automationId: created.id } }))
            .resolves.toBe(1);

        const prefixedManual = await runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "conversation:reserved-for-direct-invocation",
        });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "conversation:reserved-for-direct-invocation",
        })).resolves.toMatchObject({ id: prefixedManual!.id, causeKind: "manual" });

        await setAutomationEnabled({
            accountId: account.id, automationId: created.id, enabled: false,
        });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-44",
        })).resolves.toMatchObject({ id: first!.id, causeKind: "manual" });
        await expect(runAutomationNow({
            accountId: account.id,
            automationId: created.id,
            idempotencyKey: "ci-build-45",
        })).rejects.toBeInstanceOf(AutomationDisabledError);
    });

    it("soft-deletes a definition without rewriting its admitted Run cause", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Retained history",
                enabled: true,
                executionRecipe: currentRecipe(1),
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        const trigger = created.triggers[0]!;
        await expect(db.automationRun.count({ where: { automationId: created.id } })).resolves.toBe(0);
        const dueAt = new Date();
        await db.automationTrigger.update({ where: { id: trigger.id }, data: { nextRunAt: dueAt } });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const admitted = await db.automationRun.findFirstOrThrow({
            where: { automationId: created.id, triggerId: trigger.id },
            select: { id: true },
        });
        await expect(deleteAutomation({
            accountId: account.id, automationId: created.id,
        })).resolves.toBe(true);
        await expect(listAutomations({ accountId: account.id })).resolves.toEqual([]);
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

    it("preserves the released V2 exact-one schedule and its frozen queued recipe", async () => {
        const account = await db.account.create({
            data: createSignedAccountContentBinding(), select: { id: true },
        });
        const originalTemplateCiphertext = legacyTemplateEnvelope();
        const created = await createAutomation({
            accountId: account.id,
            requireV2DefinitionRepresentability: true,
            input: {
                name: "Released V2 schedule",
                enabled: true,
                schedule: { kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" },
                targetType: "new_session",
                templateCiphertext: originalTemplateCiphertext,
            },
        });
        expect(created.triggers).toEqual([expect.objectContaining({
            kind: "schedule", scheduleKind: "cron", scheduleExpr: "*/5 * * * *",
        })]);
        const originalTrigger = created.triggers[0]!;
        const unchangedBeforeDue = await updateAutomation({
            accountId: account.id,
            automationId: created.id,
            requireV2DefinitionRepresentability: true,
            input: {
                name: "Released V2 schedule renamed",
                schedule: { kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" },
            },
        });
        expect(unchangedBeforeDue?.triggers[0]).toMatchObject({
            id: originalTrigger.id,
            revision: originalTrigger.revision,
            nextRunAt: originalTrigger.nextRunAt,
        });
        await expect(db.automationRun.count({ where: { automationId: created.id } })).resolves.toBe(0);
        const dueAt = new Date();
        await db.automationTrigger.update({
            where: { id: created.triggers[0]!.id },
            data: { nextRunAt: dueAt },
        });
        await runAutomationScheduleWorkerPass({ now: dueAt });
        const queued = await db.automationRun.findFirstOrThrow({
            where: {
                automationId: created.id,
                triggerId: created.triggers[0]!.id,
                state: "queued",
            },
            select: { id: true, executionInputEnvelope: true },
        });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            requireV2DefinitionRepresentability: true,
            input: {
                templateCiphertext: legacyTemplateEnvelope("changed-ciphertext-base64"),
                schedule: { kind: "cron", scheduleExpr: "*/5 * * * *", timezone: "UTC" },
            },
        })).resolves.toEqual(expect.objectContaining({
            templateVersion: created.templateVersion + 1,
            triggers: [expect.objectContaining({
                revision: originalTrigger.revision,
                nextRunAt: dueAt,
            })],
        }));
        const after = await db.automationRun.findUniqueOrThrow({
            where: { id: queued.id }, select: { executionInputEnvelope: true },
        });
        expect(after.executionInputEnvelope).toBe(queued.executionInputEnvelope);
        expect(AutomationRunExecutionInputV1Schema.parse(JSON.parse(
            after.executionInputEnvelope!,
        ))).toEqual(expect.objectContaining({
            templateVersion: created.templateVersion,
            templateCiphertext: originalTemplateCiphertext,
        }));

        const cancelled = await cancelAutomationRun({
            accountId: account.id,
            runId: queued.id,
        });
        expect(cancelled?.state).toBe("cancelled");
        const advanced = await db.automationTrigger.findUniqueOrThrow({
            where: { id: originalTrigger.id },
            select: { revision: true, nextRunAt: true },
        });
        expect(advanced.revision).toBe(originalTrigger.revision);
        expect(advanced.nextRunAt?.getTime()).toBeGreaterThan(cancelled!.finishedAt!.getTime());

        const nextDueAt = new Date(cancelled!.finishedAt!.getTime() + 1);
        await db.automationTrigger.update({
            where: { id: originalTrigger.id },
            data: { nextRunAt: nextDueAt },
        });
        await runAutomationScheduleWorkerPass({ now: nextDueAt });
        await expect(db.automationRun.count({
            where: { automationId: created.id },
        })).resolves.toBe(2);
    });

    it("fails closed for current E2EE authoring and inconsistent Account currentness", async () => {
        const e2ee = await db.account.create({
            data: createSignedAccountContentBinding(), select: { id: true },
        });
        await expect(createAutomation({
            accountId: e2ee.id,
            input: {
                name: "Unavailable current E2EE writer",
                enabled: true,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationStoredContentReadError);
        await expect(db.automation.count({ where: { accountId: e2ee.id } })).resolves.toBe(0);

        const legacy = await createAutomation({
            accountId: e2ee.id,
            requireV2DefinitionRepresentability: true,
            input: {
                name: "Retained encrypted V2 schedule",
                enabled: true,
                schedule: { kind: "interval", everyMs: 300_000, timezone: null },
                targetType: "new_session",
                templateCiphertext: legacyTemplateEnvelope(),
            },
        });
        await db.account.update({
            where: { id: e2ee.id },
            data: { contentPublicKey: null, contentPublicKeySig: null },
        });
        await expect(runAutomationNow({
            accountId: e2ee.id,
            automationId: legacy.id,
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();
        await expect(updateAutomation({
            accountId: e2ee.id,
            automationId: legacy.id,
            input: { name: "must not write" },
            requireV2DefinitionRepresentability: true,
        })).resolves.toBeNull();
        await expect(deleteAutomation({
            accountId: e2ee.id,
            automationId: legacy.id,
            requireV2DefinitionRepresentability: true,
        })).resolves.toBe(false);
    });
});
