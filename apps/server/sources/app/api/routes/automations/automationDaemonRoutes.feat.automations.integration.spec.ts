import {
    AutomationRunExecutionInputV1Schema,
    serializeAutomationRunExecutionRecipeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { withAuthenticatedTestApp } from "../../testkit/sqliteFastify";
import { automationRoutes } from "./automationRoutes";

function buildTemplateEnvelope(existingSessionId?: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: "ciphertext-base64",
        ...(existingSessionId ? { existingSessionId } : {}),
    });
}

function buildPlainTemplateEnvelope(): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload: { prompt: "automation test" },
    });
}

function buildFrozenV2RunInput(params: Readonly<{
    templateCiphertext: string;
    origin: { kind: "scheduled"; scheduledFor: number } | { kind: "manual"; invokedAt: number };
    targetType?: "new_session" | "existing_session" | "execution_run";
}>): string {
    const input = {
        kind: "happier_automation_run_execution_input_v1",
        targetType: params.targetType ?? "new_session",
        templateVersion: 1,
        templateCiphertext: params.templateCiphertext,
        origin: params.origin,
    };
    return JSON.stringify(params.targetType === "execution_run"
        ? input
        : AutomationRunExecutionInputV1Schema.parse(input));
}

function strictV3RecipeShape(templateVersion: number) {
    return {
        v: 1,
        templateVersion,
        template: { t: "plain", v: { v: 1, prompt: "strict V3 definition" } },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server", machineId: "machine-1" },
                directory: "/tmp/strict-v3-automation",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    } as const;
}

function buildStrictV3Recipe(templateVersion: number): string {
    const recipe = serializeAutomationStoredDefinitionExecutionRecipeV1(
        strictV3RecipeShape(templateVersion),
    );
    if (recipe.kind !== "available") {
        throw new Error("Expected strict V3 test recipe to serialize");
    }
    return recipe.serialized;
}

function buildStrictV3RunRecipe(templateVersion: number, machineId: string): string {
    const recipe = serializeAutomationRunExecutionRecipeV1({
        ...strictV3RecipeShape(templateVersion),
        assignmentMachineIds: [machineId],
    });
    if (recipe.kind !== "available") {
        throw new Error("Expected frozen strict V3 Run recipe to serialize");
    }
    return recipe.serialized;
}

type UnsupportedV2RunCauseKind = "pluginEvent" | "conversation";

function scheduleTriggerCreate(id: string, everyMs = 60_000) {
    return {
        id,
        kind: "schedule" as const,
        enabled: true,
        revision: 1,
        scheduleKind: "interval" as const,
        everyMs,
    };
}

function scheduleRunCause(params: Readonly<{
    triggerId: string;
    scheduledFor: Date;
    occurrenceKey: string;
}>) {
    return {
        triggerId: params.triggerId,
        causeKind: "trigger" as const,
        causeTriggerKind: "schedule" as const,
        causeTriggerRevision: 1,
        causeOccurredAt: params.scheduledFor,
        causeScheduledFor: params.scheduledFor,
        occurrenceKey: params.occurrenceKey,
    };
}

async function snapshotAutomationPersistence(accountId: string) {
    const [account, automations, triggers, assignments, runs, runEvents, accountChanges] =
        await Promise.all([
            db.account.findUnique({ where: { id: accountId } }),
            db.automation.findMany({
                where: { accountId },
                orderBy: { id: "asc" },
            }),
            db.automationTrigger.findMany({
                where: { automation: { is: { accountId } } },
                orderBy: { id: "asc" },
            }),
            db.automationAssignment.findMany({
                where: { automation: { is: { accountId } } },
                orderBy: { id: "asc" },
            }),
            db.automationRun.findMany({
                where: { accountId },
                orderBy: { id: "asc" },
            }),
            db.automationRunEvent.findMany({
                where: { run: { is: { accountId } } },
                orderBy: { id: "asc" },
            }),
            db.accountChange.findMany({
                where: { accountId },
                orderBy: [{ kind: "asc" }, { entityId: "asc" }],
            }),
        ]);

    return { account, automations, triggers, assignments, runs, runEvents, accountChanges };
}

