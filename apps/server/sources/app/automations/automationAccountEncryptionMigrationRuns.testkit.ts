import {
    AccountEncryptionMigrateAutomationsDirectiveSchema,
    deriveAutomationOccurrenceKeyV1,
    AutomationSourceSelectorIdV1Schema,
    sealAutomationTriggerDefinitionStoredEnvelopeV1,
    sealAutomationRunFailureDetailStoredEnvelopeV1,
    serializeAutomationRunExecutionRecipeV1,
} from "@happier-dev/protocol";
import { expect } from "vitest";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";

import {
    matchAutomationAccountEncryptionMigrationPostStateInTx,
    migrateAutomationAccountEncryptionInTx,
} from "./automationCrudService";
import { encodeAutomationRunCause } from "./automationRunCauseCodec";

const sourceSelectorId = AutomationSourceSelectorIdV1Schema.parse(
    "8a2e26d2-5b2b-4e9b-a57f-68ca5e575dc7",
);
const e2eeTag = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const triggerDefinitionMaterial = {
    type: "dataKey" as const,
    machineKey: new Uint8Array(32).fill(9),
};

const runContentSelect = {
    id: true,
    revision: true,
    triggerEvidenceEnvelope: true,
    occurrenceEvidenceEqualityTag: true,
    executionInputEnvelope: true,
    resultEnvelope: true,
    replyContextEnvelope: true,
    replyHandoffReceiptEnvelope: true,
    errorMessage: true,
    summaryCiphertext: true,
} as const;

function eventTriggerDefinitionEnvelope(params: Readonly<{
    automationId: string;
    triggerId: string;
    triggerRevision: number;
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
        sourceSelectorId,
    };
    const definition = {
        v: 1,
        sourceInstanceId: "migration-repository",
        sourceConfig: { repositoryId: 42 },
        displayLabel: "Migration repository",
        filter: null,
        maximumObservationAgeMs: null,
    };
    return JSON.stringify(sealAutomationTriggerDefinitionStoredEnvelopeV1({
        mode: "plain",
        binding,
        definition,
    }));
}

function eventEvidence() {
    return {
        v: 1 as const,
        kind: "pluginEvent" as const,
        eventRef: {
            pluginId: "com.example.github",
            localId: "repository-event",
        },
        sourceSelectorId,
        occurrenceId: "migration-event-1",
        occurredAt: 1_724_000_000_000,
        payload: { action: "opened", repository: { id: 42 } },
    };
}

function conversationEvidence() {
    return {
        v: 1 as const,
        kind: "conversation" as const,
        bindingId: "binding-account-encryption-migration",
        occurrenceId: "migration-conversation-1",
        occurredAt: 1_724_000_001_000,
        caller: {
            pluginId: "happier.channels",
            contributionLocalId: "provider/observation-ingest-v1",
            machineId: "machine-account-encryption-migration",
        },
        input: { text: "migrate this conversation" },
        replyContextIdentity: "reply-context-account-encryption-migration",
    };
}

function plainTemplate(prompt: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_plain_v1",
        payload: { prompt },
    });
}

function encryptedTemplate(ciphertext: string): string {
    return JSON.stringify({
        kind: "happier_automation_template_encrypted_v1",
        payloadCiphertext: ciphertext,
    });
}

function strictExecutionInput(params: Readonly<{
    templateVersion: number;
    prompt: string;
    evidence: unknown;
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion,
        template: { t: "plain", v: { v: 1, prompt: params.prompt } },
        triggerEvidence: { t: "plain", v: params.evidence },
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: "server-account-encryption-migration",
                    machineId: "machine-account-encryption-migration",
                },
                directory: "/tmp/account-encryption-migration",
                agentTarget: {
                    kind: "agent",
                    identity: {
                        pluginId: "happier.agent.codex",
                        localId: "codex",
                    },
                },
            },
        },
        assignmentMachineIds: ["machine-account-encryption-migration"],
    });
    if (serialized.kind !== "available") {
        throw new Error("All-cause migration fixture must use a strict Run recipe");
    }
    return serialized.serialized;
}

