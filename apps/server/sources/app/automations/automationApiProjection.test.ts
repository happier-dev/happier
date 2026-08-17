import { describe, expect, it } from "vitest";
import {
    AutomationRunExecutionInputV1Schema,
    AutomationSourceSelectorIdV1Schema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";

import {
    isAutomationV2Compatible,
    isAutomationRunV2Compatible,
    toAutomationV2ApiDto,
    toAutomationV3DefinitionDetailApiDto,
    toAutomationV3DefinitionListItemApiDto,
    toAutomationRunV2ApiDto,
    toAutomationRunV3DetailApiDto,
    toAutomationRunV3ListApiDto,
} from "./automationApiProjection";

const DATE = new Date("2026-08-10T12:00:00.000Z");
const EVENT_OCCURRED_AT = new Date("2026-08-09T12:00:00.000Z");
const CONVERSATION_OCCURRED_AT = new Date("2026-08-08T12:00:00.000Z");
const MANUAL_CREATED_AT = new Date("2026-08-07T12:00:00.000Z");
const SCHEDULE_DUE_AT = new Date("2026-08-06T12:00:00.000Z");
const ACCOUNT_CURRENTNESS = {
    mode: "plain" as const,
    version: 7,
    contentKeyFingerprint: null,
};
const EVENT_SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "00000000-0000-4000-8000-000000000001",
);

const V2_TEMPLATE_CIPHERTEXT = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "daily" },
});

function frozenV2ExecutionInput(origin: Readonly<
    | { kind: "scheduled"; scheduledFor: number }
    | { kind: "manual"; invokedAt: number }
>): string {
    return JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 2,
        templateCiphertext: V2_TEMPLATE_CIPHERTEXT,
        origin,
    }));
}

function strictEventExecutionRecipe(): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 2,
        template: { t: "plain", v: { v: 1, prompt: "Inspect the frozen Event." } },
        triggerEvidence: {
            t: "plain",
            v: {
                v: 1,
                kind: "pluginEvent",
                eventRef: { pluginId: "com.example.github", localId: "issue-opened" },
                sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                occurrenceId: "occurrence-1",
                occurredAt: EVENT_OCCURRED_AT.getTime(),
                payload: { action: "opened" },
                sourceInstanceId: "private-source",
                sourceContractVersion: 2,
                observationReceivedAt: EVENT_OCCURRED_AT.getTime() + 1,
                filter: { version: null, result: "matched" },
            },
        },
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: { serverId: "server-1", machineId: "machine-1" },
                directory: "/tmp/event-detail",
                agentTarget: {
                    kind: "agent",
                    identity: { pluginId: "happier.agent.codex", localId: "codex" },
                },
            },
        },
    });
    if (serialized.kind !== "available") {
        throw new Error("Strict Event Run fixture must serialize");
    }
    return serialized.serialized;
}

function scheduleAutomation() {
    return {
        id: "automation-schedule",
        accountId: "account-1",
        name: "Daily summary",
        description: null,
        enabled: true,
        triggerKind: "schedule" as const,
        scheduleKind: "interval" as const,
        scheduleExpr: null,
        everyMs: 60_000,
        timezone: null,
        targetType: "new_session" as const,
        templateCiphertext: V2_TEMPLATE_CIPHERTEXT,
        templateVersion: 2,
        triggerEventPluginId: null,
        triggerEventLocalId: null,
        triggerSourceSelectorId: null,
        triggerSourceContractVersion: null,
        triggerObservationTransport: null,
        triggerWebhookEndpointId: null,
        triggerObservationStartsAt: null,
        watcherMachineId: null,
        watcherMachineInstallationId: null,
        watcherPluginId: null,
        watcherMaterializationId: null,
        triggerDefinitionEnvelope: null,
        nextRunAt: DATE,
        lastRunAt: null,
        createdAt: DATE,
        updatedAt: DATE,
        assignments: [{ machineId: "machine-1", enabled: true, priority: 0, updatedAt: DATE }],
    };
}

