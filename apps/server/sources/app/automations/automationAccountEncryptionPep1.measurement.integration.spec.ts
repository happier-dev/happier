import {
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    AutomationOccurrenceKeyV1Schema,
    AutomationStoredContentEnvelopeV1Schema,
    AutomationSourceSelectorIdV1Schema,
    deriveAutomationOccurrenceEvidenceEqualityTagV1,
    deriveAutomationOccurrenceKeyV1,
    sealAutomationConversationReplyContextStoredEnvelopeV1,
    sealAutomationOccurrenceTriggerEvidenceEnvelopeV1,
    sealAutomationReplyHandoffReceiptStoredEnvelopeV1,
    sealAutomationRunResultStoredEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
    type PluginJsonValueV2,
} from "@happier-dev/protocol";
import { writeFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";

import { migrateAutomationAccountEncryptionInTx } from "./automationCrudService";
import {
    ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT,
} from "../encryption/accountEncryptionTransitionMeasuredCapacity";

const ENABLED = process.env.HAPPIER_PEP1_MEASURE === "1";
const BATCH_SIZE = 500;
const BATCH_COUNT = 20;
const TOTAL_RUNS = BATCH_SIZE * BATCH_COUNT;
const TARGET_ENVELOPE_CIPHERTEXT_BYTES = 4_096;
const ACCOUNT_KEY = new Uint8Array(32).fill(23);
const ACCOUNT_MATERIAL = { type: "legacy" as const, secret: ACCOUNT_KEY };
const RUN_SCENARIOS = [
    "scheduleTrigger",
    "manual",
    "pluginEventTrigger",
    "conversation",
] as const;
const RUNS_PER_SCENARIO = TOTAL_RUNS / RUN_SCENARIOS.length;
const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "8a2e26d2-5b2b-4e9b-a57f-68ca5e575dc7",
);
const SCHEDULE_AUTOMATION_ID = "pep1-measurement-automation-schedule";
const EVENT_AUTOMATION_ID = "pep1-measurement-automation-event";
const CONVERSATION_AUTOMATION_ID = "pep1-measurement-automation-conversation";
const SCHEDULE_TRIGGER_ID = "pep1-measurement-trigger-schedule";
const EVENT_TRIGGER_ID = "pep1-measurement-trigger-event";
const SOURCE_TEMPLATE = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "PEP1 measurement" },
});
const TARGET_TEMPLATE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "measurement-target-template",
});
const LEGACY_SUMMARY_CIPHERTEXT = "pep1-measurement-legacy-summary";
const MEASUREMENT_CORRESPONDENCE = {
    accountId: "pep1-measurement-account",
    automationId: EVENT_AUTOMATION_ID,
    runId: "pep1-measurement-representative-run",
    handoffId: "pep1-measurement-representative-handoff",
};
const MEASUREMENT_REPLY_CONTEXT_CORRESPONDENCE = {
    automationId: MEASUREMENT_CORRESPONDENCE.automationId,
    occurrenceKey: AutomationOccurrenceKeyV1Schema.parse("A".repeat(43)),
};

type MemorySample = Readonly<{
    heapUsedBytes: number;
    rssBytes: number;
}>;

type TimedMeasurement = Readonly<{
    durationMs: number;
    heapDeltaBytes: number;
    rssDeltaBytes: number;
}>;

function memorySample(): MemorySample {
    const memory = process.memoryUsage();
    return {
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
    };
}

async function time<T>(operation: () => Promise<T>): Promise<Readonly<{
    result: T;
    measurement: TimedMeasurement;
}>> {
    const before = memorySample();
    const startedAt = performance.now();
    const result = await operation();
    const after = memorySample();
    return {
        result,
        measurement: {
            durationMs: performance.now() - startedAt,
            heapDeltaBytes: after.heapUsedBytes - before.heapUsedBytes,
            rssDeltaBytes: after.rssBytes - before.rssBytes,
        },
    };
}

type MeasurementRunScenario = (typeof RUN_SCENARIOS)[number];