function encryptedStrictExecutionInput(params: Readonly<{
    runId: string;
    templateVersion: number;
}>): string {
    const serialized = serializeAutomationRunExecutionRecipeV1({
        v: 1,
        templateVersion: params.templateVersion,
        template: {
            t: "encrypted",
            c: "replacement-encrypted-execution-input-" + params.runId,
        },
        triggerEvidence: {
            t: "encrypted",
            c: "replacement-encrypted-evidence-" + params.runId,
        },
        target: {
            kind: "newSession",
            spawn: {
                executionTarget: {
                    serverId: "server-account-encryption-migration",
                    machineId: "machine-account-encryption-migration",
                },
                directory: "/tmp/account-encryption-migration",
                agentTarget: {
                    kind: "agent",
                    identity: {
                        pluginId: "happier.agent.codex",
                        localId: "codex",
                    },
                },
            },
        },
        assignmentMachineIds: ["machine-account-encryption-migration"],
    });
    if (serialized.kind !== "available") {
        throw new Error("All-cause migration fixture must use a strict encrypted Run recipe");
    }
    return serialized.serialized;
}

function executionInput(params: Readonly<{
    templateCiphertext: string;
    retainedV2Origin: Readonly<{ kind: "scheduled"; scheduledFor: number }>
        | Readonly<{ kind: "manual"; invokedAt: number }>;
}>): string {
    return JSON.stringify({
        kind: "happier_automation_run_execution_input_v1",
        targetType: "new_session",
        templateVersion: 1,
        templateCiphertext: params.templateCiphertext,
        origin: params.retainedV2Origin,
    });
}

function plainResultEnvelope(params: Readonly<{
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string;
}>): string {
    return JSON.stringify({
        t: "plain",
        v: {
            v: 1,
            correspondence: params,
            result: { v: 1, kind: "text", text: "Automation completed" },
        },
    });
}

function plainReplyContextEnvelope(params: Readonly<{
    automationId: string;
    occurrenceKey: string;
}>): string {
    return JSON.stringify({
        t: "plain",
        v: {
            v: 1,
            correspondence: params,
            opaqueContext: {
                conversationId: "conversation-account-encryption-migration",
            },
        },
    });
}

function plainReplyReceiptEnvelope(params: Readonly<{
    accountId: string;
    automationId: string;
    runId: string;
    handoffId: string;
}>): string {
    return JSON.stringify({
        t: "plain",
        v: {
            v: 1,
            correspondence: params,
            result: {
                kind: "accepted",
                custodyId: "custody-account-encryption-migration",
            },
        },
    });
}