function eventAutomation() {
    return {
        ...scheduleAutomation(),
        id: "automation-event",
        triggerKind: "pluginEvent" as const,
        scheduleKind: null,
        scheduleExpr: null,
        everyMs: null,
        timezone: null,
        triggerEventPluginId: "com.example.github",
        triggerEventLocalId: "issue-opened",
        triggerSourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
        triggerSourceContractVersion: 2,
        triggerObservationTransport: "durablePush" as const,
        triggerWebhookEndpointId: "endpoint-1",
        triggerObservationStartsAt: DATE,
        triggerDefinitionEnvelope: JSON.stringify(
            sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: "plain",
                binding: {
                    v: 1,
                    automationId: "automation-event",
                    templateVersion: 2,
                    triggerKind: "pluginEvent",
                    eventRef: {
                        pluginId: "com.example.github",
                        localId: "issue-opened",
                    },
                    sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                },
                definition: {
                    v: 1,
                    sourceInstanceId: "private-source",
                    sourceConfig: { source: "private" },
                    displayLabel: "Private source",
                    filter: null,
                    maximumObservationAgeMs: null,
                },
            }),
        ),
        nextRunAt: null,
    };
}

function eventStatusProjection() {
    return {
        sourceStatus: {
            automationId: "automation-event",
            eventRef: { pluginId: "com.example.github", localId: "issue-opened" },
            sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
            templateVersion: 2,
            reporterMaterializationRef: {
                machineId: "machine-1",
                materializationId: "materialization-1",
                pluginId: "com.example.github",
            },
            reporterImmutableGenerationId: "github-immutable-generation-a",
            state: "attention" as const,
            code: "historyGap" as const,
            lastObservedAt: DATE.getTime(),
            lastDispositionAt: DATE.getTime(),
            nextRetryAt: null,
            observedCount: 4,
            admittedCount: 3,
            skippedCount: 1,
            revision: 7,
        },
        sourceCatalogStatus: {
            observedRevision: "9",
            adoptedRevision: "7",
            state: "reconciliationLate" as const,
            scanStartedAt: DATE.getTime(),
            nextRetryAt: DATE.getTime() + 60_000,
        },
    };
}

function eventRun() {
    return {
        id: "run-event",
        automationId: "automation-event",
        accountId: "account-1",
        state: "queued" as const,
        originKind: "pluginEvent" as const,
        originOccurredAt: EVENT_OCCURRED_AT,
        occurrenceKey: "occurrence-1",
        occurrenceEvidenceEqualityTag: null,
        originSourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
        triggerEvidenceEnvelope: "{\"t\":\"plain\",\"v\":{\"payload\":\"private\"}}",
        executionInputEnvelope: "{\"t\":\"plain\",\"v\":{\"input\":\"private\"}}",
        executionDispatchState: null,
        executionAttempt: 0,
        executionDispatchCommittedAt: null,
        executionDispatchDueAt: null,
        executionNativeRunId: null,
        executionNativeCallId: null,
        executionNativeSidechainId: null,
        resultEnvelope: JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    accountId: "account-1",
                    automationId: "automation-event",
                    runId: "run-event",
                    handoffId: "handoff-1",
                },
                result: { v: 1, kind: "text", text: "private" },
            },
        }),
        replyContextEnvelope: null,
        replyHandoffActionPluginId: null,
        replyHandoffActionLocalId: null,
        replyHandoffTargetMachineId: null,
        replyHandoffTargetMachineInstallationId: null,
        replyHandoffTargetMaterializationId: null,
        replyHandoffId: null,
        replyHandoffState: "none" as const,
        replyHandoffAttempt: 0,
        replyHandoffDueAt: null,
        replyHandoffReceiptEnvelope: null,
        scheduledAt: DATE,
        dueAt: DATE,
        claimedAt: null,
        startedAt: null,
        finishedAt: null,
        claimedByMachineId: null,
        leaseExpiresAt: null,
        attempt: 0,
        revision: 0,
        summaryCiphertext: null,
        errorCode: "source_waiting",
        errorMessage: "private provider detail",
        producedSessionId: null,
        createdAt: DATE,
        updatedAt: DATE,
    };
}