type MeasurementRunContent = Readonly<{
    scenario: MeasurementRunScenario;
    automationId: string;
    triggerId: string | null;
    causeKind: "trigger" | "manual" | "conversation";
    causeTriggerKind: "schedule" | "pluginEvent" | null;
    causeTriggerRevision: number | null;
    causeEventPluginId: string | null;
    causeEventLocalId: string | null;
    causeOccurredAt: Date;
    causeScheduledFor: Date | null;
    occurrenceKey: string | null;
    causeSourceSelectorId: string | null;
    triggerEvidenceEnvelope: string | null;
    executionInputEnvelope: string;
    resultEnvelope: string;
    replyContextEnvelope: string | null;
    replyHandoffActionPluginId: string | null;
    replyHandoffActionLocalId: string | null;
    replyHandoffTargetMachineId: string | null;
    replyHandoffTargetMachineInstallationId: string | null;
    replyHandoffTargetMaterializationId: string | null;
    replyHandoffId: string | null;
    replyHandoffState: "none" | "accepted";
    replyHandoffReceiptEnvelope: string | null;
    summaryCiphertext: string | null;
}>;

function deterministicRandomBytes(length: number): Uint8Array {
    return new Uint8Array(length).fill(7);
}

function buildTriggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    triggerId: string;
    triggerRevision: number;
    mode: "plain" | "e2ee";
}>): string {
    const binding = {
        v: 1 as const,
        automationId: params.automationId,
        triggerId: params.triggerId,
        triggerRevision: params.triggerRevision,
        triggerKind: "pluginEvent" as const,
        eventRef: {
            pluginId: "com.example.github",
            localId: "repository-event",
        },
        sourceSelectorId: SOURCE_SELECTOR_ID,
    };
    const definition: PluginJsonValueV2 = {
        v: 1,
        sourceInstanceId: "pep1-measurement-source",
        sourceConfig: { repositoryId: 42 },
        displayLabel: "PEP1 measurement source",
        filter: null,
        maximumObservationAgeMs: null,
    };
    return JSON.stringify(params.mode === "plain"
        ? sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "plain",
            binding,
            definition,
        })
        : sealAutomationTriggerDefinitionStoredEnvelopeV1({
            mode: "e2ee",
            binding,
            definition,
            material: ACCOUNT_MATERIAL,
            randomBytes: deterministicRandomBytes,
        }));
}

function utf8Bytes(value: string | null): number {
    return value === null ? 0 : new TextEncoder().encode(value).byteLength;
}

function runIdForIndex(index: number): string {
    return `pep1-measurement-run-${index}`;
}

function scenarioForIndex(index: number): MeasurementRunScenario {
    return RUN_SCENARIOS[index % RUN_SCENARIOS.length]!;
}

function automationIdForScenario(scenario: MeasurementRunScenario): string {
    switch (scenario) {
        case "scheduleTrigger":
        case "manual":
            return SCHEDULE_AUTOMATION_ID;
        case "pluginEventTrigger":
            return EVENT_AUTOMATION_ID;
        case "conversation":
            return CONVERSATION_AUTOMATION_ID;
    }
}

function buildEvidence(index: number, scenario: MeasurementRunScenario) {
    if (scenario === "pluginEventTrigger") {
        return {
            v: 1 as const,
            kind: "pluginEvent" as const,
            eventRef: {
                pluginId: "com.example.github",
                localId: "repository-event",
            },
            sourceSelectorId: SOURCE_SELECTOR_ID,
            occurrenceId: `pep1-measurement-event-${index}`,
            occurredAt: 1_724_000_000_000 + index,
            payload: {
                action: "opened",
                repository: { id: 42, fullName: "happier/example" },
            },
        };
    }
    if (scenario === "conversation") {
        return {
            v: 1 as const,
            kind: "conversation" as const,
            bindingId: "pep1-measurement-conversation-binding",
            occurrenceId: `pep1-measurement-conversation-${index}`,
            occurredAt: 1_724_000_000_000 + index,
            caller: {
                pluginId: "happier.channels",
                contributionLocalId: "provider/observation-ingest-v1",
                machineId: "machine-pep1-measurement",
            },
            input: { text: "PEP1 measurement conversation" },
            replyContextIdentity: "pep1-measurement-reply-context",
        };
    }
    return null;
}

function buildExecutionInputEnvelope(mode: "plain" | "e2ee"): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: 1,
        template: mode === "plain"
            ? { t: "plain", v: { v: 1, prompt: "PEP1 measurement" } }
            : { t: "encrypted", c: "measurement-target-template" },
        triggerEvidence: null,
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: "server-pep1-measurement",
                    machineId: "machine-pep1-measurement",
                },
                directory: "/tmp/pep1-measurement",
                agentTarget: {
                    kind: "agent",
                    identity: {
                        pluginId: "happier.agent.codex",
                        localId: "codex",
                    },
                },
            },
        },
        assignmentMachineIds: [],
    });
    if (serialized.kind !== "available") {
        throw new Error("PEP1 measurement fixture must use a strict Run recipe");
    }
    return serialized.serialized;
}

