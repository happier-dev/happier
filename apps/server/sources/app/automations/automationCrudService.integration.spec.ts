import { randomUUID } from "node:crypto";

import {
    AutomationRunExecutionInputV1Schema,
    AutomationStoredDefinitionExecutionRecipeV1Schema,
    AutomationTriggerIdSchema,
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
    getAutomation,
    listAutomationDefinitionsPage,
    listAutomations,
    reconcileAutomationDefinition,
    runAutomationNow,
    setAutomationEnabled,
    updateAutomation,
    updateAutomationTrigger,
} from "./automationCrudService";
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
    return { triggerId: AutomationTriggerIdSchema.parse(randomUUID()), trigger };
}

function legacyTemplateEnvelope(payloadCiphertext = "ciphertext-base64"): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext,
    });
}

/** Creates one revocable account machine for enabled-Automation assignment fixtures. */
async function seedExecutionMachine(accountId: string): Promise<string> {
    const machineId = `execution-machine-${randomUUID()}`;
    await db.machine.create({
        data: { id: machineId, accountId, metadata: "{}" },
    });
    return machineId;
}

async function seedPluginEventTriggerWithStatus(automationId: string, suffix: string) {
    const trigger = await db.automationTrigger.create({
        data: {
            id: `event-trigger-${suffix}-${randomUUID()}`,
            automationId,
            kind: "pluginEvent",
            enabled: true,
            eventPluginId: "happier.github",
            eventLocalId: "repository-pushed",
            sourceSelectorId: `selector-${suffix}-${randomUUID()}`,
            sourceContractVersion: 1,
            observationTransport: "checkpointedPull",
            watcherMachineId: `watcher-machine-${suffix}`,
            watcherMachineInstallationId: `watcher-installation-${suffix}`,
            watcherPluginId: "happier.github",
            watcherMaterializationId: `watcher-materialization-${suffix}`,
            definitionEnvelope: JSON.stringify({ v: 1, suffix }),
        },
        select: {
            id: true,
            revision: true,
            eventPluginId: true,
            eventLocalId: true,
            sourceSelectorId: true,
        },
    });
    await db.automationEventSourceStatus.create({
        data: {
            triggerId: trigger.id,
            eventPluginId: trigger.eventPluginId!,
            eventLocalId: trigger.eventLocalId!,
            sourceSelectorId: trigger.sourceSelectorId!,
            triggerRevision: trigger.revision,
            reporterMachineId: `reporter-machine-${suffix}`,
            reporterMachineInstallationId: `reporter-installation-${suffix}`,
            reporterMaterializationId: `reporter-materialization-${suffix}`,
            reporterImmutableGenerationId: `reporter-generation-${suffix}`,
            state: "observing",
        },
    });
    return trigger;
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
            () => db.accessKey.deleteMany(),
            () => db.session.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("accepts zero or many automatic triggers with independent state", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const directOnly = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Direct only",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: executionMachineId }],
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
        expect(scheduled.triggers.find((trigger) => trigger.everyMs === 60_000)).toMatchObject({
            kind: "schedule", enabled: true, revision: 0, everyMs: 60_000,
        });
        expect(scheduled.triggers.find((trigger) => trigger.everyMs === 120_000)).toMatchObject({
            kind: "schedule", enabled: false, revision: 0, everyMs: 120_000,
        });
        expect(scheduled.triggers[0]!.id).not.toBe(scheduled.triggers[1]!.id);
    });

    it("pages the ordinary V3 definition order by stable updatedAt/id keyset", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
        for (const id of ids) {
            await createAutomation({
                accountId: account.id,
                input: {
                    automationId: id,
                    name: id,
                    enabled: false,
                    executionRecipe: currentRecipe(1),
                    triggers: [],
                },
            });
        }
        const sameUpdatedAt = new Date("2026-08-29T10:00:00.000Z");
        await db.automation.updateMany({
            where: { id: { in: ids } },
            data: { updatedAt: sameUpdatedAt },
        });

        const first = await listAutomationDefinitionsPage({
            accountId: account.id,
            limit: 2,
        });
        expect(first.automations.map((automation) => automation.id)).toEqual(ids.slice(0, 2));
        expect(first.nextCursor).not.toBeNull();

        // Cursor progression is independent of the cursor row continuing to
        // exist; numeric offsets would skip the remaining definition here.
        await db.automation.update({
            where: { id: ids[1]! },
            data: { deletedAt: new Date("2026-08-29T10:01:00.000Z") },
        });
        const second = await listAutomationDefinitionsPage({
            accountId: account.id,
            limit: 2,
            cursor: first.nextCursor,
        });
        expect(second.automations.map((automation) => automation.id)).toEqual([ids[2]]);
        expect(second.nextCursor).toBeNull();

        await expect(listAutomationDefinitionsPage({
            accountId: account.id,
            cursor: "not-a-cursor",
        })).rejects.toThrow(AutomationValidationError);
    });

    it("keeps private trigger definition envelopes and unused status relations out of the list read", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "List read narrowing",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        const privateEnvelope = JSON.stringify({
            v: 1,
            sourceInstanceId: "repository-private",
            displayLabel: "Private repository label",
            sourceConfig: { repositoryId: "repository-private" },
        });
        await db.automationTrigger.create({
            data: {
                automationId: automation.id,
                kind: "pluginEvent",
                eventPluginId: "happier.github",
                eventLocalId: "repository-pushed",
                sourceSelectorId: `selector-${randomUUID()}`,
                sourceContractVersion: 1,
                observationTransport: "checkpointedPull",
                watcherMachineId: "watcher-machine",
                watcherMachineInstallationId: "watcher-installation",
                watcherPluginId: "happier.github",
                watcherMaterializationId: "watcher-materialization",
                definitionEnvelope: privateEnvelope,
            },
            select: { id: true },
        });

        const listed = await listAutomations({ accountId: account.id });
        const listedAutomation = listed.find((row) => row.id === automation.id);
        expect(listedAutomation).toBeDefined();
        const listedEventTrigger = listedAutomation!.triggers.find((trigger) => trigger.kind === "pluginEvent");
        expect(listedEventTrigger).toBeDefined();
        expect(listedEventTrigger!).not.toHaveProperty("definitionEnvelope");
        expect(JSON.stringify(listedEventTrigger!)).not.toContain("Private repository label");
        expect(listedEventTrigger!).not.toHaveProperty("eventSourceStatus");

        const detail = await getAutomation({ accountId: account.id, automationId: automation.id });
        const detailEventTrigger = detail?.triggers.find((trigger) => trigger.kind === "pluginEvent");
        expect(detailEventTrigger).toBeDefined();
        expect(detailEventTrigger!).toHaveProperty("definitionEnvelope", privateEnvelope);
    });

    it("rejoins an identical client-identified Automation create after response loss", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const automationId = randomUUID();
        const triggerId = AutomationTriggerIdSchema.parse(randomUUID());
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

    it("deletes Event source projection state when its trigger is retired", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Retired Event status",
                enabled: false,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        });
        const trigger = await seedPluginEventTriggerWithStatus(automation.id, "retired");

        await expect(deleteAutomationTrigger({
            accountId: account.id,
            automationId: automation.id,
            triggerId: trigger.id,
            expectedRevision: trigger.revision,
        })).resolves.not.toBeNull();
        await expect(db.automationEventSourceStatus.findUnique({
            where: { triggerId: trigger.id },
        })).resolves.toBeNull();
        await expect(db.automationTrigger.findUniqueOrThrow({
            where: { id: trigger.id },
            select: {
                deletedAt: true,
                eventPluginId: true,
                eventLocalId: true,
                sourceSelectorId: true,
                definitionEnvelope: true,
            },
        })).resolves.toEqual({
            deletedAt: expect.any(Date),
            eventPluginId: trigger.eventPluginId,
            eventLocalId: trigger.eventLocalId,
            sourceSelectorId: trigger.sourceSelectorId,
            definitionEnvelope: null,
        });
    });

    it("deletes every child Event source status when its parent Automation is deleted", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const automation = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Deleted parent Event statuses",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
                triggers: [],
            },
        });
        const first = await seedPluginEventTriggerWithStatus(automation.id, "parent-first");
        const second = await seedPluginEventTriggerWithStatus(automation.id, "parent-second");

        await expect(deleteAutomation({
            accountId: account.id,
            automationId: automation.id,
        })).resolves.toBe(true);
        await expect(db.automationEventSourceStatus.count({
            where: { triggerId: { in: [first.id, second.id] } },
        })).resolves.toBe(0);
        await expect(db.automationTrigger.count({
            where: {
                id: { in: [first.id, second.id] },
                enabled: false,
                deletedAt: null,
            },
        })).resolves.toBe(2);
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
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
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
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
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
                assignments: [{ machineId: await seedExecutionMachine(account.id) }],
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
                automationId: randomUUID(),
                name: "Unavailable current E2EE writer",
                enabled: true,
                executionRecipe: currentRecipe(1),
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
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
                assignments: [{ machineId: await seedExecutionMachine(e2ee.id) }],
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

    it("rejects an enabled create with zero enabled assignments and admits a disabled draft with none", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Enabled without assignment",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        // An all-disabled replacement set is still zero enabled assignments.
        const disabledOnlyMachineId = await seedExecutionMachine(account.id);
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Enabled with only disabled assignments",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: disabledOnlyMachineId, enabled: false }],
                triggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.count({ where: { accountId: account.id } })).resolves.toBe(0);

        // A disabled draft may own zero enabled assignments.
        await expect(createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Disabled draft",
                enabled: false,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        })).resolves.toMatchObject({ id: expect.any(String), enabled: false });
    });

    it("rejects enabling without an enabled assignment and accepts enabling with one", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const draft = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Enable gate",
                enabled: false,
                executionRecipe: currentRecipe(1),
                assignments: [],
                triggers: [],
            },
        });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: draft.id,
            enabled: true,
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: draft.id },
            select: { enabled: true },
        })).resolves.toMatchObject({ enabled: false });

        const executionMachineId = await seedExecutionMachine(account.id);
        await expect(updateAutomation({
            accountId: account.id,
            automationId: draft.id,
            input: {
                enabled: true,
                assignments: [{ machineId: executionMachineId }],
            },
        })).resolves.toMatchObject({ enabled: true });
    });

    it("rejects newly assigning a replaced machine while preserving an unchanged assignment", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const replacedMachineId = await seedExecutionMachine(account.id);
        const replacementMachineId = await seedExecutionMachine(account.id);
        const retained = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Reversible replacement assignment",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: replacedMachineId }],
                triggers: [],
            },
        });
        await db.machine.update({
            where: { id: replacedMachineId },
            data: { replacedByMachineId: replacementMachineId, replacedAt: new Date() },
        });

        // An unrelated whole-definition edit preserves the configured
        // assignment so clearing replacement can naturally reactivate it.
        await expect(updateAutomation({
            accountId: account.id,
            automationId: retained.id,
            input: {
                name: "Reversible replacement assignment renamed",
                assignments: [{ machineId: replacedMachineId }],
            },
        })).resolves.toMatchObject({
            name: "Reversible replacement assignment renamed",
            assignments: [{ machineId: replacedMachineId, enabled: true }],
        });

        const otherMachineId = await seedExecutionMachine(account.id);
        const other = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Available assignment",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: otherMachineId }],
                triggers: [],
            },
        });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: other.id,
            input: { assignments: [{ machineId: replacedMachineId }] },
        })).rejects.toMatchObject({
            name: "AutomationValidationError",
            message: `Unavailable machine assignments: ${replacedMachineId}`,
        });
        await expect(getAutomation({ accountId: account.id, automationId: other.id }))
            .resolves.toMatchObject({
                assignments: [{ machineId: otherMachineId, enabled: true }],
            });
    });

    it("rejects removing or disabling the last enabled assignment while enabled, atomically", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Last assignment gate",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: executionMachineId }],
                triggers: [],
            },
        });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { assignments: [] },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: {
                assignments: [{ machineId: executionMachineId, enabled: false }],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        // The whole patch rolled back: the enabled assignment survived.
        await expect(getAutomation({ accountId: account.id, automationId: created.id }))
            .resolves.toMatchObject({
                enabled: true,
                assignments: [{ machineId: executionMachineId, enabled: true }],
            });

        // Pausing first makes the same removal a legal disabled draft edit.
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        })).resolves.toMatchObject({ enabled: false });
        await expect(updateAutomation({
            accountId: account.id,
            automationId: created.id,
            input: { assignments: [] },
        })).resolves.toMatchObject({ enabled: false, assignments: [] });
    });

    it("rejects a whole-editor Save leaving an enabled Automation with zero enabled assignments, atomically", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Save atomicity",
                enabled: true,
                executionRecipe: currentRecipe(1),
                assignments: [{ machineId: executionMachineId }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Save without assignment",
                description: null,
                enabled: true,
                assignments: [],
                triggers: created.triggers.map((trigger) => ({
                    kind: "existing" as const,
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                })),
                removedTriggers: [],
            },
        })).rejects.toBeInstanceOf(AutomationValidationError);
        // Nothing committed: name, template revision, and assignments intact.
        await expect(getAutomation({ accountId: account.id, automationId: created.id }))
            .resolves.toMatchObject({
                name: "Save atomicity",
                templateVersion: 1,
                enabled: true,
                assignments: [{ machineId: executionMachineId, enabled: true }],
            });

        // Pausing in the same Save accepts the empty assignment set.
        await expect(reconcileAutomationDefinition({
            accountId: account.id,
            automationId: created.id,
            input: {
                expectedTemplateVersion: 1,
                name: "Save without assignment",
                description: null,
                enabled: false,
                assignments: [],
                triggers: created.triggers.map((trigger) => ({
                    kind: "existing" as const,
                    triggerId: AutomationTriggerIdSchema.parse(trigger.id),
                    expectedRevision: trigger.revision,
                })),
                removedTriggers: [],
            },
        })).resolves.toMatchObject({ enabled: false, assignments: [] });
    });

    it("authors, pauses, and resumes an existingSession definition against a layout-one Session", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" }, select: { id: true },
        });
        const executionMachineId = await seedExecutionMachine(account.id);
        const sessionId = `session-layout-one-${randomUUID()}`;
        await db.session.create({
            data: {
                id: sessionId,
                accountId: account.id,
                tag: "automation-existing-session-layout-one",
                metadata: JSON.stringify({
                    v: 1,
                    summary: { text: "Spawned layout-one Session", updatedAt: 1 },
                }),
                metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify({ t: "plain", v: { v: 1 } }),
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId: executionMachineId,
                sessionId,
                data: "opaque-machine-correspondence",
            },
        });

        const created = await createAutomation({
            accountId: account.id,
            input: {
                automationId: randomUUID(),
                name: "Layout-one existing session",
                enabled: true,
                executionRecipe: AutomationStoredDefinitionExecutionRecipeV1Schema.parse({
                    v: 1,
                    templateVersion: 1,
                    template: { t: "plain", v: { v: 1, prompt: "Continue the target Session" } },
                    triggerEvidence: null,
                    target: { kind: "existingSession", sessionId },
                }),
                assignments: [{ machineId: executionMachineId }],
                triggers: [triggerInput(intervalTrigger(60_000))],
            },
        });
        expect(created.targetType).toBe("existing_session");

        // A non-template definition mutation (pause/resume) revalidates the
        // retained strict target instead of reparsing it as a legacy envelope.
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        })).resolves.toMatchObject({ enabled: false });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        })).resolves.toMatchObject({ enabled: true });

        // Revoked-first + available-sibling correspondence: a Session may retain
        // a revoked machine's key beside an available machine's key, and the
        // available sibling must satisfy the target proof.
        const siblingMachineId = await seedExecutionMachine(account.id);
        await db.accessKey.create({
            data: {
                accountId: account.id,
                machineId: siblingMachineId,
                sessionId,
                data: "opaque-sibling-correspondence",
            },
        });
        await db.machine.update({
            where: { id: executionMachineId },
            data: { revokedAt: new Date() },
        });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: false,
        })).resolves.toMatchObject({ enabled: false });

        // With only the revoked machine's correspondence left, the same target
        // fails typed and the mutation rolls back atomically.
        await db.accessKey.deleteMany({
            where: { accountId: account.id, machineId: siblingMachineId },
        });
        await expect(setAutomationEnabled({
            accountId: account.id,
            automationId: created.id,
            enabled: true,
        })).rejects.toBeInstanceOf(AutomationValidationError);
        await expect(db.automation.findUniqueOrThrow({
            where: { id: created.id },
            select: { enabled: true },
        })).resolves.toMatchObject({ enabled: false });
    });
});