function manualRun() {
    return {
        ...eventRun(),
        id: "run-manual",
        originKind: "manual" as const,
        originOccurredAt: null,
        occurrenceKey: null,
        originSourceSelectorId: null,
        triggerEvidenceEnvelope: null,
        executionInputEnvelope: frozenV2ExecutionInput({
            kind: "manual",
            invokedAt: MANUAL_CREATED_AT.getTime(),
        }),
        errorCode: null,
        errorMessage: null,
    };
}

function scheduledRun() {
    return {
        ...manualRun(),
        id: "run-scheduled",
        originKind: "scheduled" as const,
        dueAt: SCHEDULE_DUE_AT,
        executionInputEnvelope: frozenV2ExecutionInput({
            kind: "scheduled",
            scheduledFor: SCHEDULE_DUE_AT.getTime(),
        }),
    };
}

function conversationRun() {
    return {
        ...eventRun(),
        id: "run-conversation",
        originKind: "conversation" as const,
        originOccurredAt: CONVERSATION_OCCURRED_AT,
        originSourceSelectorId: null,
    };
}

const V2_AUTOMATION_KEYS = [
    "assignments",
    "createdAt",
    "description",
    "enabled",
    "id",
    "lastRunAt",
    "name",
    "nextRunAt",
    "schedule",
    "targetType",
    "templateCiphertext",
    "templateVersion",
    "updatedAt",
];

const V2_RUN_KEYS = [
    "attempt",
    "automationId",
    "claimedAt",
    "claimedByMachineId",
    "createdAt",
    "dueAt",
    "errorCode",
    "errorMessage",
    "finishedAt",
    "id",
    "leaseExpiresAt",
    "producedSessionId",
    "scheduledAt",
    "startedAt",
    "state",
    "summaryCiphertext",
    "updatedAt",
];