function sealResultEnvelope(mode: "plain" | "e2ee", textBytes: number): string {
    const result = {
        v: 1 as const,
        kind: "text" as const,
        text: "x".repeat(textBytes),
    };
    if (mode === "plain") {
        return JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
            mode,
            correspondence: MEASUREMENT_CORRESPONDENCE,
            result,
        }));
    }
    return JSON.stringify(sealAutomationRunResultStoredEnvelopeV1({
        mode,
        material: ACCOUNT_MATERIAL,
        randomBytes: deterministicRandomBytes,
        correspondence: MEASUREMENT_CORRESPONDENCE,
        result,
    }));
}

function sealReplyContextEnvelope(mode: "plain" | "e2ee"): string {
    const opaqueContext = { conversationId: "pep1-measurement-conversation" };
    if (mode === "plain") {
        return JSON.stringify(sealAutomationConversationReplyContextStoredEnvelopeV1({
            mode,
            correspondence: MEASUREMENT_REPLY_CONTEXT_CORRESPONDENCE,
            templateVersion: 1,
            opaqueContext,
        }));
    }
    return JSON.stringify(sealAutomationConversationReplyContextStoredEnvelopeV1({
        mode,
        material: ACCOUNT_MATERIAL,
        randomBytes: deterministicRandomBytes,
        correspondence: MEASUREMENT_REPLY_CONTEXT_CORRESPONDENCE,
        templateVersion: 1,
        opaqueContext,
    }));
}

function sealReplyReceiptEnvelope(mode: "plain" | "e2ee"): string {
    const result = {
        kind: "accepted" as const,
        custodyId: "pep1-measurement-custody",
    };
    if (mode === "plain") {
        return JSON.stringify(sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
            mode,
            correspondence: MEASUREMENT_CORRESPONDENCE,
            result,
        }));
    }
    return JSON.stringify(sealAutomationReplyHandoffReceiptStoredEnvelopeV1({
        mode,
        material: ACCOUNT_MATERIAL,
        randomBytes: deterministicRandomBytes,
        correspondence: MEASUREMENT_CORRESPONDENCE,
        result,
    }));
}

function sealCanonicalTargetEnvelope(textBytes: number): string {
    return JSON.stringify(
        AutomationStoredContentEnvelopeV1Schema.parse(
            JSON.parse(sealResultEnvelope("e2ee", textBytes)),
        ),
    );
}

function sealNearMaximumRunEnvelope(): string {
    let lower = 0;
    let upper = 256 * 1024;
    let best = sealCanonicalTargetEnvelope(0);
    while (lower <= upper) {
        const candidateBytes = Math.floor((lower + upper) / 2);
        const candidate = sealCanonicalTargetEnvelope(candidateBytes);
        if (candidate.length <= 220_000) {
            best = candidate;
            lower = candidateBytes + 1;
        } else {
            upper = candidateBytes - 1;
        }
    }
    return best;
}

const SOURCE_EXECUTION_INPUT_ENVELOPE = buildExecutionInputEnvelope("plain");
const TARGET_EXECUTION_INPUT_ENVELOPE = buildExecutionInputEnvelope("e2ee");
const SOURCE_RESULT_ENVELOPE = sealResultEnvelope("plain", 256);
const SOURCE_REPLY_CONTEXT_ENVELOPE = sealReplyContextEnvelope("plain");
const SOURCE_REPLY_RECEIPT_ENVELOPE = sealReplyReceiptEnvelope("plain");
const TARGET_REPLY_CONTEXT_ENVELOPE = sealReplyContextEnvelope("e2ee");
const TARGET_REPLY_RECEIPT_ENVELOPE = sealReplyReceiptEnvelope("e2ee");
const LEGACY_RESULT_ENVELOPE = JSON.stringify({
    t: "legacySummaryCiphertext",
    c: LEGACY_SUMMARY_CIPHERTEXT,
});