async function seedAllCauseRuns(onAccountCreated?: (accountId: string) => void) {
    const account = await db.account.create({
        data: { encryptionMode: "plain" },
        select: { id: true },
    });
    onAccountCreated?.(account.id);
    const eventAutomationId = "automation-account-encryption-migration-event";
    const eventAutomation = await db.automation.create({
        data: {
            id: eventAutomationId,
            accountId: account.id,
            name: "Event evidence migration",
            enabled: false,
            triggers: {
                create: [
                    {
                        id: "trigger-account-encryption-migration-event",
                        kind: "pluginEvent",
                        eventPluginId: "com.example.github",
                        eventLocalId: "repository-event",
                        sourceSelectorId,
                        sourceContractVersion: 1,
                        observationTransport: "checkpointedPull",
                        definitionEnvelope: eventTriggerDefinitionEnvelope({
                            automationId: eventAutomationId,
                            triggerId: "trigger-account-encryption-migration-event",
                            triggerRevision: 0,
                        }),
                    },
                    {
                        id: "trigger-account-encryption-migration-schedule",
                        kind: "schedule",
                        scheduleKind: "interval",
                        everyMs: 60_000,
                    },
                ],
            },
            targetType: "new_session",
            templateCiphertext: plainTemplate("migrate Event Run"),
            templateVersion: 4,
        },
        select: {
            id: true,
            templateVersion: true,
            templateCiphertext: true,
            triggers: { select: { id: true, kind: true, revision: true } },
        },
    });
    const eventTrigger = eventAutomation.triggers.find((trigger) => trigger.kind === "pluginEvent")!;
    const scheduleTrigger = eventAutomation.triggers.find((trigger) => trigger.kind === "schedule")!;
    const conversationAutomationId = "automation-account-encryption-migration-conversation";
    const conversationAutomation = await db.automation.create({
        data: {
            id: conversationAutomationId,
            accountId: account.id,
            name: "Conversation evidence migration",
            enabled: false,
            // Conversation is a direct Run cause, so no trigger row is needed.
            targetType: "new_session",
            templateCiphertext: plainTemplate("migrate Conversation Run"),
            templateVersion: 6,
        },
        select: { id: true, templateVersion: true, templateCiphertext: true },
    });
    const replyMachine = await db.machine.create({
        data: {
            id: "machine-account-encryption-migration",
            accountId: account.id,
            metadata: "{}",
        },
        select: { id: true },
    });
    const event = eventEvidence();
    const eventRunEvidence = {
        ...event,
        sourceInstanceId: "migration-repository",
        sourceContractVersion: 1,
        observationReceivedAt: event.occurredAt,
        filter: { version: null, result: "matched" as const },
    };
    const eventRunId = "run-account-encryption-event";
    const eventOccurrenceKey = deriveAutomationOccurrenceKeyV1({
        triggerId: eventTrigger.id,
        evidence: event,
    });
    const eventRun = await db.automationRun.create({
        data: {
            id: eventRunId,
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "failed",
            ...encodeAutomationRunCause({
                kind: "trigger",
                triggerId: eventTrigger.id,
                triggerRevision: eventTrigger.revision,
                triggerKind: "pluginEvent",
                occurrenceKey: eventOccurrenceKey,
                occurredAt: event.occurredAt,
                evidence: { eventRef: event.eventRef, sourceSelectorId },
            }),
            occurrenceEvidenceEqualityTag: null,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: event }),
            executionInputEnvelope: strictExecutionInput({
                templateVersion: eventAutomation.templateVersion,
                prompt: "migrate Event Run",
                evidence: eventRunEvidence,
            }),
            resultEnvelope: plainResultEnvelope({
                accountId: account.id,
                automationId: eventAutomation.id,
                runId: eventRunId,
                handoffId: "handoff-account-encryption-event",
            }),
            errorCode: "provider_failed",
            errorMessage: JSON.stringify(sealAutomationRunFailureDetailStoredEnvelopeV1({
                mode: "plain",
                correspondence: {
                    automationId: eventAutomation.id,
                    runId: eventRunId,
                },
                detail: "private Event provider failure detail",
            })),
            scheduledAt: new Date("2026-08-10T10:00:00.000Z"),
            dueAt: new Date("2026-08-10T10:00:00.000Z"),
            finishedAt: new Date("2026-08-10T10:00:30.000Z"),
            assignments: { create: [{ machineId: replyMachine.id, priority: 0 }] },
        },
        select: runContentSelect,
    });
    const conversation = conversationEvidence();
    const conversationRunEvidence = {
        ...conversation,
        observationReceivedAt: conversation.occurredAt,
    };
    const conversationRunId = "run-account-encryption-conversation";
    const conversationCorrespondence = {
        accountId: account.id,
        automationId: conversationAutomation.id,
        runId: conversationRunId,
        handoffId: "handoff-account-encryption-conversation",
    };
    const conversationOccurrenceKey = deriveAutomationOccurrenceKeyV1(conversation);
    const conversationRun = await db.automationRun.create({
        data: {
            id: conversationRunId,
            automationId: conversationAutomation.id,
            accountId: account.id,
            state: "succeeded",
            ...encodeAutomationRunCause({
                kind: "conversation",
                occurrenceKey: conversationOccurrenceKey,
                occurredAt: conversation.occurredAt,
            }),
            occurrenceEvidenceEqualityTag: null,
            triggerEvidenceEnvelope: JSON.stringify({ t: "plain", v: conversation }),
            executionInputEnvelope: strictExecutionInput({
                templateVersion: conversationAutomation.templateVersion,
                prompt: "migrate Conversation Run",
                evidence: conversationRunEvidence,
            }),
            resultEnvelope: plainResultEnvelope(conversationCorrespondence),
            replyContextEnvelope: plainReplyContextEnvelope(
                {
                    automationId: conversationCorrespondence.automationId,
                    occurrenceKey: conversationOccurrenceKey,
                },
            ),
            replyHandoffActionPluginId: "happier.channels",
            replyHandoffActionLocalId: "automation/result-deliver-v1",
            replyHandoffTargetMachineId: replyMachine.id,
            replyHandoffTargetMachineInstallationId: "installation-account-encryption-migration",
            replyHandoffTargetMaterializationId: "materialization-account-encryption-migration",
            replyHandoffId: conversationCorrespondence.handoffId,
            replyHandoffState: "accepted",
            replyHandoffReceiptEnvelope: plainReplyReceiptEnvelope(conversationCorrespondence),
            scheduledAt: new Date("2026-08-10T10:01:00.000Z"),
            dueAt: new Date("2026-08-10T10:01:00.000Z"),
            finishedAt: new Date("2026-08-10T10:02:00.000Z"),
            assignments: { create: [{ machineId: replyMachine.id, priority: 0 }] },
        },
        select: runContentSelect,
    });
    const scheduledFor = new Date("2026-08-10T10:03:00.000Z");
    const scheduleOccurrenceKey = deriveAutomationOccurrenceKeyV1({
        triggerId: scheduleTrigger.id,
        evidence: { v: 1, kind: "schedule", scheduledFor: scheduledFor.getTime() },
    });
    const scheduledRun = await db.automationRun.create({
        data: {
            id: "run-account-encryption-scheduled",
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "queued",
            ...encodeAutomationRunCause({
                kind: "trigger",
                triggerId: scheduleTrigger.id,
                triggerRevision: scheduleTrigger.revision,
                triggerKind: "schedule",
                occurrenceKey: scheduleOccurrenceKey,
                occurredAt: scheduledFor.getTime(),
                evidence: { scheduledFor: scheduledFor.getTime() },
            }),
            executionInputEnvelope: executionInput({
                templateCiphertext: eventAutomation.templateCiphertext,
                retainedV2Origin: {
                    kind: "scheduled",
                    scheduledFor: scheduledFor.getTime(),
                },
            }),
            scheduledAt: scheduledFor,
            dueAt: scheduledFor,
            assignments: { create: [{ machineId: replyMachine.id, priority: 0 }] },
        },
        select: runContentSelect,
    });
    const manualRun = await db.automationRun.create({
        data: {
            id: "run-account-encryption-manual",
            automationId: eventAutomation.id,
            accountId: account.id,
            state: "succeeded",
            ...encodeAutomationRunCause({ kind: "manual", invokedAt: 1_723_247_201_000 }),
            executionInputEnvelope: executionInput({
                templateCiphertext: eventAutomation.templateCiphertext,
                retainedV2Origin: { kind: "manual", invokedAt: 1_723_247_201_000 },
            }),
            resultEnvelope: JSON.stringify({
                t: "legacySummaryCiphertext",
                c: "manual-predecessor-summary",
            }),
            summaryCiphertext: "manual-predecessor-summary",
            scheduledAt: new Date("2026-08-10T10:04:00.000Z"),
            dueAt: new Date("2026-08-10T10:04:00.000Z"),
            finishedAt: new Date("2026-08-10T10:05:00.000Z"),
            assignments: { create: [{ machineId: replyMachine.id, priority: 0 }] },
        },
        select: runContentSelect,
    });
    return {
        account,
        eventAutomation,
        eventTrigger,
        conversationAutomation,
        eventRun,
        conversationRun,
        scheduledRun,
        manualRun,
    };
}

