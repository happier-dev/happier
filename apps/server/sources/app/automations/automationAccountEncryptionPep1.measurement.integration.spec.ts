import {
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    AutomationStoredContentEnvelopeV1Schema,
    AutomationSourceSelectorIdV1Schema,
    deriveAutomationOccurrenceEvidenceEqualityTagV1,
    deriveAutomationOccurrenceKeyV1,
    sealAutomationConversationReplyContextStoredEnvelopeV1,
    sealAutomationEventTriggerEvidenceEnvelopeV1,
    sealAutomationReplyHandoffReceiptStoredEnvelopeV1,
    sealAutomationRunResultStoredEnvelopeV1,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
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

const ENABLED = process.env.HAPPIER_PEP1_MEASURE === "1";
const BATCH_SIZE = 500;
const BATCH_COUNT = 20;
const TOTAL_RUNS = BATCH_SIZE * BATCH_COUNT;
const TARGET_ENVELOPE_CIPHERTEXT_BYTES = 4_096;
const ACCOUNT_KEY = new Uint8Array(32).fill(23);
const ACCOUNT_MATERIAL = { type: "legacy" as const, secret: ACCOUNT_KEY };
const RUN_ORIGINS = [
    "scheduled",
    "manual",
    "pluginEvent",
    "conversation",
] as const;
const RUNS_PER_ORIGIN = TOTAL_RUNS / RUN_ORIGINS.length;
const SOURCE_SELECTOR_ID = AutomationSourceSelectorIdV1Schema.parse(
    "8a2e26d2-5b2b-4e9b-a57f-68ca5e575dc7",
);
const SCHEDULE_AUTOMATION_ID = "pep1-measurement-automation-schedule";
const EVENT_AUTOMATION_ID = "pep1-measurement-automation-event";
const CONVERSATION_AUTOMATION_ID = "pep1-measurement-automation-conversation";
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
const MEASUREMENT_SOURCE = {
    kind: "automationResult" as const,
    automationRunId: MEASUREMENT_CORRESPONDENCE.runId,
    resultId: MEASUREMENT_CORRESPONDENCE.handoffId,
    automationId: MEASUREMENT_CORRESPONDENCE.automationId,
    templateVersion: 1,
    resultDelivery: "finalResult" as const,
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

type MeasurementRunOrigin = (typeof RUN_ORIGINS)[number];

type MeasurementRunContent = Readonly<{
    originKind: MeasurementRunOrigin;
    automationId: string;
    originOccurredAt: Date | null;
    occurrenceKey: string | null;
    originSourceSelectorId: string | null;
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
    templateVersion: number;
    triggerKind: "pluginEvent" | "conversation";
    mode: "plain" | "e2ee";
}>): string {
    const binding = params.triggerKind === "pluginEvent"
        ? {
            v: 1 as const,
            automationId: params.automationId,
            templateVersion: params.templateVersion,
            triggerKind: "pluginEvent" as const,
            eventRef: {
                pluginId: "com.example.github",
                localId: "repository-event",
            },
            sourceSelectorId: SOURCE_SELECTOR_ID,
        }
        : {
            v: 1 as const,
            automationId: params.automationId,
            templateVersion: params.templateVersion,
            triggerKind: "conversation" as const,
            eventRef: null,
            sourceSelectorId: null,
        };
    const definition: PluginJsonValueV2 = params.triggerKind === "pluginEvent"
        ? {
            v: 1,
            sourceInstanceId: "pep1-measurement-source",
            sourceConfig: { repositoryId: 42 },
            displayLabel: "PEP1 measurement source",
            filter: null,
            maximumObservationAgeMs: null,
        }
        : { v: 1, bindingId: "pep1-measurement-conversation" };
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

function originForIndex(index: number): MeasurementRunOrigin {
    return RUN_ORIGINS[index % RUN_ORIGINS.length]!;
}

function automationIdForOrigin(origin: MeasurementRunOrigin): string {
    switch (origin) {
        case "scheduled":
        case "manual":
            return SCHEDULE_AUTOMATION_ID;
        case "pluginEvent":
            return EVENT_AUTOMATION_ID;
        case "conversation":
            return CONVERSATION_AUTOMATION_ID;
    }
}

function buildEvidence(index: number, origin: MeasurementRunOrigin) {
    if (origin === "pluginEvent") {
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
    if (origin === "conversation") {
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
    return JSON.stringify({
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 1,
        templateCiphertext: mode === "plain" ? SOURCE_TEMPLATE : TARGET_TEMPLATE,
        origin: {
            kind: "manual",
            invokedAt: 1_724_000_000_000,
        },
    });
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
            correspondence: MEASUREMENT_CORRESPONDENCE,
            source: MEASUREMENT_SOURCE,
            opaqueContext,
        }));
    }
    return JSON.stringify(sealAutomationConversationReplyContextStoredEnvelopeV1({
        mode,
        material: ACCOUNT_MATERIAL,
        randomBytes: deterministicRandomBytes,
        correspondence: MEASUREMENT_CORRESPONDENCE,
        source: MEASUREMENT_SOURCE,
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
    const originKind = originForIndex(index);
    const automationId = automationIdForOrigin(originKind);
    const evidence = buildEvidence(index, originKind);
    const isLegacySummarySource = originKind === "manual" && index === 1;
    const hasReplyHandoff = originKind === "conversation";
    return {
        originKind,
        automationId,
        originOccurredAt: evidence === null ? null : new Date(evidence.occurredAt),
        occurrenceKey: evidence === null
            ? null
            : deriveAutomationOccurrenceKeyV1(evidence),
        originSourceSelectorId: originKind === "pluginEvent"
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
        replyContextEnvelope: originKind === "conversation"
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
    const evidence = buildEvidence(params.index, source.originKind);
    const occurrenceKey = evidence === null
        ? null
        : deriveAutomationOccurrenceKeyV1(evidence);
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        action: "migrate",
        templates: [],
        runs: [{
            runId: runIdForIndex(params.index),
            expectedRunRevision: params.expectedRunRevision,
            triggerEvidenceEnvelope: evidence === null
                ? null
                : JSON.stringify(sealAutomationEventTriggerEvidenceEnvelopeV1({
                    material: ACCOUNT_MATERIAL,
                    evidence,
                    randomBytes: deterministicRandomBytes,
                })),
            occurrenceEvidenceEqualityTag: evidence === null
                ? null
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
    await db.automation.createMany({
        data: [
            {
                id: SCHEDULE_AUTOMATION_ID,
                accountId,
                name: "PEP1 schedule measurement",
                enabled: false,
                triggerKind: "schedule",
                scheduleKind: "interval",
                everyMs: 60_000,
                targetType: "new_session",
                templateCiphertext: SOURCE_TEMPLATE,
                templateVersion: 1,
            },
            {
                id: EVENT_AUTOMATION_ID,
                accountId,
                name: "PEP1 event measurement",
                enabled: false,
                triggerKind: "pluginEvent",
                triggerEventPluginId: "com.example.github",
                triggerEventLocalId: "repository-event",
                triggerSourceSelectorId: SOURCE_SELECTOR_ID,
                triggerSourceContractVersion: 1,
                triggerObservationTransport: "checkpointedPull",
                triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                    automationId: EVENT_AUTOMATION_ID,
                    templateVersion: 1,
                    triggerKind: "pluginEvent",
                    mode: "plain",
                }),
                targetType: "new_session",
                templateCiphertext: SOURCE_TEMPLATE,
                templateVersion: 1,
            },
            {
                id: CONVERSATION_AUTOMATION_ID,
                accountId,
                name: "PEP1 conversation measurement",
                enabled: false,
                triggerKind: "conversation",
                triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                    automationId: CONVERSATION_AUTOMATION_ID,
                    templateVersion: 1,
                    triggerKind: "conversation",
                    mode: "plain",
                }),
                targetType: "new_session",
                templateCiphertext: SOURCE_TEMPLATE,
                templateVersion: 1,
            },
        ],
    });
    await db.automationRun.createMany({
        data: runContents.map((content, index) => ({
            id: runIdForIndex(index),
            accountId,
            automationId: content.automationId,
            state: "queued" as const,
            originKind: content.originKind,
            originOccurredAt: content.originOccurredAt,
            occurrenceKey: content.occurrenceKey,
            occurrenceEvidenceEqualityTag: null,
            originSourceSelectorId: content.originSourceSelectorId,
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
            ...(automationId === SCHEDULE_AUTOMATION_ID
                ? {}
                : {
                    triggerDefinitionEnvelope: buildTriggerDefinitionEnvelope({
                        automationId,
                        templateVersion: 2,
                        triggerKind: automationId === EVENT_AUTOMATION_ID
                            ? "pluginEvent"
                            : "conversation",
                        mode: "e2ee",
                    }),
                }),
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
                v: buildEvidence(2, "pluginEvent"),
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
        const seededOriginCounts = await db.automationRun.groupBy({
            by: ["originKind"],
            where: { accountId: seeded.result.accountId },
            _count: { _all: true },
            orderBy: { originKind: "asc" },
        });
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
                    originKind: { in: ["scheduled", "manual"] },
                    OR: [
                        { triggerEvidenceEnvelope: { not: null } },
                        { occurrenceEvidenceEqualityTag: { not: null } },
                    ],
                },
            }),
        ]);
        expect(await db.account.count()).toBe(1);
        expect(await db.automation.count()).toBe(3);
        expect(seededRunRows).toBe(TOTAL_RUNS);
        expect(seededOriginCounts).toEqual([
            { originKind: "conversation", _count: { _all: RUNS_PER_ORIGIN } },
            { originKind: "manual", _count: { _all: RUNS_PER_ORIGIN } },
            { originKind: "pluginEvent", _count: { _all: RUNS_PER_ORIGIN } },
            { originKind: "scheduled", _count: { _all: RUNS_PER_ORIGIN } },
        ]);
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
            triggerEvidenceRows: RUNS_PER_ORIGIN * 2,
            executionInputRows: TOTAL_RUNS,
            resultRows: TOTAL_RUNS,
            replyContextRows: RUNS_PER_ORIGIN,
            replyReceiptRows: RUNS_PER_ORIGIN,
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

        const metrics = {
            scope: "one_account_10k_all_origin_participating_retained_runs",
            batchSize: BATCH_SIZE,
            batchCount: BATCH_COUNT,
            runRows: {
                seeded: seededRunRows,
                retainedAfterLegacyAttempt: retainedRunRowsAfterLegacyAttempt,
            },
            originRows: Object.fromEntries(seededOriginCounts.map((row) => [
                row.originKind,
                row._count._all,
            ])),
            sourceRetainedContentUtf8Bytes: seeded.result.sourceRetainedContentUtf8Bytes,
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