function buildSourceRunContent(index: number): MeasurementRunContent {
    const scenario = scenarioForIndex(index);
    const automationId = automationIdForScenario(scenario);
    const evidence = buildEvidence(index, scenario);
    const isLegacySummarySource = scenario === "manual" && index === 1;
    const hasReplyHandoff = scenario === "conversation";
    const causeOccurredAt = new Date(evidence?.occurredAt ?? 1_724_000_000_000 + index);
    const triggerId = scenario === "scheduleTrigger"
        ? SCHEDULE_TRIGGER_ID
        : scenario === "pluginEventTrigger"
            ? EVENT_TRIGGER_ID
            : null;
    return {
        scenario,
        automationId,
        triggerId,
        causeKind: scenario === "manual"
            ? "manual"
            : scenario === "conversation"
                ? "conversation"
                : "trigger",
        causeTriggerKind: scenario === "scheduleTrigger"
            ? "schedule"
            : scenario === "pluginEventTrigger"
                ? "pluginEvent"
                : null,
        causeTriggerRevision: triggerId === null ? null : 0,
        causeEventPluginId: scenario === "pluginEventTrigger"
            ? "com.example.github"
            : null,
        causeEventLocalId: scenario === "pluginEventTrigger"
            ? "repository-event"
            : null,
        causeOccurredAt,
        causeScheduledFor: scenario === "scheduleTrigger"
            ? causeOccurredAt
            : null,
        occurrenceKey: evidence === null
            ? scenario === "scheduleTrigger"
                ? deriveAutomationOccurrenceKeyV1({
                    triggerId: SCHEDULE_TRIGGER_ID,
                    evidence: {
                        v: 1,
                        kind: "schedule",
                        scheduledFor: causeOccurredAt.getTime(),
                    },
                })
                : null
            : deriveAutomationOccurrenceKeyV1(
                scenario === "pluginEventTrigger"
                    ? { triggerId: EVENT_TRIGGER_ID, evidence }
                    : evidence,
            ),
        causeSourceSelectorId: scenario === "pluginEventTrigger"
            ? SOURCE_SELECTOR_ID
            : null,
        triggerEvidenceEnvelope: evidence === null
            ? null
            : JSON.stringify(AutomationStoredContentEnvelopeV1Schema.parse({
                t: "plain",
                v: evidence,
            })),
        executionInputEnvelope: SOURCE_EXECUTION_INPUT_ENVELOPE,
        resultEnvelope: isLegacySummarySource
            ? LEGACY_RESULT_ENVELOPE
            : SOURCE_RESULT_ENVELOPE,
        replyContextEnvelope: scenario === "conversation"
            ? SOURCE_REPLY_CONTEXT_ENVELOPE
            : null,
        replyHandoffActionPluginId: hasReplyHandoff ? "happier.channels" : null,
        replyHandoffActionLocalId: hasReplyHandoff
            ? "automation/result-deliver-v1"
            : null,
        replyHandoffTargetMachineId: hasReplyHandoff
            ? "pep1-measurement-reply-machine"
            : null,
        replyHandoffTargetMachineInstallationId: hasReplyHandoff
            ? "pep1-measurement-reply-installation"
            : null,
        replyHandoffTargetMaterializationId: hasReplyHandoff
            ? "pep1-measurement-reply-materialization"
            : null,
        replyHandoffId: hasReplyHandoff
            ? MEASUREMENT_CORRESPONDENCE.handoffId
            : null,
        replyHandoffState: hasReplyHandoff ? "accepted" : "none",
        replyHandoffReceiptEnvelope: hasReplyHandoff
            ? SOURCE_REPLY_RECEIPT_ENVELOPE
            : null,
        summaryCiphertext: isLegacySummarySource
            ? LEGACY_SUMMARY_CIPHERTEXT
            : null,
    };
}