function migrationItem(params: Readonly<{
    runId: string;
    automationId: string;
    expectedRunRevision: number;
    runKind: "pluginEvent" | "conversation" | "scheduled" | "manual";
    templateVersion: number;
    retainsOccurrenceEvidence: boolean;
    resultEnvelope: string | null;
    replyContextEnvelope: string | null;
    replyHandoffReceiptEnvelope: string | null;
    failureDetailEnvelope: string | null;
}>) {
    return {
        runId: params.runId,
        expectedRunRevision: params.expectedRunRevision,
        triggerEvidenceEnvelope: params.retainsOccurrenceEvidence
            ? JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-evidence-" + params.runId,
            })
            : null,
        occurrenceEvidenceEqualityTag: params.retainsOccurrenceEvidence ? e2eeTag : null,
        executionInputEnvelope:
            params.runKind === "pluginEvent" || params.runKind === "conversation"
                ? encryptedStrictExecutionInput({
                    runId: params.runId,
                    templateVersion: params.templateVersion,
                })
                : executionInput({
                    templateCiphertext: encryptedTemplate(
                        "replacement-encrypted-execution-input-" + params.runId,
                    ),
                    retainedV2Origin: params.runKind === "scheduled"
                        ? {
                            kind: "scheduled",
                            scheduledFor: new Date("2026-08-10T10:03:00.000Z").getTime(),
                        }
                        : { kind: "manual", invokedAt: 1_723_247_201_000 },
                }),
        resultEnvelope: params.resultEnvelope === null
            ? null
            : JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-result-" + params.runId,
            }),
        replyContextEnvelope: params.replyContextEnvelope === null
            ? null
            : JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-reply-context-" + params.runId,
            }),
        replyHandoffReceiptEnvelope: params.replyHandoffReceiptEnvelope === null
            ? null
            : JSON.stringify({
                t: "encrypted",
                c: "replacement-encrypted-receipt-" + params.runId,
            }),
        failureDetailEnvelope: params.failureDetailEnvelope === null
            ? null
            : JSON.stringify(sealAutomationRunFailureDetailStoredEnvelopeV1({
                mode: "e2ee",
                correspondence: {
                    automationId: params.automationId,
                    runId: params.runId,
                },
                detail: "private Event provider failure detail",
                material: triggerDefinitionMaterial,
                randomBytes: (length) => new Uint8Array(length).fill(7),
            })),
    };
}