async function seedUnsupportedV2Automation(params: Readonly<{
    accountId: string;
    machineId: string;
    causeKind: UnsupportedV2RunCauseKind;
}>) {
    const now = Date.now();
    const isConversationRun = params.causeKind === "conversation";
    const triggerId = `trigger-plugin-event-${params.causeKind}`;
    const automation = await db.automation.create({
        data: {
            accountId: params.accountId,
            name: `pluginEvent V2 rejection fixture`,
            enabled: true,
            targetType: "new_session",
            templateCiphertext: buildPlainTemplateEnvelope(),
            templateVersion: 1,
            triggers: {
                create: {
                    id: triggerId,
                    kind: "pluginEvent",
                    enabled: true,
                    revision: 1,
                    definitionEnvelope: JSON.stringify({ t: "plain", v: {} }),
                    eventPluginId: "test.plugin",
                    eventLocalId: "event-1",
                    sourceSelectorId: "selector-1",
                    sourceContractVersion: 1,
                    observationTransport: "durablePush",
                    webhookEndpointId: "endpoint-1",
                    observationStartsAt: new Date(now - 120_000),
                },
            },
        },
        select: { id: true },
    });
    await db.automationAssignment.create({
        data: {
            automationId: automation.id,
            machineId: params.machineId,
            enabled: true,
            priority: 0,
        },
    });

    const runInput = (suffix: string) => ({
        automationId: automation.id,
        accountId: params.accountId,
        triggerId: isConversationRun ? null : triggerId,
        causeKind: isConversationRun ? "conversation" as const : "trigger" as const,
        causeTriggerKind: isConversationRun ? null : "pluginEvent" as const,
        causeTriggerRevision: isConversationRun ? null : 1,
        causeOccurredAt: new Date(now - 60_000),
        causeEventPluginId: isConversationRun ? null : "test.plugin",
        causeEventLocalId: isConversationRun ? null : "event-1",
        occurrenceKey: `${params.causeKind}-${suffix}`,
        causeSourceSelectorId: isConversationRun ? null : "selector-1",
        triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: {} }),
        ...(isConversationRun
            ? {
                replyContextEnvelope: JSON.stringify({
                    t: "plain",
                    v: {
                        v: 1,
                        correspondence: {
                            accountId: params.accountId,
                            automationId: automation.id,
                            runId: `${params.causeKind}-${suffix}`,
                            handoffId: `handoff-${suffix}`,
                        },
                        source: {
                            kind: "automationResult",
                            automationRunId: `${params.causeKind}-${suffix}`,
                            resultId: `handoff-${suffix}`,
                            automationId: automation.id,
                            templateVersion: 1,
                            resultDelivery: "finalResult",
                        },
                        opaqueContext: { conversationId: `conversation-${suffix}` },
                    },
                }),
                replyHandoffActionPluginId: "happier.channels",
                replyHandoffActionLocalId: "automation/result-deliver-v1",
                replyHandoffTargetMachineId: params.machineId,
                replyHandoffTargetMachineInstallationId: "installation-1",
                replyHandoffTargetMaterializationId: "materialization-1",
                replyHandoffId: `handoff-${suffix}`,
                replyHandoffState: "awaitingResult" as const,
            }
            : {}),
        scheduledAt: new Date(now - 60_000),
        dueAt: new Date(now - 30_000),
    });
    const [queued, claimed, running] = await Promise.all([
        db.automationRun.create({
            data: {
                ...runInput("queued"),
                state: "queued",
                attempt: 0,
            },
            select: { id: true },
        }),
        db.automationRun.create({
            data: {
                ...runInput("claimed"),
                state: "claimed",
                claimedAt: new Date(now - 20_000),
                claimedByMachineId: params.machineId,
                leaseExpiresAt: new Date(now + 60_000),
                attempt: 1,
            },
            select: { id: true },
        }),
        db.automationRun.create({
            data: {
                ...runInput("running"),
                state: "running",
                claimedAt: new Date(now - 20_000),
                startedAt: new Date(now - 10_000),
                claimedByMachineId: params.machineId,
                leaseExpiresAt: new Date(now + 60_000),
                attempt: 1,
            },
            select: { id: true },
        }),
    ]);

    return { automation, queued, claimed, running };
}