function buildRunItem(params: Readonly<{
    index: number;
    resultEnvelope: string;
    expectedRunRevision: number;
}>) {
    const source = buildSourceRunContent(params.index);
    const evidence = buildEvidence(params.index, source.scenario);
    const occurrenceKey = source.occurrenceKey;
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        action: "migrate",
        templates: [],
        runs: [{
            runId: runIdForIndex(params.index),
            expectedRunRevision: params.expectedRunRevision,
            triggerEvidenceEnvelope: evidence === null
                ? null
                : JSON.stringify(sealAutomationOccurrenceTriggerEvidenceEnvelopeV1({
                    material: ACCOUNT_MATERIAL,
                    evidence,
                    randomBytes: deterministicRandomBytes,
                })),
            occurrenceEvidenceEqualityTag: evidence === null
                ? null
                : evidence.kind === "pluginEvent"
                    ? deriveAutomationOccurrenceEvidenceEqualityTagV1({
                        purposeSeparatedAccountKey: ACCOUNT_KEY,
                        accountId: "pep1-measurement-account",
                        automationId: source.automationId,
                        triggerId: EVENT_TRIGGER_ID,
                        occurrenceKey: occurrenceKey!,
                        evidence,
                    })
                    : deriveAutomationOccurrenceEvidenceEqualityTagV1({
                        purposeSeparatedAccountKey: ACCOUNT_KEY,
                        accountId: "pep1-measurement-account",
                        automationId: source.automationId,
                        occurrenceKey: occurrenceKey!,
                        evidence,
                    }),
            executionInputEnvelope: TARGET_EXECUTION_INPUT_ENVELOPE,
            resultEnvelope: params.resultEnvelope,
            replyContextEnvelope: source.replyContextEnvelope === null
                ? null
                : TARGET_REPLY_CONTEXT_ENVELOPE,
            replyHandoffReceiptEnvelope: source.replyHandoffReceiptEnvelope === null
                ? null
                : TARGET_REPLY_RECEIPT_ENVELOPE,
            failureDetailEnvelope: null,
        }],
    });
    if (directive.action !== "migrate" || !directive.runs?.[0]) {
        throw new TypeError("Expected the measurement directive to migrate");
    }
    return directive.runs[0]!;
}

function migrationSegmentBytes(params: Readonly<{
    resultEnvelope: string;
    count: number;
}>): number {
    let bytes = 2;
    for (let index = 0; index < params.count; index += 1) {
        if (index > 0) bytes += 1;
        bytes += utf8Bytes(JSON.stringify(buildRunItem({
            index,
            resultEnvelope: params.resultEnvelope,
            expectedRunRevision: 0,
        })));
    }
    return bytes;
}

