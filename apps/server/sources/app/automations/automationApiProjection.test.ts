import { describe, expect, it } from "vitest";
import {
    AutomationSourceSelectorIdV1Schema,
    AutomationTriggerIdSchema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
    serializeAutomationStoredDefinitionExecutionRecipeV1,
} from "@happier-dev/protocol";

import {
    isAutomationDefinitionRepresentableInV2,
    isAutomationRunV2Compatible,
    toAutomationV2ApiDto,
    toAutomationDefinitionDetailApiDto,
    toAutomationDefinitionListItemApiDto,
    toAutomationRunV2ApiDto,
    toAutomationRunV3DetailApiDto,
    toAutomationRunV3ListApiDto,
} from "./automationApiProjection";

const DATE = new Date("2026-08-10T12:00:00.000Z");
const EVENT_OCCURRED_AT = new Date("2026-08-09T12:00:00.000Z");
const CONVERSATION_OCCURRED_AT = new Date("2026-08-08T12:00:00.000Z");
const MANUAL_CREATED_AT = new Date("2026-08-07T12:00:00.000Z");
const SCHEDULE_DUE_AT = new Date("2026-08-06T12:00:00.000Z");
const EVENT_OCCURRENCE_KEY = "uOH4C9cK4HhMeFWkUXMbdF_dtndJ0j9je-kIK3XpV1s";
const SCHEDULE_OCCURRENCE_KEY = "X3IAXoHE7L1ao1iOgOPa8N8GjODPVjiURQigFl_qYJo";
const CONVERSATION_OCCURRENCE_KEY = "izTbwsBetNfiXUjv6s6CRWsWzudgvK6AwVf1KjwueHs";
const ACCOUNT_CURRENTNESS = {
    mode: "plain" as const,
    version: 7,
    contentKeyFingerprint: null,
};
const EVENT_SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "00000000-0000-4000-8000-000000000001",
);
const EVENT_TRIGGER_ID = AutomationTriggerIdSchema.parse("trigger-event");

const V2_TEMPLATE_CIPHERTEXT = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "daily" },
});

function frozenV2ExecutionInput(origin: Readonly<
    | { kind: "scheduled"; scheduledFor: number }
    | { kind: "manual"; invokedAt: number }
>): string {
    // This is the exact released V2 carrier. It intentionally does not pass
    // through the current cause-only V3 schema.
    return JSON.stringify({
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 2,
        templateCiphertext: V2_TEMPLATE_CIPHERTEXT,
        origin,
    });
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
        assignmentMachineIds: ["machine-1"],
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
        targetType: "new_session" as const,
        templateCiphertext: V2_TEMPLATE_CIPHERTEXT,
        templateVersion: 2,
        lastRunAt: null,
        createdAt: DATE,
        updatedAt: DATE,
        assignments: [{ machineId: "machine-1", enabled: true, priority: 0, updatedAt: DATE }],
        triggers: [{
            id: "trigger-schedule",
            automationId: "automation-schedule",
            kind: "schedule" as const,
            enabled: true,
            revision: 1,
            deletedAt: null,
            scheduleKind: "interval" as const,
            scheduleExpr: null,
            everyMs: 60_000,
            timezone: null,
            nextRunAt: DATE,
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
            createdAt: DATE,
            updatedAt: DATE,
            eventSourceStatus: null,
        }],
    };
}

function eventAutomation() {
    return {
        ...scheduleAutomation(),
        id: "automation-event",
        triggers: [{
            ...scheduleAutomation().triggers[0],
            id: EVENT_TRIGGER_ID,
            automationId: "automation-event",
            kind: "pluginEvent" as const,
            scheduleKind: null,
            everyMs: null,
            nextRunAt: null,
            eventPluginId: "com.example.github",
            eventLocalId: "issue-opened",
            sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
            sourceContractVersion: 2,
            observationTransport: "durablePush" as const,
            webhookEndpointId: "endpoint-1",
            observationStartsAt: DATE,
            definitionEnvelope: JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
                mode: "plain",
                binding: {
                    v: 1,
                    automationId: "automation-event",
                    triggerId: EVENT_TRIGGER_ID,
                    triggerRevision: 1,
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
            })),
        }],
    };
}