describe("automation daemon routes (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-automation-daemon-routes-" });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        harness.resetEnv({ HAPPIER_FEATURE_AUTOMATIONS__ENABLED: "1" });
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automationTrigger.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("claims due runs and returns automation payload for daemon workers", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const templateCiphertext = buildPlainTemplateEnvelope();
        const triggerId = "trigger-nightly-run";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Nightly run",
                enabled: true,
                targetType: "new_session",
                templateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
            },
            select: { id: true },
        });
        await db.automationAssignment.create({
            data: {
                automationId: automation.id,
                machineId: "machine-1",
                enabled: true,
                priority: 0,
            },
        });
        const scheduledAt = new Date(Date.now() - 10_000);
        await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({
                    triggerId,
                    scheduledFor: scheduledAt,
                    occurrenceKey: "nightly-run:scheduled",
                }),
                scheduledAt,
                dueAt: new Date(Date.now() - 5_000),
                executionInputEnvelope: buildFrozenV2RunInput({
                    templateCiphertext,
                    origin: { kind: "scheduled", scheduledFor: scheduledAt.getTime() },
                }),
            },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "POST",
                    url: "/v2/automations/runs/claim",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-1",
                        leaseDurationMs: 30_000,
                    },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(body.run).toEqual(
                    expect.objectContaining({
                        automationId: automation.id,
                        state: "claimed",
                        claimedByMachineId: "machine-1",
                    }),
                );
                expect(body.automation).toEqual(
                    expect.objectContaining({
                        id: automation.id,
                        name: "Nightly run",
                        targetType: "new_session",
                    }),
                );

                const claimed = await db.automationRun.findUnique({
                    where: { id: body.run.id },
                    select: {
                        state: true,
                        claimedByMachineId: true,
                        leaseExpiresAt: true,
                    },
                });
                expect(claimed?.state).toBe("claimed");
                expect(claimed?.claimedByMachineId).toBe("machine-1");
                expect(claimed?.leaseExpiresAt).not.toBeNull();
            },
        );
    });

    it("claims only a retained V2 Run snapshot and projects that frozen input instead of strict V3 Definition bytes", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-v2-frozen-snapshot",
                accountId: account.id,
                metadata: "{}",
            },
        });

        const strictTemplateCiphertext = buildStrictV3Recipe(1);
        const strictTriggerId = "trigger-strict-v3";
        const strictAutomation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict V3 schedule",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: strictTemplateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(strictTriggerId) },
                assignments: {
                    create: {
                        machineId: "machine-v2-frozen-snapshot",
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true },
        });

        const frozenTemplateCiphertext = buildPlainTemplateEnvelope();
        const predecessorTriggerId = "trigger-predecessor-v2";
        const predecessorAutomation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Predecessor V2 schedule",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: frozenTemplateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(predecessorTriggerId) },
                assignments: {
                    create: {
                        machineId: "machine-v2-frozen-snapshot",
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true },
        });
        const executionRunTriggerId = "trigger-execution-run";
        const executionRunAutomation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Execution Run target",
                enabled: true,
                targetType: "execution_run",
                templateCiphertext: frozenTemplateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(executionRunTriggerId) },
                assignments: {
                    create: {
                        machineId: "machine-v2-frozen-snapshot",
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true },
        });
        const multiTriggerAutomation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Unrepresentable multiple schedules",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: frozenTemplateCiphertext,
                templateVersion: 1,
                triggers: {
                    create: [
                        scheduleTriggerCreate("trigger-multi-a"),
                        scheduleTriggerCreate("trigger-multi-b", 120_000),
                    ],
                },
                assignments: {
                    create: {
                        machineId: "machine-v2-frozen-snapshot",
                        enabled: true,
                        priority: 0,
                    },
                },
            },
            select: { id: true },
        });
        const now = Date.now();
        const strictScheduledFor = new Date(now - 120_000);
        const strictRun = await db.automationRun.create({
            data: {
                automationId: strictAutomation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({
                    triggerId: strictTriggerId,
                    scheduledFor: strictScheduledFor,
                    occurrenceKey: "strict-v3:primary",
                }),
                scheduledAt: strictScheduledFor,
                dueAt: strictScheduledFor,
                executionInputEnvelope: strictTemplateCiphertext,
            },
            select: { id: true },
        });
        await db.automationRun.createMany({
            data: Array.from({ length: 30 }, (_, index) => {
                const scheduledFor = new Date(now - 240_000 + index);
                return {
                    automationId: strictAutomation.id,
                    accountId: account.id,
                    state: "queued" as const,
                    ...scheduleRunCause({
                        triggerId: strictTriggerId,
                        scheduledFor,
                        occurrenceKey: `strict-v3:${index}`,
                    }),
                    scheduledAt: scheduledFor,
                    dueAt: scheduledFor,
                    executionInputEnvelope: strictTemplateCiphertext,
                };
            }),
        });
        const nullInputPredecessorRun = await db.automationRun.create({
            data: {
                automationId: predecessorAutomation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({
                    triggerId: predecessorTriggerId,
                    scheduledFor: new Date(now - 180_000),
                    occurrenceKey: "predecessor:null-input",
                }),
                scheduledAt: new Date(now - 180_000),
                dueAt: new Date(now - 180_000),
                executionInputEnvelope: null,
            },
            select: { id: true },
        });
        const executionRunTargetRun = await db.automationRun.create({
            data: {
                automationId: executionRunAutomation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({
                    triggerId: executionRunTriggerId,
                    scheduledFor: new Date(now - 90_000),
                    occurrenceKey: "execution-run:scheduled",
                }),
                scheduledAt: new Date(now - 90_000),
                dueAt: new Date(now - 90_000),
                executionInputEnvelope: buildFrozenV2RunInput({
                    templateCiphertext: frozenTemplateCiphertext,
                    targetType: "execution_run",
                    origin: { kind: "scheduled", scheduledFor: now - 90_000 },
                }),
            },
            select: { id: true },
        });
        const frozenInput = buildFrozenV2RunInput({
            templateCiphertext: frozenTemplateCiphertext,
            origin: { kind: "scheduled", scheduledFor: now - 60_000 },
        });
        const multiTriggerScheduledFor = new Date(now - 70_000);
        const multiTriggerRun = await db.automationRun.create({
            data: {
                automationId: multiTriggerAutomation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({
                    triggerId: "trigger-multi-a",
                    scheduledFor: multiTriggerScheduledFor,
                    occurrenceKey: "multi-trigger:scheduled",
                }),
                scheduledAt: multiTriggerScheduledFor,
                dueAt: multiTriggerScheduledFor,
                executionInputEnvelope: buildFrozenV2RunInput({
                    templateCiphertext: frozenTemplateCiphertext,
                    origin: {
                        kind: "scheduled",
                        scheduledFor: multiTriggerScheduledFor.getTime(),
                    },
                }),
            },
            select: { id: true },
        });
        const predecessorRun = await db.automationRun.create({
            data: {
                automationId: predecessorAutomation.id,
                accountId: account.id,
                state: "queued",
                ...scheduleRunCause({
                    triggerId: predecessorTriggerId,
                    scheduledFor: new Date(now - 60_000),
                    occurrenceKey: "predecessor:frozen-input",
                }),
                scheduledAt: new Date(now - 60_000),
                dueAt: new Date(now - 60_000),
                executionInputEnvelope: frozenInput,
            },
            select: { id: true },
        });

        // A current Definition is mutable after the predecessor Run's input
        // was frozen. The V2 worker may finish the retained work, but it must
        // never receive this new strict recipe as a V2 target/template pair.
        const replacementStrictTemplateCiphertext = buildStrictV3Recipe(2);
        await db.automation.update({
            where: { id: predecessorAutomation.id },
            data: {
                templateCiphertext: replacementStrictTemplateCiphertext,
                templateVersion: 2,
            },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const assignments = await app.inject({
                    method: "GET",
                    url: "/v2/automations/daemon/assignments?machineId=machine-v2-frozen-snapshot",
                    headers: { "x-test-user-id": account.id },
                });
                expect(assignments.statusCode).toBe(200);
                expect(assignments.json()).toEqual({ assignments: [] });

                const definitions = await app.inject({
                    method: "GET",
                    url: "/v2/automations",
                    headers: { "x-test-user-id": account.id },
                });
                expect(definitions.statusCode).toBe(200);
                expect(definitions.json()).toEqual(expect.not.arrayContaining([
                    expect.objectContaining({ id: multiTriggerAutomation.id }),
                ]));

                const retainedRunList = await app.inject({
                    method: "GET",
                    url: `/v2/automations/${predecessorAutomation.id}/runs`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(retainedRunList.statusCode, retainedRunList.body).toBe(200);
                expect(retainedRunList.json()).toEqual(expect.objectContaining({
                    runs: [expect.objectContaining({ id: predecessorRun.id, state: "queued" })],
                }));

                const claim = await app.inject({
                    method: "POST",
                    url: "/v2/automations/runs/claim",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-v2-frozen-snapshot",
                        leaseDurationMs: 30_000,
                    },
                });

                expect(claim.statusCode).toBe(200);
                expect(claim.json()).toEqual(expect.objectContaining({
                    run: expect.objectContaining({ id: predecessorRun.id, state: "claimed" }),
                    automation: expect.objectContaining({
                        id: predecessorAutomation.id,
                        targetType: "new_session",
                        templateCiphertext: frozenTemplateCiphertext,
                    }),
                }));
            },
        );

        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: strictRun.id },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "queued",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: multiTriggerRun.id },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "queued",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: nullInputPredecessorRun.id },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "queued",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
        });
        await expect(db.automationRun.findUniqueOrThrow({
            where: { id: executionRunTargetRun.id },
            select: {
                state: true,
                claimedByMachineId: true,
                leaseExpiresAt: true,
                attempt: true,
            },
        })).resolves.toEqual({
            state: "queued",
            claimedByMachineId: null,
            leaseExpiresAt: null,
            attempt: 0,
        });
    });

    it("rejects every V2 Run mutation for a strict V3 schedule before it changes persistence", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = "machine-v2-strict-run-mutations";
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "{}",
            },
        });
        const strictInput = buildStrictV3Recipe(1);
        const triggerId = "trigger-strict-v3-lifecycle";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Strict V3 lifecycle rejection",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: strictInput,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
                assignments: {
                    create: { machineId, enabled: true, priority: 0 },
                },
            },
            select: { id: true },
        });
        const now = Date.now();
        const scheduledFor = new Date(now - 60_000);
        const runInput = {
            automationId: automation.id,
            accountId: account.id,
            ...scheduleRunCause({ triggerId, scheduledFor, occurrenceKey: "placeholder" }),
            scheduledAt: scheduledFor,
            dueAt: new Date(now - 30_000),
            claimedAt: new Date(now - 20_000),
            claimedByMachineId: machineId,
            leaseExpiresAt: new Date(now + 60_000),
            attempt: 1,
            executionInputEnvelope: buildStrictV3RunRecipe(1, machineId),
        };
        const [claimedForHeartbeat, claimedForStart, runningForSucceed, runningForFail, queuedForCancel] =
            await Promise.all([
                db.automationRun.create({ data: { ...runInput, occurrenceKey: "strict:heartbeat", state: "claimed" }, select: { id: true } }),
                db.automationRun.create({ data: { ...runInput, occurrenceKey: "strict:start", state: "claimed" }, select: { id: true } }),
                db.automationRun.create({
                    data: { ...runInput, occurrenceKey: "strict:succeed", state: "running", startedAt: new Date(now - 10_000) },
                    select: { id: true },
                }),
                db.automationRun.create({
                    data: { ...runInput, occurrenceKey: "strict:fail", state: "running", startedAt: new Date(now - 10_000) },
                    select: { id: true },
                }),
                db.automationRun.create({
                    data: {
                        ...runInput,
                        occurrenceKey: "strict:cancel",
                        state: "queued",
                        claimedAt: null,
                        claimedByMachineId: null,
                        leaseExpiresAt: null,
                        attempt: 0,
                    },
                    select: { id: true },
                }),
            ]);

        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
        };
        const mutations = [
            {
                path: `/v2/automations/runs/${claimedForHeartbeat.id}/heartbeat`,
                payload: { machineId, attempt: 1, leaseDurationMs: 30_000 },
            },
            {
                path: `/v2/automations/runs/${claimedForStart.id}/start`,
                payload: { machineId, attempt: 1 },
            },
            {
                path: `/v2/automations/runs/${runningForSucceed.id}/succeed`,
                payload: { machineId, attempt: 1, summaryCiphertext: "legacy summary" },
            },
            {
                path: `/v2/automations/runs/${runningForFail.id}/fail`,
                payload: { machineId, attempt: 1, errorCode: "v2-must-not-write" },
            },
            {
                path: `/v2/automations/runs/${queuedForCancel.id}/cancel`,
                payload: undefined,
            },
        ];

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                for (const mutation of mutations) {
                    const before = await snapshotAutomationPersistence(account.id);
                    const response = await app.inject({
                        method: "POST",
                        url: mutation.path,
                        headers: mutation.payload ? headers : { "x-test-user-id": account.id },
                        ...(mutation.payload ? { payload: mutation.payload } : {}),
                    });
                    expect(response.statusCode, mutation.path).toBe(404);
                    expect(await snapshotAutomationPersistence(account.id)).toEqual(before);
                }
            },
        );
    });

    it("retains the committed predecessor V2 Session through input failure and cancellation settlement", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = "machine-v2-known-session-retention";
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "{}",
            },
        });
        const templateCiphertext = buildPlainTemplateEnvelope();
        const triggerId = "trigger-v2-session-retention";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Predecessor V2 known Session retention",
                enabled: true,
                targetType: "new_session",
                templateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
            },
            select: { id: true },
        });
        const now = Date.now();
        const executionInputEnvelope = buildFrozenV2RunInput({
            templateCiphertext,
            origin: { kind: "scheduled", scheduledFor: now - 60_000 },
        });
        const createRunningRun = async (id: string) => await db.automationRun.create({
            data: {
                id,
                automationId: automation.id,
                accountId: account.id,
                state: "running",
                ...scheduleRunCause({
                    triggerId,
                    scheduledFor: new Date(now - 60_000),
                    occurrenceKey: `session-retention:${id}`,
                }),
                scheduledAt: new Date(now - 60_000),
                dueAt: new Date(now - 30_000),
                claimedAt: new Date(now - 20_000),
                startedAt: new Date(now - 10_000),
                claimedByMachineId: machineId,
                leaseExpiresAt: new Date(now + 60_000),
                attempt: 1,
                executionInputEnvelope,
            },
            select: { id: true },
        });
        const failureCases = [
            { suffix: "rejected", errorCode: "prompt_delivery_failed", errorMessage: "admission rejected" },
            { suffix: "unknown", errorCode: "prompt_delivery_outcome_unknown", errorMessage: "admission outcome unknown" },
            { suffix: "missing-transport", errorCode: "prompt_delivery_failed", errorMessage: "machine admission unavailable" },
            { suffix: "thrown-admission", errorCode: "prompt_delivery_failed", errorMessage: "machine admission threw" },
        ] as const;

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                for (const failure of failureCases) {
                    const run = await createRunningRun(`run-v2-known-session-${failure.suffix}`);
                    const session = await db.session.create({
                        data: {
                            id: `session-v2-known-${failure.suffix}`,
                            accountId: account.id,
                            tag: `v2-known-session-${failure.suffix}`,
                            metadata: "{}",
                        },
                        select: { id: true },
                    });

                    const response = await app.inject({
                        method: "POST",
                        url: `/v2/automations/runs/${run.id}/fail`,
                        headers: {
                            "content-type": "application/json",
                            "x-test-user-id": account.id,
                        },
                        payload: {
                            machineId,
                            attempt: 1,
                            producedSessionId: session.id,
                            errorCode: failure.errorCode,
                            errorMessage: failure.errorMessage,
                        },
                    });

                    expect(response.statusCode, failure.suffix).toBe(200);
                    expect(await db.automationRun.findUniqueOrThrow({
                        where: { id: run.id },
                        select: {
                            state: true,
                            producedSessionId: true,
                            errorCode: true,
                        },
                    })).toEqual({
                        state: "failed",
                        producedSessionId: session.id,
                        errorCode: failure.errorCode,
                    });
                }

                // The released predecessor client has neither the optional
                // attempt nor the Session-retention field. Its terminal
                // failure remains representable by the current V2 reader.
                const legacyOmissionRun = await createRunningRun("run-v2-legacy-fail-omits-session");
                const legacyOmissionResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${legacyOmissionRun.id}/fail`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId,
                        errorCode: "legacy-v2-input-failure",
                        errorMessage: "The predecessor client did not supply a Session result",
                    },
                });
                expect(legacyOmissionResponse.statusCode).toBe(200);
                expect(await db.automationRun.findUniqueOrThrow({
                    where: { id: legacyOmissionRun.id },
                    select: {
                        state: true,
                        producedSessionId: true,
                        errorCode: true,
                    },
                })).toEqual({
                    state: "failed",
                    producedSessionId: null,
                    errorCode: "legacy-v2-input-failure",
                });

                const cancelledRun = await createRunningRun("run-v2-known-session-cancelled");
                const cancelledSession = await db.session.create({
                    data: {
                        id: "session-v2-known-cancelled",
                        accountId: account.id,
                        tag: "v2-known-session-cancelled",
                        metadata: "{}",
                    },
                    select: { id: true },
                });
                const cancelResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${cancelledRun.id}/cancel`,
                    headers: { "x-test-user-id": account.id },
                });
                expect(cancelResponse.statusCode).toBe(200);

                const cancelledFailureResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${cancelledRun.id}/fail`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId,
                        attempt: 1,
                        producedSessionId: cancelledSession.id,
                        errorCode: "session_start_cancelled_after_create",
                        errorMessage: "Automation Run cancellation won after the canonical Session result was known",
                    },
                });

                expect(cancelledFailureResponse.statusCode).toBe(200);
                expect(await db.automationRun.findUniqueOrThrow({
                    where: { id: cancelledRun.id },
                    select: {
                        state: true,
                        producedSessionId: true,
                        errorCode: true,
                    },
                })).toEqual({
                    state: "cancelled",
                    producedSessionId: cancelledSession.id,
                    errorCode: null,
                });
            },
        );
    });

    it("renews lease only for the claiming machine", async () => {
        const account = await db.account.create({
            data: { encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const templateCiphertext = buildPlainTemplateEnvelope();
        const triggerId = "trigger-heartbeat";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Heartbeat run",
                enabled: true,
                targetType: "new_session",
                templateCiphertext,
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId) },
            },
            select: { id: true },
        });
        const scheduledAt = new Date(Date.now() - 30_000);
        const run = await db.automationRun.create({
            data: {
                automationId: automation.id,
                accountId: account.id,
                state: "claimed",
                ...scheduleRunCause({
                    triggerId,
                    scheduledFor: scheduledAt,
                    occurrenceKey: "heartbeat:scheduled",
                }),
                scheduledAt,
                dueAt: new Date(Date.now() - 20_000),
                claimedAt: new Date(Date.now() - 10_000),
                claimedByMachineId: "machine-1",
                leaseExpiresAt: new Date(Date.now() + 1_000),
                attempt: 1,
                executionInputEnvelope: buildFrozenV2RunInput({
                    templateCiphertext,
                    origin: { kind: "scheduled", scheduledFor: scheduledAt.getTime() },
                }),
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const okResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${run.id}/heartbeat`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-1",
                        leaseDurationMs: 45_000,
                    },
                });
                expect(okResponse.statusCode).toBe(200);
                const okBody = okResponse.json() as any;
                expect(okBody.ok).toBe(true);
                expect(typeof okBody.leaseExpiresAt).toBe("number");

                const deniedResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${run.id}/heartbeat`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-2",
                        leaseDurationMs: 45_000,
                    },
                });
                expect(deniedResponse.statusCode).toBe(404);
                expect(deniedResponse.json()).toEqual({ error: "automation_run_not_found_or_not_claimed" });

                await db.automationRun.update({
                    where: { id: run.id },
                    data: { attempt: 2 },
                });

                const staleLegacyAttemptResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${run.id}/heartbeat`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-1",
                        leaseDurationMs: 45_000,
                    },
                });
                expect(staleLegacyAttemptResponse.statusCode).toBe(404);

                const currentAttemptResponse = await app.inject({
                    method: "POST",
                    url: `/v2/automations/runs/${run.id}/heartbeat`,
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        machineId: "machine-1",
                        attempt: 2,
                        leaseDurationMs: 45_000,
                    },
                });
                expect(currentAttemptResponse.statusCode).toBe(200);
            },
        );
    });

    it("returns assignments scoped to the requested machine", async () => {
        const account = await db.account.create({
            data: { publicKey: "pk-automation-daemon-assignments" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-2",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const triggerId = "trigger-assigned-run";
        const automation = await db.automation.create({
            data: {
                accountId: account.id,
                name: "Assigned run",
                enabled: true,
                targetType: "new_session",
                templateCiphertext: buildTemplateEnvelope(),
                templateVersion: 1,
                triggers: { create: scheduleTriggerCreate(triggerId, 120_000) },
            },
            select: { id: true },
        });
        await db.automationAssignment.createMany({
            data: [
                {
                    automationId: automation.id,
                    machineId: "machine-1",
                    enabled: true,
                    priority: 2,
                },
                {
                    automationId: automation.id,
                    machineId: "machine-2",
                    enabled: true,
                    priority: 1,
                },
            ],
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const response = await app.inject({
                    method: "GET",
                    url: "/v2/automations/daemon/assignments?machineId=machine-1",
                    headers: { "x-test-user-id": account.id },
                });

                expect(response.statusCode).toBe(200);
                const body = response.json() as any;
                expect(Array.isArray(body.assignments)).toBe(true);
                expect(body.assignments).toHaveLength(1);
                expect(body.assignments[0]).toEqual(
                    expect.objectContaining({
                        machineId: "machine-1",
                        enabled: true,
                        priority: 2,
                        automation: expect.objectContaining({
                            id: automation.id,
                            name: "Assigned run",
                        }),
                    }),
                );
            },
        );
    });

    it("keeps non-schedule definitions and non-V2 Run causes out of V2 mutations while V3 Run Now accepts zero triggers", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const machineId = "machine-v2-unsupported-mutations";
        await db.machine.create({
            data: {
                id: machineId,
                accountId: account.id,
                metadata: "{}",
            },
        });
        const headers = {
            "content-type": "application/json",
            "x-test-user-id": account.id,
            "x-happier-account-stored-content-protocol": "2",
        };

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                for (const causeKind of ["pluginEvent", "conversation"] as const) {
                    const fixture = await seedUnsupportedV2Automation({
                        accountId: account.id,
                        machineId,
                        causeKind,
                    });

                    const definitionMutations = [
                        {
                            name: "patch",
                            method: "PATCH" as const,
                            path: (automationId: string) => `/v2/automations/${automationId}`,
                            payload: { name: "V2 must not update this" },
                        },
                        {
                            name: "delete",
                            method: "DELETE" as const,
                            path: (automationId: string) => `/v2/automations/${automationId}`,
                        },
                        {
                            name: "pause",
                            method: "POST" as const,
                            path: (automationId: string) => `/v2/automations/${automationId}/pause`,
                        },
                        {
                            name: "resume",
                            method: "POST" as const,
                            path: (automationId: string) => `/v2/automations/${automationId}/resume`,
                        },
                        {
                            name: "assignments",
                            method: "POST" as const,
                            path: (automationId: string) => `/v2/automations/${automationId}/assignments`,
                            payload: {
                                assignments: [{ machineId, enabled: false, priority: 1 }],
                            },
                        },
                        {
                            name: "run-now",
                            method: "POST" as const,
                            path: (automationId: string) => `/v2/automations/${automationId}/run-now`,
                        },
                    ];

                    for (const operation of definitionMutations) {
                        const before = await snapshotAutomationPersistence(account.id);
                        const known = await app.inject({
                            method: operation.method,
                            url: operation.path(fixture.automation.id),
                            headers: operation.payload
                                ? headers
                                : {
                                    "x-test-user-id": account.id,
                                    "x-happier-account-stored-content-protocol": "2",
                                },
                            ...(operation.payload ? { payload: operation.payload } : {}),
                        });
                        expect(known.statusCode, `${causeKind} ${operation.name}`).toBe(404);
                        expect(await snapshotAutomationPersistence(account.id)).toEqual(before);

                        const absent = await app.inject({
                            method: operation.method,
                            url: operation.path(`missing-${causeKind}-${operation.name}`),
                            headers: operation.payload
                                ? headers
                                : {
                                    "x-test-user-id": account.id,
                                    "x-happier-account-stored-content-protocol": "2",
                                },
                            ...(operation.payload ? { payload: operation.payload } : {}),
                        });
                        expect(known.json()).toEqual(absent.json());
                    }

                    const runMutations = [
                        {
                            name: "heartbeat",
                            path: (runId: string) => `/v2/automations/runs/${runId}/heartbeat`,
                            runId: fixture.claimed.id,
                            payload: { machineId, attempt: 1, leaseDurationMs: 30_000 },
                        },
                        {
                            name: "start",
                            path: (runId: string) => `/v2/automations/runs/${runId}/start`,
                            runId: fixture.claimed.id,
                            payload: { machineId, attempt: 1 },
                        },
                        {
                            name: "succeed",
                            path: (runId: string) => `/v2/automations/runs/${runId}/succeed`,
                            runId: fixture.running.id,
                            payload: { machineId, attempt: 1, summaryCiphertext: "legacy-summary" },
                        },
                        {
                            name: "fail",
                            path: (runId: string) => `/v2/automations/runs/${runId}/fail`,
                            runId: fixture.running.id,
                            payload: { machineId, attempt: 1, errorCode: "test" },
                        },
                        {
                            name: "cancel",
                            path: (runId: string) => `/v2/automations/runs/${runId}/cancel`,
                            runId: fixture.claimed.id,
                        },
                    ];

                    for (const operation of runMutations) {
                        const before = await snapshotAutomationPersistence(account.id);
                        const known = await app.inject({
                            method: "POST",
                            url: operation.path(operation.runId),
                            headers: operation.payload
                                ? headers
                                : {
                                    "x-test-user-id": account.id,
                                    "x-happier-account-stored-content-protocol": "2",
                                },
                            ...(operation.payload ? { payload: operation.payload } : {}),
                        });
                        expect(known.statusCode, `${causeKind} ${operation.name}`).toBe(404);
                        expect(await snapshotAutomationPersistence(account.id)).toEqual(before);

                        const absent = await app.inject({
                            method: "POST",
                            url: operation.path(`missing-${causeKind}-${operation.name}`),
                            headers: operation.payload
                                ? headers
                                : {
                                    "x-test-user-id": account.id,
                                    "x-happier-account-stored-content-protocol": "2",
                                },
                            ...(operation.payload ? { payload: operation.payload } : {}),
                        });
                        expect(known.json()).toEqual(absent.json());
                    }

                    const beforeClaim = await snapshotAutomationPersistence(account.id);
                    const claim = await app.inject({
                        method: "POST",
                        url: "/v2/automations/runs/claim",
                        headers,
                        payload: { machineId, leaseDurationMs: 30_000 },
                    });
                    expect(claim.statusCode).toBe(200);
                    expect(claim.json()).toEqual({ run: null, automation: null });
                    expect(await snapshotAutomationPersistence(account.id)).toEqual(beforeClaim);
                    expect(fixture.queued.id).toEqual(expect.any(String));
                }

                const zeroTriggerAutomation = await db.automation.create({
                    data: {
                        accountId: account.id,
                        name: "V3 zero-trigger Run Now control",
                        enabled: true,
                        targetType: "new_session",
                        templateCiphertext: buildPlainTemplateEnvelope(),
                        templateVersion: 1,
                    },
                    select: { id: true },
                });

                const v3RunNow = await app.inject({
                    method: "POST",
                    url: `/v3/automations/${zeroTriggerAutomation.id}/run-now`,
                    headers: {
                        "x-test-user-id": account.id,
                        "x-happier-account-stored-content-protocol": "2",
                    },
                });
                expect(v3RunNow.statusCode).toBe(200);
                expect(v3RunNow.json()).toEqual(expect.objectContaining({
                    run: expect.objectContaining({
                        automationId: zeroTriggerAutomation.id,
                        state: "queued",
                        cause: expect.objectContaining({ kind: "manual" }),
                    }),
                }));

                const v3Run = await db.automationRun.findFirst({
                    where: {
                        automationId: zeroTriggerAutomation.id,
                        causeKind: "manual",
                    },
                    select: {
                        state: true,
                        executionInputEnvelope: true,
                    },
                });
                expect(v3Run).toEqual({
                    state: "queued",
                    executionInputEnvelope: expect.any(String),
                });
                expect(JSON.parse(v3Run?.executionInputEnvelope ?? "")).toEqual({
                    kind: "happier_automation_run_execution_input_v1",
                    targetType: "new_session",
                    templateVersion: 1,
                    templateCiphertext: buildPlainTemplateEnvelope(),
                    origin: {
                        kind: "manual",
                        invokedAt: expect.any(Number),
                    },
                });
            },
        );
    });

    it("rejects existing_session automation creation when target session is missing or not resumable", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        await db.machine.create({
            data: {
                id: "machine-1",
                accountId: account.id,
                metadata: "{}",
            },
            select: { id: true },
        });
        const unsupportedSession = await db.session.create({
            data: {
                tag: "unsupported-target",
                accountId: account.id,
                metadata: JSON.stringify({ flavor: "unknown-local-backend" }),
                active: true,
            },
            select: { id: true },
        });

        await withAuthenticatedTestApp(
            (app) => automationRoutes(app as any),
            async (app) => {
                const missingResponse = await app.inject({
                    method: "POST",
                    url: "/v2/automations",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        name: "Existing missing",
                        enabled: true,
                        schedule: { kind: "interval", everyMs: 60_000 },
                        targetType: "existing_session",
                        templateCiphertext: buildTemplateEnvelope("missing-session"),
                        assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                    },
                });
                expect(missingResponse.statusCode).toBe(400);
                expect(String((missingResponse.json() as any).error ?? "")).toMatch(/existing session/i);

                const inactiveResponse = await app.inject({
                    method: "POST",
                    url: "/v2/automations",
                    headers: {
                        "content-type": "application/json",
                        "x-test-user-id": account.id,
                    },
                    payload: {
                        name: "Existing unsupported",
                        enabled: true,
                        schedule: { kind: "interval", everyMs: 60_000 },
                        targetType: "existing_session",
                        templateCiphertext: buildTemplateEnvelope(unsupportedSession.id),
                        assignments: [{ machineId: "machine-1", enabled: true, priority: 0 }],
                    },
                });
                expect(inactiveResponse.statusCode).toBe(400);
                expect(String((inactiveResponse.json() as any).error ?? "")).toMatch(/resume|resum/i);
            },
        );
    });
});