async function seedOneAccount(params: Readonly<{
    targetResultEnvelope: string;
}>) {
    const accountId = "pep1-measurement-account";
    const runContents = Array.from(
        { length: TOTAL_RUNS },
        (_, index) => buildSourceRunContent(index),
    );
    await db.account.create({
        data: { id: accountId, encryptionMode: "plain" },
    });
    await db.automation.create({
        data: {
            id: SCHEDULE_AUTOMATION_ID,
            accountId,
            name: "PEP1 schedule measurement",
            enabled: false,
            triggers: {
                create: {
                    id: SCHEDULE_TRIGGER_ID,
                    kind: "schedule",
                    scheduleKind: "interval",
                    everyMs: 60_000,
                },
            },
            targetType: "new_session",
            templateCiphertext: SOURCE_TEMPLATE,
            templateVersion: 1,
        },
    });
    await db.automation.create({
        data: {
            id: EVENT_AUTOMATION_ID,
            accountId,
            name: "PEP1 event measurement",
            enabled: false,
            triggers: {
                create: {
                    id: EVENT_TRIGGER_ID,
                    kind: "pluginEvent",
                    eventPluginId: "com.example.github",
                    eventLocalId: "repository-event",
                    sourceSelectorId: SOURCE_SELECTOR_ID,
                    sourceContractVersion: 1,
                    observationTransport: "checkpointedPull",
                    definitionEnvelope: buildTriggerDefinitionEnvelope({
                        automationId: EVENT_AUTOMATION_ID,
                        triggerId: EVENT_TRIGGER_ID,
                        triggerRevision: 0,
                        mode: "plain",
                    }),
                },
            },
            targetType: "new_session",
            templateCiphertext: SOURCE_TEMPLATE,
            templateVersion: 1,
        },
    });
    await db.automation.create({
        data: {
            id: CONVERSATION_AUTOMATION_ID,
            accountId,
            name: "PEP1 conversation measurement",
            enabled: false,
            // Conversation is a direct Run cause and has no trigger row.
            targetType: "new_session",
            templateCiphertext: SOURCE_TEMPLATE,
            templateVersion: 1,
        },
    });
    await db.automationRun.createMany({
        data: runContents.map((content, index) => ({
            id: runIdForIndex(index),
            accountId,
            automationId: content.automationId,
            state: "queued" as const,
            triggerId: content.triggerId,
            causeKind: content.causeKind,
            causeTriggerKind: content.causeTriggerKind,
            causeTriggerRevision: content.causeTriggerRevision,
            causeEventPluginId: content.causeEventPluginId,
            causeEventLocalId: content.causeEventLocalId,
            causeOccurredAt: content.causeOccurredAt,
            causeScheduledFor: content.causeScheduledFor,
            occurrenceKey: content.occurrenceKey,
            occurrenceEvidenceEqualityTag: null,
            causeSourceSelectorId: content.causeSourceSelectorId,
            triggerEvidenceEnvelope: content.triggerEvidenceEnvelope,
            executionInputEnvelope: content.executionInputEnvelope,
            resultEnvelope: content.resultEnvelope,
            replyContextEnvelope: content.replyContextEnvelope,
            replyHandoffActionPluginId: content.replyHandoffActionPluginId,
            replyHandoffActionLocalId: content.replyHandoffActionLocalId,
            replyHandoffTargetMachineId: content.replyHandoffTargetMachineId,
            replyHandoffTargetMachineInstallationId:
                content.replyHandoffTargetMachineInstallationId,
            replyHandoffTargetMaterializationId:
                content.replyHandoffTargetMaterializationId,
            replyHandoffId: content.replyHandoffId,
            replyHandoffState: content.replyHandoffState,
            replyHandoffReceiptEnvelope: content.replyHandoffReceiptEnvelope,
            summaryCiphertext: content.summaryCiphertext,
            scheduledAt: new Date("2026-08-10T10:00:00.000Z"),
            dueAt: new Date("2026-08-10T10:00:00.000Z"),
        })),
    });
    const runs = await db.automationRun.findMany({
        where: { accountId },
        select: { id: true, revision: true },
        orderBy: { id: "asc" },
    });
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        action: "migrate",
        templates: [
            SCHEDULE_AUTOMATION_ID,
            EVENT_AUTOMATION_ID,
            CONVERSATION_AUTOMATION_ID,
        ].map((automationId) => ({
            automationId,
            expectedTemplateVersion: 1,
            templateCiphertext: TARGET_TEMPLATE,
            triggerDefinitionEnvelopes: automationId === EVENT_AUTOMATION_ID
                ? [{
                    triggerId: EVENT_TRIGGER_ID,
                    triggerRevision: 0,
                    envelope: buildTriggerDefinitionEnvelope({
                        automationId,
                        triggerId: EVENT_TRIGGER_ID,
                        triggerRevision: 0,
                        mode: "e2ee",
                    }),
                }]
                : [],
        })),
        // The released direct migration request intentionally caps one
        // participant segment at 500 rows. This is the exact segment a
        // future Account-owned PEP1 coordinator must stage and replay; it is
        // not a claim that the legacy one-shot route can migrate 10,000 rows.
        runs: runs.slice(0, BATCH_SIZE).map((run) => {
            const index = Number(run.id.slice("pep1-measurement-run-".length));
            const item = buildRunItem({
                index,
                resultEnvelope: params.targetResultEnvelope,
                expectedRunRevision: run.revision,
            });
            return { ...item, runId: run.id };
        }),
    });
    const sourceRetainedContentUtf8Bytes = runContents.reduce(
        (total, content) => total
            + utf8Bytes(content.triggerEvidenceEnvelope)
            + utf8Bytes(content.executionInputEnvelope)
            + utf8Bytes(content.resultEnvelope)
            + utf8Bytes(content.replyContextEnvelope)
            + utf8Bytes(content.replyHandoffReceiptEnvelope)
            + utf8Bytes(content.summaryCiphertext),
        0,
    );
    return { accountId, directive, sourceRetainedContentUtf8Bytes };
}