function eventStatusProjection() {
    return {
        durablePushEndpointMaterializationRef: {
            machineId: "observation-machine-1",
            materializationId: "observation-materialization-1",
            pluginId: "com.example.github",
        },
        sourceStatus: {
            automationId: "automation-event",
            triggerId: EVENT_TRIGGER_ID,
            triggerRevision: 1,
            eventRef: { pluginId: "com.example.github", localId: "issue-opened" },
            sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
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
        triggerId: "trigger-event",
        triggerRetired: false,
        causeKind: "trigger" as const,
        causeTriggerKind: "pluginEvent" as const,
        causeTriggerRevision: 1,
        causeOccurredAt: EVENT_OCCURRED_AT,
        causeEventPluginId: "com.example.github",
        causeEventLocalId: "issue-opened",
        causeScheduledFor: null,
        causeSessionLifecycleEvent: null,
        causeSourceSessionId: null,
        causeSourceTurnId: null,
        occurrenceKey: EVENT_OCCURRENCE_KEY,
        legacyManualIdempotencyKey: null,
        occurrenceEvidenceEqualityTag: null,
        causeSourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
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
        triggerId: null,
        causeKind: "manual" as const,
        causeTriggerKind: null,
        causeTriggerRevision: null,
        causeOccurredAt: MANUAL_CREATED_AT,
        causeEventPluginId: null,
        causeEventLocalId: null,
        occurrenceKey: null,
        legacyManualIdempotencyKey: null,
        causeSourceSelectorId: null,
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
        triggerId: "trigger-schedule",
        causeKind: "trigger" as const,
        causeTriggerKind: "schedule" as const,
        causeTriggerRevision: 1,
        causeOccurredAt: SCHEDULE_DUE_AT,
        causeScheduledFor: SCHEDULE_DUE_AT,
        occurrenceKey: SCHEDULE_OCCURRENCE_KEY,
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
        triggerId: null,
        causeKind: "conversation" as const,
        causeTriggerKind: null,
        causeTriggerRevision: null,
        causeOccurredAt: CONVERSATION_OCCURRED_AT,
        causeEventPluginId: null,
        causeEventLocalId: null,
        occurrenceKey: CONVERSATION_OCCURRENCE_KEY,
        causeSourceSelectorId: null,
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

        expect(isAutomationDefinitionRepresentableInV2(schedule)).toBe(true);
        expect(isAutomationDefinitionRepresentableInV2(event)).toBe(false);
        expect(isAutomationDefinitionRepresentableInV2({
            ...schedule,
            triggers: [],
        })).toBe(false);
        expect(isAutomationDefinitionRepresentableInV2({
            ...schedule,
            triggers: [schedule.triggers[0], { ...schedule.triggers[0], id: "trigger-schedule-2" }],
        })).toBe(false);
        expect(isAutomationDefinitionRepresentableInV2({
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
        expect(toAutomationDefinitionDetailApiDto(
            event,
            ACCOUNT_CURRENTNESS,
            new Map([["trigger-event", eventStatusProjection()]]),
            new Map(),
            [{
                id: "trigger-retired",
                automationId: "automation-event",
                kind: "sessionLifecycle",
                revision: 7,
                retiredAt: DATE,
            }],
        )).toEqual(expect.objectContaining({
            id: "automation-event",
            retiredTriggers: [{
                id: "trigger-retired",
                kind: "sessionLifecycle",
                revision: 7,
                retiredAt: DATE.getTime(),
            }],
            triggers: [expect.objectContaining({
                id: "trigger-event",
                kind: "pluginEvent",
                eventRef: { pluginId: "com.example.github", localId: "issue-opened" },
                sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                triggerDefinitionEnvelope: event.triggers[0].definitionEnvelope,
                observation: {
                    kind: "durablePush",
                    webhookEndpointId: "endpoint-1",
                    endpointMaterializationRef: {
                        machineId: "observation-machine-1",
                        materializationId: "observation-materialization-1",
                        pluginId: "com.example.github",
                    },
                    observationStartsAt: DATE.getTime(),
                },
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
            })],
        }));
        expect(toAutomationDefinitionDetailApiDto(event, ACCOUNT_CURRENTNESS)).not.toHaveProperty("schedule");
        const listItem = toAutomationDefinitionListItemApiDto(
            event,
            new Map([["trigger-event", eventStatusProjection()]]),
        );
        expect(listItem).toMatchObject({
            triggers: [{
                sourceStatus: { state: "attention", code: "historyGap", revision: 7 },
                sourceCatalogStatus: { observedRevision: "9", adoptedRevision: "7" },
            }],
        });
        expect(listItem.triggers[0]).not.toHaveProperty("triggerDefinitionEnvelope");
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
            revision: 0,
            cause: {
                kind: "trigger",
                triggerId: "trigger-event",
                triggerRevision: 1,
                triggerKind: "pluginEvent",
                occurrenceKey: EVENT_OCCURRENCE_KEY,
                occurredAt: EVENT_OCCURRED_AT.getTime(),
                evidence: {
                    eventRef: {
                        pluginId: "com.example.github",
                        localId: "issue-opened",
                    },
                    sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                },
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

    it("publishes the existing-Session association on the bounded list and withholds it for a retained template", () => {
        const serialized = serializeAutomationStoredDefinitionExecutionRecipeV1({
            v: 1,
            templateVersion: 2,
            template: { t: "plain", v: { v: 1, prompt: "Summarize this session." } },
            triggerEvidence: null,
            target: { kind: "existingSession", sessionId: "session-77" },
        });
        if (serialized.kind !== "available") {
            throw new Error("Existing-session recipe fixture must serialize");
        }
        const current = {
            ...scheduleAutomation(),
            id: "automation-existing-session",
            targetType: "existing_session" as const,
            templateCiphertext: serialized.serialized,
        };

        const listItem = toAutomationDefinitionListItemApiDto(current);
        expect(listItem.existingSessionId).toBe("session-77");
        expect(listItem).not.toHaveProperty("templateCiphertext");
        expect(listItem).not.toHaveProperty("executionRecipe");
        expect(toAutomationDefinitionDetailApiDto(current, ACCOUNT_CURRENTNESS).existingSessionId)
            .toBe("session-77");

        // A stale recipe revision and a retained predecessor template are both
        // undisclosed: only a reader that can open the template may trust them.
        expect(toAutomationDefinitionListItemApiDto({
            ...current,
            templateVersion: 3,
        }).existingSessionId).toBeNull();
        expect(toAutomationDefinitionListItemApiDto({
            ...current,
            templateCiphertext: V2_TEMPLATE_CIPHERTEXT,
        }).existingSessionId).toBeNull();
        expect(toAutomationDefinitionListItemApiDto(scheduleAutomation()).existingSessionId)
            .toBeNull();
    });

    it("does not manufacture Event status without the batch projection owner", () => {
        const event = eventAutomation();

        expect(toAutomationDefinitionListItemApiDto(event)).toMatchObject({
            triggers: [{ sourceStatus: null, sourceCatalogStatus: null }],
        });
    });

    it("projects Event source status only onto the trigger identity that owns it", () => {
        const event = eventAutomation();
        const secondTrigger = {
            ...event.triggers[0],
            id: "trigger-event-2",
            eventLocalId: "pull-request-opened",
        };
        const list = toAutomationDefinitionListItemApiDto(
            { ...event, triggers: [event.triggers[0], secondTrigger] },
            new Map([["trigger-event", eventStatusProjection()]]),
        );

        expect(list.triggers).toEqual([
            expect.objectContaining({
                id: "trigger-event",
                sourceStatus: expect.objectContaining({
                    triggerId: "trigger-event",
                    triggerRevision: 1,
                }),
            }),
            expect.objectContaining({
                id: "trigger-event-2",
                sourceStatus: null,
                sourceCatalogStatus: null,
            }),
        ]);
    });

    it("projects Session lifecycle status by trigger identity", () => {
        const schedule = scheduleAutomation();
        const lifecycleTrigger = {
            ...schedule.triggers[0],
            id: "trigger-lifecycle",
            automationId: "automation-lifecycle",
            kind: "sessionLifecycle" as const,
            scheduleKind: null,
            everyMs: null,
            nextRunAt: null,
            sessionLifecycleEvent: "parentTurnCompleted" as const,
            sourceSessionId: "session-source",
            sourceTurnId: "turn-source",
        };
        const automation = {
            ...schedule,
            id: "automation-lifecycle",
            triggers: [lifecycleTrigger],
        };

        expect(toAutomationDefinitionListItemApiDto(
            automation,
            new Map(),
            new Map([["trigger-lifecycle", { state: "waiting" as const, runId: null }]]),
        ).triggers).toEqual([
            expect.objectContaining({
                id: "trigger-lifecycle",
                kind: "sessionLifecycle",
                status: { state: "waiting", runId: null },
            }),
        ]);
        expect(() => toAutomationDefinitionListItemApiDto(automation))
            .toThrow("Automation row has no sessionLifecycle status for its declared arm");
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

    it("exposes the native execution identity and ordered transition history an uncertain Run needs", () => {
        const uncertain = {
            ...eventRun(),
            executionInputEnvelope: strictEventExecutionRecipe(),
            state: "outcome_uncertain" as const,
            executionDispatchState: "outcomeUnknown" as const,
            executionAttempt: 2,
            executionNativeRunId: "native-run-1",
            executionNativeCallId: "native-call-1",
            executionNativeSidechainId: "native-sidechain-1",
            errorCode: "execution_run_cancelled_outcome_unknown",
            // Persisted newest-first exactly as the detail read selects it.
            events: [
                {
                    ts: new Date(3_000),
                    type: "run_outcome_uncertain",
                    payload: { reason: "cancelled_after_dispatch_permitted" },
                },
                {
                    ts: new Date(2_000),
                    type: "execution_dispatch_retry_scheduled",
                    payload: { machineId: "machine-1", executionAttempt: 1, outcome: "noRunCreated" },
                },
                {
                    ts: new Date(1_000),
                    type: "run_started",
                    payload: { machineId: "machine-1" },
                },
            ],
        };

        const detail = toAutomationRunV3DetailApiDto(uncertain, "plain");

        expect(detail).toEqual(expect.objectContaining({
            executionNativeRunId: "native-run-1",
            executionNativeCallId: "native-call-1",
            executionNativeSidechainId: "native-sidechain-1",
        }));
        // The user reads the history in the order it happened.
        expect(detail.events).toEqual([
            {
                at: 1_000,
                type: "run_started",
                machineId: "machine-1",
                errorCode: null,
                executionAttempt: null,
                outcome: null,
                reason: null,
            },
            {
                at: 2_000,
                type: "execution_dispatch_retry_scheduled",
                machineId: "machine-1",
                errorCode: null,
                executionAttempt: 1,
                outcome: "noRunCreated",
                reason: null,
            },
            {
                at: 3_000,
                type: "run_outcome_uncertain",
                machineId: null,
                errorCode: null,
                executionAttempt: null,
                outcome: null,
                reason: "cancelled_after_dispatch_permitted",
            },
        ]);
    });

    it("never projects an unnamed persisted transition field into the user-facing history", () => {
        const detail = toAutomationRunV3DetailApiDto({
            ...eventRun(),
            executionInputEnvelope: strictEventExecutionRecipe(),
            events: [
                {
                    ts: new Date(1_000),
                    type: "run_failed",
                    payload: {
                        machineId: "machine-1",
                        errorCode: "invalid_template",
                        decryptedPrompt: "secret prompt text",
                    },
                },
            ],
        }, "plain");

        expect(JSON.stringify(detail.events)).not.toContain("secret prompt text");
        expect(detail.events[0]).toEqual({
            at: 1_000,
            type: "run_failed",
            machineId: "machine-1",
            errorCode: "invalid_template",
            executionAttempt: null,
            outcome: null,
            reason: null,
        });
    });

    it("projects every Run cause from immutable bytes without changing V2 scheduledAt", () => {
        const manual = {
            ...manualRun(),
            createdAt: MANUAL_CREATED_AT,
        };

        expect(toAutomationRunV3ListApiDto(scheduledRun()).cause).toEqual({
            kind: "trigger",
            triggerId: "trigger-schedule",
            triggerRevision: 1,
            triggerKind: "schedule",
            occurrenceKey: SCHEDULE_OCCURRENCE_KEY,
            occurredAt: SCHEDULE_DUE_AT.getTime(),
            evidence: { scheduledFor: SCHEDULE_DUE_AT.getTime() },
        });
        expect(toAutomationRunV3ListApiDto(manual).cause).toEqual({
            kind: "manual",
            invokedAt: MANUAL_CREATED_AT.getTime(),
        });
        expect(toAutomationRunV3ListApiDto(eventRun()).cause).toEqual({
            kind: "trigger",
            triggerId: "trigger-event",
            triggerRevision: 1,
            triggerKind: "pluginEvent",
            occurrenceKey: EVENT_OCCURRENCE_KEY,
            occurredAt: EVENT_OCCURRED_AT.getTime(),
            evidence: {
                eventRef: {
                    pluginId: "com.example.github",
                    localId: "issue-opened",
                },
                sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
            },
        });
        expect(toAutomationRunV3ListApiDto(conversationRun()).cause).toEqual({
            kind: "conversation",
            occurrenceKey: CONVERSATION_OCCURRENCE_KEY,
            occurredAt: CONVERSATION_OCCURRED_AT.getTime(),
        });
        expect(toAutomationRunV2ApiDto(manual).scheduledAt).toBe(DATE.getTime());
    });

    it("keeps an immutable trigger cause renderable after the trigger is retired", () => {
        const historical = toAutomationRunV3ListApiDto({
            ...eventRun(),
            triggerRetired: true,
        });

        expect(historical).toMatchObject({
            triggerId: "trigger-event",
            triggerRetired: true,
            cause: {
                kind: "trigger",
                triggerId: "trigger-event",
                triggerRevision: 1,
                triggerKind: "pluginEvent",
                occurrenceKey: EVENT_OCCURRENCE_KEY,
                occurredAt: EVENT_OCCURRED_AT.getTime(),
                evidence: {
                    eventRef: {
                        pluginId: "com.example.github",
                        localId: "issue-opened",
                    },
                    sourceSelectorId: EVENT_SOURCE_SELECTOR_ID,
                },
            },
        });
    });

    it("fails closed rather than returning a private V3 envelope under the wrong Account mode", () => {
        expect(() => toAutomationRunV3DetailApiDto({
            ...manualRun(),
            executionInputEnvelope: JSON.stringify({
                kind: "happier_automation_run_execution_input_v1",
                targetType: "new_session",
                templateVersion: 2,
                templateCiphertext: JSON.stringify({
                    kind: "happier_automation_template_encrypted_v1",
                    payloadCiphertext: "ciphertext",
                }),
                origin: { kind: "manual", invokedAt: MANUAL_CREATED_AT.getTime() },
            }),
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