describe("Automation API projections", () => {
    it("keeps predecessor v2 schedule/manual-only and projects the v3 trigger union without source leakage", () => {
        const schedule = scheduleAutomation();
        const event = eventAutomation();

        expect(isAutomationV2Compatible(schedule)).toBe(true);
        expect(isAutomationV2Compatible(event)).toBe(false);
        expect(isAutomationV2Compatible({
            ...schedule,
            templateCiphertext: "not a retained V2 template envelope",
        })).toBe(false);
        const v2 = toAutomationV2ApiDto(schedule);
        expect(v2).toMatchObject({
            id: "automation-schedule",
            schedule: { kind: "interval", everyMs: 60_000 },
        });
        expect(Object.keys(v2).sort()).toEqual(V2_AUTOMATION_KEYS);
        expect(Object.keys(v2.schedule).sort()).toEqual([
            "everyMs",
            "kind",
            "scheduleExpr",
            "timezone",
        ]);
        expect(toAutomationV3DefinitionDetailApiDto(
            event,
            ACCOUNT_CURRENTNESS,
            eventStatusProjection(),
        )).toEqual(expect.objectContaining({
            id: "automation-event",
            trigger: {
                kind: "pluginEvent",
                eventRef: {
                    pluginId: "com.example.github",
                    localId: "issue-opened",
                },
                sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                sourceContractVersion: 2,
                observation: {
                    kind: "durablePush",
                    webhookEndpointId: "endpoint-1",
                    observationStartsAt: DATE.getTime(),
                },
            },
            triggerDefinitionEnvelope: event.triggerDefinitionEnvelope,
            sourceStatus: expect.objectContaining({
                state: "attention",
                code: "historyGap",
                revision: 7,
                reporterMaterializationRef: {
                    machineId: "machine-1",
                    materializationId: "materialization-1",
                    pluginId: "com.example.github",
                },
                reporterImmutableGenerationId: "github-immutable-generation-a",
            }),
            sourceCatalogStatus: {
                observedRevision: "9",
                adoptedRevision: "7",
                state: "reconciliationLate",
                scanStartedAt: DATE.getTime(),
                nextRetryAt: DATE.getTime() + 60_000,
            },
        }));
        expect(toAutomationV3DefinitionDetailApiDto(event, ACCOUNT_CURRENTNESS)).not.toHaveProperty("schedule");
        const listItem = toAutomationV3DefinitionListItemApiDto(event, eventStatusProjection());
        expect(listItem).toMatchObject({
            sourceStatus: { state: "attention", code: "historyGap", revision: 7 },
            sourceCatalogStatus: { observedRevision: "9", adoptedRevision: "7" },
        });
        expect(listItem).not.toHaveProperty("triggerDefinitionEnvelope");
        expect(listItem).not.toHaveProperty("templateCiphertext");
    });

    it("keeps v3 list rows bounded, rejects generic Event execution envelopes, and reserves private request/result content for exact detail", () => {
        const run = eventRun();
        const manual = manualRun();

        expect(isAutomationRunV2Compatible(run)).toBe(false);
        expect(isAutomationRunV2Compatible(manual)).toBe(true);
        expect(isAutomationRunV2Compatible({
            ...scheduledRun(),
            executionInputEnvelope: null,
        })).toBe(false);
        expect(isAutomationRunV2Compatible({
            ...scheduledRun(),
            executionInputEnvelope: "{\"kind\":\"happier_automation_run_execution_recipe_v1\"}",
        })).toBe(false);
        expect(isAutomationRunV2Compatible({
            ...scheduledRun(),
            executionInputEnvelope: frozenV2ExecutionInput({
                kind: "manual",
                invokedAt: SCHEDULE_DUE_AT.getTime(),
            }),
        })).toBe(false);
        expect(isAutomationRunV2Compatible({
            ...scheduledRun(),
            executionInputEnvelope: JSON.stringify({
                kind: "happier_automation_run_execution_input_v1",
                targetType: "execution_run",
                templateVersion: 2,
                templateCiphertext: V2_TEMPLATE_CIPHERTEXT,
                origin: { kind: "scheduled", scheduledFor: SCHEDULE_DUE_AT.getTime() },
            }),
        })).toBe(false);
        const v2Manual = toAutomationRunV2ApiDto(manual);
        expect(v2Manual.scheduledAt).toBe(DATE.getTime());
        expect(v2Manual.summaryCiphertext).toBeNull();
        expect(Object.keys(v2Manual).sort()).toEqual(V2_RUN_KEYS);

        const v2Legacy = toAutomationRunV2ApiDto({
            ...manual,
            resultEnvelope: JSON.stringify({
                t: "legacySummaryCiphertext",
                c: " exact predecessor bytes ",
            }),
            summaryCiphertext: null,
        });
        expect(v2Legacy.summaryCiphertext).toBe(" exact predecessor bytes ");
        expect(toAutomationRunV3ListApiDto(run)).toEqual(expect.objectContaining({
            id: "run-event",
            origin: {
                kind: "pluginEvent",
                occurrenceKey: "occurrence-1",
                sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                occurredAt: EVENT_OCCURRED_AT.getTime(),
            },
            errorCode: "source_waiting",
        }));
        expect(toAutomationRunV3ListApiDto(run)).not.toHaveProperty("errorMessage");
        expect(toAutomationRunV3ListApiDto(run)).not.toHaveProperty("resultEnvelope");
        expect(toAutomationRunV3ListApiDto(run)).not.toHaveProperty("summaryCiphertext");
        expect(() => toAutomationRunV3DetailApiDto(run, "plain"))
            .toThrow("Automation stored content is invalid");
        expect(() => toAutomationRunV3DetailApiDto({
            ...eventRun(),
            executionInputEnvelope: frozenV2ExecutionInput({
                kind: "manual",
                invokedAt: MANUAL_CREATED_AT.getTime(),
            }),
        }, "plain")).toThrow("Automation stored content is invalid");
    });

    it("does not manufacture Event status without the batch projection owner", () => {
        const event = eventAutomation();

        expect(toAutomationV3DefinitionListItemApiDto(event)).toMatchObject({
            sourceStatus: null,
            sourceCatalogStatus: null,
        });
    });

    it("keeps a strict Event Run invisible to V2 while exposing its frozen recipe to V3 detail", () => {
        const executionInputEnvelope = strictEventExecutionRecipe();
        const run = {
            ...eventRun(),
            executionInputEnvelope,
        };

        expect(isAutomationRunV2Compatible(run)).toBe(false);
        expect(toAutomationRunV3DetailApiDto(run, "plain")).toEqual(expect.objectContaining({
            executionInputEnvelope,
        }));
        expect(() => toAutomationRunV3DetailApiDto(run, "e2ee"))
            .toThrow("Automation stored content mode does not match the Account");
    });

    it("projects every Run origin from its immutable timestamp without changing V2 scheduledAt", () => {
        const manual = {
            ...manualRun(),
            createdAt: MANUAL_CREATED_AT,
        };

        expect(toAutomationRunV3ListApiDto(scheduledRun()).origin).toEqual({
            kind: "scheduled",
            scheduledFor: SCHEDULE_DUE_AT.getTime(),
        });
        expect(toAutomationRunV3ListApiDto(manual).origin).toEqual({
            kind: "manual",
            invokedAt: MANUAL_CREATED_AT.getTime(),
        });
        expect(toAutomationRunV3ListApiDto(eventRun()).origin).toEqual(expect.objectContaining({
            kind: "pluginEvent",
            occurredAt: EVENT_OCCURRED_AT.getTime(),
        }));
        expect(toAutomationRunV3ListApiDto(conversationRun()).origin).toEqual(expect.objectContaining({
            kind: "conversation",
            occurredAt: CONVERSATION_OCCURRED_AT.getTime(),
        }));
        expect(toAutomationRunV2ApiDto(manual).scheduledAt).toBe(DATE.getTime());
    });

    it("fails closed rather than returning a private V3 envelope under the wrong Account mode", () => {
        expect(() => toAutomationRunV3DetailApiDto({
            ...manualRun(),
            executionInputEnvelope: JSON.stringify(AutomationRunExecutionInputV1Schema.parse({
                kind: "happier_automation_run_execution_input_v1",
                targetType: "new_session",
                templateVersion: 2,
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "ciphertext",
                }),
                origin: { kind: "manual", invokedAt: MANUAL_CREATED_AT.getTime() },
            })),
        }, "plain")).toThrow("Automation stored content mode does not match the Account");
    });

    it("reads a frozen schedule/manual execution recipe through its nested Account-mode envelope", () => {
        const executionInputEnvelope = JSON.stringify({
            kind: "happier_automation_run_execution_input_v1",
            targetType: "new_session",
            templateVersion: 1,
            templateCiphertext: JSON.stringify({
                kind: "happier_automation_template_plain_v1",
                payload: { directory: "/tmp/frozen-detail" },
            }),
            origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
        });
        const run = {
            ...manualRun(),
            executionInputEnvelope,
        };

        expect(toAutomationRunV3DetailApiDto(run, "plain")).toEqual(expect.objectContaining({
            executionInputEnvelope,
        }));
        expect(() => toAutomationRunV3DetailApiDto(run, "e2ee"))
            .toThrow("Automation stored content mode does not match the Account");
    });

    it("keeps a current private failure detail out of structural and predecessor projections", () => {
        const errorDetailEnvelope = JSON.stringify({
            t: "plain",
            v: {
                v: 1,
                correspondence: {
                    automationId: "automation-event",
                    runId: "run-manual",
                },
                detail: "The worker saw /private/project.",
            },
        });
        const run = {
            ...manualRun(),
            errorCode: "worker_crashed",
            errorMessage: errorDetailEnvelope,
        };

        expect(toAutomationRunV3ListApiDto(run)).not.toHaveProperty("errorDetailEnvelope");
        const detail = toAutomationRunV3DetailApiDto(run, "plain");
        expect(detail.errorDetailEnvelope).toBe(errorDetailEnvelope);
        expect(toAutomationRunV2ApiDto(run).errorMessage).toBeNull();
    });
});