function buildDirective(seeded: Awaited<ReturnType<typeof seedAllCauseRuns>>) {
    const directive = AccountEncryptionMigrateAutomationsDirectiveSchema.parse({
        action: "migrate",
        templates: [
            {
                automationId: seeded.eventAutomation.id,
                expectedTemplateVersion: seeded.eventAutomation.templateVersion,
                templateCiphertext: encryptedTemplate(
                    "replacement-encrypted-template-" + seeded.eventAutomation.id,
                ),
                triggerDefinitionEnvelopes: [{
                    triggerId: seeded.eventTrigger.id,
                    triggerRevision: seeded.eventTrigger.revision,
                    envelope: JSON.stringify(
                    sealAutomationTriggerDefinitionStoredEnvelopeV1({
                        mode: "e2ee",
                        binding: {
                            v: 1,
                            automationId: seeded.eventAutomation.id,
                            triggerId: seeded.eventTrigger.id,
                            triggerRevision: seeded.eventTrigger.revision,
                            triggerKind: "pluginEvent",
                            eventRef: {
                                pluginId: "com.example.github",
                                localId: "repository-event",
                            },
                            sourceSelectorId,
                        },
                        definition: {
                            v: 1,
                            sourceInstanceId: "migration-repository",
                            sourceConfig: { repositoryId: 42 },
                            displayLabel: "Migration repository",
                            filter: null,
                            maximumObservationAgeMs: null,
                        },
                        material: triggerDefinitionMaterial,
                        randomBytes: (length) => new Uint8Array(length).fill(6),
                    }),
                    ),
                }],
            },
            {
                automationId: seeded.conversationAutomation.id,
                expectedTemplateVersion: seeded.conversationAutomation.templateVersion,
                templateCiphertext: encryptedTemplate(
                    "replacement-encrypted-template-" + seeded.conversationAutomation.id,
                ),
                triggerDefinitionEnvelopes: [],
            },
        ],
        runs: [
            migrationItem({
                runId: seeded.eventRun.id,
                automationId: seeded.eventAutomation.id,
                expectedRunRevision: seeded.eventRun.revision,
                runKind: "pluginEvent",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: true,
                resultEnvelope: seeded.eventRun.resultEnvelope,
                replyContextEnvelope: seeded.eventRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.eventRun.replyHandoffReceiptEnvelope,
                failureDetailEnvelope: seeded.eventRun.errorMessage,
            }),
            migrationItem({
                runId: seeded.conversationRun.id,
                automationId: seeded.conversationAutomation.id,
                expectedRunRevision: seeded.conversationRun.revision,
                runKind: "conversation",
                templateVersion: seeded.conversationAutomation.templateVersion,
                retainsOccurrenceEvidence: true,
                resultEnvelope: seeded.conversationRun.resultEnvelope,
                replyContextEnvelope: seeded.conversationRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.conversationRun.replyHandoffReceiptEnvelope,
                failureDetailEnvelope: seeded.conversationRun.errorMessage,
            }),
            migrationItem({
                runId: seeded.scheduledRun.id,
                automationId: seeded.eventAutomation.id,
                expectedRunRevision: seeded.scheduledRun.revision,
                runKind: "scheduled",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: false,
                resultEnvelope: seeded.scheduledRun.resultEnvelope,
                replyContextEnvelope: seeded.scheduledRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.scheduledRun.replyHandoffReceiptEnvelope,
                failureDetailEnvelope: seeded.scheduledRun.errorMessage,
            }),
            migrationItem({
                runId: seeded.manualRun.id,
                automationId: seeded.eventAutomation.id,
                expectedRunRevision: seeded.manualRun.revision,
                runKind: "manual",
                templateVersion: seeded.eventAutomation.templateVersion,
                retainsOccurrenceEvidence: false,
                resultEnvelope: seeded.manualRun.resultEnvelope,
                replyContextEnvelope: seeded.manualRun.replyContextEnvelope,
                replyHandoffReceiptEnvelope: seeded.manualRun.replyHandoffReceiptEnvelope,
                failureDetailEnvelope: seeded.manualRun.errorMessage,
            }),
        ],
    });
    if (directive.action !== "migrate") {
        throw new Error("Expected all-cause migration directive");
    }
    return directive;
}