describe.skipIf(!ENABLED)("PEP1 Automation Run measurement (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-pep1-automation-measurement-",
        });
    }, 120_000);

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.accountChange.deleteMany(),
            () => db.automationRunEvent.deleteMany(),
            () => db.automationRun.deleteMany(),
            () => db.automationAssignment.deleteMany(),
            () => db.automation.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    afterAll(async () => {
        await harness.close();
    });

    it("measures one Account with 10,000 retained Runs and exposes the legacy direct-surface limit", async () => {
        const sourceEnvelope = JSON.stringify(
            AutomationStoredContentEnvelopeV1Schema.parse({
                t: "plain",
                v: buildEvidence(2, "pluginEventTrigger"),
            }),
        );
        const minimalEnvelope = sealCanonicalTargetEnvelope(0);
        const typicalEnvelope = sealCanonicalTargetEnvelope(
            TARGET_ENVELOPE_CIPHERTEXT_BYTES,
        );
        const nearMaximumEnvelope = sealNearMaximumRunEnvelope();
        const payloadBytes = {
            minimal: migrationSegmentBytes({
                resultEnvelope: minimalEnvelope,
                count: TOTAL_RUNS,
            }),
            typical: migrationSegmentBytes({
                resultEnvelope: typicalEnvelope,
                count: TOTAL_RUNS,
            }),
            nearMaximumPerRow: migrationSegmentBytes({
                resultEnvelope: nearMaximumEnvelope,
                count: 1,
            }),
        };
        const nearMaximumDerived10kBytes =
            payloadBytes.nearMaximumPerRow * BATCH_SIZE * BATCH_COUNT;

        const seeded = await time(async () =>
            await seedOneAccount({ targetResultEnvelope: typicalEnvelope }),
        );
        const seededRunRows = await db.automationRun.count({
            where: { accountId: seeded.result.accountId },
        });
        const seededCauseCounts = await db.automationRun.groupBy({
            by: ["causeKind", "causeTriggerKind"],
            where: { accountId: seeded.result.accountId },
            _count: { _all: true },
            orderBy: [
                { causeKind: "asc" },
                { causeTriggerKind: "asc" },
            ],
        });
        const seededCauseRows = Object.fromEntries(seededCauseCounts.map((row) => [
            row.causeKind === "trigger"
                ? `trigger:${row.causeTriggerKind}`
                : row.causeKind,
            row._count._all,
        ]));
        const seededTriggerRows = (await db.automationTrigger.findMany({
            where: { automation: { accountId: seeded.result.accountId } },
            select: {
                id: true,
                automationId: true,
                kind: true,
                revision: true,
                definitionEnvelope: true,
            },
            orderBy: { id: "asc" },
        })).map((row) => ({
            id: row.id,
            automationId: row.automationId,
            kind: row.kind,
            revision: row.revision,
            hasDefinitionEnvelope: row.definitionEnvelope !== null,
        }));
        const [
            participatingRunRows,
            triggerEvidenceRows,
            executionInputRows,
            resultRows,
            replyContextRows,
            replyReceiptRows,
            legacySummaryRows,
            scheduledOrManualEvidenceRows,
        ] = await Promise.all([
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    OR: [
                        { triggerEvidenceEnvelope: { not: null } },
                        { occurrenceEvidenceEqualityTag: { not: null } },
                        { executionInputEnvelope: { not: null } },
                        { resultEnvelope: { not: null } },
                        { replyContextEnvelope: { not: null } },
                        { replyHandoffReceiptEnvelope: { not: null } },
                        { summaryCiphertext: { not: null } },
                    ],
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    triggerEvidenceEnvelope: { not: null },
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    executionInputEnvelope: { not: null },
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    resultEnvelope: { not: null },
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    replyContextEnvelope: { not: null },
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    replyHandoffReceiptEnvelope: { not: null },
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    summaryCiphertext: { not: null },
                },
            }),
            db.automationRun.count({
                where: {
                    accountId: seeded.result.accountId,
                    OR: [
                        { causeKind: "manual" },
                        {
                            causeKind: "trigger",
                            causeTriggerKind: "schedule",
                        },
                    ],
                    AND: {
                        OR: [
                            { triggerEvidenceEnvelope: { not: null } },
                            { occurrenceEvidenceEqualityTag: { not: null } },
                        ],
                    },
                },
            }),
        ]);
        expect(await db.account.count()).toBe(1);
        expect(await db.automation.count()).toBe(3);
        expect(seededTriggerRows).toEqual([
            {
                id: EVENT_TRIGGER_ID,
                automationId: EVENT_AUTOMATION_ID,
                kind: "pluginEvent",
                revision: 0,
                hasDefinitionEnvelope: true,
            },
            {
                id: SCHEDULE_TRIGGER_ID,
                automationId: SCHEDULE_AUTOMATION_ID,
                kind: "schedule",
                revision: 0,
                hasDefinitionEnvelope: false,
            },
        ]);
        expect(seededRunRows).toBe(TOTAL_RUNS);
        expect(seededCauseRows).toEqual({
            conversation: RUNS_PER_SCENARIO,
            manual: RUNS_PER_SCENARIO,
            "trigger:pluginEvent": RUNS_PER_SCENARIO,
            "trigger:schedule": RUNS_PER_SCENARIO,
        });
        expect({
            participatingRunRows,
            triggerEvidenceRows,
            executionInputRows,
            resultRows,
            replyContextRows,
            replyReceiptRows,
            legacySummaryRows,
            scheduledOrManualEvidenceRows,
        }).toEqual({
            participatingRunRows: TOTAL_RUNS,
            triggerEvidenceRows: RUNS_PER_SCENARIO * 2,
            executionInputRows: TOTAL_RUNS,
            resultRows: TOTAL_RUNS,
            replyContextRows: RUNS_PER_SCENARIO,
            replyReceiptRows: RUNS_PER_SCENARIO,
            legacySummaryRows: 1,
            scheduledOrManualEvidenceRows: 0,
        });
        const legacyDirectSegment = await time(async () =>
            await inTx(async (tx) =>
                await migrateAutomationAccountEncryptionInTx({
                    tx,
                    accountId: seeded.result.accountId,
                    toMode: "e2ee",
                    directive: seeded.result.directive,
                }),
            ),
        );
        expect(legacyDirectSegment.result).toEqual({ status: "migration_too_large" });
        const retainedRunRowsAfterLegacyAttempt = await db.automationRun.count({
            where: { accountId: seeded.result.accountId },
        });
        expect(retainedRunRowsAfterLegacyAttempt).toBe(seededRunRows);

        // The Account transition owner's source census enumerates exactly two
        // row classes: every Automation definition, then every Run holding
        // retained content. Both are counted above against the same predicates,
        // so their sum is this Account's participant census.
        const censusParticipantRows = participatingRunRows + await db.automation.count({
            where: { accountId: seeded.result.accountId },
        });
        // These are the two facts the Account transition owner's recorded
        // capacity is derived from. Re-running this harness after a fixture,
        // schema, or Protocol-bound change turns RED here instead of letting
        // the recorded bound silently age.
        expect({
            censusParticipantRows,
            nearMaximumParticipantEncodedBytes: BigInt(
                payloadBytes.nearMaximumPerRow,
            ),
        }).toEqual({ ...ACCOUNT_ENCRYPTION_TRANSITION_PEP1_CAPACITY_MEASUREMENT });

        const metrics = {
            scope: "one_account_10k_all_cause_participating_retained_runs",
            batchSize: BATCH_SIZE,
            batchCount: BATCH_COUNT,
            runRows: {
                seeded: seededRunRows,
                retainedAfterLegacyAttempt: retainedRunRowsAfterLegacyAttempt,
            },
            causeRows: seededCauseRows,
            sourceRetainedContentUtf8Bytes: seeded.result.sourceRetainedContentUtf8Bytes,
            censusParticipantRows,
            accountRows: await db.account.count(),
            automationRows: await db.automation.count(),
            requestRunSegmentBytes: payloadBytes,
            nearMaximumDerived10kRunItemBytes: nearMaximumDerived10kBytes,
            legacyDirectSegmentRequestBytes: new TextEncoder().encode(
                JSON.stringify(seeded.result.directive),
            ).byteLength,
            sourceTriggerEvidenceEnvelopeBytes: new TextEncoder().encode(sourceEnvelope).byteLength,
            targetEnvelopeBytes: {
                minimal: new TextEncoder().encode(minimalEnvelope).byteLength,
                typical: new TextEncoder().encode(typicalEnvelope).byteLength,
                nearMaximum: new TextEncoder().encode(nearMaximumEnvelope).byteLength,
                executionInput: utf8Bytes(TARGET_EXECUTION_INPUT_ENVELOPE),
                replyContext: utf8Bytes(TARGET_REPLY_CONTEXT_ENVELOPE),
                replyReceipt: utf8Bytes(TARGET_REPLY_RECEIPT_ENVELOPE),
            },
            oneAccountSeed: seeded.measurement,
            legacyDirectSegment: {
                result: legacyDirectSegment.result,
                measurement: legacyDirectSegment.measurement,
            },
        };
        const outputPath = process.env.HAPPIER_PEP1_MEASURE_OUTPUT;
        if (outputPath) {
            await writeFile(outputPath, JSON.stringify(metrics), "utf8");
        }
        console.log("PEP1_MEASUREMENT", JSON.stringify(metrics));
    }, 300_000);
});