function expectedMigratedRun(
    source: Readonly<{ id: string; revision: number }>,
    target: NonNullable<ReturnType<typeof buildDirective>["runs"]>[number],
) {
    return {
        id: source.id,
        revision: source.revision + 1,
        triggerEvidenceEnvelope: target.triggerEvidenceEnvelope,
        occurrenceEvidenceEqualityTag: target.occurrenceEvidenceEqualityTag,
        executionInputEnvelope: target.executionInputEnvelope,
        resultEnvelope: target.resultEnvelope,
        replyContextEnvelope: target.replyContextEnvelope,
        replyHandoffReceiptEnvelope: target.replyHandoffReceiptEnvelope,
        errorMessage: target.failureDetailEnvelope,
        summaryCiphertext: null,
    };
}

/**
 * The canonical all-cause retained-Run migration-participant assertion. Both
 * SQLite integration and PostgreSQL DB-contract suites call this exact scenario.
 */
export async function assertAllCauseAutomationRunMigrationToE2ee(params?: Readonly<{
    onAccountCreated?: (accountId: string) => void;
}>) {
    const seeded = await seedAllCauseRuns(params?.onAccountCreated);
    const directive = buildDirective(seeded);
    const targetsByRunId = new Map(directive.runs!.map((target) => [target.runId, target] as const));
    const eventTarget = targetsByRunId.get(seeded.eventRun.id)!;
    const conversationTarget = targetsByRunId.get(seeded.conversationRun.id)!;
    const scheduledTarget = targetsByRunId.get(seeded.scheduledRun.id)!;
    const manualTarget = targetsByRunId.get(seeded.manualRun.id)!;
    const templatesByAutomationId = new Map(
        directive.templates.map((template) => [template.automationId, template] as const),
    );
    const eventTemplate = templatesByAutomationId.get(seeded.eventAutomation.id)!;
    const conversationTemplate = templatesByAutomationId.get(seeded.conversationAutomation.id)!;
    const eventTriggerTarget = eventTemplate.triggerDefinitionEnvelopes.find(
        (target) => target.triggerId === seeded.eventTrigger.id,
    )!;

    await expect(inTx(async (tx) =>
        await migrateAutomationAccountEncryptionInTx({
            tx,
            accountId: seeded.account.id,
            toMode: "e2ee",
            directive,
        }),
    )).resolves.toEqual({ status: "applied" });

    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.eventRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.eventRun, eventTarget!));
    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.conversationRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.conversationRun, conversationTarget!));
    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.scheduledRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.scheduledRun, scheduledTarget!));
    await expect(db.automationRun.findUniqueOrThrow({
        where: { id: seeded.manualRun.id },
        select: runContentSelect,
    })).resolves.toEqual(expectedMigratedRun(seeded.manualRun, manualTarget!));
    await expect(db.automation.findUniqueOrThrow({
        where: { id: seeded.eventAutomation.id },
        select: {
            templateCiphertext: true,
            templateVersion: true,
            triggers: {
                where: { kind: "pluginEvent" },
                select: { definitionEnvelope: true },
            },
        },
    })).resolves.toEqual({
        templateCiphertext: eventTemplate.templateCiphertext,
        templateVersion: seeded.eventAutomation.templateVersion + 1,
        triggers: [{ definitionEnvelope: eventTriggerTarget.envelope }],
    });
    await expect(db.automation.findUniqueOrThrow({
        where: { id: seeded.conversationAutomation.id },
        select: {
            templateCiphertext: true,
            templateVersion: true,
            triggers: { select: { definitionEnvelope: true } },
        },
    })).resolves.toEqual({
        templateCiphertext: conversationTemplate.templateCiphertext,
        templateVersion: seeded.conversationAutomation.templateVersion + 1,
        triggers: [],
    });
    await expect(inTx(async (tx) =>
        await matchAutomationAccountEncryptionMigrationPostStateInTx({
            tx,
            accountId: seeded.account.id,
            toMode: "e2ee",
            directive,
        }),
    )).resolves.toEqual({ status: "matched" });

}
